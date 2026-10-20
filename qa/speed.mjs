// アプリの中のボードの速さを測る（10/20 satouさん「実行速度も気にして」）。ボード側の board/check-speed.mjs と同じ測り方：
// 150 枚のカードで、PC とスマホ相当（CPU 4倍遅く）で、描き直し1回・カードの詳細を開くまで。
// 目安（超えたら ❌・終了コード 1）：詳細を開く 200ms 以下（INP の「良い」）、描き直し 100ms 以下。
// 使い方: LK_BOARD=<ボードの HTML> node qa/speed.mjs   （ボードの写しはこのリポジトリに入れない）
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, extname, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BOARD = readFileSync(process.env.LK_BOARD || resolve(root, 'qa/board.fixture.html'), 'utf8');
const now = Date.now(), iso = (d) => new Date(now - d * 864e5).toISOString();
const lanes = ['now', 'next', 'wait', 'later', 'hold', 'agent', 'done'];
const cards = Array.from({ length: 150 }, (_, i) => ({
  doc_id: 's' + i, no: i + 1, title: '速さテストのカード ' + i + ' — 件名がすこし長めのとき二行になるかを見る', owner: i % 3 ? 'you' : 'agent', lane: lanes[i % 7],
  category: ['転職', 'ボード', 'サブスク'][i % 3], priority: ['high', 'mid', 'low'][i % 3], due: i % 5 ? null : new Date(now + (i % 9 - 3) * 864e5).toISOString().slice(0, 10),
  created: iso(30 - i / 5), updated: iso(1), note: '補足の文 '.repeat(4), progress: '進み具合の文', order: i,
  history: [{ at: iso(1), who: 'you', text: 'コメント' }, { at: iso(0.5), who: 'claude', text: '返事' }],
}));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.jpg': 'image/jpeg', '.css': 'text/css' };
const server = createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const f = normalize(resolve(root, '.' + p));
  if (!f.startsWith(root + sep) || !existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[extname(f)] || 'application/octet-stream' });
  res.end(readFileSync(f));
}).listen(0);
const base = `http://127.0.0.1:${server.address().port}/`;
const b64 = (s) => Buffer.from(s).toString('base64');

const LIM = { render: 100, open: 200 };
let ng = 0;
const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
for (const [w, h, name, cpu] of [[1366, 900, 'PC', 1], [390, 844, 'スマホ相当', 4]]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, serviceWorkers: 'block' });
  await ctx.route('https://api.github.com/**', (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^.*\/contents\//, '');
    if (route.request().method() !== 'GET') return route.fulfill({ json: { content: { sha: 'x' } } });
    if (path === 'local-board/cards.json') return route.fulfill({ json: { sha: 's', content: b64(JSON.stringify(cards)) } });
    if (path === 'board/index.html') return route.fulfill({ json: { sha: 'b', content: b64(BOARD) } });
    return route.fulfill({ status: 404, json: { message: 'Not Found' } });
  });
  await ctx.addInitScript(() => {
    localStorage.setItem('lk.mode', JSON.stringify('github'));
    localStorage.setItem('lk.gh', JSON.stringify({ owner: 'example-owner', repo: 'example-data', branch: 'main', token: 'qa-dummy-token' }));
  });
  const p = await ctx.newPage();
  await p.goto(base);
  await p.waitForFunction(() => window.LK?.ready && document.querySelectorAll('#board .card').length > 0, null, { timeout: 30000 });
  await p.evaluate(() => { const d = document.getElementById('talkDlg'); if (d?.open) d.close(); });
  const cdp = await ctx.newCDPSession(p);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
  const r = await p.evaluate(() => {
    const med = (x) => x.sort((a, b) => a - b)[x.length >> 1];
    const ts = [], os = [];
    for (let i = 0; i < 5; i++) { const a = performance.now(); render(); ts.push(performance.now() - a); }
    for (let i = 0; i < 3; i++) { const a = performance.now(); document.querySelectorAll('#board .card .ttl')[i].click(); os.push(performance.now() - a); document.getElementById('detail').close(); }
    return { render: Math.round(med(ts)), open: Math.round(med(os)), n: document.querySelectorAll('#board .card').length };
  });
  const bad = Object.keys(LIM).filter((k) => r[k] > LIM[k]);
  if (bad.length) ng++;
  console.log(`${bad.length ? '❌' : '✓'} ${name}（${r.n} 枚）：描き直し ${r.render}ms・詳細を開く ${r.open}ms${bad.length ? `（目安超え: ${bad.join(',')}）` : ''}`);
  await ctx.close();
}
await browser.close();
server.close();
console.log(ng ? `失敗 ${ng} 件` : '全部 OK');
process.exit(ng ? 1 : 0);

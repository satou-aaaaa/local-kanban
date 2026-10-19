// カンバンの PWA の自動検査（Claude を使わず CI で回す）。
// 本物の GitHub や鍵は使わない。api.github.com への通信はブラウザの中で見本のデータ（qa/cards.sample.json）に差し替える。
//   ❌ 失敗にするもの:
//     - manifest の必須項目・アイコンの大きさ、sw.js の SHELL に書いたファイルが無い
//     - JS のエラー（pageerror / console.error）
//     - 見本のカードが列に出ない、「済み」「答える」が GitHub への保存（PUT）に届かない、保存の中身が違う
//     - 鍵（Authorization）を api.github.com 以外に送った
//     - service worker が動かない、オフラインで開き直すと画面が出ない
//     - スマホ幅（390px）で列がタブにならない
// 使い方: node qa/run.mjs [--out qa-report]
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname, extname, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = Object.fromEntries(process.argv.slice(2).join(' ').split('--').filter(Boolean).map((s) => s.trim().split(/\s+/)));
const OUT = args.out || 'qa-report';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const passes = [];
const check = (ok, msg) => (ok ? passes : failures).push(msg);

// ---------- 1. ファイルの検査（ブラウザなし） ----------
const pngSize = (f) => { const b = readFileSync(resolve(root, f)); return b.toString('ascii', 1, 4) === 'PNG' ? `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}` : null; };
let manifest = {};
try { manifest = JSON.parse(readFileSync(resolve(root, 'manifest.webmanifest'), 'utf8')); check(true, 'manifest.webmanifest を読めた'); }
catch (e) { check(false, `manifest.webmanifest が JSON として読めない: ${e.message}`); }
for (const k of ['name', 'short_name', 'start_url', 'display', 'icons']) check(manifest[k] != null, `manifest に ${k} がある`);
for (const want of ['192x192', '512x512']) check((manifest.icons || []).some((i) => i.sizes === want), `manifest に ${want} のアイコンがある`);
for (const i of manifest.icons || []) {
  const f = resolve(root, i.src);
  check(existsSync(f) && pngSize(i.src) === i.sizes, `アイコン ${i.src} があり、大きさが ${i.sizes}`);
}
const sw = readFileSync(resolve(root, 'sw.js'), 'utf8');
const shell = JSON.parse((sw.match(/const SHELL = (\[[^\]]*\])/) || [])[1]?.replace(/'/g, '"') || '[]');
check(shell.length > 0, 'sw.js の SHELL を読めた');
for (const p of shell) check(p === './' || existsSync(resolve(root, p)), `SHELL のファイル ${p} がある`);

// ---------- 2. 手元のサーバー（127.0.0.1 だけ） ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
const server = createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const f = normalize(resolve(root, '.' + p));
  if (!f.startsWith(root + sep) || !existsSync(f)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': TYPES[extname(f)] || 'application/octet-stream' });
  res.end(readFileSync(f));
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${server.address().port}/`;

// ---------- 3. ブラウザで GitHub につないだ状態を作る ----------
const sample = readFileSync(resolve(root, 'qa/cards.sample.json'), 'utf8');
const SAMPLE = JSON.parse(sample);
const TOKEN = 'qa-dummy-token';
const puts = [];
const leaks = [];
let offline = false;
const errors = [];

const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
context.on('request', (r) => {
  const auth = r.headers().authorization || '';
  if (auth.includes(TOKEN) && new URL(r.url()).host !== 'api.github.com') leaks.push(r.url());
});
await context.route('https://api.github.com/**', async (route) => {
  const req = route.request();
  const path = new URL(req.url()).pathname.replace(/^.*\/contents\//, '');
  if (req.method() === 'GET') {
    if (path === 'local-board/cards.json') return route.fulfill({ json: { sha: 'sha-cards', content: Buffer.from(sample).toString('base64') } });
    if (path === 'local-board/BOARD.md') return route.fulfill({ json: { sha: 'sha-md', content: Buffer.from('# board\n').toString('base64') } });
    return route.fulfill({ status: 404, json: { message: 'Not Found' } });
  }
  if (req.method() === 'PUT') {
    const body = req.postDataJSON();
    puts.push({ path, body, text: Buffer.from(body.content, 'base64').toString('utf8') });
    return route.fulfill({ json: { content: { sha: `sha-${puts.length}` } } });
  }
  return route.fulfill({ status: 405, json: {} });
});
await context.addInitScript((t) => {
  if (!localStorage.getItem('lk.gh')) {
    localStorage.setItem('lk.mode', JSON.stringify('github'));
    localStorage.setItem('lk.gh', JSON.stringify({ owner: 'example-owner', repo: 'example-data', branch: 'main', token: t }));
  }
}, TOKEN);

const page = await context.newPage();
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  if (offline && /ERR_INTERNET_DISCONNECTED|Failed to fetch|Failed to load resource/.test(m.text())) return;
  errors.push(`console.error: ${m.text()}`);
});

const waitPut = async (n, label) => {
  const t0 = Date.now();
  while (puts.length < n && Date.now() - t0 < 10000) await page.waitForTimeout(100);
  check(puts.length >= n, `${label}が GitHub への保存（PUT）に届いた`);
};
const lastCards = () => JSON.parse([...puts].reverse().find((p) => p.path === 'local-board/cards.json')?.text || '[]');

try {
  await page.goto(base);
  await page.waitForSelector('#board:not([hidden]) .card', { timeout: 10000 });
  const live = SAMPLE.filter((c) => !c.deleted);
  const shown = await page.$$eval('#board .card .t', (els) => els.map((e) => e.textContent));
  check(shown.length === live.length, `見本のカード ${live.length} 枚が出た（出たのは ${shown.length} 枚）`);
  check(!shown.some((t) => t.includes('消したもの')), '消したカードは出ない');
  for (const [lane, n] of Object.entries(live.reduce((a, c) => ((a[c.lane] = (a[c.lane] || 0) + 1), a), {}))) {
    const got = await page.$$eval(`#board .lane[data-lane="${lane}"] .card`, (e) => e.length);
    check(got === n, `列 ${lane} にカード ${n} 枚（${got} 枚）`);
  }

  // 「済み」を押す → 保存の中身を確かめる
  await page.locator('#board .lane[data-lane="now"] .card', { hasText: '見本のカード（今やる）' }).locator('[data-act=done]').click();
  await waitPut(1, '「済み」');
  let c1 = lastCards().find((c) => c.doc_id === 's1');
  check(c1?.lane === 'done' && !!c1.done_at, '「済み」にしたカードが lane done・done_at 付きで保存された');
  check(c1?.moves?.at(-1)?.from === 'now' && c1?.moves?.at(-1)?.to === 'done', '列の移動（moves）が記録された');
  check(c1?.local_edit === true, 'ローカルで直した印（local_edit）が付いた');
  check(puts[0]?.body?.sha === 'sha-cards', '読んだときの sha を付けて保存した（上書きの事故を防ぐ）');
  check(puts.some((p) => p.path === 'local-board/BOARD.md'), 'BOARD.md も保存した');
  check(lastCards().some((c) => c.doc_id === 's6' && c.deleted), '消したカードの行は保存でも残る');

  // 確認のカードに答える
  const before = puts.length;
  await page.locator('#board .card.ask [data-opt="0"]').click();
  await waitPut(before + 1, '確認への答え');
  const c2 = lastCards().find((c) => c.doc_id === 's2');
  check(c2?.answer === 'はい' && c2?.answer_status === 'local', '答え（answer・answer_status）が保存された');

  // カードを足す
  const before2 = puts.length;
  await page.click('#addBtn');
  await page.fill('#addForm [name=title]', 'QA で足したカード');
  await page.click('#addForm button.primary');
  await waitPut(before2 + 1, 'カードの追加');
  check(lastCards().some((c) => c.title === 'QA で足したカード' && /^local-/.test(c.doc_id)), '足したカードが local- の ID で保存された');

  // service worker とオフライン
  const swOk = await page.evaluate(() => navigator.serviceWorker.ready.then((r) => !!r.active)).catch(() => false);
  check(swOk, 'service worker が動いた');
  const hasManifest = await page.evaluate(() => !!document.querySelector('link[rel=manifest]'));
  check(hasManifest, 'manifest のリンクが入った');
  await page.waitForTimeout(500);
  offline = true;
  await context.setOffline(true);
  await page.reload();
  await page.waitForSelector('#status', { timeout: 10000 });
  const offlineCards = await page.$$eval('#board .card', (e) => e.length);
  check(offlineCards > 0, `オフラインで開き直しても、画面（service worker の保存分）とカードが出た（${offlineCards} 枚）`);
  await context.setOffline(false);
  offline = false;
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: resolve(OUT, 'pc.png'), fullPage: true });

  // スマホ幅：列はタブで1つずつ
  const phone = await context.newPage();
  phone.on('pageerror', (e) => errors.push(`pageerror(スマホ): ${e.message}`));
  await phone.setViewportSize({ width: 390, height: 844 });
  await phone.goto(base);
  await phone.waitForSelector('#board .card', { timeout: 10000 });
  const tabs = await phone.$$eval('#tabs button', (e) => e.filter((b) => b.offsetParent !== null).length);
  check(tabs === 6, `スマホ幅で列のタブが 6 つ出た（${tabs}）`);
  const visibleLanes = await phone.$$eval('#board .lane', (e) => e.filter((s) => getComputedStyle(s).display !== 'none').length);
  check(visibleLanes === 1, `スマホ幅で見える列は 1 つ（${visibleLanes}）`);
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(overflow <= 1, `スマホ幅で横にはみ出さない（${overflow}px）`);
  await phone.locator('#tabs button', { hasText: '次にやる' }).click();
  const cur = await phone.$eval('#board .lane.cur', (s) => s.dataset.lane);
  check(cur === 'next', 'タブを押すとその列に切り替わる');
  await phone.screenshot({ path: resolve(OUT, 'phone.png'), fullPage: true });
} catch (e) {
  failures.push(`途中で止まった: ${e.message.split('\n')[0]}`);
}

check(leaks.length === 0, `鍵を api.github.com 以外に送っていない${leaks.length ? `（送り先: ${leaks.join(', ')}）` : ''}`);
for (const e of errors) failures.push(e);
await browser.close();
server.close();

mkdirSync(OUT, { recursive: true });
const report = [
  `## カンバン QA ${failures.length ? '❌' : '✅'}`,
  '',
  `通った項目 ${passes.length}・失敗 ${failures.length}`,
  '',
  ...(failures.length ? ['### 失敗', ...failures.map((f) => `- ❌ ${f}`), ''] : []),
  '<details><summary>通った項目</summary>',
  '',
  ...passes.map((p) => `- ✅ ${p}`),
  '',
  '</details>',
  '',
].join('\n');
writeFileSync(resolve(OUT, 'report.md'), report);
console.log(report);
process.exit(failures.length ? 1 : 0);

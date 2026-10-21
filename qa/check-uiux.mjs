// アプリの使いやすさを数字で測る（UI/UX 専門家役の点検の自動の部分。ボードの board-src/qa/check-uiux.mjs と LAST TELL の qa/checks/uiux.js が手本）。
// 2026-10-21 satouさん「カンバンにも LAST TELL と同じようなチェック機構を」。手順は reviews/README.md。
// 使い方: node qa/check-uiux.mjs [--update-baseline] [--show] [--shots <フォルダ>]（点検に使う画面写真を撮る）
//         LK_BOARD=<ボードの写し> で本物のボードでも測れる（基準は「本物」の欄。写しはこのリポジトリに入れない）
// 場面：ボード（スマホ 390x844・PC 1366x768・スマホの暗い色）、カードの詳細、会話の欄（💬）、🎤と会話・AI の設定。壁紙なし。
// 見ること:
//   - 記号だけのボタンに名前がある（aria-label か title）…… 外れ 0（NN/g「アイコンは文字を添える」、WCAG 4.1.2）
//   - 押す所が 24px 以上（WCAG 2.5.8。アプリの部品だけ）…… 外れ 0
//   - 文字の大きさ 12px 未満の数 …… 基準（qa/uiux-baseline.json）より増えない
//   - 文字と背景の明るさの差（4.5:1、大きい字は 3:1）が足りない数 …… 基準より増えない（WCAG 1.4.3）
//   - 押せる部品の数（最初の画面・全部）…… 基準より1つでも増えたら ❌（ごちゃごちゃ度。2026-10-21 satouさん「ボタンが増えたことによって、UI/UXに影響がでている」）。
//     増やすときは --update-baseline で基準を上げ、reviews/v<版>.md の「## 増やした押す所」に理由と代わりに減らしたものを書く（qa/check-review.mjs が見る）
//   - カードの中身以外の文字数（見出し・ボタン・札）…… 基準の 1.1 倍まで（10/20 satouさん「文字数が多く見にくい」）
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname, extname, normalize, sep, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const basePath = resolve(root, 'qa/uiux-baseline.json');
const argv = process.argv.slice(2);
const update = argv.includes('--update-baseline'), show = argv.includes('--show');
const shotsDir = (i => (i >= 0 ? argv[i + 1] : ''))(argv.indexOf('--shots'));
const real = !!process.env.LK_BOARD;
const BOARD = readFileSync(process.env.LK_BOARD || resolve(root, 'qa/board.fixture.html'), 'utf8');
const cards = readFileSync(resolve(root, 'qa/cards.sample.json'), 'utf8');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.jpg': 'image/jpeg', '.css': 'text/css', '.svg': 'image/svg+xml' };
const server = createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const f = normalize(resolve(root, '.' + p));
  if (!f.startsWith(root + sep) || !existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[extname(f)] || 'application/octet-stream' });
  res.end(readFileSync(f));
}).listen(0);
const base = `http://127.0.0.1:${server.address().port}/`;
const b64 = s => Buffer.from(s).toString('base64');

// 測る（scope の中だけ。scope が無ければ開いているダイアログの外＝ボードの画面）
function measure(scopeSel) {
  const scope = scopeSel ? document.querySelector(scopeSel) : document.body;
  const vis = e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden' && !e.closest('dialog:not([open])') && !(e.closest('details:not([open])') && !e.closest('summary'));
  const inScope = e => scope.contains(e) && (scopeSel || !e.closest('dialog'));
  const ctrls = [...scope.querySelectorAll('button,summary,select,input,textarea,a[href]')].filter(e => vis(e) && inScope(e));
  const label = e => (e.getAttribute('aria-label') || e.getAttribute('title') || e.getAttribute('aria-labelledby') || (e.labels && e.labels.length) || e.closest('label'));
  const noName = ctrls.filter(e => (e.tagName === 'BUTTON' || e.tagName === 'SUMMARY') && !/[\p{L}\p{N}]/u.test(e.textContent || '') && !label(e)).map(e => (e.textContent || '').trim() || e.outerHTML.slice(0, 40));
  // 入力欄の名前（placeholder は名前にならない。WCAG 4.1.2・1.3.1。v35 の点検で見つかった）
  const noField = ctrls.filter(e => /^(INPUT|SELECT|TEXTAREA)$/.test(e.tagName) && !/hidden|file|submit|button/.test(e.type) && !label(e)).map(e => e.name || e.id || e.tagName);
  // アプリの部品（ボードの外側・アプリのダイアログ）だけ押す所の大きさを見る。ボードの部品（カードの詳細を含む）はボードの検査が見る
  const appCtrl = e => (scopeSel && !scope.matches('#detail')) || e.closest('#lkBar,.lk,#lkMenu,#lkPochi,#talkBtn,#reloadBtn') || e.closest('header')?.querySelector('#lkMenu');
  const tiny = ctrls.filter(e => appCtrl(e) && !(e.tagName === 'INPUT' && /checkbox|radio/.test(e.type) && e.closest('label'))).filter(e => { const r = e.getBoundingClientRect(); return r.width < 24 || r.height < 24; }).map(e => (e.getAttribute('aria-label') || e.textContent || e.id || e.tagName).trim().slice(0, 14) + `(${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)})`);
  const first = ctrls.filter(e => { const r = e.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth; }).length;
  const texts = []; const tw = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT); let n;
  while ((n = tw.nextNode())) { if (!n.textContent.trim()) continue; const e = n.parentElement; if (!e || !vis(e) || !inScope(e) || /SCRIPT|STYLE/.test(e.tagName)) continue; texts.push([e, n.textContent.trim()]); }
  const small = new Set(), lowC = new Set(); let chrome = 0;
  const lum = c => { const v = c.map(x => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
  const rgba = s => { const m = s.match(/[\d.]+/g); if (!m) return [0, 0, 0, 0]; const v = m.map(Number); if (/^color\(srgb/.test(s)) for (let i = 0; i < 3; i++) v[i] *= 255; return v; };
  const bgOf = e => {
    let col = [255, 255, 255]; const stack = [];
    for (let x = e; x; x = x.parentElement) {
      const cs = getComputedStyle(x);
      if (cs.backgroundImage !== 'none' && !/gradient/.test(cs.backgroundImage)) return null;
      if (cs.backdropFilter && cs.backdropFilter !== 'none' && rgba(cs.backgroundColor)[3] < 0.85) return null; // すりガラスは下の絵で変わるので測らない
      const c = rgba(cs.backgroundColor); if (c.length < 4) c[3] = 1; if (c[3] > 0) stack.push(c); if (c[3] >= 1) break;
      if (x.tagName === 'DIALOG' && x.open) { const bd = rgba(getComputedStyle(x, '::backdrop').backgroundColor); if (bd[3] > 0) stack.push(bd.length < 4 ? [...bd, 1] : bd); }
    }
    for (const c of stack.reverse()) col = col.map((v, i) => v * (1 - c[3]) + c[i] * c[3]);
    return col;
  };
  for (const [e, t] of texts) {
    const cs = getComputedStyle(e); const fs = parseFloat(cs.fontSize);
    if (fs < 12) small.add(e);
    const fg = rgba(cs.color); const bg = bgOf(e);
    if (bg && (fg[3] === undefined || fg[3] >= 0.99) && +cs.opacity !== 0) {
      const a = lum(fg.slice(0, 3)), b2 = lum(bg); const r = (Math.max(a, b2) + 0.05) / (Math.min(a, b2) + 0.05);
      const big = fs >= 24 || (fs >= 18.66 && +cs.fontWeight >= 700);
      if (r < (big ? 3 : 4.5)) { lowC.add(e); e.dataset.cr = r.toFixed(2); }
    }
    if (!e.closest('.card')) chrome += t.length;
  }
  const sample = s => [...s].slice(0, 5).map(e => e.tagName.toLowerCase() + (e.id ? '#' + e.id : e.className ? '.' + String(e.className).split(' ')[0] : '') + '「' + (e.textContent || '').trim().slice(0, 12) + '」' + (e.dataset.cr || ''));
  // 上のバーが横にはみ出していないか（v35 の点検：スマホで「見た目」が画面の外に隠れていた）
  const out = scopeSel ? [] : [...document.querySelectorAll('header button, header summary, header a[href]')].filter(vis).filter(e => e.getBoundingClientRect().right > innerWidth + 1).map(e => (e.getAttribute('aria-label') || e.textContent || '').trim().slice(0, 10));
  return { out, noName, noField, tiny, first, taps: ctrls.length, small: small.size, smallEx: sample(small), lowC: lowC.size, lowCEx: sample(lowC), chrome };
}

const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
const baseAll = existsSync(basePath) ? JSON.parse(readFileSync(basePath, 'utf8')) : {};
const kind = real ? '本物のボード' : 'にせもののボード';
const baseline = baseAll[kind] || {}; const now = {}; let ng = 0;
const ok = (c, m) => { console.log(c ? '✓' : '❌', m); if (!c) ng++; };
const VIEWS = [['スマホ', 390, 844, true, 'light'], ['PC', 1366, 768, false, 'light'], ['スマホ（暗い色）', 390, 844, true, 'dark']];
for (const [tag, w, h, mobile, scheme] of VIEWS) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: mobile, isMobile: mobile, colorScheme: scheme, serviceWorkers: 'block' });
  await ctx.route('https://api.github.com/**', route => {
    const p = new URL(route.request().url()).pathname.replace(/^.*\/contents\//, '');
    if (route.request().method() !== 'GET') return route.fulfill({ json: { content: { sha: 'x' } } });
    if (p === 'local-board/cards.json') return route.fulfill({ json: { sha: 's', content: b64(cards) } });
    if (p === 'board/index.html') return route.fulfill({ json: { sha: 'b', content: b64(BOARD) } });
    if (p === 'local-board/settings.json') return route.fulfill({ json: { sha: 'st', content: b64(JSON.stringify({ wallpaper: 'none' })) } });
    return route.fulfill({ status: 404, json: { message: 'Not Found' } });
  });
  await ctx.addInitScript(() => {
    localStorage.setItem('lk.mode', JSON.stringify('github'));
    localStorage.setItem('lk.gh', JSON.stringify({ owner: 'example-owner', repo: 'example-data', branch: 'main', token: 'qa-dummy-token' }));
    localStorage.setItem('kanban-wp', 'none');
    for (const k of ['SpeechRecognition', 'webkitSpeechRecognition']) { const C = window[k]; if (C) { C.available = async () => 'unavailable'; C.install = async () => false; } }
    // 読み上げは止めておく（会話の欄を開いても声を出さない）
    try { window.speechSynthesis.speak = (u) => { setTimeout(() => u.onend && u.onend(), 0); }; } catch { /* なくてよい */ }
  });
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(base);
  await p.waitForFunction(() => window.LK?.ready && document.querySelectorAll('#board .card').length > 0, null, { timeout: 30000 });
  await p.evaluate(() => { for (const d of document.querySelectorAll('dialog[open]')) d.close(); });
  await p.waitForTimeout(400);
  const scenes = [['ボード', null, async () => {}], ['詳細', 'dialog#detail', async () => {
    // 押す所がいちばん多いカード（Claude の確認があるもの）を、ボードの openDetail で開く
    const okd = await p.evaluate(() => { const c = cards.find((x) => x.decision && !x.answer && !x.deleted) || cards.find((x) => !x.deleted); if (!c || typeof openDetail !== 'function') return false; openDetail(c.id); return true; });
    if (!okd) throw new Error('openDetail が無い');
    await p.waitForFunction(() => document.querySelector('dialog#detail')?.open, null, { timeout: 10000 });
    await p.waitForTimeout(300);
  }], ['会話', '#talkDlg', async () => {
    await p.evaluate(() => { for (const d of document.querySelectorAll('dialog[open]')) d.close(); });
    await p.click(await p.isVisible('#talkBtn') ? '#talkBtn' : '#lkPochi'); // スマホでポチがいるときは 💬 を隠す（v42）
    await p.waitForFunction(() => document.getElementById('talkDlg')?.open, null, { timeout: 10000 });
    await p.waitForTimeout(800);
  }], ['設定', '#talkSetDlg, dialog:has(#talkSetForm)', async () => {
    await p.evaluate(() => { for (const d of document.querySelectorAll('dialog[open]')) d.close(); });
    await p.click('#lkMenu summary'); await p.click('#lkMenu [data-m=aiset]');
    await p.waitForFunction(() => document.querySelector('#talkSetForm')?.closest('dialog')?.open, null, { timeout: 10000 });
    await p.waitForTimeout(300);
  }]];
  for (const [scene, sel, open] of scenes) {
    if (scene !== 'ボード' && tag === 'スマホ（暗い色）' && scene === '設定') { /* 暗い色の設定画面も測る */ }
    try { await open(); } catch (e) { ok(false, `${tag}・${scene}：開けない（${e.message.split('\n')[0]}）`); continue; }
    const scopeSel = sel ? await p.evaluate((s) => { const d = document.querySelector(s.split(',').map(x => x.trim()).find(x => { try { return document.querySelector(x); } catch { return false; } })); const dlg = d?.closest('dialog') || d; if (!dlg) return null; dlg.dataset.qaScope = '1'; return '[data-qa-scope="1"]'; }, sel) : null;
    const m = await p.evaluate(measure, scopeSel);
    if (scopeSel) await p.evaluate(() => document.querySelector('[data-qa-scope]')?.removeAttribute('data-qa-scope'));
    const key = `${tag}・${scene}`; now[key] = { first: m.first, taps: m.taps, small: m.small, lowC: m.lowC, chrome: m.chrome }; const bs = baseline[key];
    ok(!m.noName.length, `${key}：記号だけのボタンに名前がある${m.noName.length ? '（名前が無い: ' + m.noName.slice(0, 5).join(' ') + '）' : ''}`);
    ok(!m.out.length, `${key}：上のバーが画面からはみ出していない${m.out.length ? '（はみ出し: ' + m.out.join(' ') + '）' : ''}`);
    ok(!m.noField.length, `${key}：入力欄に名前がある${m.noField.length ? '（名前が無い: ' + m.noField.slice(0, 5).join(' ') + '）' : ''}`);
    ok(!m.tiny.length, `${key}：アプリの押す所が 24px 以上${m.tiny.length ? '（小さい: ' + m.tiny.slice(0, 5).join(' ') + '）' : ''}`);
    if (bs && !update) {
      ok(m.first <= bs.first, `${key}：最初の画面で押せる部品 ${m.first}（基準 ${bs.first}。増やすなら点検の記録に理由）`);
      if (bs.taps != null) ok(m.taps <= bs.taps, `${key}：押せる部品 全部で ${m.taps}（基準 ${bs.taps}。増やすなら点検の記録に理由）`);
      ok(m.small <= bs.small, `${key}：12px 未満の文字 ${m.small}（基準 ${bs.small}）${m.small > bs.small ? ' 例: ' + m.smallEx.join(' ') : ''}`);
      ok(m.lowC <= bs.lowC, `${key}：明るさの差が足りない文字 ${m.lowC}（基準 ${bs.lowC}）${m.lowC > bs.lowC ? ' 例: ' + m.lowCEx.join(' ') : ''}`);
      ok(m.chrome <= Math.round(bs.chrome * 1.1) + 5, `${key}：カードの中身以外の文字 ${m.chrome} 字（基準 ${bs.chrome}、1.1 倍まで）`);
    } else if (!bs && !update) console.log('・', key, 'の基準がまだ無い（--update-baseline で作る）');
    if (update || show) console.log('・', key, JSON.stringify(now[key]), '小さい字', m.smallEx.join(' '), '／差が足りない', m.lowCEx.join(' '));
    if (shotsDir) { mkdirSync(shotsDir, { recursive: true }); await p.screenshot({ path: join(shotsDir, `${tag.replace(/[（）]/g, '')}-${scene}.png`) }); }
    if (scene === 'ボード' && shotsDir) {
      try {
        // ボードの openDetail で開く（カードを押すと、中の「はい」などのボタンに当たることがある）
        const viaFn = await p.evaluate(() => { try { if (typeof openDetail === 'function' && typeof cards !== 'undefined' && cards.length) { openDetail(cards[0].id); return true; } } catch {} return false; });
        if (!viaFn) await p.locator('#board .card .ttl, #board .card').first().click({ timeout: 5000 });
        await p.waitForTimeout(300);
        await p.screenshot({ path: join(shotsDir, `${tag.replace(/[（）]/g, '')}-詳細.png`) }); await p.keyboard.press('Escape'); await p.waitForTimeout(200);
      } catch { /* 詳細の写真は無くてもよい */ }
    }
  }
  ok(!errs.length, `${tag}：JS のエラーが無い${errs.length ? '（' + errs[0] + '）' : ''}`);
  await ctx.close();
}
await browser.close(); server.close();
if (update) { baseAll[kind] = now; writeFileSync(basePath, JSON.stringify(baseAll, null, 1) + '\n'); console.log('基準を書き直した: qa/uiux-baseline.json（' + kind + '）'); }
console.log(ng ? `❌ ${ng} 件` : '全部 OK');
process.exit(ng ? 1 : 0);

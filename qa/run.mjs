// カンバンの PWA の自動検査（Claude を使わず CI で回す）。
// 本物の GitHub や鍵は使わない。api.github.com への通信はブラウザの中で見本のデータ（qa/cards.sample.json）に差し替える。
//   ❌ 失敗にするもの:
//     - manifest の必須項目・アイコンの大きさ、sw.js の SHELL に書いたファイルが無い
//     - JS のエラー（pageerror / console.error）
//     - ボードのにせもの（qa/board.fixture.html。LK_BOARD=ファイル で本物のボードの写しでも回せる）がアプリの中で動かない
//     - 壁紙が出ない（アプリにすると背景が消えた 2026-10-20）、見た目の設定が local-board/settings.json に保存されない・ほかの端末の設定が当たらない
//     - 見本のカードが列に出ない、「済み」「答える」が GitHub への保存（PUT）に届かない、保存の中身が違う
//     - 鍵（Authorization）を api.github.com 以外に送った
//     - service worker が動かない、オフラインで開き直すと画面が出ない
//     - スマホ幅（390px）で横にはみ出す、アプリの押すところが小さい（44px 未満）、入力欄の文字が 16px 未満、
//       カードの詳細が下から出ない、左右になぞっても列が変わらない、済みの後に「戻す」が出ない・戻せない
//     - 声の命令の読み取り（voice.js）が文型どおりにならない、Ctrl+K の命令が保存に届かない、消す前に聞き返さない
//     - URL（#add=）・共有メニュー（?title=&url=）からカードを足せない
//     - 端末の中で聞き取れないブラウザ（Edge・Firefox・サーバー版だけの音声認識）で🎤が出る・聞き取りを始める・エラーになる
//     - manifest の shortcuts・share_target が無いか、scope の外を指す
//     - 会話モード（AI なし・端末の中の AI・文字で話す）が動かない、消す前に聞き返さない、AI に補足を渡す、会話中に GitHub 以外へ通信する
//     - CSP の connect-src が自分のサイト・GitHub の API・モデルの置き場（Hugging Face・GitHub raw）以外を許している
//     - 端末の中の AI（localai.js）：ボタンを押す前にモデルを取りに行く、モデルの置き場以外・GET 以外の通信をする、
//       入れた WebLLM・Whisper・Silero で会話できない、会話中に外へ通信する、消せない、同梱の部品が読めない・LICENSE が無い
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
check(shell.includes('./voice.js'), 'SHELL に voice.js がある（オフラインでも声の命令が動く）');
check(shell.includes('./talk.js'), 'SHELL に talk.js がある（オフラインでも会話モードが動く）');
check(shell.includes('./localai.js'), 'SHELL に localai.js がある（入れた AI がオフラインでも動く）');
check(!shell.some((p) => p.includes('vendor/')), 'SHELL に vendor/（数十MB の AI 部品）を入れていない（使う人だけが取る）');
// 同梱の AI 部品：localai.js が指すファイルがあり、ライセンスが添えてある
const localai = readFileSync(resolve(root, 'localai.js'), 'utf8');
const vendorFiles = [...localai.matchAll(/'(vendor\/[^']+)'/g)].map((m) => m[1]).flatMap((p) => (/\.(m?js|wasm)$/.test(p) ? [p] : [p + '.mjs', p + '.wasm']));
check(vendorFiles.length === 6, `localai.js が指す同梱の部品を読めた（${vendorFiles.length}）`);
for (const p of vendorFiles) {
  check(existsSync(resolve(root, p)), `同梱の部品 ${p} がある`);
  check(existsSync(resolve(root, dirname(p), 'LICENSE')), `同梱の部品 ${dirname(p)} に LICENSE がある`);
}
for (const f of ['./boot.js', './shim.js', './app.js', './app.css']) check(shell.includes(f), `SHELL に ${f} がある（ボードの画面をオフラインでも組み立てられる）`);
check(!shell.some((p) => p.includes('bg/')), 'SHELL に壁紙の写真（bg/）を入れていない（選んだ写真だけを取る）');
// 壁紙：写真と小さい見本（bg/t/）が対になっている
const { readdirSync } = await import('node:fs');
const wps = readdirSync(resolve(root, 'bg')).filter((f) => f.endsWith('.jpg'));
check(wps.length >= 2, `壁紙の写真が bg/ にある（${wps.length} 枚）`);
for (const w of wps) check(existsSync(resolve(root, 'bg/t', w)), `壁紙 ${w} の小さい見本（bg/t/）がある`);
const html = readFileSync(resolve(root, 'index.html'), 'utf8');
check(/<script src="boot\.js"><\/script>/.test(html) && !/class="lane"|id="board"/.test(html), 'index.html はボードを持たず boot.js で組み立てる（ボードの HTML は非公開の置き場から読む）');
const csp = (html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/) || [])[1] || '';
const connect = (csp.match(/connect-src ([^;]+)/) || [])[1]?.trim().split(/\s+/) || [];
// 許すのは、自分のサイト・GitHub の API（カードの保存）・モデルの置き場（Hugging Face と WebLLM のモデル用 wasm の GitHub raw）だけ
const MODEL_HOSTS = ['https://huggingface.co', 'https://*.huggingface.co', 'https://*.hf.co', 'https://raw.githubusercontent.com'];
check(connect.length > 0 && connect.every((x) => x === "'self'" || x === 'https://api.github.com' || MODEL_HOSTS.includes(x)), `CSP の connect-src は自分のサイト・GitHub の API・モデルの置き場だけ（${connect.join(' ') || 'なし'}）`);
const isModelHost = (h) => h === 'huggingface.co' || h.endsWith('.huggingface.co') || h.endsWith('.hf.co') || h === 'raw.githubusercontent.com';
check((csp.match(/worker-src ([^;]+)/) || [])[1]?.trim() === "'self' blob:", "CSP の worker-src は自分のサイトと blob:（CPU 版の AI が中で作る worker）だけ");
check(/default-src 'self'/.test(csp), 'CSP の default-src は自分のサイトだけ');
const sc = manifest.shortcuts || [];
check(sc.length >= 3, `manifest に shortcuts が 3 つ以上ある（${sc.length}）`);
for (const x of sc) check(!!x.name && /^\.\/(#|$)/.test(x.url || '') && (x.icons || []).every((i) => existsSync(resolve(root, i.src))), `shortcut「${x.name}」の url が scope の中で、アイコンがある`);
const st = manifest.share_target || {};
check(st.action === './' && st.method === 'GET' && st.params?.title === 'title' && st.params?.text === 'text' && st.params?.url === 'url', 'manifest の share_target が ./ に GET で title・text・url を渡す');

// ---------- 2. 手元のサーバー（127.0.0.1 だけ） ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.jpg': 'image/jpeg', '.css': 'text/css' };
// 同梱の AI 部品のにせもの（検査では本物のモデルを取らない。WebGPU も無い）。fakeVendor が true の間だけ出す
let fakeVendor = false;
const vendorHits = [];
const FAKE = {
  llm: `export async function CreateMLCEngine(id, cfg) {
  window.__llmId = id;
  cfg?.initProgressCallback?.({ progress: 0.5, text: 'params_shard_0.bin' });
  await fetch('https://huggingface.co/mlc-ai/' + id + '/resolve/main/mlc-chat-config.json');
  cfg?.initProgressCallback?.({ progress: 1, text: 'done' });
  return { chat: { completions: { create: async (req) => { window.__llmReq.push(req); return { choices: [{ message: { content: JSON.stringify(window.__llmReplies.shift() || { say: 'うん', action: null }) } }] }; } } }, unload() {} };
}
export async function deleteModelAllInfoInCache(id) { window.__deleted = id; }
export async function hasModelInCache(id) { return !window.__modelGone; }`,
  cpu: `export class CacheManager { async clear() { window.__cpuCleared = true; } }
export class Wllama {
  constructor(paths, cfg) { window.__cpu = { wasm: paths.default, cfg }; this.cacheManager = new CacheManager(); }
  async loadModelFromUrl(url, o) { Object.assign(window.__cpu, { url, gpuLayers: o.n_gpu_layers }); o.progressCallback?.({ loaded: 1, total: 2 }); await fetch(url); }
  async createChatCompletion(req) { window.__llmReq.push(req); return { choices: [{ message: { content: JSON.stringify(window.__llmReplies.shift() || { say: 'うん', action: null }) } }] }; }
  async exit() {}
}`,
  tf: `export const env = { backends: { onnx: { wasm: {} } } };
export class Tensor { constructor(type, data, dims) { Object.assign(this, { type, data, dims }); } }
export async function pipeline(task, model, opts) {
  window.__asr = { task, model, device: opts.device, revision: opts.revision };
  opts.progress_callback?.({ status: 'progress', progress: 50, file: 'encoder_model.onnx' });
  await fetch('https://huggingface.co/' + model + '/resolve/main/config.json');
  return async (audio, o) => { window.__asrCalls.push({ n: audio.length, lang: o.language }); return { text: window.__heard.shift() || '' }; };
}
let n = 0;
export const AutoModel = { from_pretrained: async (id) => {
  await fetch('https://huggingface.co/' + id + '/resolve/main/onnx/model.onnx');
  return async ({ state }) => { n++; window.__vadCalls = n; return { output: { data: [n % 40 < 10 ? 0.9 : 0.05] }, stateN: state }; };
} };`,
};
const server = createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/favicon.ico') { res.writeHead(204); return res.end(); } // ブラウザが勝手に取りに行くだけ（アプリは使わない）
  if (p.startsWith('/vendor/')) {
    if (!/[?&]qa-import=1/.test(req.url)) vendorHits.push(p); // 検査がわざと読む（声の部品が読めるかの確認）ものは数えない
    if (fakeVendor && /web-llm/.test(p)) { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end(FAKE.llm); }
    if (fakeVendor && /wllama.*\.js$/.test(p)) { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end(FAKE.cpu); }
    if (fakeVendor && /transformers/.test(p)) { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end(FAKE.tf); }
  }
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
// ボード：ふだんはにせもの。LK_BOARD=<ボードの HTML> を付けると本物の写しで回す（データのリポジトリの CI・手元で。公開リポジトリには置かない）
const BOARD = readFileSync(process.env.LK_BOARD || resolve(root, 'qa/board.fixture.html'), 'utf8');
check(true, `ボード: ${process.env.LK_BOARD ? '本物の写し（LK_BOARD）' : 'にせもの（qa/board.fixture.html）'}`);
// ほかの端末で選んだ見た目（壁紙は「谷」）。この端末で開くと当たること
const files = {
  'local-board/settings.json': JSON.stringify({ updated: '2026-01-01T00:00:00Z', values: { 'kanban-wp': 'canyon', 'kanban-pal': 'std' }, at: { 'kanban-wp': '2026-01-01T00:00:00Z' } }),
  'board/today.json': JSON.stringify({ items: [{ title: '見本の予定', start: '2099-01-05T14:30:00+09:00' }] }),
};
let cardsText = null; // ほかの端末・Claude が書いたあとの cards.json（null なら見本のまま）
let conflictOnce = false;
let failPuts = false; // true のあいだ保存は失敗する（GitHub に届かない） // true にすると、次の cards.json の保存を 1 回だけ「ほかの端末が先に書いた」にする

const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
// 本物の SpeechRecognition.available()・install() は、CI の headless Chrome では音声の部品が無くタブごと落ちる
// （Target crashed。2026-10-20 に2回）。どのコンテキストでも「端末の中では日本語を聞けない端末」のふりにしておく。
// 各検査が自分のにせもの（addInitScript）を入れれば、あとから入るそちらが勝つ。
{
  const open = browser.newContext.bind(browser);
  browser.newContext = async (o) => {
    const c = await open(o);
    await c.addInitScript(() => {
      for (const k of ['SpeechRecognition', 'webkitSpeechRecognition']) {
        const C = window[k];
        if (C) { C.available = async () => 'unavailable'; C.install = async () => false; }
      }
      // 検査のブラウザは保存できる量（quota）が小さいので、空きのある端末のふりにする（空きが足りない場合は G の検査が自分で替える）
      try { navigator.storage.estimate = async () => ({ quota: 5e10, usage: 1e9 }); } catch { /* なくてよい */ }
    });
    return c;
  };
}
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
context.on('request', (r) => {
  const auth = r.headers().authorization || '';
  if (auth.includes(TOKEN) && new URL(r.url()).host !== 'api.github.com') leaks.push(r.url());
});
await context.route('https://api.github.com/**', async (route) => {
  const req = route.request();
  const path = new URL(req.url()).pathname.replace(/^.*\/contents\//, '');
  if (req.method() === 'GET') {
    if (path === 'local-board/cards.json') return route.fulfill({ json: { sha: 'sha-cards', content: Buffer.from(cardsText || sample).toString('base64') } });
    if (path === 'local-board/BOARD.md') return route.fulfill({ json: { sha: 'sha-md', content: Buffer.from('# board\n').toString('base64') } });
    if (path === 'board/index.html') return route.fulfill({ json: { sha: 'sha-board', content: Buffer.from(BOARD).toString('base64') } });
    if (files[path] != null) return route.fulfill({ json: { sha: 'sha-' + path, content: Buffer.from(files[path]).toString('base64') } });
    return route.fulfill({ status: 404, json: { message: 'Not Found' } });
  }
  if (req.method() === 'PUT') {
    const body = req.postDataJSON();
    if (failPuts) return route.fulfill({ status: 503, json: { message: 'unavailable' } });
    if (conflictOnce && path === 'local-board/cards.json') { conflictOnce = false; return route.fulfill({ status: 409, json: { message: 'conflict' } }); }
    if (path === 'local-board/settings.json' || path === 'local-board/pochi-memory.json') files[path] = Buffer.from(body.content, 'base64').toString('utf8');
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
  if (/status of (409|503)/.test(m.text())) return; // 保存がぶつかった・届かなかったときの検査でわざと返す
  if (/status of 404/.test(m.text()) && /pochi-memory\.json/.test(m.location()?.url || '')) return; // まだ何も覚えていない（初めは無いファイル）
  if (offline && /ERR_INTERNET_DISCONNECTED|Failed to fetch|Failed to load resource/.test(m.text())) return;
  errors.push(`console.error: ${m.text()}`);
});

// 保存は cards.json → BOARD.md の順に PUT される。前の保存の BOARD.md を取り違えないよう、cards.json の中身で待つ
const waitCards = async (pred, label) => {
  const t0 = Date.now();
  while (!pred(lastCards()) && Date.now() - t0 < 10000) await page.waitForTimeout(100);
  check(pred(lastCards()), `${label}が GitHub への保存（PUT）に届いた`);
};
const lastCards = () => JSON.parse([...puts].reverse().find((p) => p.path === 'local-board/cards.json')?.text || '[]');

const REAL = !!process.env.LK_BOARD;
const ready = (pg) => pg.waitForFunction(() => window.LK?.ready && document.querySelector('#board .card'), null, { timeout: 15000 });
try {
  await page.goto(base);
  await ready(page);
  // ボードの HTML を非公開の置き場から読み、端末に取っておいて、それを画面にした
  check(await page.evaluate(() => LKBoot.hasBoard && !!document.getElementById('wall') && typeof move === 'function' && typeof say === 'function'), 'ボードの HTML を読んで端末に取っておき、それを画面にした（壁紙・move・say がある）');
  check(await page.evaluate(() => document.title) === 'カンバン', '題は「カンバン」');
  const live = SAMPLE.filter((c) => !c.deleted);
  const inBoard = await page.evaluate(() => cards.filter((c) => !c.deleted).map((c) => c.id));
  check(inBoard.length === live.length && live.every((c) => inBoard.includes(c.doc_id)), `ボードに見本のカード ${live.length} 枚が渡った（${inBoard.length} 枚）`);
  check(!(await page.evaluate(() => cards.some((c) => c.title.includes('消したもの') && !c.deleted))), '消したカードは消したまま');
  check(await page.$$eval('#board .card', (e) => e.length) > 0, 'カードが画面に出た');

  // ---------- 壁紙と見た目（アプリにすると背景が消えた 2026-10-20） ----------
  const look = async (pg) => pg.evaluate(() => ({ wp: document.documentElement.classList.contains('wp'), bg: getComputedStyle(document.getElementById('wall')).backgroundImage, shown: getComputedStyle(document.getElementById('wall')).display !== 'none' }));
  let lk = await look(page);
  check(lk.wp && lk.shown && /bg\/canyon\.jpg/.test(lk.bg), `ほかの端末で選んだ壁紙（谷）が当たって出た（${lk.bg}）`);
  const loaded = await page.evaluate(() => new Promise((ok) => { const i = new Image(); i.onload = () => ok(i.naturalWidth > 0); i.onerror = () => ok(false); i.src = 'bg/canyon.jpg'; }));
  check(loaded, '壁紙の写真（bg/canyon.jpg）を読めた');
  const wpNames = await page.evaluate(() => (typeof WPS !== 'undefined' ? WPS.map((w) => (Array.isArray(w) ? w[0] : w.id || w.k || w)) : []).filter((n) => typeof n === 'string' && !/^(none|own)$/.test(n)));
  const noPhoto = wpNames.filter((n) => !existsSync(resolve(root, 'bg', n + '.jpg')) || !existsSync(resolve(root, 'bg/t', n + '.jpg')));
  check(wpNames.length > 0 && noPhoto.length === 0, `ボードで選べる壁紙の写真がすべて bg/ と bg/t/ にある（${wpNames.length} 枚${noPhoto.length ? '。無いもの: ' + noPhoto.join(', ') : ''}）`);

  if (!REAL) {
    // 見た目を変えると local-board/settings.json に保存する（スマホでも同じになる）
    await page.click('#lookBtn');
    await page.click('#look [data-wp=lake]');
    const t0 = Date.now();
    while (!puts.some((p) => p.path === 'local-board/settings.json') && Date.now() - t0 < 8000) await page.waitForTimeout(100);
    const sp = [...puts].reverse().find((p) => p.path === 'local-board/settings.json');
    const sv = sp ? JSON.parse(sp.text) : {};
    check(sv.values?.['kanban-wp'] === 'lake' && !!sv.at?.['kanban-wp'], `見た目を変えると local-board/settings.json に保存した（${sv.values?.['kanban-wp']}）`);
    check(!/qa-dummy-token|lk\.gh|"token"/.test(sp?.text || ''), '設定の保存に鍵を入れていない');
    lk = await look(page);
    check(/bg\/lake\.jpg/.test(lk.bg), 'この端末でもすぐ壁紙が変わった');

    // 「済み」を押す → 保存の中身を確かめる
    await page.locator('#lane-now .card', { hasText: '見本のカード（今やる）' }).locator('[data-a=done]').click();
    await waitCards((cs) => cs.some((c) => c.doc_id === 's1' && c.lane === 'done'), '「済み」');
    const c1 = lastCards().find((c) => c.doc_id === 's1');
    check(c1?.lane === 'done' && !!c1.done_at, '「済み」にしたカードが lane done・done_at 付きで保存された');
    check(c1?.moves?.at(-1)?.from === 'now' && c1?.moves?.at(-1)?.to === 'done', '列の移動（moves）が記録された');
    check(c1?.local_edit === true, 'ローカルで直した印（local_edit）が付いた');
    check(puts.find((p) => p.path === 'local-board/cards.json')?.body?.sha === 'sha-cards', '読んだときの sha を付けて保存した（上書きの事故を防ぐ）');
    check(lastCards().some((c) => c.doc_id === 's6' && c.deleted), '消したカードの行は保存でも残る');
    check(lastCards().every((c) => !('id' in c) && c.doc_id), '保存の形は cards.json のまま（doc_id。ボードの id を混ぜない）');
    // ボードの「戻す」
    check(await page.isVisible('#toast-undo'), '済みにすると「戻す」が出る');
    await page.click('#toast-undo');
    await waitCards((cs) => cs.find((c) => c.doc_id === 's1')?.lane === 'now', 'ボードの「戻す」');

    // 確認のカードに答える（Claude に届けられないので「local」で残す。Claude が戻ったら届ける）
    await page.locator('#board .card', { hasText: '見本の確認' }).locator('[data-a=ans][data-i="0"]').click();
    await waitCards((cs) => cs.some((c) => c.doc_id === 's2' && c.answer), '確認への答え');
    const c2 = lastCards().find((c) => c.doc_id === 's2');
    check(c2?.answer === 'はい' && c2?.answer_status === 'local', `答えは answer_status「local」で保存された（${c2?.answer_status}。取り込みで Claude に届ける印）`);
    check(c2?.lane === 'agent' && c2?.owner === 'agent', '答えたカードはエージェントの番');

    // ボードの「＋ 頼む・足す」で足す
    await page.click('#compose-btn');
    await page.fill('#ask', 'QA で足したカード');
    await page.click('#add');
    await waitCards((cs) => cs.some((c) => c.title === 'QA で足したカード'), 'カードの追加');
    const added = lastCards().find((c) => c.title === 'QA で足したカード');
    check(/^local-/.test(added?.doc_id || '') && !('no' in added), '足したカードは local- の ID で、番号（no）は付けない（Claude が取り込むときに振る）');
    check(puts.some((p) => p.path === 'local-board/BOARD.md'), 'BOARD.md も保存した');

    // ほかの端末が先に保存していた（409）→ 読み直して、まだ保存していない変更をかけ直す
    await page.waitForTimeout(1500);
    conflictOnce = true;
    await page.evaluate(() => move('s3', 'hold'));
    await waitCards((cs) => cs.find((c) => c.doc_id === 's3')?.lane === 'hold', 'ぶつかった保存のかけ直し');
    await page.waitForFunction(() => /合わせて保存/.test(document.querySelector('#lkStatus').textContent), null, { timeout: 5000 }).catch(() => {});
    check(!conflictOnce && /合わせて保存/.test(await page.textContent('#lkStatus')), `保存がぶつかったら読み直してかけ直した（${await page.textContent('#lkStatus')}）`);
    await page.evaluate(() => move('s3', 'next'));
    await waitCards((cs) => cs.find((c) => c.doc_id === 's3')?.lane === 'next', '元に戻す');

    // 今日の予定（board/today.json）がボードに渡る
    check(/予定 1 件/.test(await page.textContent('#agenda')), '今日の予定（board/today.json）をボードに渡した');

    // オフラインで直してアプリを閉じても、次に開いたときに保存する（変更を端末に残す）
    {
      const pg = await context.newPage();
      pg.on('pageerror', (e) => errors.push(`pageerror(オフラインで閉じる): ${e.message}`));
      await pg.goto(base); await ready(pg);
      failPuts = true;
      await pg.evaluate(() => move('s3', 'later'));
      await pg.waitForTimeout(2000);
      check(await pg.evaluate(() => JSON.parse(localStorage.getItem('lk.pending') || 'null')?.ops?.length > 0), 'オフラインでまだ送れない変更を端末に残した');
      await pg.waitForTimeout(1100);
      const un = (await pg.isVisible('#lkUnsent')) ? await pg.textContent('#lkUnsent') : '';
      check(/未送信 1件/.test(un), `まだ送れない変更の数を画面に出す（${un || 'なし'}）`);
      await pg.close();
      failPuts = false;
      const pg2 = await context.newPage();
      pg2.on('pageerror', (e) => errors.push(`pageerror(開き直し): ${e.message}`));
      await pg2.goto(base); await ready(pg2);
      await waitCards((cs) => cs.find((c) => c.doc_id === 's3')?.lane === 'later', '閉じる前に送れなかった変更（開き直したとき）');
      await pg2.waitForTimeout(500);
      check(await pg2.evaluate(() => !localStorage.getItem('lk.pending')), '送れたら端末の控えを消した');
      await pg2.evaluate(() => move('s3', 'next'));
      await waitCards((cs) => cs.find((c) => c.doc_id === 's3')?.lane === 'next', '元に戻す');
      await pg2.close();
    }

    // 知らせ（通知）：確認が来た・satouさんの番に戻った・今日が期限。アプリの中で作り、外へは送らない
    {
      const pg = await context.newPage();
      pg.on('pageerror', (e) => errors.push(`pageerror(知らせ): ${e.message}`));
      // 通知はにせものに差し替える（CI のヘッドレスのブラウザは通知を許可できないため。見るのは「いつ・何を知らせるか」）
      await pg.addInitScript(() => {
        window.__notes = [];
        const push = (t, o) => window.__notes.push(t + '｜' + o.body);
        ServiceWorkerRegistration.prototype.showNotification = function (t, o) { push(t, o); return Promise.resolve(); };
        window.Notification = class { static permission = 'default'; static requestPermission() { this.permission = 'granted'; return Promise.resolve('granted'); } constructor(t, o) { push(t, o); } };
      });
      await pg.goto(base); await ready(pg);
      await pg.click('#lkMenu summary'); await pg.click('#lkMenu [data-m=notify]');
      check(await pg.evaluate(() => JSON.parse(localStorage.getItem('lk.notify'))) === true && /止める/.test(await pg.textContent('#lkMenu [data-m=notify]')), '「🔔 知らせを受け取る」で通知を許可して入にした');
      await pg.waitForTimeout(300);
      check(await pg.evaluate(() => window.__notes.length) === 0, '入にしたときは、今あるカードでいっぺんに鳴らさない');
      const t = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
      const after = JSON.parse(sample).map((c) => (c.doc_id === 's4' ? { ...c, owner: 'you', lane: 'now', moves: [{ at: '2099-01-01T00:00:00Z', from: 'agent', to: 'now' }] } : c));
      after.push({ doc_id: 's8', title: '見本の新しい確認', owner: 'you', lane: 'now', decision: { question: '見本の新しい問い', options: [{ label: 'はい', consequence: '' }] } });
      after.push({ doc_id: 's9', title: '見本の今日が期限', owner: 'you', lane: 'next', due: t });
      cardsText = JSON.stringify(after);
      await pg.evaluate(() => LK.reload());
      await pg.waitForTimeout(500);
      const notes = await pg.evaluate(() => window.__notes);;
      check(notes.some((n) => /確認が来ました｜見本の新しい問い/.test(n)), `確認が来たら知らせた（${notes.join(' / ') || 'なし'}）`);
      check(notes.some((n) => /satouさんの番になりました｜見本のカード（エージェント）/.test(n)), 'エージェントから satouさんの番に戻ったら知らせた');
      check(notes.some((n) => /今日が期限です｜見本の今日が期限/.test(n)), '今日が期限のカードを知らせた');
      const n1 = notes.length;
      await pg.evaluate(() => LK.reload()); await pg.waitForTimeout(300);
      check(await pg.evaluate(() => window.__notes.length) === n1, '同じことは二度知らせない');
      cardsText = null;
      await pg.evaluate(() => { localStorage.setItem('lk.notify', 'false'); localStorage.removeItem('lk.notified'); });
      await pg.close();
    }

    // 画面に戻ったら（1分以上たっていたら）読み直す
    check(/visibilitychange/.test(readFileSync(resolve(root, 'shim.js'), 'utf8')), '画面に戻ったら読み直す仕組みがある');
  }
  // 声の命令の読み取り（voice.js）
  const parsed = await page.evaluate(() => {
    const L = [['now', '今やる', '今'], ['next', '次にやる', '次'], ['later', '時間があるとき', 'あとで'], ['hold', '保留'], ['agent', 'エージェント'], ['done', '済み']];
    return ['牛乳を買うを追加', '牛乳を買うを今やるに追加', '今やるに牛乳を買うを追加', '請求書を済み', '請求書を保留へ', '今やるを読んで', '戻す', '請求書を消して', '2番', 'はい', 'ほにゃらら',
      '今やることは', '請求書はどうなった', '請求書の状況を教えて']
      .map((t) => JSON.stringify(Voice.parse(t, L)));
  });
  const want = ['{"type":"add","title":"牛乳を買う","lane":null}', '{"type":"add","title":"牛乳を買う","lane":"now"}', '{"type":"add","title":"牛乳を買う","lane":"now"}',
    '{"type":"done","query":"請求書"}', '{"type":"move","query":"請求書","lane":"hold"}', '{"type":"read","lane":"now"}', '{"type":"undo"}',
    '{"type":"delete","query":"請求書"}', '{"type":"pick","n":2}', '{"type":"yes"}', '{"type":"unknown","text":"ほにゃらら"}',
    '{"type":"read","lane":"now"}', '{"type":"status","query":"請求書"}', '{"type":"status","query":"請求書"}'];
  parsed.forEach((p, i) => check(p === want[i], `声の文型 ${i + 1}: ${want[i]}（${p}）`));

  // Ctrl+K で会話の欄に打って列を移す（命令も会話も同じ欄。2026-10-20 入口を一つにした）
  const cmd = async (t) => { await page.keyboard.press('Control+k'); await page.fill('#talkIn', t); await page.press('#talkIn', 'Enter'); };
  await cmd('見本のカード（次にやる・毎週）を保留へ');
  await waitCards((cs) => cs.find((c) => c.doc_id === 's3')?.lane === 'hold', 'Ctrl+K の「〇〇を保留へ」');
  check(lastCards().find((c) => c.doc_id === 's3')?.lane === 'hold', 'Ctrl+K の命令でカードが保留に移った');
  check(await page.evaluate(() => document.querySelector('#talkDlg').open && !document.querySelector('#cmdDlg')), 'Ctrl+K は会話と同じ欄を開く（命令だけの欄は無い）');
  await page.waitForFunction(() => /保留にしたよ/.test(document.querySelector('#talkLog').textContent), null, { timeout: 3000 }).catch(() => {});
  check(/保留にしたよ/.test(await page.textContent('#talkLog')), `打った命令の結果をポチが一言で返す（${(await page.textContent('#talkLog')).slice(-60)}）`);
  check((lastCards().find((c) => c.doc_id === 's3')?.history || []).some((h) => h.who === 'ポチ' && /保留/.test(h.text)), '会話で動かしたカードの履歴に「ポチ」と残る');
  // 消すのも聞き返さずにすぐやり、一言で知らせる → 戻す で戻る（2026-10-20 satouさん「AI に任せる」）
  await page.waitForTimeout(1500);
  await cmd('見本のカード（エージェント）を消して');
  await waitCards((cs) => cs.find((c) => c.doc_id === 's4')?.deleted === true, '「消して」');
  check(lastCards().find((c) => c.doc_id === 's4')?.deleted === true, '「消して」は聞き返さずに消す（行は残る）');
  await page.waitForFunction(() => /消したよ/.test(document.querySelector('#talkLog').textContent), null, { timeout: 3000 }).catch(() => {});
  check(/消したよ/.test(await page.textContent('#talkLog')) && !/消していい|消しますか/.test(await page.textContent('#talkLog')), '消したら確認ではなく「消したよ」と一言で知らせる');
  await page.waitForTimeout(1500);
  await cmd('戻す');
  await waitCards((cs) => !cs.find((c) => c.doc_id === 's4')?.deleted, '「戻す」');
  check(!lastCards().find((c) => c.doc_id === 's4')?.deleted, '「戻す」で消す前に戻った');

  // 様子を聞く・動かしたあとの「戻す」・見つからないときの候補（2026-10-20 音声スレッドの依頼）
  await page.waitForTimeout(1500);
  await cmd('見本のカード（エージェント）はどうなった');
  await page.waitForTimeout(300);
  const st = await page.textContent('#toast-msg');
  check(/「見本のカード（エージェント）」はエージェント/.test(st) && /進めています/.test(st), `「〇〇はどうなった」で列と今の段を答える（${st}）`);
  await cmd('見本のカード（次にやる・毎週）を今やるへ');
  await waitCards((cs) => cs.find((c) => c.doc_id === 's3')?.lane === 'now', '命令で今やるへ');
  check(await page.isVisible('#talkLog .undo'), '命令で動かしたら、会話の返事に「戻す」を出す');
  await page.click('#talkLog .undo >> nth=-1');
  await waitCards((cs) => cs.find((c) => c.doc_id === 's3')?.lane === 'hold', '「戻す」を押す');
  check(lastCards().find((c) => c.doc_id === 's3')?.lane === 'hold', '「戻す」を押すと前の列に戻る');
  await page.waitForTimeout(1500);
  await cmd('見本のカアド毎週を済み');
  await page.waitForTimeout(300);
  const pick = await page.$$eval('#lkPick:not([hidden]) [data-pick]', (bs) => bs.map((b) => b.textContent));
  check(pick.length >= 2 && pick.some((t) => /毎週/.test(t)), `見つからないときは近い候補を押せる形で出す（${pick.join(' / ')}）`);
  await page.click('#lkPick [data-pick="0"]');
  await page.waitForTimeout(300);
  check(await page.isHidden('#lkPick') && /やめました/.test(await page.textContent('#toast-msg')), '候補の「やめる」を押すと、何もせず候補を閉じる');

  // URL（#add=）と共有メニュー（?title=&url=）から足す
  const viaUrl = async (u, label, test) => {
    const pg = await context.newPage();
    pg.on('pageerror', (e) => errors.push(`pageerror(${label}): ${e.message}`));
    const n = puts.length;
    await pg.goto(base + u);
    const t0 = Date.now();
    while (!puts.slice(n).some((p) => p.path === 'local-board/cards.json') && Date.now() - t0 < 10000) await pg.waitForTimeout(100);
    const saved = JSON.parse(puts.slice(n).find((p) => p.path === 'local-board/cards.json')?.text || '[]');
    check(saved.some(test), `${label}からカードを足した`);
    check(!(await pg.evaluate(() => location.search + location.hash)), `${label}のあと URL から命令を消した（開き直しで二重にならない）`);
    await pg.close();
  };
  await viaUrl('#add=' + encodeURIComponent('URL で足したカード') + '&lane=now&due=2026-12-01', 'URL（#add=）', (c) => c.title === 'URL で足したカード' && c.lane === 'now' && c.due === '2026-12-01');
  await viaUrl('?title=' + encodeURIComponent('共有された記事') + '&url=' + encodeURIComponent('https://example.com/a'), '共有メニュー（?title=&url=）', (c) => c.title === '共有された記事' && c.link === 'https://example.com/a');

  // 音声認識が無いブラウザ（Edge・Firefox）では🎤で案内を出す
  const noVoice = await context.newPage();
  await noVoice.addInitScript(() => { delete window.SpeechRecognition; delete window.webkitSpeechRecognition; });
  noVoice.on('pageerror', (e) => errors.push(`pageerror(音声認識なし): ${e.message}`));
  await noVoice.goto(base);
  await ready(noVoice);
  await noVoice.click('#micBtn');
  check(/使えません/.test(await noVoice.textContent('#vstatus')), `音声認識が無いと🎤で「使えない」と AI の部品の場所を出す（${await noVoice.textContent('#vstatus')}）`);
  check(/🎤は/.test(await noVoice.textContent('#talkWhy')), '音声認識が無い理由を上に一言出す');
  check(!(await noVoice.evaluate(() => window.__boardMic)), 'ボードの🎤ではなくアプリの🎤（端末の中の AI の耳も使える）が動いた');
  await noVoice.close();
  // 端末の中で聞き取れないブラウザ（サーバーへ送る音声認識しか無い）では聞き取りを始めない（プライベートな内容を外に出さない）
  const serverOnly = await context.newPage();
  await serverOnly.addInitScript(() => { class SR { start() { window.__started = true; } } window.webkitSpeechRecognition = SR; delete window.SpeechRecognition; });
  serverOnly.on('pageerror', (e) => errors.push(`pageerror(サーバー版だけ): ${e.message}`));
  await serverOnly.goto(base);
  await ready(serverOnly);
  await serverOnly.waitForTimeout(300);
  await serverOnly.click('#micBtn'); await serverOnly.waitForTimeout(200);
  await serverOnly.keyboard.press('m'); await serverOnly.waitForTimeout(200);
  check(!(await serverOnly.evaluate(() => window.__started)), 'サーバーに送る音声認識しか無いと、🎤でも M キーでも聞き取りを始めない（声を外に出さない）');
  await serverOnly.close();

  // 🎤：音声認識をにせものに差し替えて、聞き取り → 命令 → 読み上げ の流れを確かめる（候補が複数なら番号で選ぶ）
  const mic = await context.newPage();
  mic.on('pageerror', (e) => errors.push(`pageerror(🎤): ${e.message}`));
  await mic.addInitScript(() => {
    window.__heard = ['見本のカードを済み', '2番']; window.__spoken = [];
    class FakeSR {
      static available(o) { return Promise.resolve(o?.processLocally ? 'available' : 'available'); }
      start() { window.__local = this.processLocally === true; const t = window.__heard.shift(); setTimeout(() => { if (t) this.onresult({ results: [[{ transcript: t }]] }); this.onend(); }, 50); }
    }
    window.webkitSpeechRecognition = FakeSR; delete window.SpeechRecognition;
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new Error('検査ではマイクを使わない'));
    window.speechSynthesis.getVoices = () => [{ name: 'ネットの声', lang: 'ja-JP', localService: false }, { name: '端末の声', lang: 'ja-JP', localService: true }];
    window.speechSynthesis.speak = (u) => { window.__spoken.push(u.text); setTimeout(() => u.onend && u.onend(), 10); };
  });
  const b6 = puts.length;
  await mic.goto(base);
  await ready(mic);
  await mic.click('#micBtn');
  const t6 = Date.now();
  while (!puts.slice(b6).some((p) => p.path === 'local-board/cards.json') && Date.now() - t6 < 12000) await mic.waitForTimeout(100);
  const spoken = await mic.evaluate(() => window.__spoken);
  check(/候補が.*何番/.test(spoken.join('')), `🎤 候補が複数のときは読み上げて番号を聞く（${spoken[0] || 'なし'}）`);
  const saved6 = JSON.parse(puts.slice(b6).find((p) => p.path === 'local-board/cards.json')?.text || '[]');
  const picked = saved6.filter((c) => c.lane === 'done' && c.moves?.at(-1)?.to === 'done' && c.moves?.at(-1)?.from !== null && c.doc_id !== 's5');
  check(picked.length === 1, `🎤「2番」で選んだカードが済みになった（${picked.map((c) => c.title).join('・') || 'なし'}）`);
  await mic.waitForFunction(() => window.__spoken.some((t) => /済みにした/.test(t)), null, { timeout: 3000 }).catch(() => {});
  check((await mic.evaluate(() => window.__spoken)).some((t) => /済みにした/.test(t)), '🎤 結果を読み上げた');
  check(await mic.evaluate(() => document.querySelector('#talkDlg').open && [...document.querySelectorAll('#talkLog .you')].map((d) => d.textContent).join('|') === '見本のカードを済み|2番'), '🎤 ボードの🎤も会話と同じ欄を開き、話したことを文字で同じ流れに残す');
  check(await mic.evaluate(() => Voice.localVoice()?.name === '端末の声'), '🎤 読み上げは端末の中の声を選ぶ（ネット経由の声は使わない）');
  check(await mic.evaluate(() => { const g = speechSynthesis.getVoices; speechSynthesis.getVoices = () => [{ name: 'ネットの声', lang: 'ja-JP', localService: false }]; const n = Voice.localVoice(); speechSynthesis.getVoices = g; return n === null; }), '🎤 端末の中の声が無ければ読み上げない');
  check(await mic.evaluate(() => window.__local), '🎤 端末の中だけで聞き取る設定（processLocally = true）で聞いた');
  // 声のなめらかさ：文ごとに止めない・読みにくい記号を除く・よい声を先に選ぶ・速さと高さ
  const flow = await mic.evaluate(async () => {
    const got = [], cancels = [];
    const sp = speechSynthesis.speak, cn = speechSynthesis.cancel, gv = speechSynthesis.getVoices;
    speechSynthesis.cancel = () => cancels.push(got.length);
    speechSynthesis.speak = (u) => { got.push({ text: u.text, rate: u.rate, pitch: u.pitch }); setTimeout(() => u.onend && u.onend(), 5); };
    localStorage.setItem('voice.rate', '1.2'); localStorage.setItem('voice.pitch', '0.9');
    const r = await Voice.speakAll('はい。済みにしたよ🎉 次は「見本のカード」（今やる）だね…。期限は3〜5日。');
    speechSynthesis.getVoices = () => [{ name: 'A', lang: 'ja-JP', localService: true }, { name: 'B (Enhanced)', lang: 'ja-JP', localService: true }, { name: 'C Natural', lang: 'ja-JP', localService: false }];
    const best = Voice.localVoice()?.name;
    localStorage.setItem('voice.name', 'A'); const chosen = Voice.localVoice()?.name; localStorage.removeItem('voice.name');
    localStorage.removeItem('voice.rate'); localStorage.removeItem('voice.pitch');
    speechSynthesis.speak = sp; speechSynthesis.cancel = cn; speechSynthesis.getVoices = gv;
    return { r, got, cancels, best, chosen, long: Voice.chunks('あ'.repeat(70) + '。' + 'い'.repeat(70) + '。').length };
  });
  check(flow.r === true && flow.got.length === 1 && flow.cancels.length === 1 && flow.cancels[0] === 0, `🔊 短い文はつなげて1度に読む・止めるのは最初の1回だけ（${flow.got.length} 回・cancel ${flow.cancels.length} 回）`);
  check(!/[🎉…〜（）]/u.test(flow.got.map((x) => x.text).join('')) && /3から5/.test(flow.got[0]?.text || ''), `🔊 絵文字・「…」・かっこを読まない・「3〜5」は「3から5」（${flow.got[0]?.text}）`);
  check(Math.abs(flow.got[0]?.rate - 1.2) < 1e-3 && Math.abs(flow.got[0]?.pitch - 0.9) < 1e-3, '🔊 決めた速さと高さで読む');
  check(flow.best === 'B (Enhanced)' && flow.chosen === 'A', `🔊 端末の中の声のうち、なめらかな声（Enhanced など）を先に選ぶ・選んだ声があればそれ（${flow.best}・${flow.chosen}）`);
  check(flow.long === 2, '🔊 長い文は分けて読む（Chrome が途中で止めないように）');
  // 気持ちで話し分ける声（koe.js）：入れていれば表情の気持ちで話す・だめなら端末の声・部品は読み込めて取得元は固定
  const koe = await mic.evaluate(async () => {
    const got = [], said = [];
    const kr = Koe.ready, ks = Koe.speak, sp = speechSynthesis.speak, cn = speechSynthesis.cancel;
    speechSynthesis.cancel = () => {};
    speechSynthesis.speak = (u) => { said.push(u.text); setTimeout(() => u.onend && u.onend(), 5); };
    Koe.ready = () => true;
    Koe.speak = async (parts, o) => { got.push({ parts, mood: o.mood }); return true; };
    Voice.mood = 'happy'; await Voice.speakAll('やったね！済みにしたよ。');
    Koe.speak = async () => { throw new Error('GPU が止まった'); };
    await Voice.speakAll('だめでも話す。');
    Koe.speak = () => new Promise((_, no) => setTimeout(() => no(new Error('止めた後に失敗')), 20));
    const late = Voice.speakAll('止めたら話さない。'); Voice.stop(); await late;
    Koe.ready = kr; Koe.speak = ks; speechSynthesis.speak = sp; speechSynthesis.cancel = cn; Voice.mood = 'normal';
    const lib = await import('./vendor/karume-models-0.14.0/sbv2.js?qa-import=1');
    return { got, said, styles: [...new Set(Object.values(Koe.STYLE))].sort(), lib: ['Sbv2Pipeline', 'toSbv2Utterance', 'analyzeWithWords', 'getDictionary'].every((k) => typeof lib[k] === 'function'), rev: lib.SBV2_SOURCES['sbv2-jvnv'], installed: Koe.status().installed, credit: Koe.CREDIT };
  });
  check(koe.got.length === 1 && koe.got[0].mood === 'happy', `🎭 入れた声では、ポチの表情（うれしい）の気持ちで話す（${JSON.stringify(koe.got[0]?.mood)}）`);
  check(koe.said.some((t) => /だめでも話す/.test(t)), '🎭 入れた声が動かないときは、端末の声で話す');
  check(!koe.said.some((t) => /止めたら話さない/.test(t)), '🎭 止めた後に入れた声が失敗しても、端末の声で話し出さない');
  check(koe.styles.join() === 'Angry,Disgust,Fear,Happy,Neutral,Sad,Surprise', `🎭 7つの気持ちを全部使える（${koe.styles.join('・')}）`);
  check(koe.lib && /^[0-9a-f]{40}$/.test(koe.rev?.revision || '') && koe.rev?.repo === 'hdae/karume-sbv2-jvnv', '🎭 声の部品（vendor）が読み込め、モデルの取得元はコミットで固定');
  check(koe.installed === '', '🎭 声のモデルは押すまで入れない（PC でも勝手に取らない）');
  check(/CC BY-SA 4\.0/.test(koe.credit) && /Takamichi/.test(koe.credit) && /litagin/.test(koe.credit), '🎭 クレジット（CC BY-SA 4.0・JVNV の作者・元のモデル）を出す');
  await mic.close();

  // ---------- 会話モード（talk.js）：耳・頭・口をにせものに差し替えて、流れと「外に出さない」を確かめる ----------
  const talkPage = async ({ heard = [], replies = null, sr = true }, label) => {
    const pg = await context.newPage();
    pg.on('pageerror', (e) => errors.push(`pageerror(${label}): ${e.message}`));
    const outside = [];
    pg.on('request', (r) => { const h = new URL(r.url()).host; if (!/^127\.0\.0\.1(:\d+)?$/.test(h) && h !== 'api.github.com' && !r.url().startsWith('data:')) outside.push(r.url()); });
    await pg.addInitScript(({ heard, replies, sr }) => {
      window.__heard = heard; window.__spoken = []; window.__prompts = []; window.__system = '';
      if (sr) {
        class FakeSR {
          static available() { return Promise.resolve('available'); }
          start() { const t = window.__heard.shift(); setTimeout(() => { if (t) this.onresult({ results: [[{ transcript: t }]] }); this.onend(); }, t ? 80 : 400); }
        }
        window.webkitSpeechRecognition = FakeSR;
      } else delete window.webkitSpeechRecognition;
      delete window.SpeechRecognition;
      window.speechSynthesis.getVoices = () => [{ name: '端末の声', lang: 'ja-JP', localService: true }];
      window.__boundaries = [];
      window.speechSynthesis.speak = (u) => { window.__spoken.push(u.text); setTimeout(() => { u.onboundary?.({ charIndex: 2 }); u.onend?.(); }, 5); };
      window.speechSynthesis.cancel = () => {};
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new Error('検査ではマイクを使わない'));
      if (replies) {
        window.LanguageModel = {
          availability: () => Promise.resolve('available'),
          create: (o) => { window.__system = JSON.stringify(o.initialPrompts); return Promise.resolve({ prompt: (t) => { window.__prompts.push(t); return Promise.resolve(JSON.stringify(replies.shift() || { say: 'うん', action: null })); }, destroy() {} }); },
        };
      } else delete window.LanguageModel;
    }, { heard, replies, sr });
    await pg.goto(base);
    await ready(pg);
    return { pg, outside };
  };
  const waitTalkEnd = async (pg) => { const t0 = Date.now(); while (Date.now() - t0 < 15000 && (await pg.evaluate(() => document.querySelector('#talkDlg').open))) await pg.waitForTimeout(100); };

  // A. AI なし：1枚ずつ読み上げ、「済み」「あとで」で動かし、「終わり」で閉じる
  {
    const { pg, outside } = await talkPage({ heard: ['済み', 'あとで', '終わり'] }, '会話 AI なし');
    await pg.evaluate(() => {
      window.__moods = []; window.__confetti = 0;
      addEventListener('voice:boundary', (e) => window.__boundaries.push(e.detail?.at));
      new MutationObserver(() => window.__moods.push(document.querySelector('#talkDlg').dataset.mood)).observe(document.querySelector('#talkDlg'), { attributes: true, attributeFilter: ['data-mood'] });
      new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach((n) => { if (n.classList?.contains('confetti')) window.__confetti++; }))).observe(document.querySelector('#talkAva'), { childList: true });
    });
    await pg.click('#talkBtn');
    await waitTalkEnd(pg);
    const spoken = await pg.evaluate(() => window.__spoken.join(''));
    check(/見本のカード、?今やる/.test(spoken), '会話（AI なし）：最初に「今やる」の1枚目を読み上げた');
    check(/AI なし/.test(await pg.textContent('#talkMode')), '会話（AI なし）：内蔵 AI が無い端末では AI なしで動く');
    check(/AI を入れると/.test(await pg.textContent('#talkLog')), '会話（AI なし）：AI なしで話していることと、AI を入れられることを伝えた');
    const phr = await pg.evaluate(() => Talk.PHRASES.done);
    check(phr.some((p) => spoken.includes(p)), '会話（AI なし）：「済み」でほめた');
    const moods = await pg.evaluate(() => ({ m: window.__moods, c: window.__confetti }));
    check(moods.m.includes('happy') && moods.m.includes('listen') && moods.c > 0, `キャラの見た目：聞くときは耳を動かし、済みにしたら笑顔と紙吹雪（${[...new Set(moods.m)].join(',')}・紙吹雪 ${moods.c}）`);
    check(await pg.evaluate(() => document.querySelector('#talkDlg').dataset.sync === '1' && window.__boundaries.includes(2)), '会話：読み上げの言葉の区切りで口を合わせた');
    await waitCards((cs) => cs.find((c) => c.doc_id === 's1')?.lane === 'done' && cs.find((c) => c.doc_id === 's2')?.lane === 'later', '会話（AI なし）の「済み」「あとで」');
    check(!(await pg.evaluate(() => document.querySelector('#talkDlg').open)), '会話（AI なし）：「終わり」で閉じた');
    check(outside.length === 0, `会話（AI なし）：自分のサイトと GitHub 以外へ通信していない${outside.length ? '（' + outside.join(', ') + '）' : ''}`);
    await pg.close();
  }

  // B. 端末の中の AI（Prompt API）：JSON の命令でカードを動かす。消すのは本人が「消して」と言ったときだけ（聞き返さない）。AI に補足を渡さない
  {
    const { pg, outside } = await talkPage({
      heard: ['毎週のやつ保留にしといて', 'エージェントのやつ消して', 'そういえば今やるのやつ', '終わり'],
      replies: [
        { say: 'オッケー、保留にしたよ', action: { type: 'move', query: '見本のカード（次にやる・毎週）', lane: 'hold' } },
        { say: '消すね', action: { type: 'delete', query: '見本のカード（エージェント）' } },
        { say: 'うん', action: { type: 'delete', query: '見本のカード（今やる）' } },
      ],
    }, '会話 AI');
    await pg.evaluate(() => LK.memory.put({ id: 'qa-note', kind: 'note', text: '見本の覚えたこと' }));
    await pg.click('#talkBtn');
    await waitTalkEnd(pg);
    check(/内蔵 AI/.test(await pg.textContent('#talkMode')), '会話（AI）：内蔵 AI があれば使う');
    await waitCards((cs) => cs.find((c) => c.doc_id === 's3')?.lane === 'hold' && cs.find((c) => c.doc_id === 's4')?.deleted === true, '会話（AI）の「保留」と「消す」');
    const spoken = await pg.evaluate(() => window.__spoken.join(''));
    check(!/消しますか|消していい/.test(spoken) && /見本のカード（エージェント）/.test(await pg.textContent('#talkLog')), '会話（AI）：「消して」は聞き返さずに消し、どのカードを消したか一言添えた');
    check(!lastCards().find((c) => c.doc_id === 's1')?.deleted, '会話（AI）：本人が「消して」と言っていないのに AI が消そうとしても消さない');
    const prompts = await pg.evaluate(() => window.__prompts.join('\n'));
    check(prompts.includes('見本のカード（次にやる・毎週）') && !prompts.includes('見本の補足'), '会話（AI）：AI に渡すのは題・列・期限だけ（補足は渡さない）');
    check(/（明日まで|（期限すぎ|（\d+月\d+日まで/.test(prompts) && !/期限 20\d\d-/.test(prompts), '会話（AI）：期限は日付ではなく言葉で渡す');
    const sys = await pg.evaluate(() => window.__system);
    check(/ポチ/.test(sys) && /タメ口/.test(sys), '会話（AI）：キャラの名前と性格を AI への指示に入れた');
    check(/"role":"assistant"/.test(sys) && /話し言葉/.test(sys), '会話（AI）：指示に話し方と返事の見本（few-shot）を入れた');
    check(/覚えていること/.test(sys) && /見本の覚えたこと/.test(sys), '会話（AI）：ポチが覚えたことを AI への指示に入れた');
    await pg.evaluate(() => LK.memory.forget('qa-note'));
    check(/🧠/.test(await pg.textContent('#talkMode')) && await pg.isHidden('#talkAiGet'), '会話（AI）：AI と話していることを会話の画面に出す');
    check(outside.length === 0, `会話（AI）：自分のサイトと GitHub 以外へ通信していない${outside.length ? '（' + outside.join(', ') + '）' : ''}`);
    await pg.close();
  }

  // 会話の言い回し：同じ文を続けて言わない・時間帯・期限の言い方・古い会話のまとめ
  {
    const pg = await context.newPage();
    await pg.goto(base);
    await ready(pg);
    const r = await pg.evaluate(() => {
      const pick = Talk.picker();
      const seq = Array.from({ length: 40 }, () => pick('again', Talk.PHRASES.again));
      const kinds = Object.entries(Talk.PHRASES).filter(([k, v]) => Array.isArray(v) && v.length < 2).map(([k]) => k);
      const greet = Object.values(Talk.PHRASES.greet).filter((v) => v.length < 2).length;
      const t = new Date(2026, 9, 20);
      const msgs = LocalAI.messages({ system: 'S', examples: [['u', 'a']], summary: 'まとめ', past: Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: String(i) })), text: 'いま' });
      return {
        repeat: seq.some((x, i) => i && x === seq[i - 1]), distinct: new Set(seq).size, kinds, greet,
        day: [3, 7, 13, 19, 23].map((h) => Talk.partOfDay(h)).join(','),
        due: [Talk.dueWords('2026-10-19', t), Talk.dueWords('2026-10-20', t), Talk.dueWords('2026-10-21', t), Talk.dueWords('2026-11-02', t)].join('|'),
        sys: msgs[0].content, n: msgs.length, first: msgs[3]?.content, last: msgs.at(-1).content, keep: LocalAI.KEEP,
      };
    });
    check(!r.repeat && r.distinct >= 2, '会話（AI なし）：同じ言い回しを続けて言わない');
    check(r.kinds.length === 0 && r.greet === 0, `会話（AI なし）：どの返事にも言い回しが2つ以上ある${r.kinds.length ? '（' + r.kinds.join(',') + '）' : ''}`);
    check(r.day === 'night,morning,day,evening,night', `会話：時間帯であいさつを変える（${r.day}）`);
    check(r.due === '期限すぎてるよ。|今日が期限だよ。|明日が期限。|期限は11月2日。', `会話：期限の言い方（${r.due}）`);
    check(/まとめ/.test(r.sys) && r.n === 1 + 2 + r.keep * 2 + 1 && r.first === String(40 - r.keep * 2) && r.last === 'いま', `会話（入れた AI）：覚えるのは直近 ${r.keep} 往復で、古い分はまとめにして渡す`);
    await pg.close();
  }

  // ポチが覚える：呼び方・「覚えて」・設定の画面で忘れる・次の会話で呼び方を使う・言い直しを覚える
  {
    const { pg, outside } = await talkPage({ sr: false }, '覚える');
    await pg.click('#talkBtn');
    await pg.waitForFunction(() => /打って/.test(document.querySelector('#talkState').textContent), null, { timeout: 10000 });
    const type = async (t) => { await pg.fill('#talkIn', t); await pg.press('#talkIn', 'Enter'); await pg.waitForTimeout(150); };
    await type('ポテトって呼んで');
    await type('見本の豆知識って覚えて');
    await pg.waitForTimeout(1600);
    const saved = JSON.parse(files['local-board/pochi-memory.json'] || '{"items":[]}');
    check(saved.items.some((i) => i.kind === 'name' && i.text === 'ポテト') && saved.items.some((i) => i.kind === 'note' && /見本の豆知識/.test(i.text)), 'ポチが覚える：「〇〇って呼んで」「〇〇って覚えて」をデータのリポジトリの pochi-memory.json に書いた');
    await type('何を覚えてる');
    check(/ポテト/.test(await pg.textContent('#talkLog')) && /見本の豆知識/.test(await pg.textContent('#talkLog')), 'ポチが覚える：「何を覚えてる？」で覚えたことを答える');
    await pg.click('#talkEnd');
    await pg.click('#lkMenu summary'); await pg.click('#lkMenu [data-m=aiset]');
    const listed = await pg.textContent('#memList');
    check(/ポテト/.test(listed) && /見本の豆知識/.test(listed), 'ポチが覚える：設定の画面に覚えたことの一覧を出す');
    await pg.click('#memList button[aria-label*="見本の豆知識"]');
    await pg.waitForTimeout(1600);
    const after = files['local-board/pochi-memory.json'] || '';
    check(!/見本の豆知識/.test(after) && /ポテト/.test(after), 'ポチが覚える：「忘れる」を押すと中身ごと消す（ほかは残す）');
    await pg.click('#talkSetForm button[value=cancel]');
    await pg.close();
    check(outside.length === 0, 'ポチが覚える：自分のサイトと GitHub 以外へ通信していない');

    const again = await talkPage({ sr: false }, '覚える2');
    await again.pg.click('#talkBtn');
    await again.pg.waitForFunction(() => window.__spoken.length > 0, null, { timeout: 10000 });
    check(/ポテト/.test(await again.pg.evaluate(() => window.__spoken.join(''))), 'ポチが覚える：別の端末・次の会話でも覚えた呼び方であいさつする');
    // 言い直し：分からなかった言葉のすぐあとに「済み」が2回来たら、その言葉を「済み」として覚える
    const r = await again.pg.evaluate(async () => {
      const store = []; const acts = [];
      const mem = { all: () => store.filter((i) => !i.gone), put: (it) => { const x = { ...it, id: it.id || 'x' + store.length }; const k = store.findIndex((i) => i.id === x.id); if (k >= 0) store[k] = x; else store.push(x); return x; }, forget: (id) => { const x = store.find((i) => i.id === id); if (x) x.gone = true; }, forgetAll: () => store.forEach((i) => { i.gone = true; }) };
      const cards = Array.from({ length: 6 }, (_, i) => ({ title: '見本' + i, lane: 'now' }));
      const t = Talk.create({ settings: { ai: 'off', bargeIn: false }, lanes: { now: '今やる' }, laneWords: [['now', '今やる']], memory: mem,
        board: () => cards, queue: () => cards, run: () => '', act: (c) => { acts.push(c.type); return 'ok'; }, pending: () => false, onLine() {}, onState() {} });
      localStorage.removeItem('lk.wordSeen');
      await t.start();
      let first = null;
      for (const [i, w] of ['ばっちり', '済み', 'ばっちり', '済み', 'ばっちり'].entries()) { await t.hear(w); if (i === 1) first = store.filter((x) => x.kind === 'word').length; }
      const learned = store.find((i) => i.kind === 'word');
      await t.hear('ばっちりを忘れて');
      const gone = !mem.all().some((i) => i.kind === 'word');
      t.stop();
      return { acts, learned, gone, first };
    });
    check(r.learned?.word === 'ばっちり' && r.learned?.count >= 2 && r.acts.length === 3, `ポチが覚える：言い直しが2回あった言葉を覚えて、3回目からはその意味で動かす（${JSON.stringify(r.learned)}・${r.acts.join(',')}）`);
    check(r.gone, 'ポチが覚える：「〇〇を忘れて」で覚えた言葉を消す');
    check(r.first === 0, `ポチが覚える：言い直しの1回目はデータのリポジトリに書かない（この端末の中だけで数える）（${r.first}）`);
    const h = await again.pg.evaluate(() => [Talk.habitText({ morning: 4, night: 1 }), Talk.habitText({ morning: 2, night: 1 }), Talk.habitText({ morning: 2, day: 2, evening: 2 })]);
    check(h[0] === '朝によく片づける' && h[1] === '' && h[2] === '', `ポチが覚える：よく片づける時間帯は5回以上・半分以上のときだけ覚える（${h.join('|')}）`);
    await again.pg.close();
  }

  // キャラの見た目：どの形にも まばたき・表情の口・演出の部品がある。動きを減らす設定では動かさない
  {
    const pg = await context.newPage();
    await pg.emulateMedia({ reducedMotion: 'reduce' });
    await pg.goto(base); await ready(pg);
    const r = await pg.evaluate(() => {
      const parts = ['.lid', '.m-normal', '.m-happy', '.m-open', '.m-surprise', '.m-sad', '.m-think', '.brow', '.ears', '.fx-think', '.fx-ring'];
      const box = document.createElement('div'); box.id = 'talkDlg'; document.body.appendChild(box);
      const miss = [];
      for (const k of ['maru', 'kaku', 'shizuku']) { box.innerHTML = Talk.avatarSvg(k, '#3b82f6'); for (const p of parts) if (!box.querySelector(p)) miss.push(k + p); }
      const ids = new Set([...document.querySelectorAll('radialGradient')].map((g) => g.id));
      box.innerHTML = Talk.avatarSvg('maru', '#3b82f6') + Talk.avatarSvg('maru', '#3b82f6');
      const two = new Set([...box.querySelectorAll('radialGradient')].map((g) => g.id)).size === 2;
      const anim = getComputedStyle(box.querySelector('.lid')).animationName;
      box.remove();
      return { miss, two, anim, ids: ids.size };
    });
    check(r.miss.length === 0, `キャラの見た目：3つの形すべてに まばたき・6つの口・眉・耳・演出がある${r.miss.length ? '（無い: ' + r.miss.join(',') + '）' : ''}`);
    check(r.two, 'キャラの見た目：同じ画面に2つ描いても色のぼかしの id がぶつからない');
    check(r.anim === 'none', `キャラの見た目：「動きを減らす」設定ではまばたきなどを動かさない（${r.anim}）`);
    await pg.close();
  }

  // C. 耳が無い端末：文字を打って話す。キャラの設定を変えられる
  {
    const { pg, outside } = await talkPage({ sr: false }, '会話 文字');
    await pg.click('#talkBtn');
    await pg.waitForFunction(() => /打って/.test(document.querySelector('#talkState').textContent), null, { timeout: 10000 });
    check(true, '会話（耳なし）：打って話す案内が出た');
    await pg.fill('#talkIn', '済み'); await pg.press('#talkIn', 'Enter');
    await waitCards((cs) => cs.find((c) => c.doc_id === 's1')?.lane === 'done', '会話（耳なし）で打った「済み」');
    await pg.click('#talkSetBtn');
    await pg.fill('#talkSetForm [name=name]', 'テスト名');
    await pg.click('#talkSetForm [name=icon][value=kaku]');
    await pg.click('#talkSetForm button[value=ok]');
    check((await pg.textContent('#talkName')) === 'テスト名', 'キャラの設定：名前を変えると会話の画面に出る');
    check(await pg.evaluate(() => JSON.parse(localStorage.getItem('lk.talk')).icon === 'kaku'), 'キャラの設定：アイコンの選択を端末に保存した');
    await pg.click('#talkEnd');
    check(outside.length === 0, '会話（耳なし）：自分のサイトと GitHub 以外へ通信していない');
    await pg.close();
  }

  // D. 入口を一つに（2026-10-20 satouさん「チャットと声で入力のやり方が違う。もっとシームレスに」）：
  //    🎤で話しても、打っても、同じ欄・同じ流れに文字で残る。はっきりした命令は AI を待たずに動かし、それ以外は会話（AI）へ。
  //    声には声で、打ったら文字だけで返す。打つと聞くのをやめ、🎤でまた聞く
  {
    const { pg, outside } = await talkPage({ heard: ['見本のカード（次にやる・毎週）を保留へ'], replies: [{ say: 'いいね、その調子！', action: null }] }, '一つの欄');
    await pg.click('#micBtn');
    await waitCards((cs) => cs.find((c) => c.doc_id === 's3')?.lane === 'hold', '一つの欄：🎤で言った命令');
    await pg.waitForFunction(() => window.__spoken.some((t) => /保留にしたよ/.test(t)), null, { timeout: 5000 }).catch(() => {});
    const a = await pg.evaluate(() => ({ spoken: window.__spoken.slice(), prompts: window.__prompts.length }));
    check(a.spoken.some((t) => /保留にしたよ/.test(t)) && a.prompts === 0, `一つの欄：🎤で言ったはっきりした命令は AI を待たずに動かし、結果を声で一言返す（${a.spoken.join('／')}・AI ${a.prompts} 回）`);
    await pg.waitForFunction(() => document.querySelector('#talkDlg').dataset.state === 'idle', null, { timeout: 5000 }).catch(() => {});
    check(await pg.evaluate(() => document.querySelector('#talkMic').getAttribute('aria-pressed') === 'false' && !document.querySelector('#talkMic').classList.contains('on')), '一つの欄：しばらく何も聞こえなければ聞くのをやめ、🎤の印（aria-pressed と見た目）も消す');
    const n0 = a.spoken.length;
    await pg.fill('#talkIn', '今日はいい天気だね'); await pg.press('#talkIn', 'Enter');
    await pg.waitForFunction(() => /その調子/.test(document.querySelector('#talkLog').textContent), null, { timeout: 5000 }).catch(() => {});
    const b = await pg.evaluate(() => ({ you: [...document.querySelectorAll('#talkLog .you')].map((d) => d.textContent), log: document.querySelector('#talkLog').textContent, spoken: window.__spoken.length, prompts: window.__prompts.length }));
    check(b.you.join('|') === '見本のカード（次にやる・毎週）を保留へ|今日はいい天気だね', `一つの欄：話したことも打ったことも、同じ流れに順に文字で残る（${b.you.join('|')}）`);
    check(b.prompts === 1 && /その調子/.test(b.log), '一つの欄：命令でない言葉は会話として AI に渡し、返事を同じ流れに出す');
    check(b.spoken === n0, '一つの欄：打ったときは文字だけで返す（声を出さない）');
    await pg.evaluate(() => { window.__heard.push('終わり'); });
    await pg.click('#talkMic');
    check(await pg.evaluate(() => document.querySelector('#talkMic').getAttribute('aria-pressed') === 'true' || !document.querySelector('#talkDlg').open), '一つの欄：🎤を押すと、打っていた会話の続きを声で聞く');
    await waitTalkEnd(pg);
    check(!(await pg.evaluate(() => document.querySelector('#talkDlg').open)), '一つの欄：打つ⇄話すを切り替えたあとも「終わり」で閉じる');
    check(outside.length === 0, '一つの欄：自分のサイトと GitHub 以外へ通信していない');
    await pg.close();
  }

  // E. AI に任せる（2026-10-20 satouさん「AI に権限をあげるので、基本的に AI が作業をする形に」）：
  //    ポチが話し始めに自分で整理して報告する・一言で複数の命令・期限・Claude に回す・どれも「戻す」で戻せる・履歴に「ポチ」
  {
    const words = await page.evaluate(() => {
      const L = [['now', '今やる', '今'], ['next', '次にやる', '次'], ['later', '時間があるとき', 'あとで'], ['agent', 'エージェント'], ['done', '済み']];
      const t = new Date(2026, 9, 20);
      return {
        agent: JSON.stringify(Voice.parse('資料の下書きをClaudeに回して', L)), due: JSON.stringify(Voice.parse('牛乳は金曜までに', L)), later: JSON.stringify(Voice.parse('牛乳をあとでに', L)),
        split: Voice.split('りんごとみかんを済みに、ぶどうは明日').join('|'), keep: Voice.split('牛乳をあとでにして').length,
        dates: ['今日', '明日', '金曜', '25日', '5日', '週末'].map((w) => Voice.dueDate(w, t)).join(','),
      };
    });
    check(words.agent === '{"type":"agent","query":"資料の下書き"}', `声の文型：「〇〇を Claude に回して」（${words.agent}）`);
    check(words.due === '{"type":"due","query":"牛乳","when":"金曜"}' && words.later === '{"type":"move","query":"牛乳","lane":"later"}', `声の文型：「〇〇は金曜までに」で期限、「あとでに」は列のまま（${words.due} ${words.later}）`);
    check(words.split === 'りんごとみかんを済みに|ぶどうは明日' && words.keep === 1, `一言の中の複数の命令を区切る（${words.split}）`);
    check(words.dates === '2026-10-20,2026-10-21,2026-10-23,2026-10-25,2026-11-05,2026-10-24', `「明日」「金曜」「25日」を日付に直す（${words.dates}）`);

    const { pg, outside } = await talkPage({ sr: false }, '任せる');
    const ymd = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
    await pg.evaluate(async ({ yesterday }) => {
      const t = new Date().toISOString();
      const body = (title, lane, due, o) => ({ type: 'task', title, owner: 'you', lane, priority: 'mid', order: o, created: t, updated: t, moves: [{ at: t, to: lane }], due, history: [{ at: t, who: 'you', text: '検査で足した' }] });
      for (const [i, d] of ['2099-02-01', '2099-02-02', '2099-02-03'].entries()) await LK.add(body('見本の今やる' + (i + 1), 'now', d, 10 + i));
      await LK.add(body('見本の期限すぎ', 'next', yesterday, 20));
      await LK.add(body('見本の調べもの', 'later', null, 21));
      for (const [i, f] of ['りんご', 'みかん', 'ぶどう'].entries()) await LK.add(body('見本の' + f, 'next', null, 30 + i));
    }, { yesterday: ymd(-1) });
    await pg.waitForTimeout(1200); // 足したのと整理を「戻す」で一緒に戻さないよう、間をあける
    const lane = (title) => pg.evaluate((t) => LK.cards.find((c) => c.title === t && !c.deleted)?.lane, title);
    const nowN = () => pg.evaluate(() => LK.cards.filter((c) => c.lane === 'now' && !c.deleted).length);
    await pg.click('#talkBtn');
    await pg.waitForFunction(() => /整理したよ/.test(document.querySelector('#talkLog').textContent), null, { timeout: 10000 }).catch(() => {});
    const hello = await pg.textContent('#talkLog');
    check(/整理したよ/.test(hello) && /見本の期限すぎ/.test(hello) && /戻す/.test(hello), `任せる：話し始めにポチが自分で整理して、やったことを一言で報告する（${hello.slice(0, 120)}）`);
    check(await lane('見本の期限すぎ') === 'now' && await nowN() === 3, `任せる：期限すぎを今やるへ上げ、今やるは3枚までにした（今やる ${await nowN()} 枚）`);
    const agent = await pg.evaluate(() => LK.cards.find((c) => c.title === '見本の調べもの'));
    check(agent?.lane === 'agent' && agent?.owner === 'agent', '任せる：調べものなど Claude ができそうなカードは Claude に回した');
    check(await pg.evaluate(() => LK.cards.filter((c) => (c.history || []).some((h) => h.who === 'ポチ')).length >= 3), '任せる：ポチが動かしたカードの履歴に「ポチ」と残る');
    const type = async (t) => { await pg.fill('#talkIn', t); await pg.press('#talkIn', 'Enter'); await pg.waitForTimeout(400); };
    await type('戻して');
    check(await lane('見本の期限すぎ') === 'next' && await lane('見本の調べもの') === 'later' && await nowN() === 5, `任せる：「戻して」で整理を全部まとめて元に戻す（今やる ${await nowN()} 枚）`);
    await pg.waitForTimeout(900);
    await type('りんごとみかんを済みに、ぶどうは明日');
    const fr = await pg.evaluate(() => Object.fromEntries(['りんご', 'みかん', 'ぶどう'].map((f) => { const c = LK.cards.find((x) => x.title === '見本の' + f); return [f, c?.lane + ':' + (c?.due || '')]; })));
    check(fr['りんご'].startsWith('done') && fr['みかん'].startsWith('done') && fr['ぶどう'] === 'next:' + ymd(1), `任せる：一言で何枚もの操作をこなす（${JSON.stringify(fr)}）`);
    const said = (await pg.$$eval('#talkLog .l.ai', (ls) => ls.map((l) => l.textContent))).at(-1) || '';
    check(/りんご/.test(said) && /みかん/.test(said) && /ぶどう/.test(said) && /明日|\d+月\d+日/.test(said), `任せる：まとめてやったことを一言で全部伝える（${said}）`);
    await pg.waitForTimeout(900);
    await type('ぶどうをClaudeに回して');
    const g = await pg.evaluate(() => LK.cards.find((c) => c.title === '見本のぶどう'));
    check(g?.lane === 'agent' && g?.owner === 'agent' && /Claude に回した/.test(await pg.textContent('#talkLog')), '任せる：「Claude に回して」でカードを Claude の列へ回し、一言で知らせる');
    // 本人が戻したカードは、次に話し始めたときに二度と動かさない
    await pg.evaluate(() => { document.querySelector('#talkIn').value = ''; });
    await type('終わり');
    await pg.waitForTimeout(500);
    await pg.click('#talkBtn');
    await pg.waitForTimeout(1500);
    check(await lane('見本の期限すぎ') === 'next' && await lane('見本の調べもの') === 'later', '任せる：本人が戻したカードは、次に話し始めても動かさない');
    await type('終わり');
    check(outside.length === 0, '任せる：自分のサイトと GitHub 以外へ通信していない（Claude に回すのはカードの列だけ）');
    const tk = readFileSync(resolve(root, 'talk.js'), 'utf8'), la = readFileSync(resolve(root, 'localai.js'), 'utf8');
    check(/visibilitychange/.test(tk) && /fails >= 2/.test(tk) && /CTX = 4096/.test(la) && !/会話のまとめ役/.test(la), '会話が続いても止まらない：画面を消したら聞くのをやめる・2回失敗で AI なし・4096・返事のたびにまとめを作らない');
    await pg.close();
  }

  // 人っぽく：同じ言い出しを続けない・2文まで・考えているあいだの相槌・出来た文から読み上げる
  {
    const pg = await context.newPage();
    pg.on('pageerror', (e) => errors.push(`pageerror(人っぽく): ${e.message}`));
    await pg.goto(base); await ready(pg);
    const r = await pg.evaluate(async () => {
      const t0 = performance.now(), ev = [];
      speechSynthesis.getVoices = () => [{ name: '端末の声', lang: 'ja-JP', localService: true }];
      speechSynthesis.cancel = () => {};
      speechSynthesis.speak = (u) => { ev.push(['speak', u.text, performance.now() - t0]); setTimeout(() => u.onend && u.onend(), 5); };
      const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
      const replies = [
        ['{"say":"オッケー、牛乳ね。', '今やるに入れとく？ あと三つ目の文。","action":null}'],
        ['{"say":"オッケー、じゃあ次。', 'どれにする？","action":null}'],
      ];
      window.LanguageModel = {
        availability: async () => 'available',
        create: async () => ({
          async *promptStreaming() { const [a, b] = replies.shift(); await wait(900); ev.push(['chunk1', '', performance.now() - t0]); yield a; await wait(400); ev.push(['chunk2', '', performance.now() - t0]); yield b; },
          prompt: async () => '{"say":"うん","action":null}', destroy() {},
        }),
      };
      const lines = [];
      const t = Talk.create({ settings: { ai: 'auto', bargeIn: false }, lanes: { now: '今やる' }, laneWords: [['now', '今やる']], board: () => [], queue: () => [],
        run: () => '', act: () => '', pending: () => false, onLine: (w, x) => lines.push([w, x]), onState() {} });
      await t.start('text');
      await t.hear('牛乳買わなきゃ', { voice: true });
      await t.hear('うん', { voice: true });
      t.stop();
      const ai = lines.filter(([w]) => w === 'ai').map(([, x]) => x);
      const pick = Talk.picker(); const acks = Array.from({ length: 30 }, () => pick('ack', Talk.PHRASES.ack));
      return { ev, ai, aizuchi: Talk.PHRASES.aizuchi, acks, opens: ai.map((x) => Talk.opening(x)) };
    });
    const speaks = r.ev.filter((e) => e[0] === 'speak');
    const c2 = r.ev.find((e) => e[0] === 'chunk2')?.[2] ?? 0;
    check(r.aizuchi.includes(speaks[0]?.[1]), `人っぽく：AI が考えているあいだ（0.7 秒より長いとき）は相槌を打つ（${speaks[0]?.[1]}）`);
    check(speaks[1] && speaks[1][2] < c2, `人っぽく：AI の返事は出来た文から読み上げ始める（1文目 ${Math.round(speaks[1]?.[2] ?? -1)}ms・残りが届く ${Math.round(c2)}ms）`);
    check(!speaks.some((e) => /三つ目/.test(e[1])), `人っぽく：返事は2文までで切る（${speaks.map((e) => e[1]).join('／')}）`);
    check(r.opens.length >= 2 && r.opens[0] !== r.opens[1], `人っぽく：直前と同じ言い出しを続けない（${r.ai.join('／')}）`);
    check(!r.acks.some((x, i) => i && x === r.acks[i - 1]), '人っぽく：命令をやったときの最初の一言も、同じものを続けない');
    await pg.close();
  }

  check(vendorHits.length === 0, `ふだんの画面・会話では同梱の AI 部品（vendor/）を読み込まない${vendorHits.length ? '（' + vendorHits.join(', ') + '）' : ''}`);

  // E. 本物の同梱部品が CSP の下で読み込めて、localai.js が使う関数がある（モデルは取らない）
  {
    const pg = await context.newPage();
    pg.on('pageerror', (e) => errors.push(`pageerror(部品の読み込み): ${e.message}`));
    const outside = [];
    pg.on('request', (r) => { const h = new URL(r.url()).host; if (!/^127\.0\.0\.1(:\d+)?$/.test(h) && h !== 'api.github.com') outside.push(r.url()); });
    await pg.goto(base);
    await ready(pg);
    const got = await pg.evaluate(async (v) => {
      const out = {};
      try { const m = await import('./' + v.llm); out.llm = ['CreateMLCEngine', 'deleteModelAllInfoInCache'].filter((k) => typeof m[k] === 'function'); } catch (e) { out.llmErr = String(e); }
      try { const m = await import('./' + v.tf); out.tf = ['pipeline', 'Tensor'].filter((k) => typeof m[k] === 'function').concat(typeof m.AutoModel?.from_pretrained === 'function' ? ['AutoModel'] : [], m.env?.backends?.onnx?.wasm ? ['wasm'] : []); } catch (e) { out.tfErr = String(e); }
      try { const m = await import('./' + v.cpu); out.cpu = ['Wllama', 'CacheManager'].filter((k) => typeof m[k] === 'function'); } catch (e) { out.cpuErr = String(e); }
      const cw = await fetch('./' + v.cpuWasm).then((r) => r.arrayBuffer()).catch(() => null);
      out.cpuWasm = !!cw && cw.byteLength > 1e6 && new Uint8Array(cw, 0, 4).join() === '0,97,115,109';
      const w = await fetch('./' + v.ort + '.wasm').then((r) => r.arrayBuffer()).catch(() => null);
      out.wasm = !!w && WebAssembly.validate(new Uint8Array(w));
      out.compiled = !!w && await WebAssembly.compile(w).then(() => true, (e) => String(e)); // CSP の 'wasm-unsafe-eval' で wasm を動かせる
      return out;
    }, await pg.evaluate(() => window.LocalAI.VENDOR));
    check((got.llm || []).length === 2, `同梱の WebLLM を読み込めて、使う関数がある${got.llmErr ? '（' + got.llmErr + '）' : ''}`);
    check((got.tf || []).length === 4, `同梱の transformers.js を読み込めて、使う関数がある（${(got.tf || []).join(',')}${got.tfErr ? ' ' + got.tfErr : ''}）`);
    check(got.wasm === true, '同梱の ONNX Runtime の wasm が壊れていない');
    check((got.cpu || []).length === 2, `同梱の wllama（CPU 版の頭）を読み込めて、使う関数がある${got.cpuErr ? '（' + got.cpuErr + '）' : ''}`);
    check(got.cpuWasm === true, '同梱の wllama の wasm がある（壊れていない）');
    check(got.compiled === true, `CSP の下で wasm を動かせる（${got.compiled}）`);
    check(outside.length === 0, `部品を読み込むだけでは外へ通信しない${outside.length ? '（' + outside.join(', ') + '）' : ''}`);
    await pg.evaluate(() => caches.delete('kanban-vendor')); // 次の検査でにせものの部品を使うため
    await pg.close();
  }

  // D. スマホ（内蔵 AI も端末内の音声認識も無い）：「AI の部品を入れる」でモデルを取り、WebLLM と Whisper と Silero で会話する
  {
    fakeVendor = true;
    const pg = await context.newPage();
    pg.on('pageerror', (e) => errors.push(`pageerror(端末の中の AI): ${e.message}`));
    const net = [];
    pg.on('request', (r) => { const u = new URL(r.url()); if (!/^127\.0\.0\.1(:\d+)?$/.test(u.host) && u.host !== 'api.github.com') net.push({ host: u.host, url: r.url(), method: r.method() }); });
    await pg.route(/^https:\/\/([a-z0-9-]+\.)*(huggingface\.co|hf\.co)\//, (route) => route.fulfill({ json: {} }));
    await pg.addInitScript(() => {
      window.__heard = []; window.__spoken = []; window.__llmReq = []; window.__llmReplies = []; window.__asrCalls = [];
      delete window.webkitSpeechRecognition; delete window.SpeechRecognition; delete window.LanguageModel;
      Object.defineProperty(navigator, 'gpu', { configurable: true, value: { requestAdapter: async () => ({ features: new Set(['shader-f16']) }) } });
      Object.defineProperty(navigator, 'deviceMemory', { configurable: true, value: 4 });
      window.speechSynthesis.getVoices = () => [{ name: '端末の声', lang: 'ja-JP', localService: true }];
      window.speechSynthesis.speak = (u) => { window.__spoken.push(u.text); setTimeout(() => u.onend && u.onend(), 5); };
      window.speechSynthesis.cancel = () => {};
      // マイクのかわりに小さな音を流す（音の中身は見ない。声かどうかはにせものの Silero が決める）
      navigator.mediaDevices.getUserMedia = async () => { const ac = new AudioContext(); const o = ac.createOscillator(); const d = ac.createMediaStreamDestination(); o.connect(d); o.start(); return d.stream; };
    });
    await pg.goto(base);
    await ready(pg);
    check(await pg.evaluate(() => !Voice.supported) && /AI の部品/.test(await pg.textContent('#talkWhy')), '端末の中の AI（入れる前）：耳が無いので🎤は使えないと出し、AI の部品の場所を案内する');
    await pg.click('#lkMenu summary'); await pg.click('#lkMenu [data-m=aiset]');
    check(/約 0\.5GB/.test(await pg.textContent('#aiGet')), `端末の中の AI：入れる前に大きさの目安を出す（${await pg.textContent('#aiGet')}）`);
    check(net.length === 0, '端末の中の AI：ボタンを押す前はモデルを取りに行かない');
    await pg.click('#aiGet');
    await pg.waitForFunction(() => /入りました|入れられません/.test(document.querySelector('#aiMsg').textContent), null, { timeout: 15000 }).catch(() => {});
    const msg = await pg.textContent('#aiMsg');
    check(/入りました/.test(msg), `端末の中の AI：「AI の部品を入れる」で入った（${msg}）`);
    check(await pg.evaluate(() => window.__llmId) === 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC', '端末の中の AI：メモリ 4GB の端末には小さいモデル（0.5B）を選んだ');
    check(net.length > 0 && net.every((x) => isModelHost(x.host) && x.method === 'GET'), `端末の中の AI：取りに行ったのはモデルの置き場だけで、GET だけ（${[...new Set(net.map((x) => x.method + ' ' + x.host))].join(', ')}）`);
    check(!net.some((x) => /%E8%A6%8B%E6%9C%AC|見本/.test(x.url)), '端末の中の AI：モデルを取るときにカードの中身を送っていない');
    check(/入っています/.test(await pg.textContent('#aiStat')) && /huggingface\.co/.test(await pg.textContent('#aiStat')), '端末の中の AI：どこから取ったかを設定画面に出す');
    check(await pg.evaluate(() => Voice.supported) && !/🎤は/.test(await pg.textContent('#talkWhy')), '端末の中の AI：Whisper を入れたら🎤が使えるようになる');
    await pg.click('#talkSetForm button[value=cancel]');
    net.length = 0;
    await pg.evaluate(() => {
      window.__heard.push('毎週のやつ今やるにして', 'ありがとう', '終わり');
      window.__llmReplies.push({ say: 'オッケー、今やるに入れたよ', action: { type: 'move', query: '見本のカード（次にやる・毎週）', lane: 'now' } }, { say: 'どういたしまして！', action: null });
    });
    await pg.click('#talkBtn');
    const t0 = Date.now();
    while (Date.now() - t0 < 30000 && (await pg.evaluate(() => document.querySelector('#talkDlg').open))) await pg.waitForTimeout(200);
    check(/WebLLM/.test(await pg.textContent('#talkMode')), '会話（入れた AI）：内蔵 AI が無い端末では入れた WebLLM を使う');
    await waitCards((cs) => cs.find((c) => c.doc_id === 's3')?.lane === 'now', '会話（入れた AI・Whisper で聞いた声）の「今やるに」');
    const asr = await pg.evaluate(() => ({ calls: window.__asrCalls, vad: window.__vadCalls || 0 }));
    check(asr.calls.length >= 1 && asr.calls.every((c) => c.lang === 'japanese' && c.n > 0), `会話（入れた AI）：Whisper で日本語として聞き取った（${asr.calls.length} 回）`);
    check(asr.vad > 0, '会話（入れた AI）：話し終わりを Silero VAD で見た');
    const req = await pg.evaluate(() => window.__llmReq);
    const charName = await pg.evaluate(() => JSON.parse(localStorage.getItem('lk.talk') || '{}').name || 'ポチ');
    const sent = JSON.stringify(req);
    check(req.length >= 1 && req[0].response_format?.type === 'json_object' && req[0].messages[0].content.includes(charName), '会話（入れた AI）：キャラの指示と JSON の形を WebLLM に渡した');
    check(sent.includes('見本のカード（次にやる・毎週）') && !sent.includes('見本の補足'), '会話（入れた AI）：AI に渡すのは題・列・期限だけ（補足は渡さない）');
    const m0 = req[0]?.messages || [], m1 = req.find((r, i) => i > 0 && r.response_format)?.messages || [];
    check(m0.some((m) => m.role === 'assistant') && m0.filter((m) => m.role === 'user').length >= 2, '会話（入れた AI）：返事の見本（few-shot）を渡した');
    check(m1.some((m) => m.role === 'user' && m.content === '毎週のやつ今やるにして') && m1.some((m) => m.role === 'assistant' && /今やるに入れたよ/.test(m.content)), '会話（入れた AI）：2回目には前のやりとりを覚えて渡した');
    check(m1.filter((m) => m.role === 'user' && /見本のカード/.test(m.content)).length === 1, '会話（入れた AI）：ボードの一覧は今回の発言にだけ入れ、前の分は覚えない');
    check(req[0]?.temperature === 0.7 && req[0]?.top_p === 0.8 && req[0]?.repetition_penalty === 1.1, `会話（入れた AI）：返事の出し方は Qwen2.5 の公式の既定（${req[0]?.temperature}/${req[0]?.top_p}/${req[0]?.repetition_penalty}）`);
    check(net.length === 0, `会話（入れた AI）：会話中は外へ通信していない${net.length ? '（' + net.map((x) => x.url).join(', ') + '）' : ''}`);
    await pg.click('#lkMenu summary'); await pg.click('#lkMenu [data-m=aiset]');
    await pg.click('#aiDel');
    await pg.waitForFunction(() => /消しました/.test(document.querySelector('#aiMsg').textContent), null, { timeout: 10000 }).catch(() => {});
    check(await pg.evaluate(() => !localStorage.getItem('lk.ai') && window.__deleted === 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC'), '端末の中の AI：「入れた AI を消す」でモデルと印を消した');
    check(await pg.evaluate(() => !Voice.supported), '端末の中の AI：消したら🎤も使えなくなる');
    await pg.click('#talkSetForm button[value=cancel]');
    await pg.evaluate(() => caches.delete('kanban-vendor'));
    fakeVendor = false;
    await pg.close();
  }

  // F. WebGPU が使えないスマホ（GPU が Chrome の対象外。2026-10-20 Pixel 6a で止まった）：CPU 版の頭（wllama）を入れて話す
  {
    fakeVendor = true;
    const pg = await context.newPage();
    pg.on('pageerror', (e) => errors.push(`pageerror(CPU 版の AI): ${e.message}`));
    const net = [];
    pg.on('request', (r) => { const u = new URL(r.url()); if (!/^127\.0\.0\.1(:\d+)?$/.test(u.host) && u.host !== 'api.github.com') net.push({ host: u.host, url: r.url(), method: r.method() }); });
    await pg.route(/^https:\/\/([a-z0-9-]+\.)*(huggingface\.co|hf\.co)\//, (route) => route.fulfill({ json: {} }));
    await pg.addInitScript(() => {
      window.__heard = []; window.__spoken = []; window.__llmReq = []; window.__llmReplies = []; window.__asrCalls = []; window.__tried = [];
      // 本物の音声認識は使わない（CI の Chrome が落ちた）。Pixel のように、端末の中で聞く関数はあるが日本語は 'unavailable' と答えるにせもの
      delete window.webkitSpeechRecognition; delete window.LanguageModel;
      window.__srState = 'unavailable';
      window.SpeechRecognition = class { static async available() { return window.__srState; } static async install() { if (window.__srInstallOk) window.__srState = 'available'; return !!window.__srInstallOk; } start() { this.onerror?.({ error: 'not-allowed' }); } stop() {} abort() {} };
      navigator.mediaDevices.getUserMedia = async () => { const ac = new AudioContext(); const o = ac.createOscillator(); const d = ac.createMediaStreamDestination(); o.connect(d); o.start(); return d.stream; };
      Object.defineProperty(navigator, 'gpu', { configurable: true, value: { requestAdapter: async (o) => { window.__tried.push(JSON.stringify(o || {})); return null; } } });
      window.speechSynthesis.getVoices = () => [{ name: '端末の声', lang: 'ja-JP', localService: true }];
      window.speechSynthesis.speak = (u) => { window.__spoken.push(u.text); setTimeout(() => u.onend && u.onend(), 5); };
      window.speechSynthesis.cancel = () => {};
    });
    await pg.goto(base);
    await ready(pg);
    await pg.click('#lkMenu summary'); await pg.click('#lkMenu [data-m=aiset]');
    await pg.waitForFunction(() => /CPU で動く AI/.test(document.querySelector('#aiStat').textContent), null, { timeout: 5000 }).catch(() => {});
    check(/耳 Whisper/.test(await pg.textContent('#aiStat')) && /約 0\.5GB/.test(await pg.textContent('#aiGet')), `CPU 版の AI：端末の中で聞く関数があっても日本語が使えなければ、耳（Whisper）も入れると出す（${await pg.textContent('#aiGet')}）`);
    const earQ = await pg.evaluate(async () => {
      const out = {};
      window.__srState = 'available'; out.available = await LocalAI.earNeeded({ tryInstall: true });
      window.__srState = 'downloadable'; window.__srInstallOk = true; out.downloadable = await LocalAI.earNeeded({ tryInstall: true });
      window.__srState = 'unavailable'; window.__srInstallOk = false; out.unavailable = await LocalAI.earNeeded({ tryInstall: true });
      return out;
    });
    check(earQ.available === false && earQ.downloadable === false && earQ.unavailable === true, `耳が要るかは、端末の音声認識の実際の答えで決める（使える→不要・入れて使えた→不要・使えない→要る：${JSON.stringify(earQ)}）`);
    check(/WebGPU が使えないので、CPU で動く AI/.test(await pg.textContent('#aiStat')), `CPU 版の AI：WebGPU が使えない端末では、入れる前に CPU 版になる・ゆっくりと出す（${await pg.textContent('#aiStat')}）`);
    const tried = await pg.evaluate(() => window.__tried);
    check(tried.some((t) => /compatibility/.test(t)) && tried.some((t) => /low-power/.test(t)), `CPU 版の AI：あきらめる前に WebGPU を別の指定（互換モード・電力）でも探した（${tried.join(' ')}）`);
    await pg.waitForFunction(() => /CPU で動かして|WebGPU が使えない/.test(document.querySelector('#koeStat')?.textContent || ''), null, { timeout: 5000 }).catch(() => {});
    check(/WebGPU が使えない/.test(await pg.textContent('#koeStat')) && (await pg.isDisabled('#koeGet')), `CPU 版の AI：気持ちの声は入れられない理由を出し、ボタンを押せなくする（${await pg.textContent('#koeStat')}）`);
    check(net.length === 0, 'CPU 版の AI：ボタンを押す前はモデルを取りに行かない');
    await pg.click('#aiGet');
    await pg.waitForFunction(() => /入りました|入れられません/.test(document.querySelector('#aiMsg').textContent), null, { timeout: 15000 }).catch(() => {});
    const msg = await pg.textContent('#aiMsg');
    check(/入りました/.test(msg), `CPU 版の AI：WebGPU が無くても「AI の部品を入れる」で入った（${msg}）`);
    const cpu = await pg.evaluate(() => window.__cpu || {});
    check(/Qwen2\.5-0\.5B-Instruct-GGUF\/resolve\/[0-9a-f]{40}\/qwen2\.5-0\.5b-instruct-q4_0\.gguf$/.test(cpu.url || '') && cpu.gpuLayers === 0 && /vendor\/wllama-[\d.]+\/wllama\.wasm$/.test(cpu.wasm || ''), `CPU 版の AI：Qwen 公式の GGUF（コミットで固定）を GPU なしで、同梱の wasm で動かす（${cpu.url}）`);
    check(net.length > 0 && net.every((x) => isModelHost(x.host) && x.method === 'GET'), `CPU 版の AI：取りに行ったのはモデルの置き場だけで、GET だけ（${[...new Set(net.map((x) => x.method + ' ' + x.host))].join(', ')}）`);
    check(/CPU で動かしています/.test(await pg.textContent('#aiStat')), 'CPU 版の AI：入れたあと、CPU で動かしていることを設定画面に出す');
    check(await pg.evaluate(() => LocalAI.status().ear && !!window.__asr), 'CPU 版の AI：日本語を端末の中で聞けない端末には耳（Whisper）も入れた');
    await pg.click('#talkSetForm button[value=cancel]');
    net.length = 0;
    await pg.evaluate(() => {
      window.__heard.push('毎週のやつ今やるにして', '終わり');
      window.__llmReplies.push({ say: 'オッケー、今やるに入れたよ', action: { type: 'move', query: '見本のカード（次にやる・毎週）', lane: 'now' } });
    });
    await pg.click('#talkBtn');
    const t0 = Date.now();
    while (Date.now() - t0 < 30000 && (await pg.evaluate(() => document.querySelector('#talkDlg').open))) await pg.waitForTimeout(200);
    check(/CPU で動かしています（ゆっくり）/.test(await pg.textContent('#talkMode')), `会話（CPU 版の AI）：CPU で動かしている（ゆっくり）と出す（${await pg.textContent('#talkMode')}）`);
    await waitCards((cs) => cs.find((c) => c.doc_id === 's3')?.lane === 'now', '会話（CPU 版の AI）の「今やるに」');
    const req = await pg.evaluate(() => window.__llmReq);
    check(req.length >= 1 && req[0].response_format?.type === 'json_schema' && req[0].response_format.json_schema?.schema?.required?.includes('say') && req[0].temp === 0.7 && req[0].penalty_repeat === 1.1, `会話（CPU 版の AI）：JSON の形と返事の出し方を wllama の形で渡した（${JSON.stringify(req[0]?.response_format)?.slice(0, 80)}）`);
    check(net.length === 0, `会話（CPU 版の AI）：会話中は外へ通信していない${net.length ? '（' + net.map((x) => x.url).join(', ') + '）' : ''}`);
    await pg.click('#lkMenu summary'); await pg.click('#lkMenu [data-m=aiset]');
    await pg.click('#aiDel');
    await pg.waitForFunction(() => /消しました/.test(document.querySelector('#aiMsg').textContent), null, { timeout: 10000 }).catch(() => {});
    check(await pg.evaluate(() => !localStorage.getItem('lk.ai') && window.__cpuCleared === true), 'CPU 版の AI：「入れた AI を消す」でモデル（wllama の保存）と印を消した');
    await pg.click('#talkSetForm button[value=cancel]');
    // 頭だけ入れてある端末（耳を入れる前の版で入れた）：「耳だけ足す」で Whisper だけ取る
    await pg.evaluate(() => { localStorage.setItem('lk.ai', JSON.stringify({ llm: LocalAI.CPU.label, engine: 'cpu', at: '2026-10-20', from: ['huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF'] })); window.__cpu = null; window.__asr = null; });
    await pg.click('#lkMenu summary'); await pg.click('#lkMenu [data-m=aiset]');
    await pg.waitForFunction(() => /耳.*だけ足す/.test(document.querySelector('#aiGet').textContent), null, { timeout: 5000 }).catch(() => {});
    check(/耳（声の聞き取り）だけ足す/.test(await pg.textContent('#aiGet')), `頭だけ入れた端末では「耳だけ足す」を出す（${await pg.textContent('#aiGet')}）`);
    await pg.click('#aiGet');
    await pg.waitForFunction(() => /入りました|入れられません/.test(document.querySelector('#aiMsg').textContent), null, { timeout: 15000 }).catch(() => {});
    const earOnly = await pg.evaluate(() => ({ ear: LocalAI.status().ear, llm: LocalAI.status().llm, asr: !!window.__asr, cpu: !!window.__cpu }));
    check(earOnly.ear && earOnly.asr && !earOnly.cpu && !!earOnly.llm, `「耳だけ足す」で Whisper だけ取り、頭は取り直さない（${JSON.stringify(earOnly)}）`);
    await pg.click('#talkSetForm button[value=cancel]');
    await pg.evaluate(() => caches.delete('kanban-vendor'));
    fakeVendor = false;
    await pg.close();
  }

  // G. 準備を💬の中で1ボタンに・空きを先に見る・消えたら黙って取り直さない・耳の版を固定・この端末の診断（2026-10-20 問題点の一覧 5〜7）
  {
    fakeVendor = true;
    const pg = await context.newPage();
    pg.on('pageerror', (e) => errors.push(`pageerror(1ボタン): ${e.message}`));
    const net = [];
    pg.on('request', (r) => { const u = new URL(r.url()); if (!/^127\.0\.0\.1(:\d+)?$/.test(u.host) && u.host !== 'api.github.com') net.push(r.url()); });
    await pg.route(/^https:\/\/([a-z0-9-]+\.)*(huggingface\.co|hf\.co)\//, (route) => route.fulfill({ json: {} }));
    await pg.addInitScript(() => {
      window.__heard = []; window.__spoken = []; window.__llmReq = []; window.__llmReplies = []; window.__asrCalls = []; window.__tiny = true; window.__locks = 0;
      delete window.webkitSpeechRecognition; delete window.SpeechRecognition; delete window.LanguageModel;
      Object.defineProperty(navigator, 'gpu', { configurable: true, value: { requestAdapter: async () => ({ features: new Set(['shader-f16']) }) } });
      navigator.storage.estimate = async () => (window.__tiny ? { quota: 2e8, usage: 1e8 } : { quota: 5e10, usage: 1e9 });
      Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request: async () => { window.__locks++; return { release: async () => { window.__locks--; } }; } } });
      window.speechSynthesis.getVoices = () => [{ name: '端末の声', lang: 'ja-JP', localService: true }];
      window.speechSynthesis.speak = (u) => { window.__spoken.push(u.text); setTimeout(() => u.onend && u.onend(), 5); };
      window.speechSynthesis.cancel = () => {};
    });
    await pg.goto(base);
    await ready(pg);
    await pg.evaluate(() => localStorage.removeItem('lk.ai'));
    await pg.click('#talkBtn');
    await pg.waitForFunction(() => !document.querySelector('#talkAiGet').hidden, null, { timeout: 10000 }).catch(() => {});
    check(await pg.isVisible('#talkAiGet') && /GB/.test(await pg.textContent('#talkAiGet')), `💬の中に AI を入れる1ボタンを、大きさと一緒に出す（${await pg.textContent('#talkAiGet')}）`);
    await pg.click('#talkAiGet');
    await pg.waitForFunction(() => /空き/.test(document.querySelector('#talkMode').textContent), null, { timeout: 5000 }).catch(() => {});
    check(/空きが足りません/.test(await pg.textContent('#talkMode')) && net.length === 0, `入れる前に端末の空きを見て、足りなければ取りに行かない（${await pg.textContent('#talkMode')}）`);
    await pg.evaluate(() => { window.__tiny = false; });
    await pg.click('#talkAiGet');
    await pg.waitForFunction(() => /WebLLM/.test(document.querySelector('#talkMode').textContent), null, { timeout: 15000 }).catch(() => {});
    check(/WebLLM/.test(await pg.textContent('#talkMode')) && await pg.evaluate(() => document.querySelector('#talkDlg').open), `💬の中の1ボタンで入れて、そのまま AI で話し始める（${await pg.textContent('#talkMode')}）`);
    check(await pg.evaluate(() => window.__locks === 0 && window.__asr?.revision === '1846881b6b3a3024392c1eea3ad983695bc23925'), '入れるあいだだけ画面を消さないようにし（終わったら放す）、耳（Whisper）は版を固定して取る');
    await pg.fill('#talkIn', 'いい天気だね'); await pg.press('#talkIn', 'Enter');
    await pg.waitForTimeout(800);
    await pg.fill('#talkIn', '終わり'); await pg.press('#talkIn', 'Enter');
    await pg.waitForTimeout(500);
    // ブラウザがモデルを消していたら、黙って取り直さずに知らせる
    await pg.evaluate(() => { window.__modelGone = true; });
    net.length = 0;
    await pg.click('#talkBtn');
    await pg.waitForFunction(() => /消えていました/.test(document.querySelector('#talkLog').textContent), null, { timeout: 10000 }).catch(() => {});
    check(/消えていました/.test(await pg.textContent('#talkLog')) && net.length === 0 && !(await pg.evaluate(() => LocalAI.llmReady())), `入れた AI が消えていたら、取り直さずに知らせる（${net.length} 回通信）`);
    await pg.fill('#talkIn', '終わり'); await pg.press('#talkIn', 'Enter');
    await pg.waitForTimeout(500);
    // この端末の診断：データのリポジトリの local-board/diagnostics/ にだけ書く。会話の中身・カードは入れない
    const b4 = puts.length;
    await pg.click('#lkMenu summary'); await pg.click('#lkMenu [data-m=aiset]');
    await pg.click('#diagBtn');
    await pg.waitForFunction(() => /送りました|送れません/.test(document.querySelector('#diagMsg').textContent), null, { timeout: 10000 }).catch(() => {});
    const d = puts.slice(b4).find((x) => /^local-board\/diagnostics\/[\w.-]+\.json$/.test(x.path));
    const dj = d ? JSON.parse(d.text) : {};
    check(!!d && 'webgpu' in dj && 'isolated' in dj && Array.isArray(dj['最近の返事']) && dj['最近の返事'].length >= 1 && 'think_s' in dj['最近の返事'][0], `「この端末の診断」で端末の様子と返事の秒数を local-board/diagnostics/ に書く（${d?.path}）`);
    check(!!d && !/見本|終わり|ポチだよ/.test(d.text), '診断に会話の中身・カードの題を入れない');
    await pg.click('#talkSetForm button[value=cancel]');
    await pg.evaluate(() => { localStorage.removeItem('lk.ai'); return caches.delete('kanban-vendor'); });
    fakeVendor = false;
    await pg.close();
  }

  // ---------- service worker・オフライン・インストールしたアプリ ----------
  const swOk = await page.evaluate(() => navigator.serviceWorker.ready.then((r) => !!r.active)).catch(() => false);
  check(swOk, 'service worker が動いた');
  check(await page.evaluate(() => !!document.querySelector('link[rel=manifest]')), 'manifest のリンクが入った（ボードの画面にも）');
  check(await page.evaluate(() => document.querySelectorAll('meta[http-equiv="Content-Security-Policy"]').length >= 1 && /connect-src 'self' https:\/\/api\.github\.com/.test(document.querySelector('meta[http-equiv="Content-Security-Policy"]').content)), 'ボードの画面にも同じ CSP（外へ通信しない決まり）が入った');
  // インストールしたアプリが開くページ（manifest の start_url）でも壁紙が出る（2026-10-20 アプリにすると背景が消えた）
  {
    const pg = await context.newPage();
    pg.on('pageerror', (e) => errors.push(`pageerror(アプリ): ${e.message}`));
    await pg.goto(new URL(manifest.start_url || './', base).href);
    await ready(pg);
    const l = await look(pg);
    check(l.wp && l.shown && /bg\/\w+\.jpg/.test(l.bg), `インストールしたアプリが開くページ（start_url）でも壁紙が出る（${l.bg}）`);
    await pg.close();
  }
  await page.waitForTimeout(500);
  offline = true;
  await context.setOffline(true);
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#board .card'), null, { timeout: 15000 }).catch(() => {});
  const offlineCards = await page.$$eval('#board .card', (e) => e.length);
  check(offlineCards > 0, `オフラインで開き直しても、ボードの画面（端末に取っておいた分）とカードが出た（${offlineCards} 枚）`);
  const offWp = await look(page);
  const offImg = await page.evaluate(() => new Promise((ok) => { const m = /url\("?([^")]+)/.exec(getComputedStyle(document.getElementById('wall')).backgroundImage); if (!m) return ok(false); const i = new Image(); i.onload = () => ok(true); i.onerror = () => ok(false); i.src = m[1]; }));
  check(offWp.wp && offImg, 'オフラインでも壁紙の写真が出る（一度見た写真は端末に取っておく）');
  check(await page.evaluate(() => crossOriginIsolated), 'オフラインで開いても、ほかのサイトから切り離した状態（COOP・COEP）で開く');
  await context.setOffline(false);
  offline = false;
  // 画面に COOP・COEP（credentialless）を付けても、GitHub の API とボードはそのまま動く。AI が CPU のスレッドを何本も使える（SharedArrayBuffer）
  await page.reload();
  await ready(page);
  const coi = await page.evaluate(() => ({ iso: crossOriginIsolated, sab: typeof SharedArrayBuffer === 'function', cards: document.querySelectorAll('#board .card').length, ok: !!window.LK?.ready }));
  check(coi.iso && coi.sab && coi.cards > 0 && coi.ok, `開き直したら、ほかのサイトから切り離した状態（crossOriginIsolated）になり、GitHub につないだボードもそのまま出る（${JSON.stringify(coi)}）`);
  {
    const sw = readFileSync(resolve(root, 'sw.js'), 'utf8');
    const now = JSON.parse((sw.match(/VENDOR_NOW = (\[[^\]]*\])/) || [, '[]'])[1].replace(/'/g, '"'));
    const dirs = readdirSync(resolve(root, 'vendor'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
    check(JSON.stringify([...now].sort()) === JSON.stringify(dirs), `sw.js の VENDOR_NOW（残す部品の版）が vendor/ のフォルダと同じ（古い版を端末から消すため。${now.join(',')}）`);
  }
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: resolve(OUT, 'pc.png'), fullPage: true });

  // つなぐ前（初めて開いたスマホ）でも、AI の部品のボタンにたどり着けること
  // （2026-10-20 「AI の部品を入れる」が💬→⚙の奥にしかなく、つなぐ前は見つけられなかった）
  {
    const fresh = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const pg = await fresh.newPage();
    pg.on('pageerror', (e) => errors.push(`pageerror(つなぐ前): ${e.message}`));
    await fresh.route(/^https:\/\/(?!127\.0\.0\.1|localhost)/, (route) => route.abort());
    await pg.goto(base);
    await pg.waitForSelector('#lkIntro:not([hidden])', { timeout: 10000 });
    check(await pg.isHidden('#talkBtn'), 'つなぐ前は💬を出さない');
    const why = (await pg.isVisible('#talkWhy')) ? await pg.textContent('#talkWhy') : '';
    check(/つないだあと/.test(why) && /AI の設定/.test(why), `つなぐ前は💬・🎤が出ない理由と AI の設定の場所を一言出す（${why || 'なし'}）`);
    await pg.click('#lkMenu summary');
    await pg.locator('#lkMenu [data-m=aiset]').click();
    await pg.waitForSelector('#talkSet[open]', { timeout: 5000 }).catch(() => {});
    check(await pg.isVisible('#aiGet'), 'つなぐ前の画面から「⋯ → 🎤と会話・AI の設定」で「AI の部品を入れる」ボタンにたどり着ける');
    check(await pg.isVisible('#koeGet') && /声を入れる|WebGPU/.test((await pg.textContent('#koeGet')) + (await pg.textContent('#koeStat'))), `キャラの設定に「気持ちで話し分ける声」を入れるボタンがある（${await pg.textContent('#koeStat')}）`);
    {
      await pg.evaluate(() => { window.__try = []; speechSynthesis.getVoices = () => [{ name: '端末の声', lang: 'ja-JP', localService: true }]; speechSynthesis.cancel = () => {}; speechSynthesis.speak = (u) => { window.__try.push(u.rate); setTimeout(() => u.onend && u.onend(), 5); }; });
      await pg.locator('#talkSetForm [name=rate]').fill('1.3');
      await pg.click('#voiceTry');
      await pg.waitForFunction(() => window.__try.length > 0, null, { timeout: 3000 }).catch(() => {});
      await pg.waitForTimeout(100);
      const tr = await pg.evaluate(() => ({ rates: window.__try, kept: localStorage.getItem('voice.rate') }));
      check(Math.abs(tr.rates[0] - 1.3) < 1e-3 && tr.kept === null, `「試しに聞く」で決める前の速さを聞ける・保存はしない（${JSON.stringify(tr)}）`);
    }
    await pg.keyboard.press('Escape');
    await pg.locator('#lkIntro [data-m=aiset]').click();
    check(await pg.isVisible('#aiGet'), 'つなぐ前の最初の画面のボタンからも AI の設定を開ける');
    await fresh.close();
  }

  // 初めての端末で cards.json を選ぶ（2026-10-20 CodeRabbit：ボードの画面が無いと、つないだことになるのにカードが出なかった）
  {
    const fresh = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const pg = await fresh.newPage();
    pg.on('pageerror', (e) => errors.push(`pageerror(ファイルを選ぶ): ${e.message}`));
    await fresh.route(/^https:\/\/(?!127\.0\.0\.1|localhost)/, (route) => route.abort());
    await pg.goto(base);
    await pg.waitForSelector('#lkIntro:not([hidden])', { timeout: 10000 });
    const json = { name: 'cards.json', mimeType: 'application/json', buffer: Buffer.from(sample) };
    await pg.setInputFiles('#fileInput', [json]);
    await pg.waitForFunction(() => /board\/index\.html/.test(document.querySelector('#lkStatus')?.textContent || ''), null, { timeout: 5000 }).catch(() => {});
    check(/board\/index\.html も選んで/.test(await pg.textContent('#lkStatus')) && await pg.evaluate(() => !LK.ready), `ボードの画面が無い端末で cards.json だけ選ぶと、board/index.html も選ぶよう言い、つないだことにしない（${await pg.textContent('#lkStatus')}）`);
    await pg.setInputFiles('#fileInput', [json, { name: 'index.html', mimeType: 'text/html', buffer: Buffer.from(BOARD) }]);
    let shown = false; // ボードの画面を入れたあと、ページが開き直る
    for (let t0 = Date.now(); !shown && Date.now() - t0 < 15000;) {
      shown = await pg.evaluate(() => !!(window.LK?.ready && LKBoot.hasBoard && document.querySelector('#board .card'))).catch(() => false);
      if (!shown) await pg.waitForTimeout(200);
    }
    check(shown, 'cards.json と board/index.html を一緒に選ぶと、ボードの画面を入れてカードを出す');
    await fresh.close();
  }

  // ---------- スマホ幅（390px） ----------
  const phone = await context.newPage();
  phone.on('pageerror', (e) => errors.push(`pageerror(スマホ): ${e.message}`));
  await phone.setViewportSize({ width: 390, height: 844 });
  await phone.goto(base);
  await ready(phone);
  const pl = await look(phone);
  check(pl.wp && pl.shown, 'スマホでも壁紙が出る');
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(overflow <= 1, `スマホ幅で横にはみ出さない（${overflow}px）`);
  // アプリが足したところは、指で押しやすい大きさ（Apple は 44pt、WCAG 2.5.8 は 24px 以上）。入力欄の文字は 16px 以上（iPhone が勝手に拡大しない）
  await phone.click('#lkMenu summary');
  const tiny = await phone.$$eval('#lkMenu summary, #lkMenu .items button, #talkBtn, #reloadBtn, #micBtn', (els) => els
    .filter((e) => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden')
    .map((e) => { const r = e.getBoundingClientRect(); return r.width < 44 || r.height < 44 ? `${e.id || e.tagName}「${e.textContent.trim().slice(0, 10)}」${Math.round(r.width)}x${Math.round(r.height)}` : null; })
    .filter(Boolean));
  check(tiny.length === 0, `スマホ幅でアプリのボタンが小さすぎない（${tiny.join('、') || 'なし'}）`);
  await phone.click('#lkMenu summary');
  const smallFont = await phone.$$eval('input:not([type=file]):not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]), select, textarea', (els) => els
    .filter((e) => parseFloat(getComputedStyle(e).fontSize) < 16).map((e) => e.name || e.id || e.tagName));
  check(smallFont.length === 0, `スマホ幅で入力欄の文字が 16px 以上（小さいもの: ${smallFont.join('、') || 'なし'}）`);
  // カードの詳細は下から出る（親指で届く）
  await phone.evaluate(() => openDetail(cards.find((c) => !c.deleted).id));
  const sheet = await phone.$eval('dialog#detail', (d) => { const r = d.getBoundingClientRect(); return { open: d.open, w: r.width, bottom: r.bottom, h: innerHeight }; });
  check(sheet.open && sheet.w >= 380 && Math.abs(sheet.bottom - sheet.h) <= 2, `スマホ幅でカードの詳細が下から出る（幅 ${Math.round(sheet.w)}・下端 ${Math.round(sheet.bottom)}/${sheet.h}）`);
  await phone.keyboard.press('Escape');
  // 左右になぞると隣の列へ
  const topLane = () => phone.evaluate(() => { const ls = [...document.querySelectorAll('#board .lane')]; const l = ls.find((x) => x.getBoundingClientRect().bottom > 70) || ls.at(-1); return l?.id; });
  const swipe = (dx) => phone.evaluate((dx) => {
    const el = document.getElementById('board');
    const o = { pointerType: 'touch', isPrimary: true, pointerId: 7, bubbles: true };
    el.dispatchEvent(new PointerEvent('pointerdown', { ...o, clientX: 200, clientY: 400 }));
    el.dispatchEvent(new PointerEvent('pointerup', { ...o, clientX: 200 + dx, clientY: 410 }));
  }, dx);
  await phone.evaluate(() => document.getElementById('lane-now').scrollIntoView({ block: 'start' }));
  const l0 = await topLane();
  await swipe(-150); await phone.waitForTimeout(600);
  const l1 = await topLane();
  check(l0 !== l1, `左になぞると次の列へ（${l0} → ${l1}）`);
  await swipe(150); await phone.waitForTimeout(600);
  check(await topLane() === l0, '右になぞると前の列へ戻る');

  // 切り替えボタンは押すと「選ばれている」印（aria-pressed と見た目）が変わること
  // （2026-10-19 claude.ai のボードで、表示だけ変わって印が変わらない不具合があった。shared-workflows incidents/2026-10-19-board-toggle-state.md）
  if (!REAL) {
    await phone.click('#lookBtn');
    const groups = await phone.$$eval('[aria-pressed]', (bs) => [...new Set(bs.filter((b) => b.offsetParent !== null).map((b) => b.parentElement))].map((p) => (p.id ? '#' + p.id : null)).filter(Boolean)); // 閉じた画面の中のボタンは押せないので、見えている組だけ
    check(groups.includes('#look'), 'ボードの壁紙えらびが切り替えボタン（aria-pressed）になっている');
    for (const g of groups) {
      const n = await phone.$$eval(`${g} > [aria-pressed]`, (bs) => bs.length);
      for (let i = 0; i < n; i++) {
        await phone.locator(`${g} > [aria-pressed]`).nth(i).click();
        const st = await phone.$$eval(`${g} > [aria-pressed]`, (bs) => bs.map((b) => b.getAttribute('aria-pressed')));
        check(st.every((a, j) => a === String(j === i)), `${g} の ${i + 1} 番目を押すと、そのボタンだけが選ばれた印になる`);
      }
    }
  }
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

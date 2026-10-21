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
  // 耳は ear-worker.js（Worker）の中で動くので、にせものは画面の検査用の値（__asr・__heard など）を画面とやりとりして読み書きする
  tf: `const inPage = typeof window !== 'undefined';
let seq = 0; const waits = new Map();
if (!inPage) self.addEventListener('message', (e) => { const d = e.data; if (d && d.__qaRe) { waits.get(d.__qaRe)?.(d.v); waits.delete(d.__qaRe); } });
const qa = (kind, v) => (inPage ? Promise.resolve(window.__qaEar(kind, v)) : new Promise((ok) => { const id = ++seq; waits.set(id, ok); self.postMessage({ __qa: id, kind, v }); }));
export const env = { backends: { onnx: { wasm: {} } } };
export class Tensor { constructor(type, data, dims) { Object.assign(this, { type, data, dims }); } }
export async function pipeline(task, model, opts) {
  await qa('asr-init', { task, model, device: opts.device, revision: opts.revision });
  opts.progress_callback?.({ status: 'progress', progress: 50, file: 'encoder_model.onnx' });
  await fetch('https://huggingface.co/' + model + '/resolve/main/config.json');
  return async (audio, o) => ({ text: await qa('asr', { n: audio.length, lang: o.language }) });
}
let n = 0;
export const AutoModel = { from_pretrained: async (id) => {
  await fetch('https://huggingface.co/' + id + '/resolve/main/onnx/model.onnx');
  return async ({ state }) => { n++; qa('vad', n); return { output: { data: [n % 40 < 10 ? 0.9 : 0.05] }, stateN: state }; };
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
  // ボードの元（マージ済み）。毎朝の写し board/index.html より先に読む
  'board-src/kanban.html': BOARD.replace(/<\/body>/i, '<!--lk-board-src--></body>'),
  // Claude を起こす印（データ側の app-inbox ブランチ）
  'local-board/inbox.json': '{"pending":false}\n',
  'board/today.json': JSON.stringify({ items: [{ title: '見本の予定', start: '2099-01-05T14:30:00+09:00' }] }),
};
let cardsText = null; // ほかの端末・Claude が書いたあとの cards.json（null なら見本のまま）
let conflictOnce = false;
let inboxBranch = true; // データ側に app-inbox ブランチがあるか
let failPuts = false; // true のあいだ保存は失敗する（GitHub に届かない） // true にすると、次の cards.json の保存を 1 回だけ「ほかの端末が先に書いた」にする

// 耳（Whisper）のにせもの：window.__heard を順に「聞こえた」ことにする。localai.js の本物の耳と替わらないよう、Voice ができたときに入れて固定する。
// 押している間だけ聞く（hold）は、release()（離した）で聞いた分を返す。addInitScript に渡す（外の変数は使わない）
const fakeEar = () => {
  window.__heard = window.__heard || []; window.__earCalls = [];
  const fake = {
    ready: () => true,
    listen: ({ hold } = {}) => new Promise((ok, ng) => {
      window.__earCalls.push({ hold: !!hold });
      if (window.__earFail) { const e = new Error('マイクを使えませんでした'); e.code = window.__earFail; window.__earFail = ''; setTimeout(() => ng(e), 100); return; }
      const go = () => { const t = window.__heard.shift(); setTimeout(() => (t ? ok({ text: t }) : ng(new Error('聞き取れませんでした'))), t ? 80 : 400); };
      if (hold) { window.__srHold = (window.__srHold || 0) + 1; window.__earRelease = go; } else go();
    }),
    cancel() {},
    release() { const f = window.__earRelease; window.__earRelease = null; f?.(); },
  };
  let V;
  Object.defineProperty(window, 'Voice', { configurable: true, get() { return V; }, set(v) { V = v; v.useEar(fake); v.useEar = () => {}; } });
};

const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
// 本物の SpeechRecognition.available()・install() は、CI の headless Chrome では音声の部品が無くタブごと落ちる
// （Target crashed。2026-10-20 に2回）。どのコンテキストでも「端末の中では日本語を聞けない端末」のふりにしておく。
// 各検査が自分のにせもの（addInitScript）を入れれば、あとから入るそちらが勝つ。
{
  const open = browser.newContext.bind(browser);
  browser.newContext = async (o) => {
    const c = await open(o);
    await c.addInitScript(() => {
      try { if (!localStorage.getItem('lk.slim')) localStorage.setItem('lk.slim', '1'); } catch { /* なくてよい */ } // 「減らして固める」の1回だけの知らせは、それを見る検査だけで出す
      for (const k of ['SpeechRecognition', 'webkitSpeechRecognition']) {
        const C = window[k];
        if (C) { C.available = async () => 'unavailable'; C.install = async () => false; }
      }
      // 耳のにせもの（Worker の中）が、画面の検査用の値を読み書きできるようにする（本物の耳は使わない）
      window.__qaEar = (kind, v) => {
        if (kind === 'asr-init') { window.__asr = v; return null; }
        if (kind === 'asr') { (window.__asrCalls ||= []).push(v); return window.__heard?.shift() || ''; }
        if (kind === 'vad') { window.__vadCalls = v; return null; }
        return null;
      };
      const W = window.Worker;
      if (W) window.Worker = class extends W {
        constructor(u, o) {
          super(u, o);
          this.addEventListener('message', (e) => { const d = e.data; if (d && d.__qa) { e.stopImmediatePropagation(); this.postMessage({ __qaRe: d.__qa, v: window.__qaEar(d.kind, d.v) }); } });
        }
      };
      // アプリのアイコンの数（Badging API）を覚えておく
      navigator.setAppBadge = async (n) => { window.__badge = n; };
      navigator.clearAppBadge = async () => { window.__badge = 0; };
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
    if (/\/branches\/app-inbox$/.test(path)) return inboxBranch ? route.fulfill({ json: { name: 'app-inbox' } }) : route.fulfill({ status: 404, json: { message: 'Branch not found' } });
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
  if (/status of 404/.test(m.text()) && /pochi-memory\.json/.test(m.location()?.url || '')) return;
  if (/status of 404/.test(m.text()) && /inbox\.json|branches\/app-inbox/.test(m.location()?.url || '')) return; // 印のファイル・ブランチが無いときの検査 // まだ何も覚えていない（初めは無いファイル）
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
  check(await page.evaluate(() => (localStorage.getItem('lk.board') || '').includes('<!--lk-board-src-->')), 'ボードは毎朝の写しより先に、マージ済みの元（board-src/kanban.html）を読む（新しい機能がその日のうちに届く）');
  check(await page.evaluate((b) => LK.boardOk(b) && !LK.boardOk('<html><body><div id="board"></div></body></html>') && !LK.boardOk(null), BOARD), 'アプリが当てにする部品（#board・move・openDetail・say・render・WPS）が無いボードの元は使わず、毎朝の写しで開く');
  check(/ボードを新しい版にしました/.test(await page.textContent('#lkStatus')), `ボードが新しくなって開き直したら、状態の1行で知らせる（${await page.textContent('#lkStatus')}）`);
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
    await page.click('#lkMenu summary'); await page.click('#lkMenu [data-m=look]');
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
    {
      const t0 = Date.now(); let pings = [];
      while (Date.now() - t0 < 8000 && !(pings = puts.filter((x) => x.path === 'local-board/inbox.json')).length) await page.waitForTimeout(100);
      const p0 = pings[0];
      check(!!p0 && p0.body.branch === 'app-inbox' && /"pending":true/.test(p0.text), `答えたら、Claude を起こす印を app-inbox ブランチに置く（毎時を待たずに届く）（${p0?.body.branch}）`);
      check(!!p0 && !/見本|はい|example|token/i.test(p0.text) && Object.keys(JSON.parse(p0.text)).sort().join() === 'at,n,pending', `印にはカードの中身を入れない（時刻と件数だけ）（${p0?.text?.trim()}）`);
      const before = pings.length;
      await page.evaluate(() => LK.update('s3', { note: '印のテスト' }, 'メモ'));
      await page.waitForTimeout(2500);
      check(puts.filter((x) => x.path === 'local-board/inbox.json').length === before, '同じ答えでは印を2回置かない（ほかの変更の保存では置かない）');
      // ブランチはあるのに印のファイルだけ無い：sha なしで新しく作る。ブランチも無ければ何もしない
      const keep = files['local-board/inbox.json']; delete files['local-board/inbox.json'];
      const made = await page.evaluate(() => LK.store.ping(1));
      const p1 = puts.filter((x) => x.path === 'local-board/inbox.json').at(-1);
      check(made === true && p1 && !('sha' in p1.body) && p1.body.branch === 'app-inbox', `印のファイルが無くても、ブランチがあれば sha なしで作る（${made}・${p1 && JSON.stringify(Object.keys(p1.body))}）`);
      inboxBranch = false; const n1 = puts.length;
      const none = await page.evaluate(() => LK.store.ping(1));
      check(none === false && puts.length === n1, 'app-inbox ブランチが無ければ印を置かない');
      inboxBranch = true; files['local-board/inbox.json'] = keep;
      check(await page.evaluate(() => /^example-owner\/example-data@main\|/.test(LK.ls.get('woke') || '')), '起こした印の記録は、つなぎ先（リポジトリ・ブランチ）ごと');
      await page.evaluate(() => LK.update('s3', { note: '見本の補足（AI に渡さない）' }, 'メモ'));
      await page.waitForTimeout(1500);
    }

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

    // 保存に失敗した変更の理由は、次に保存できたときの題（コミット）に残す（失敗した分の理由を先に消していた）
    {
      failPuts = true;
      await page.evaluate(() => move('s3', 'hold'));
      await page.waitForTimeout(1500);
      await page.evaluate(() => move('s3', 'later'));
      failPuts = false;
      await waitCards((cs) => cs.find((c) => c.doc_id === 's3')?.lane === 'later', '失敗のあとの保存');
      const m = [...puts].reverse().find((p) => p.path === 'local-board/cards.json')?.body.message || '';
      check(/保留.*ほか 1 件/.test(m), `保存に失敗した変更も、次の保存の題に数える（${m}）`);
      await page.evaluate(() => move('s3', 'next'));
      await waitCards((cs) => cs.find((c) => c.doc_id === 's3')?.lane === 'next', '元に戻す');
    }

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
      after.push({ doc_id: 's10', title: '見本の答え待ち', owner: 'agent', lane: 'agent', live_bucket: 'BLOCKED' });
      after.push({ doc_id: 's11', title: '見本の済み', owner: 'agent', lane: 'done', done_at: '2099-01-01T00:00:00Z' });
      cardsText = JSON.stringify(after);
      await pg.evaluate(() => LK.reload());
      await pg.waitForTimeout(500);
      const notes = await pg.evaluate(() => window.__notes);;
      check(notes.some((n) => /ポチ：確認が来てるよ｜見本の新しい問い/.test(n)), `確認が来たら知らせた（${notes.join(' / ') || 'なし'}）`);
      check(notes.some((n) => /ポチ：satouさんの番だよ｜見本のカード（エージェント）/.test(n)), 'エージェントから satouさんの番に戻ったら知らせた');
      check(notes.some((n) => /ポチ：今日までだよ！｜見本の今日が期限/.test(n)), '今日が期限のカードを、ポチの言葉で知らせた');
      check(notes.some((n) => /ポチ：Claude が待ってるよ｜見本の答え待ち/.test(n)), 'Claude が答えを待っているカード（畳んだ進行中の列の中）を知らせた（ボード v53）');
      check(!notes.some((n) => /見本の済み/.test(n)), '済んだものは知らせない（ボードの「済み」のまとめで見る）');
      const n1 = notes.length;
      await pg.evaluate(() => LK.reload()); await pg.waitForTimeout(300);
      check(await pg.evaluate(() => window.__notes.length) === n1, '同じことは二度知らせない');
      // satouさんが答えたあとに、また Claude が待ちになったら、もう一度知らせる（v37 の点検）
      cardsText = JSON.stringify(after.map((c) => (c.doc_id === 's10' ? { ...c, history: [{ at: '2099-01-02T00:00:00Z', who: 'you', text: '答えた' }] } : c)));
      await pg.evaluate(() => LK.reload()); await pg.waitForTimeout(400);
      check((await pg.evaluate(() => window.__notes.slice(-3))).some((n) => /Claude が待ってるよ｜見本の答え待ち/.test(n)) && await pg.evaluate((n) => window.__notes.length, n1) > n1, '答えたあとにまた Claude が待ちになったら、もう一度知らせる');
      // 知らせを押すとそのカードが開く（sw.js が #card=<id> を付けて開く）
      await Promise.all([pg.waitForNavigation(), pg.evaluate(() => { history.replaceState(null, '', location.pathname + '#card=s10'); location.reload(); })]); await ready(pg);
      check(await pg.waitForFunction(() => document.querySelector('dialog#detail')?.open, null, { timeout: 8000 }).then(() => true, () => false) && !(await pg.evaluate(() => location.hash)).includes('card'), '知らせを押すと、そのカードの詳細が開く（#card=<id>）');
      check(/postMessage\(\{ card: id \}\)/.test(readFileSync(resolve(root, 'sw.js'), 'utf8')), 'sw.js が知らせのカードを開いている画面へ渡す');
      // 初めての端末ではボードを取って開き直す。そのときも URL から来た操作（#card・#add など）をなくさない
      await pg.keyboard.press('Escape');
      await Promise.all([pg.waitForNavigation(), pg.evaluate(() => { sessionStorage.setItem('lk.entry', JSON.stringify({ card: 's1' })); location.reload(); })]); await ready(pg);
      check(await pg.waitForFunction(() => document.querySelector('dialog#detail')?.open, null, { timeout: 8000 }).then(() => true, () => false) && await pg.evaluate(() => !sessionStorage.getItem('lk.entry')), '開き直しても URL から来た操作をなくさない（開き直す前に取っておいた操作を、開いたあとに行う）');
      cardsText = null;
      await pg.evaluate(() => { localStorage.setItem('lk.notify', 'false'); localStorage.removeItem('lk.notified'); });
      await pg.close();
    }

    // 画面に戻ったら（1分以上たっていたら）読み直す
    check(/visibilitychange/.test(readFileSync(resolve(root, 'shim.js'), 'utf8')), '画面に戻ったら読み直す仕組みがある');
  }
  // ---------- 🤖 ほかの AI に渡す・AI の返事を貼る（2026-10-21 satouさん「claude 以外の AI も」） ----------
  // 共有（navigator.share）とクリップボードはにせものに替える。渡す文に鍵・リポジトリ名・連絡先が入らないこと、返事を貼ると一覧が出て取り込め、戻せること
  {
    const pg = await context.newPage();
    pg.on('pageerror', (e) => errors.push(`pageerror(AI に渡す): ${e.message}`));
    await pg.addInitScript(() => {
      window.__shared = []; window.__clip = '';
      // 共有の画面はスマホ（指で押す端末）だけで使う。ここではスマホのふりをする
      window.__coarse = true; const mm = window.matchMedia.bind(window);
      window.matchMedia = (q) => (q === '(pointer:coarse)' ? { matches: window.__coarse, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; } } : mm(q));
      navigator.share = async (d) => { window.__shared.push(d.text); };
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t) => { window.__clip = t; }, readText: async () => window.__clipIn || '' } });
    });
    const s12 = { doc_id: 's12', title: '見本の渡すカード', owner: 'you', lane: 'now', order: 3, due: '2099-01-10',
      note: '電話 090-1234-5678、連絡は taro@example.com へ。住所は東京都千代田区丸の内1-2-3。データは example-owner/example-data にある。2026-10-21 に 3 件',
      history: [{ at: '2099-01-01T00:00:00Z', who: 'you', text: '鍵は qa-dummy-token だった' }, { at: '2099-01-02T00:00:00Z', who: 'claude', text: '見本の返事 03-1234-5678' }] };
    cardsText = JSON.stringify([...SAMPLE, s12]);
    await pg.goto(base); await ready(pg);
    await pg.evaluate(() => LK.reload()); await pg.waitForFunction(() => LK.cards.some((c) => c.doc_id === 's12'), null, { timeout: 5000 });
    // ポチの会話の中身が渡す文に入らないこと（会話の欄に書いてから渡す）
    await pg.evaluate(() => { const d = document.createElement('div'); d.className = 'l you'; d.textContent = '会話のひみつの話'; document.querySelector('#talkLog').appendChild(d); });
    await pg.evaluate(() => openDetail('s12'));
    const hb = await pg.waitForSelector('dialog#detail[open] #lkHand', { timeout: 5000 }).then((h) => h.boundingBox(), () => null);
    check(!!hb && hb.height >= 44 && hb.width >= 44 && await pg.getAttribute('#lkHand', 'aria-label') === 'AI に渡す（ほかの AI）', `カードの詳細に「🤖 ほかの AI に渡す」が出る（44px 以上・名前つき。${hb ? Math.round(hb.width) + 'x' + Math.round(hb.height) : 'なし'}）`);
    await pg.click('#lkHand');
    await pg.waitForFunction(() => window.__shared.length > 0, null, { timeout: 3000 }).catch(() => {});
    const t1 = await pg.evaluate(() => window.__shared[0] || '');
    check(/題：見本の渡すカード/.test(t1) && /ID：s12/.test(t1) && /```json\n\{"kanban_reply":1,"card":"s12"/.test(t1) && /1つだけ返して/.test(t1) && /期限：2099-01-10/.test(t1), '渡す文に題・ID・期限・返事の決まった形（```json の kanban_reply）がある（共有で渡した）');
    check(!/qa-dummy-token|example-data/.test(t1), '渡す文に鍵・データのリポジトリ名が入らない');
    check(!/090-1234-5678|03-1234-5678|taro@example\.com|丸の内1-2-3/.test(t1) && /［電話］/.test(t1) && /［メール］/.test(t1) && /［住所］/.test(t1), '渡す文の電話番号・メールアドレス・住所は伏せ字になる');
    check(/2026-10-21 に 3 件/.test(t1), '日付や数は伏せ字にしない');
    check(!/ひみつの話/.test(t1) && /本人：/.test(t1) && /Claude：見本の返事/.test(t1), '渡す文に最近の記録は入り、ポチの会話の中身は入らない');
    // PC（指で押さない端末）では、共有があってもコピー（v43 の点検：PC で OS の共有画面が出て迷う）
    await pg.evaluate(() => { window.__coarse = false; });
    await pg.click('#lkHand');
    await pg.waitForFunction(() => !!window.__clip, null, { timeout: 3000 }).catch(() => {});
    const t2 = await pg.evaluate(() => window.__clip);
    check(t2 === t1 && await pg.evaluate(() => window.__shared.length === 1), 'PC では共有の画面を出さず、同じ文をクリップボードにコピーする');
    // 共有が無いスマホでもコピー
    await pg.evaluate(() => { window.__coarse = true; window.__clip = ''; navigator.share = undefined; });
    await pg.click('#lkHand');
    await pg.waitForFunction(() => !!window.__clip, null, { timeout: 3000 }).catch(() => {});
    check(await pg.evaluate(() => window.__clip) === t1, '共有が無い端末では、同じ文をクリップボードにコピーする');
    // 渡したカードの詳細には「🤖 返事を貼る」も出る（行きと帰りを同じ所に。v43 の点検）
    check(/伏せました/.test(await pg.evaluate(() => document.querySelector('#toast-msg')?.textContent || document.querySelector('#lkStatus')?.textContent || '')), '渡したら、伏せ字にしたものと残るものを知らせる');
    await pg.evaluate(() => { document.querySelector('dialog#detail').close(); openDetail('s12'); });
    const hp = await pg.waitForSelector('dialog#detail[open] #lkHandPaste', { timeout: 3000 }).then(() => true, () => false);
    check(hp, '渡したカードの詳細に「🤖 返事を貼る」が出る');
    if (hp) { await pg.click('#lkHandPaste'); check(await pg.evaluate(() => document.querySelector('#lkPaste').open), '「🤖 返事を貼る」で貼る欄が開く'); await pg.evaluate(() => document.querySelector('#lkPaste').close()); }
    check(await pg.evaluate(async () => { document.querySelector('dialog#detail').close(); openDetail('s1'); await new Promise((r) => setTimeout(r, 50)); return !document.querySelector('dialog#detail #lkHandPaste'); }), '渡していないカードには「返事を貼る」を出さない（押す所を増やさない）');
    await pg.evaluate(() => { document.querySelector('dialog#detail').close(); openDetail('s12'); });
    const t3 = await pg.evaluate(() => LK.handText('s2'));
    check(/確認：見本の問い\n選択肢：はい／いいえ/.test(t3), '確認のカードは、問いと選択肢も渡す');
    const m = await pg.evaluate(() => [LK.mask('〒100-0005 東京都千代田区丸の内1丁目2番3号'), LK.mask('さいたま市大宮区桜木町1-7-5 に行く'), LK.mask('+81 90 1234 5678'), LK.mask('第1-2回の会議・10-21・0120-12-345'), LK.mask('鍵 github_pat_ABC123')]);
    check(m[0] === '［住所］' && /^［住所］ に行く$/.test(m[1]) && m[2] === '［電話］' && m[3] === '第1-2回の会議・10-21・0120-12-345' && m[4] === '鍵 ［鍵］', `伏せ字の形（${m.join(' / ')}）`);
    await pg.keyboard.press('Escape'); await pg.waitForTimeout(200);
    if (await pg.evaluate(() => document.querySelector('dialog#detail')?.open)) await pg.evaluate(() => document.querySelector('dialog#detail').close());

    // 返事を貼る
    const paste = async (txt) => { await pg.fill('#lkPasteIn', txt); await pg.waitForTimeout(50); return pg.evaluate(() => ({ msg: document.querySelector('#lkPasteMsg').textContent, items: [...document.querySelectorAll('#lkPasteList:not([hidden]) li')].map((l) => l.textContent), go: !document.querySelector('#lkPasteGo').disabled })); };
    await pg.click('#lkMenu summary'); await pg.click('#lkMenu [data-m=aipaste]');
    check(await pg.evaluate(() => document.querySelector('#lkPaste').open), '「⋯ → 🤖 AI の返事を貼る」で貼る欄が開く');
    const before = await pg.evaluate(() => JSON.stringify(LK.cards.find((c) => c.doc_id === 's12')));
    const bad = [
      ['返事に JSON が無い', 'そうですね、まずは資料を集めましょう。', /見つかりません/],
      ['JSON が崩れている', '```json\n{"kanban_reply":1,"card":"s12",}\n```', /崩れて/],
      ['kanban_reply が違う', '```json\n{"kanban_reply":2,"card":"s12","note_add":"x"}\n```', /別の形/],
      ['知らないカード', '```json\n{"kanban_reply":1,"card":"nope","note_add":"x"}\n```', /「nope」が見つかりません/],
      ['card が無い', '```json\n{"kanban_reply":1,"note_add":"x"}\n```', /どのカード/],
    ];
    for (const [label, txt, re] of bad) { const r = await paste(txt); check(re.test(r.msg) && !r.go && !r.items.length, `形が違う返事（${label}）は理由を日本語で言い、取り込めない（${r.msg}）`); }
    check(await pg.evaluate(() => JSON.stringify(LK.cards.find((c) => c.doc_id === 's12'))) === before, '形が違う返事では何も変えない');
    const ok = await paste('いい案です。\n\n```json\n{"kanban_reply":1,"card":"s12","note_add":"先に資料を集める","lane":"next","due":"2099-02-03","comment":"AI の見立て"}\n```\n以上です。');
    check(ok.go && ok.items.length === 4 && ok.items.some((x) => /今やる → 次にやる/.test(x)) && ok.items.some((x) => /2099-02-03/.test(x)) && ok.items.some((x) => /先に資料を集める/.test(x)), `返事を貼ると、変わる所が一覧で出る（${ok.items.join(' / ')}）`);
    await pg.click('#lkPasteGo');
    await waitCards((cs) => { const c = cs.find((x) => x.doc_id === 's12'); return c?.lane === 'next' && c.due === '2099-02-03'; }, 'AI の返事の取り込み');
    const c12 = lastCards().find((c) => c.doc_id === 's12');
    const h12 = (c12?.history || []).at(-1) || {};
    check(/AI：先に資料を集める$/.test(c12?.note || '') && c12?.moves?.at(-1)?.to === 'next', '取り込むと、メモに足して列を移す');
    check(h12.who === 'AI' && /AI の見立て/.test(h12.text || '') && (c12.history || []).filter((h) => h.who === 'AI').length === 1, `履歴に who「AI」で1行残る（${h12.text}）`);
    check(!(await pg.evaluate(() => document.querySelector('#lkPaste').open)) && await pg.isVisible('#toast-undo'), '取り込んだら閉じて「戻す」を出す');
    await pg.click('#toast-undo');
    await waitCards((cs) => { const c = cs.find((x) => x.doc_id === 's12'); return c?.lane === 'now' && c.due === '2099-01-10'; }, 'AI の返事の「戻す」');
    check(!/先に資料/.test(lastCards().find((c) => c.doc_id === 's12')?.note || ''), '「戻す」で取り込む前に戻る（メモも）');
    // 決まった値以外の lane・due・answer は捨てる（ほかは取り込む）
    await pg.waitForTimeout(1000);
    await pg.click('#lkMenu summary'); await pg.click('#lkMenu [data-m=aipaste]');
    const odd = await paste('```json\n{"kanban_reply":1,"card":"s12","note_add":"見直す","lane":"agent","due":"来週","answer":"はい"}\n```');
    check(odd.go && odd.items.length === 1 && /列「agent」/.test(odd.msg) && /期限「来週」/.test(odd.msg) && /答え「はい」/.test(odd.msg), `決まった値でない lane・due・answer は捨てると言う（${odd.msg}）`);
    await pg.click('#lkPasteGo');
    await waitCards((cs) => /AI：見直す$/.test(cs.find((x) => x.doc_id === 's12')?.note || ''), '値を捨てた返事の取り込み');
    check(lastCards().find((c) => c.doc_id === 's12')?.lane === 'now', '決まった値でない lane は捨て、列は変えない');
    const ans = await pg.evaluate(() => [LK.planReply('```json\n{"kanban_reply":1,"card":"s2","answer":"はい"}\n```'), LK.planReply('```json\n{"kanban_reply":1,"card":"s2","answer":"たぶん"}\n```')]);
    check(ans[0].answer === 'はい' && !ans[1].answer && /変える所がありません/.test(ans[1].why || ''), '答えは確認の選択肢の label だけ受け取る');
    check(ans[0].lines.some((x) => /^列：/.test(x)), `答えだけの返事でも、Claude の列へ移ることを一覧で見せる（${ans[0].lines.join(' / ')}）`);
    const curly = await pg.evaluate(() => [LK.planReply('```json\n{"kanban_reply":1,"card":"s12","note_add":"“重要”を確認"}\n```'), LK.planReply('```json\n{“kanban_reply”:1,“card”:“s12”,“note_add”:“見直す”}\n```')]);
    check(curly[0].note === '“重要”を確認', `メモの中の “” はそのまま読む（${curly[0].note || curly[0].why}）`);
    check(curly[1].note === '見直す', `引用符が全部 “” になった返事も読める（${curly[1].note || curly[1].why}）`);
    const curly2 = await pg.evaluate(() => [LK.planReply('{“kanban_reply”:1,“card”:“s12”,“note_add”:“彼は“OK”と言った”}'), LK.planReply('見本：\n```json\n{"kanban_reply":1,"card":"s12","note_add":"メモに足す一言"}\n```\n答え：\n```json\n{"kanban_reply":1,"card":"s12","note_add":"後ろの答え"}\n```')]);
    check(/全角/.test(curly2[0].why || '') && /半角/.test(curly2[0].why || ''), `引用符が全角で読めないときは、直し方（半角で出し直す）を言う（${curly2[0].why}）`);
    check(curly2[1].note === '後ろの答え', `見本を引用したあとの本当の返事を読む（後ろの候補から）（${curly2[1].note || curly2[1].why}）`);
    const smp = await pg.evaluate(() => LK.planReply('```json\n{"kanban_reply":1,"card":"s12","note_add":"メモに足す一言","lane":"now|next|later|hold|done（任意）","comment":"…（任意）"}\n```'));
    check(!smp.note && !smp.comment && /変える所がありません/.test(smp.why || '') && /見本の文のまま/.test(smp.why || ''), `返事の形の見本の文をそのまま返されても取り込まない（${smp.why}）`);
    check(await pg.evaluate(() => { const d = document.querySelector('#lkPaste'); return d.open ? false : true; }), '取り込んだら貼る欄を閉じる');
    await pg.waitForTimeout(1500);
    cardsText = null;
    await pg.close();
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
  await noVoice.waitForSelector('#talkSet[open]', { timeout: 3000 }).catch(() => {});
  await noVoice.waitForFunction(() => document.activeElement?.id === 'earGet', null, { timeout: 3000 }).catch(() => {}); // フォーカスは少しおいて移す（CI は遅い）
  check(/聞き取りの部品/.test(await noVoice.textContent('#vstatus')) && await noVoice.evaluate(() => document.querySelector('#talkSet').open && /聞き取りを入れる/.test(document.querySelector('#earGet').textContent) && document.activeElement?.id === 'earGet'), `耳（Whisper）が無いと、🎤で「聞き取りを入れる」のボタンを開いて知らせる（${await noVoice.textContent('#vstatus')}）`);
  {
    const hl = await noVoice.evaluate(() => ({ msg: document.querySelector('#earMsg').textContent, hl: document.querySelector('#earBox').classList.contains('lk-hl'), name: document.querySelector('#earProg').getAttribute('aria-label') || '' }));
    check(/1回入れます/.test(hl.msg) && hl.hl && !!hl.name, `🎤から開いた設定の耳の欄に、なぜ開いたかを書き（ダイアログの裏に隠れない）、欄を目立たせる。進み具合に名前がある（${JSON.stringify(hl)}）`);
    check(/打って話してね/.test(await noVoice.evaluate(() => { document.querySelector('#talkSet').close(); document.querySelector('#talkBtn').click(); return document.querySelector('#talkIn').placeholder; })), '耳が無いときは、打つ欄に「🎤で話しても」と書かない');
    await noVoice.evaluate(() => document.querySelector('#talkDlg').open && document.querySelector('#talkDlg').close());
  }
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
  await mic.addInitScript(fakeEar);
  await mic.addInitScript(() => {
    window.__heard = ['見本のカードを済み', '2番']; window.__spoken = [];
    window.webkitSpeechRecognition = class { start() { window.__srUsed = true; } }; delete window.SpeechRecognition; // Chrome の聞き取りがあっても使わない
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
  check(await mic.evaluate(() => document.querySelector('#talkDlg').open && [...document.querySelectorAll('#talkLog .you')].map((d) => d.textContent.replace(/^あなた：/, '')).join('|') === '見本のカードを済み|2番'), '🎤 ボードの🎤も会話と同じ欄を開き、話したことを文字で同じ流れに残す');
  check(await mic.evaluate(() => Voice.localVoice()?.name === '端末の声'), '🎤 読み上げは端末の中の声を選ぶ（ネット経由の声は使わない）');
  check(await mic.evaluate(() => { const g = speechSynthesis.getVoices; speechSynthesis.getVoices = () => [{ name: 'ネットの声', lang: 'ja-JP', localService: false }]; const n = Voice.localVoice(); speechSynthesis.getVoices = g; return n === null; }), '🎤 端末の中の声が無ければ読み上げない');
  check(await mic.evaluate(() => window.__earCalls.length >= 2 && !window.__srUsed), '🎤 耳（Whisper）だけで聞いた（Chrome の聞き取りは使わない）');
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

  // 🎤（2026-10-21 satouさん Pixel「マイクを押してもすぐ OFF」→「減らして固める」）：耳は Whisper だけ。
  // Chrome の聞き取りがあっても使わない（Android ではマイクの取り合いで話す前に止まった）。割り込み用のマイクを持ったままでも、押す → 話す → 文字が出てカードが動く
  {
    const pg = await context.newPage();
    pg.on('pageerror', (e) => errors.push(`pageerror(🎤 耳だけ): ${e.message}`));
    await pg.addInitScript(fakeEar);
    await pg.addInitScript(() => {
      window.__heard = ['見本のカード（次にやる・毎週）を保留へ', 'ありがとう', '終わり']; window.__spoken = []; window.__live = 0; window.__srStarts = 0;
      class FakeSR { static available() { return Promise.resolve('available'); } start() { window.__srStarts++; setTimeout(() => { this.onerror?.({ error: 'audio-capture' }); this.onend?.(); }, 100); } stop() {} abort() {} }
      window.webkitSpeechRecognition = FakeSR; window.SpeechRecognition = FakeSR;
      navigator.mediaDevices.getUserMedia = async () => { const ac = new AudioContext(); const o = ac.createOscillator(); const d = ac.createMediaStreamDestination(); o.connect(d); o.start(); window.__live++; return d.stream; };
      window.speechSynthesis.getVoices = () => [{ name: '端末の声', lang: 'ja-JP', localService: true }];
      window.speechSynthesis.speak = (u) => { window.__spoken.push(u.text); setTimeout(() => u.onend && u.onend(), 10); };
      window.speechSynthesis.cancel = () => {};
      if (!sessionStorage.getItem('qa.bi')) { sessionStorage.setItem('qa.bi', localStorage.getItem('lk.talk') || ''); const t = JSON.parse(localStorage.getItem('lk.talk') || '{}'); t.bargeIn = true; localStorage.setItem('lk.talk', JSON.stringify(t)); }
    });
    await pg.goto(base); await ready(pg);
    await pg.click('#micBtn');
    await waitCards((cs) => cs.find((c) => c.doc_id === 's3')?.lane === 'hold', '🎤（耳だけ）で「保留」');
    await pg.waitForTimeout(800);
    const r = await pg.evaluate(() => ({ you: [...document.querySelectorAll('#talkLog .you')].map((d) => d.textContent.replace(/^あなた：/, '')), sr: window.__srStarts, live: window.__live, sys: [...document.querySelectorAll('#talkLog .sys')].map((d) => d.textContent).join(' / '), mic: document.querySelector('#talkMic').getAttribute('aria-pressed') }));
    check(r.you[0] === '見本のカード（次にやる・毎週）を保留へ' && r.sr === 0 && !/audio-capture|止めた/.test(r.sys), `🎤：耳（Whisper）だけで聞き、押す → 話す → 文字が出てカードが動く。Chrome の聞き取りは使わない（${r.you.join('|')}・Chrome ${r.sr} 回｜${r.sys}）`);
    check(r.live >= 1, `🎤：耳で聞くあいだも、割り込み用のマイクを持てる（${r.live}）`);
    await pg.evaluate(() => move('s3', 'next'));
    await waitCards((cs) => cs.find((c) => c.doc_id === 's3')?.lane === 'next', '🎤（耳だけ）のあと元に戻す');
    await pg.evaluate(() => { const k = sessionStorage.getItem('qa.bi'); k ? localStorage.setItem('lk.talk', k) : localStorage.removeItem('lk.talk'); });
    await pg.close();
  }
  // 「減らして固める」を入れた最初の1回：前の版で AI を使っていた端末も AI を切り、そのことを会話の欄で1回だけ言う
  {
    const pg = await context.newPage();
    pg.on('pageerror', (e) => errors.push(`pageerror(減らして固める): ${e.message}`));
    await pg.addInitScript(() => { if (!sessionStorage.getItem('qa.once')) { sessionStorage.setItem('qa.once', '1'); localStorage.removeItem('lk.slim'); localStorage.setItem('lk.talk', JSON.stringify({ ai: 'auto', name: 'ポチ' })); } });
    await pg.goto(base); await ready(pg);
    await pg.click('#talkBtn');
    await pg.waitForFunction(() => /ポチを軽くしたよ/.test(document.querySelector('#talkLog')?.textContent || ''), null, { timeout: 5000 }).catch(() => {});
    const r = await pg.evaluate(() => ({ log: document.querySelector('#talkLog').textContent, ai: JSON.parse(localStorage.getItem('lk.talk') || '{}').ai, slim: localStorage.getItem('lk.slim') }));
    check(/ポチを軽くしたよ/.test(r.log) && r.ai === 'off' && r.slim === '1', `減らして固める：前に AI を使っていた端末も1回だけ AI を切り、そう言う（${r.ai}）`);
    await pg.evaluate(() => localStorage.removeItem('lk.talk'));
    await pg.close();
  }
  // ---------- 会話モード（talk.js）：耳・頭・口をにせものに差し替えて、流れと「外に出さない」を確かめる ----------
  const talkPage = async ({ heard = [], replies = null, sr = true }, label) => {
    const pg = await context.newPage();
    pg.on('pageerror', (e) => errors.push(`pageerror(${label}): ${e.message}`));
    const outside = [];
    pg.on('request', (r) => { const h = new URL(r.url()).host; if (!/^127\.0\.0\.1(:\d+)?$/.test(h) && h !== 'api.github.com' && !r.url().startsWith('data:')) outside.push(r.url()); });
    if (sr) await pg.addInitScript(fakeEar); // 耳（Whisper）のにせもの。sr: false なら耳が無い端末
    await pg.addInitScript(({ heard, replies }) => {
      window.__heard = heard; window.__spoken = []; window.__prompts = []; window.__system = '';
      delete window.webkitSpeechRecognition; delete window.SpeechRecognition;
      { const t = JSON.parse(localStorage.getItem('lk.talk') || '{}'); t.ai = replies ? 'auto' : 'off'; localStorage.setItem('lk.talk', JSON.stringify(t)); } // AI は入れた人だけ（⚙ で AI を使う）
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
    }, { heard, replies });
    // lk.talk は端末どうしで同じにする設定（local-board/settings.json）。前の検査が保存した AI の入り切りが勝たないよう、ここでは消しておく
    try { const sj = JSON.parse(files['local-board/settings.json']); if (sj.values?.['lk.talk']) { delete sj.values['lk.talk']; if (sj.at) delete sj.at['lk.talk']; files['local-board/settings.json'] = JSON.stringify(sj); } } catch { /* なくてよい */ }
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
    // 読む順はボードの並び（本物のボード版48からは prioCmp。答えていない確認 s2 が s1 より先になる）
    const [q1, q2] = (await pg.evaluate(() => LK.queueTitles('now'))).map((t) => SAMPLE.find((c) => c.title === t)?.doc_id);
    await pg.click('#talkBtn');
    await waitTalkEnd(pg);
    const spoken = await pg.evaluate(() => window.__spoken.join(''));
    check(/見本のカード、?今やる/.test(spoken), '会話（AI なし）：最初に「今やる」の1枚目を読み上げた');
    check(/AI なし/.test(await pg.textContent('#talkMode')), '会話（AI なし）：内蔵 AI が無い端末では AI なしで動く');
    check(/AI なし/.test(await pg.textContent('#talkMode')) && !/AI を入れると/.test(await pg.textContent('#talkLog')), '会話（AI なし）：AI なしで話していることは上の札だけで伝え、会話の中で同じことを言わない');
    const phr = await pg.evaluate(() => Talk.PHRASES.done);
    check(phr.some((p) => spoken.includes(p)), '会話（AI なし）：「済み」でほめた');
    const moods = await pg.evaluate(() => ({ m: window.__moods, c: window.__confetti }));
    check(moods.m.includes('happy') && moods.m.includes('listen') && moods.c === 0, `キャラの見た目：聞くときは耳を動かし、1枚済みにしたら笑顔だけ（紙吹雪は区切りの枚数のとき）（${[...new Set(moods.m)].join(',')}・紙吹雪 ${moods.c}）`);
    check(await pg.evaluate(() => document.querySelector('#talkDlg').dataset.sync === '1' && window.__boundaries.includes(2)), '会話：読み上げの言葉の区切りで口を合わせた');
    await waitCards((cs) => !!q1 && !!q2 && cs.find((c) => c.doc_id === q1)?.lane === 'done' && cs.find((c) => c.doc_id === q2)?.lane === 'later', `会話（AI なし）の「済み」「あとで」（${q1}・${q2}）`);
    check(!(await pg.evaluate(() => document.querySelector('#talkDlg').open)), '会話（AI なし）：「終わり」で閉じた');
    check(outside.length === 0, `会話（AI なし）：自分のサイトと GitHub 以外へ通信していない${outside.length ? '（' + outside.join(', ') + '）' : ''}`);
    await pg.close();
  }

  // A2. AI なしで打って話す（2026-10-21 satouさん「会話の部分が上手く動いていない」：あいさつ・「何からやる？」・「それは済みにして」が通じなかった）
  {
    const { pg, outside } = await talkPage({ sr: false }, '会話 AI なし・打つ');
    await pg.click('#talkBtn');
    await pg.waitForFunction(() => document.querySelectorAll('#talkLog .l.ai').length > 0, null, { timeout: 8000 }).catch(() => {});
    const say = async (t) => { const n = await pg.$$eval('#talkLog .l.ai', (l) => l.length); await pg.fill('#talkIn', t); await pg.press('#talkIn', 'Enter'); await pg.waitForFunction((k) => document.querySelectorAll('#talkLog .l.ai').length > k, n, { timeout: 5000 }).catch(() => {}); await pg.waitForTimeout(150); return (await pg.$$eval('#talkLog .l.ai', (l) => l.map((x) => x.textContent))).slice(n).join(' ') || ''; }; // 返事が2つの吹き出しに分かれることがあるので、新しい分を全部
    // 開いたときのポチの問い（「調子どう？」など。最初の文は問い1つ）が出るまで待つ。数が止まるのを待つだけでは、問いが遅れて出たときに返事と取り違えた
    await pg.waitForFunction(() => [...document.querySelectorAll('#talkLog .l.ai')].some((l) => /[？?]/.test(l.textContent)), null, { timeout: 5000 }).catch(() => {});
    { let k = -1; for (let i = 0; i < 20; i++) { const c = await pg.$$eval('#talkLog .l.ai', (l) => l.length); if (c === k) break; k = c; await pg.waitForTimeout(300); } } // 最初のひと言が出そろうまで待つ
    const hi = await say('おはよう');
    check(/おはよう/.test(hi) && !/もう一回|分からな/.test(hi), `会話（AI なし）：「おはよう」にあいさつを返す（${hi.slice(0, 60)}）`);
    const what = await say('今日は何からやる？');
    check(/「[^」]+」/.test(what) && !/もう一回|分からな/.test(what), `会話（AI なし）：「今日は何からやる？」にカードで答える（${what.slice(0, 60)}）`);
    const st = await say('見本のカード（次にやる・毎週）はどうなった');
    check(/「見本のカード（次にやる・毎週）」/.test(st), `会話：「〇〇はどうなった」で様子を答える（${st.slice(0, 60)}）`);
    const it = await say('それは保留にして');
    await waitCards((cs) => cs.find((c) => c.doc_id === 's3')?.lane === 'hold', '「それは保留にして」');
    check(lastCards().find((c) => c.doc_id === 's3')?.lane === 'hold' && !/見つからない/.test(it), `会話：「それ」は直前に話に出たカードを指す（${it.slice(0, 60)}）`);
    await say('戻す');
    // 新機能10：「今日なにする？」→ やることを3つにしぼって言う（今やる・次にやるから。エージェント・予定待ちは入れない）
    const three = await say('今日なにする？');
    const picked = [...three.matchAll(/「([^」]+)」/g)].map((m) => m[1]);
    check(+(three.match(/今日は([123])つ/) || [])[1] === new Set(picked).size && !picked.some((x) => /エージェント|予定待ち|済み/.test(x)) && picked[0] === '見本のカード（今やる）' && /まずは1つ目から/.test(three), `会話：「今日なにする？」で、やることを3つにしぼって言い、最初の1つをすすめる（${three.slice(0, 90)}）`);
    await say('2つ目を保留へ');
    await waitCards((cs) => cs.find((c) => c.title === picked[1])?.lane === 'hold', `「今日なにする？」のあと「2つ目を保留へ」で、言った2つ目（${picked[1]}）を動かす`);
    await say('戻す');
    // 「済み」だけでも1つ目を済みにする（会話の一覧の写しには id が無いので、本物のカードに引き直す。CodeRabbit #52）
    await say('今日なにする？');
    await say('済み');
    await waitCards((cs) => cs.find((c) => c.title === picked[0])?.lane === 'done', `「今日なにする？」のあと「済み」で、1つ目（${picked[0]}）を済みにする`);
    await say('戻す');
    await say('終わり');
    check(outside.length === 0, '会話（AI なし・打つ）：自分のサイトと GitHub 以外へ通信していない');
    await pg.close();
  }

  // A3. AI なしで雑談（2026-10-21 satouさん「普通に人間と喋っているように」）：話題に返事する・毎回カードの話に戻さない・雑談の「うん」でカードを動かさない
  {
    const { pg, outside } = await talkPage({ sr: false }, '会話 AI なし・雑談');
    await pg.click('#talkBtn');
    await pg.waitForFunction(() => document.querySelectorAll('#talkLog .l.ai').length > 0, null, { timeout: 8000 }).catch(() => {});
    const say = async (t) => { const n = await pg.$$eval('#talkLog .l.ai', (l) => l.length); await pg.fill('#talkIn', t); await pg.press('#talkIn', 'Enter'); await pg.waitForFunction((k) => document.querySelectorAll('#talkLog .l.ai').length > k, n, { timeout: 5000 }).catch(() => {}); return (await pg.$$eval('#talkLog .l.ai', (l) => l.map((x) => x.textContent))).at(-1) || ''; };
    await pg.waitForTimeout(1200); // 開いたときのポチの整理の保存が終わるのを待つ
    const putsAt = puts.length; // この検査で保存したカードだけを見る（前の検査・開いたときの整理の保存は見ない）
    const putList = () => puts.slice(putsAt).filter((p) => p.path === 'local-board/cards.json').map((p) => p.body?.message || '').join(' / ');
    const moved = () => puts.slice(putsAt).filter((p) => p.path === 'local-board/cards.json').length;
    const open1 = (await pg.$$eval('#talkLog .l.ai', (l) => l.map((x) => x.textContent))).at(-1) || '';
    check(!/済み、あとで、保留、どれ/.test(open1) && (open1.match(/[？?]/g) || []).length <= 1, `雑談：最初のひと言でカードの答えを迫らず、問いは1つ（${open1.slice(0, 80)}）`);
    const r1 = await say('最近どう？');
    check(!/カード、見つからない|もう一回|分からな/.test(r1), `雑談：「最近どう？」を探す命令と取らない（${r1.slice(0, 50)}）`);
    const r2 = await say('今日面接なんだ');
    check(/面接/.test(r2) && !/「見本のカード/.test(r2), `雑談：話題（面接）に返事し、カードの話に戻さない（${r2.slice(0, 50)}）`);
    const r3 = await say('ちょっと緊張してる');
    check(!/「見本のカード/.test(r3), `雑談：気持ちを話した直後にカードの話をしない（${r3.slice(0, 50)}）`);
    const r4 = await say('昨日ラーメン食べた');
    check(/ラーメン/.test(r4), `雑談：言葉を拾って返す（${r4.slice(0, 50)}）`);
    const r5 = await say('うん');
    await pg.waitForTimeout(600);
    check(moved() === 0 && !/済みにした|1枚へった/.test(r5), `雑談：雑談のあとの「うん」でカードを済みにしない（「カードも見る？」への「うん」はカードを出すだけ）（${r5.slice(0, 50)}｜${putList()}）`);
    const r6 = await say('ありがとう');
    check(!/「見本のカード/.test(r6), `雑談：お礼のあとにすぐ次のカードを聞かない（${r6.slice(0, 50)}）`);
    const r8 = await say('今日は何からやる？');
    const r9 = await say('うん');
    for (let i = 0; i < 50 && !moved(); i++) await pg.waitForTimeout(100); // 保存は少し遅れて届く
    check(/「[^」]+」/.test(r8) && moved() > 0 && /済|へった|早い|おお|やった|えらい/.test(r9), `雑談：カードを聞いたあとの「うん」は済みにする（${r9.slice(0, 50)}）`);
    await say('戻す');
    const n0 = moved();
    await say('おやすみ');
    await pg.waitForTimeout(800);
    check(moved() === n0 && !(await pg.evaluate(() => document.querySelector('#talkDlg').open)), '雑談：「おやすみ」で会話を終え、カードは動かさない');
    check(outside.length === 0, '会話（AI なし・雑談）：自分のサイトと GitHub 以外へ通信していない');
    await pg.close();
  }

  // B. 端末の中の AI（Prompt API）：JSON の命令でカードを動かす。消すのは本人が「消して」と言ったときだけ（聞き返さない）。AI に補足を渡さない
  {
    const { pg, outside } = await talkPage({
      heard: ['毎週のやつ保留にしといて', 'エージェントのやつ消して', 'そういえば今やるのやつ', 'クロードって賢いよね', '終わり'],
      replies: [
        { say: 'オッケー、保留にしたよ', action: { type: 'move', query: '見本のカード（次にやる・毎週）', lane: 'hold' } },
        { say: '消すね', action: { type: 'delete', query: '見本のカード（エージェント）' } },
        { say: 'うん', action: { type: 'delete', query: '見本のカード（今やる）' } },
        { say: 'だよね', action: { type: 'agent', query: '見本のカード（今やる）' } },
      ],
    }, '会話 AI');
    await pg.evaluate(() => LK.memory.put({ id: 'qa-note', kind: 'note', text: '見本の覚えたこと' }));
    await pg.click('#talkBtn');
    await waitTalkEnd(pg);
    check(/内蔵 AI/.test(await pg.textContent('#talkMode')), `会話（AI）：内蔵 AI があれば使う（${await pg.textContent('#talkMode')}｜${(await pg.textContent('#talkLog')).slice(0, 160)}）`);
    await waitCards((cs) => cs.find((c) => c.doc_id === 's3')?.lane === 'hold' && cs.find((c) => c.doc_id === 's4')?.deleted === true, '会話（AI）の「保留」と「消す」');
    const spoken = await pg.evaluate(() => window.__spoken.join(''));
    check(!/消しますか|消していい/.test(spoken) && /見本のカード（エージェント）/.test(await pg.textContent('#talkLog')), '会話（AI）：「消して」は聞き返さずに消し、どのカードを消したか一言添えた');
    check(!lastCards().find((c) => c.doc_id === 's1')?.deleted, '会話（AI）：本人が「消して」と言っていないのに AI が消そうとしても消さない');
    check(lastCards().find((c) => c.doc_id === 's1')?.owner !== 'agent', '会話（AI）：本人が「Claude にやらせて」と頼んでいないのに AI が Claude に回そうとしても回さない');
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
        big: LocalAI.recent([{ role: 'user', content: 'あ'.repeat(5000) }, { role: 'assistant', content: '{"say":"うん"}' }]).reduce((n, m) => n + m.content.length, 0), budget: LocalAI.BUDGET,
        user: LocalAI.userPart('いまのボード:\n- [今やる] 見本\n\nユーザー: メモ\nユーザー: のまま'),
      };
    });
    check(!r.repeat && r.distinct >= 2, '会話（AI なし）：同じ言い回しを続けて言わない');
    check(r.kinds.length === 0 && r.greet === 0, `会話（AI なし）：どの返事にも言い回しが2つ以上ある${r.kinds.length ? '（' + r.kinds.join(',') + '）' : ''}`);
    { const miss = await pg.evaluate(() => Object.values(Talk.PHRASES.greet).flat().filter((h) => !Talk.withName(h, 'ポテト').includes('、ポテト'))); check(miss.length === 0, `会話：どのあいさつにも呼び方が入る${miss.length ? '（入らない: ' + miss.join(' / ') + '）' : ''}`); }
    check(r.day === 'night,morning,day,evening,night', `会話：時間帯であいさつを変える（${r.day}）`);
    check(r.due === '期限すぎてるよ。|今日が期限だよ。|明日が期限。|期限は11月2日。', `会話：期限の言い方（${r.due}）`);
    check(r.big <= r.budget, `会話（入れた AI）：1往復だけでも長すぎるときは BUDGET に収める（${r.big}字）`);
    check(r.user === 'メモ\nユーザー: のまま', `会話（入れた AI）：覚えるときはボードの一覧だけ外し、本人の言葉は削らない（${JSON.stringify(r.user)}）`);
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
    // あいさつは何回かに分けて読むので、最初の1つだけでなく、呼び方が出るまで待つ（1つ目だけ見ると時々落ちた）
    await again.pg.waitForFunction(() => /ポテト/.test(window.__spoken.join('')), null, { timeout: 10000 }).catch(() => {});
    { const sp = await again.pg.evaluate(() => window.__spoken.join('')); check(/ポテト/.test(sp), `ポチが覚える：別の端末・次の会話でも覚えた呼び方であいさつする（${sp.slice(0, 80)}）`); }
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

  // ポチと声の改善（2026-10-21 の案の★）：キャラ設定書・言いかけ待ち・合図の音・Whisper の作り話を捨てる・長押し・前回の続き
  {
    const { pg, outside } = await talkPage({ heard: ['えっと', '済み', 'あとで', '終わり'] }, 'ポチの改善');
    // A6 キャラ設定書：決まった返事・見本の会話に「言わないこと」が入っていない。AI への指示に一人称・口ぐせ・言わないことを入れる。前の版の人物像は新しいものに置きかえる
    const per = await pg.evaluate(() => {
      const P = Talk.PERSONA, all = [];
      for (const v of Object.values(Talk.PHRASES)) for (const x of Array.isArray(v) ? v : Object.values(v).flat()) all.push(x);
      for (const [, a] of Talk.EXAMPLES_ALL) all.push(JSON.parse(a).say);
      const bad = all.filter((x) => P.neverRe.test(x));
      const sys = Talk.systemPrompt(Talk.settingsOf({}), { now: '今やる' });
      const old = Talk.settingsOf({ persona: '気さくな相棒。タメ口で、明るく短く話す。「今日どれからやる？」と一緒に進める友達のように。できたらちゃんとほめる。説教はしない。' }).persona;
      return { bad, n: P.traits.length, sys, renew: old === P.about, mine: Talk.settingsOf({ persona: '自分で書いた人物像' }).persona };
    });
    check(per.bad.length === 0, `キャラ設定書：決まった返事と見本の会話に「言わないこと」が無い${per.bad.length ? '（' + per.bad.join(' / ') + '）' : ''}`);
    check(per.n >= 4 && per.n <= 6 && /一人称は「ぼく」/.test(per.sys) && /言わないこと/.test(per.sys) && /口ぐせ/.test(per.sys), 'キャラ設定書：性格は4〜6語、AI への指示に一人称・口ぐせ・言わないことを入れる');
    check(per.renew && per.mine === '自分で書いた人物像', 'キャラ設定書：前の版の決まった人物像は新しいものに置きかえ、自分で書いた人物像はそのまま');
    // B2 言いかけ：語尾で判断する（頼みごと・「あとで」は言い終わり）
    const uf = await pg.evaluate(() => ['牛乳買ってきて', '今日は疲れたけど', '明日やるから', 'えっと', '会議があるので、', 'あとで', '済み', '保留にしといて', '牛乳を追加して', '覚えて', '終わり'].map((t) => (Talk.unfinished(t) ? 1 : 0)).join(''));
    check(uf === '11111000000', `言いかけ：〜て・〜けど・〜から・えっと・「、」で終わったら続きを待ち、頼みごとや短い答えは待たない（${uf}）`);
    check(await pg.evaluate(() => Talk.joinHeard('えっと、', '済み') === '済み' && Talk.joinHeard('疲れたけど', 'もう1枚やる') === '疲れたけど、もう1枚やる'), '言いかけ：続きとつなぐ（最後の「えっと」は落とす）');
    // 会話：「えっと」→「済み」をつないで1回の返事にし、聞き始め・聞き終わりに合図の音を鳴らす
    await pg.click('#talkBtn');
    await waitTalkEnd(pg);
    const you = await pg.evaluate(() => [...document.querySelectorAll('#talkLog .you')].map((d) => d.textContent.replace(/^あなた：/, '')));
    check(you[0] === '済み' && /続けてどうぞ/.test(await pg.textContent('#talkLog')), `言いかけ：「えっと」で答えずに続きを聞き、つないで1回で答えた（${you.join('|')}）`);
    const cues = await pg.evaluate(() => Talk.cueLog.join(','));
    check(/start/.test(cues) && /end/.test(cues), `合図の音：聞き始め「ポン」と聞き終わり「ポロン」を鳴らした（${cues}）`);
    // C1 前回の続き：終わりに一言まとめ、あとに回したカードを覚える
    const sp = await pg.evaluate(() => window.__spoken.join(''));
    const last = await pg.evaluate(() => LK.memory.all().find((m) => m.id === 'last'));
    check(/今日は1枚片づけたね/.test(sp) && /また今度聞くね/.test(sp), '前回の続き：「終わり」で今日の枚数とあとに回したカードを一言でまとめた');
    check(last?.kind === 'last' && last.done === 1 && !!last.follow && /1枚片づけた/.test(last.text), `前回の続き：まとめを覚えた（${JSON.stringify(last)}）`);
    await pg.waitForTimeout(1600);
    check(/"kind": "last"/.test(files['local-board/pochi-memory.json'] || ''), '前回の続き：まとめはデータのリポジトリの pochi-memory.json に置く');
    // 次の会話：「昨日の〇〇、どうなった？」から始め、「済み」でそのカードを済みにする（30分以内に開き直したときは聞かない）。設定で切れる
    const fu = await pg.evaluate(async () => {
      const yest = new Date(Date.now() - 864e5).toISOString();
      const run = async (settings, at, answer) => {
        const store = [{ id: 'last', kind: 'last', text: '昨日', follow: '見本B', at }], acts = [], said = [];
        const mem = { all: () => store, put: (it) => { store.push({ ...it, at: new Date().toISOString() }); return it; }, forget() {}, forgetAll() {} };
        const cards = [{ title: '見本A', lane: 'now' }, { title: '見本C', lane: 'next' }], later = { title: '見本B', lane: 'later' };
        const t = Talk.create({ settings: { ai: 'off', bargeIn: false, reply: 'text', ...settings }, lanes: { now: '今やる' }, laneWords: [['now', '今やる']], memory: mem,
          board: () => [...cards, later], queue: () => cards, card: (x) => (x === later.title ? later : null), run: () => '', act: (c) => { acts.push(c.type + ':' + c.card?.title); return 'ok'; }, pending: () => false, onLine: (w, x) => { if (w === 'ai') said.push(x); }, onState() {} });
        await t.start(); if (answer) await t.hear(answer); t.stop();
        return { first: said[0] || '', acts };
      };
      return { ask: await run({}, yest, '済み'), soon: await run({}, new Date().toISOString()), off: await run({ followUp: false }, yest) };
    });
    check(/昨日の「見本B」、どうなった/.test(fu.ask.first) && fu.ask.acts[0] === 'done:見本B', `前回の続き：次の会話は「昨日の〇〇、どうなった？」から始め、「済み」でそのカードを済みにする（${fu.ask.first}・${fu.ask.acts.join(',')}）`);
    check(!/どうなった/.test(fu.soon.first) && !/どうなった/.test(fu.off.first), '前回の続き：30分以内に開き直したとき・設定で切ったときは聞かない');
    // B6 Whisper の作り話：短い・小さい声のときの決まり文句だけ捨てる
    const ph = await pg.evaluate(async () => {
      if (!window.LocalAI) await new Promise((ok) => { const sc = document.createElement('script'); sc.src = './localai.js'; sc.onload = ok; sc.onerror = ok; document.head.append(sc); });
      const f = window.LocalAI?.phantom; if (!f) return 'なし';
      return [f('ご視聴ありがとうございました', { speechMs: 1200, rms: 0.1 }), f('チャンネル登録お願いします', { speechMs: 2000, rms: 0.1 }), f('おやすみなさい', { speechMs: 500, rms: 0.1 }), f('おやすみなさい', { speechMs: 1500, rms: 0.1 }), f('ありがとうございました', { speechMs: 1500, rms: 0.005 }), f('牛乳を済み', { speechMs: 300, rms: 0.001 }), f('はい', { speechMs: 300, rms: 0.1 })].map((x) => (x ? 1 : 0)).join('');
    });
    check(ph === '1110100', `Whisper の作り話：「ご視聴ありがとうございました」などを、声が短い・小さいときだけ捨てる（${ph}）`);
    await pg.close();
    check(outside.length === 0, 'ポチの改善：自分のサイトと GitHub 以外へ通信していない');
  }
  // B1 押している間だけ聞く：🎤を長押しすると離すまで聞き、離したら答える。今までの「押すと聞き続ける」も残す。合図の音は設定で消せる
  {
    const { pg, outside } = await talkPage({ heard: [] }, '長押し');
    const keepTalk = await pg.evaluate(() => { const k = localStorage.getItem('lk.talk'); localStorage.setItem('lk.talk', JSON.stringify({ ...JSON.parse(k || '{}'), cue: false })); return k; });
    await pg.click('#talkBtn');
    await pg.waitForFunction(() => /打つか/.test(document.querySelector('#talkState').textContent), null, { timeout: 15000 }).catch(() => {});
    await pg.evaluate(() => { Talk.cueLog.length = 0; window.__heard.length = 0; });
    const b = await pg.locator('#talkMic').boundingBox();
    await pg.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await pg.evaluate(() => { window.__heard.push('見本のカード（次にやる・毎週）を保留に'); });
    await pg.mouse.down();
    await pg.waitForTimeout(700);
    const mid = await pg.evaluate(() => ({ st: document.querySelector('#talkState').textContent, on: document.querySelector('#talkMic').getAttribute('aria-pressed'), hold: window.__srHold || 0 }));
    await pg.mouse.up();
    await waitCards((cs) => cs.find((c) => c.doc_id === 's3')?.lane === 'hold', '🎤の長押しで話した「保留に」');
    check(mid.hold >= 1 && /離したら/.test(mid.st) && mid.on === 'true', `🎤の長押し：押している間は「離したら答えるね」と聞き続け、🎤の印も付く（${mid.st}・${mid.on}）`);
    check(await pg.evaluate(() => [...document.querySelectorAll('#talkLog .you')].some((d) => /保留に/.test(d.textContent))), '🎤の長押し：離したら、聞いたことを同じ流れに文字で残して動かす');
    check(await pg.evaluate(() => Talk.cueLog.length === 0), '合図の音：設定で切ると鳴らさない');
    const f = await pg.evaluate(() => { const f = document.querySelector('#talkSetForm'); return !!(f.cue && f.waitMore && f.followUp); });
    check(f, 'キャラの設定：合図の音・言いかけ待ち・前回の続きを設定で切りかえられる');
    await pg.evaluate((k) => (k == null ? localStorage.removeItem('lk.talk') : localStorage.setItem('lk.talk', k)), keepTalk);
    await pg.close();
    check(outside.length === 0, '長押し：自分のサイトと GitHub 以外へ通信していない');
  }

  // A1 ボードの隅のポチ・A4 下がらない成長
  {
    const { pg, outside } = await talkPage({ heard: [] }, '隅のポチ');
    await pg.waitForSelector('#lkPochi svg', { timeout: 10000 }).catch(() => {});
    const a = await pg.evaluate(() => { const b = document.querySelector('#lkPochi'); const r = b?.getBoundingClientRect(); return b && { shown: !b.hidden && r.width > 0, label: b.getAttribute('aria-label'), g: LK.memory.all().find((m) => m.id === 'growth') }; });
    check(a?.shown && /ポチと話す/.test(a.label), 'ボードの隅のポチ：つないだらボードの隅に小さなポチがいる（押すと会話）');
    const base = await pg.evaluate(() => cards.filter((c) => !c.deleted && c.lane === 'done' && c.owner !== 'agent').length);
    check(a?.g?.kind === 'growth' && a.g.total >= base && !!a.g.since, `成長：一緒に済みにした合計を覚えたことに置く（${JSON.stringify(a?.g)}）`);
    const was = await pg.evaluate(() => { const l = cards.find((c) => c.id === 's3').lane; move('s3', 'done'); return l; }); // 今やるの並びを変えない（あとの検査が今やるの1枚目を使う）
    await pg.waitForFunction(() => document.querySelector('#lkPochi')?.classList.contains('hop'), null, { timeout: 5000 }).catch(() => {});
    const h = await pg.evaluate(() => ({ hop: document.querySelector('#lkPochi').classList.contains('hop'), total: LK.memory.all().find((m) => m.id === 'growth')?.total, bubble: document.querySelectorAll('#lkPochi ~ .bubble, #lkPochi .bubble').length, spoken: window.__spoken.length }));
    check(h.hop && h.total === Math.max(a?.g?.total || 0, base + 1), `ボードの隅のポチ：カードを済みにすると跳ね、合計が増える（${JSON.stringify(h)}）`);
    check(h.spoken === 0 && h.bubble === 0, 'ボードの隅のポチ：しゃべらない・吹き出しを出さない');
    // 下がらない：済みを戻しても合計は減らない
    await pg.evaluate((l) => move('s3', l), was);
    await pg.waitForTimeout(400);
    check(await pg.evaluate((n) => LK.memory.all().find((m) => m.id === 'growth')?.total === n, h.total), '成長：済みを戻しても合計は下がらない');
    // 小物：10枚でリボン・30枚でスカーフ・50枚で帽子・100枚で星。夜はナイトキャップ。会話を開いたら1回だけ知らせる
    const w = await pg.evaluate(async () => {
      const box = document.createElement('div'); box.innerHTML = Talk.avatarSvg('maru', '#3b82f6', Talk.growthOf(100).wear); document.body.append(box);
      const parts = ['bow', 'scarf', 'hat', 'star'].filter((k) => box.querySelector('.w-' + k)); box.remove();
      const store = [{ id: 'growth', kind: 'growth', total: 12, shown: 0, since: '2026-10-01', at: '2026-10-01T00:00:00Z' }], said = [];
      const mem = { all: () => store, put: (it) => { const k = store.findIndex((i) => i.id === it.id); if (k >= 0) store[k] = it; else store.push(it); return it; }, forget() {}, forgetAll() {} };
      const mk = () => Talk.create({ settings: { ai: 'off', bargeIn: false, reply: 'text' }, lanes: { now: '今やる' }, laneWords: [['now', '今やる']], memory: mem, board: () => [], queue: () => [], run: () => '', act: () => 'ok', pending: () => false, onLine: (k, x) => { if (k === 'ai') said.push(x); }, onState() {} });
      for (let i = 0; i < 2; i++) { const t = mk(); await t.start(); t.stop(); }
      return { parts, said, shown: store[0].shown, lines: Talk.memoryLines(store).join('|') };
    });
    check(w.parts.length === 4, `成長：小物（リボン・スカーフ・帽子・星）を描ける（${w.parts.join(',')}）`);
    check(/リボン/.test(w.said[0]) && !/リボン/.test(w.said[1] || '') && w.shown === 1, `成長：新しい小物は会話を開いたときに1回だけ知らせる（${w.said.join(' / ')}）`);
    check(/合計12枚/.test(w.lines), '成長：一緒に片づけた合計を AI への指示に入れる');
    // 設定で消せる
    const keepTalk = await pg.evaluate(() => { const k = localStorage.getItem('lk.talk'); localStorage.setItem('lk.talk', JSON.stringify({ ...JSON.parse(k || '{}'), corner: false })); return k; });
    await pg.click('#lkMenu summary'); await pg.click('#lkMenu [data-m=aiset]');
    check(await pg.evaluate(() => document.querySelector('#talkSetForm').corner.checked === false), 'キャラの設定：ボードの隅のポチを出すかを切りかえられる');
    await pg.click('#talkSetForm button[value=ok]');
    check(await pg.evaluate(() => document.querySelector('#lkPochi').hidden), 'ボードの隅のポチ：設定で消せる');
    await pg.evaluate((k) => (k == null ? localStorage.removeItem('lk.talk') : localStorage.setItem('lk.talk', k)), keepTalk);
    await pg.close();
    check(outside.length === 0, '隅のポチ：自分のサイトと GitHub 以外へ通信していない');
  }

  // 会話の改善（2026-10-21 の案の残り）：見本20個・雑談の決まり・困ったときの言葉・喜び方の大小・「今日は静かにして」・断られた提案・週のふりかえり・連続と調子（設定で入れたときだけ）
  {
    const { pg, outside } = await talkPage({ heard: [] }, '会話の改善');
    const r = await pg.evaluate(async () => {
      const out = {};
      const T = Talk;
      // C2 見本：20個から入れ替える。動かす見本と会話だけの見本を半分ずつ
      const ex = T.pickExamples(6), acts = ex.filter(([, a]) => !a.includes('"action":null')).length;
      out.ex = { all: T.EXAMPLES_ALL.length, n: ex.length, acts, diff: new Set(Array.from({ length: 5 }, () => T.pickExamples(4).map((x) => x[0]).join()).values()).size };
      // C8 困ったとき
      out.kind = [T.kindly('「牛乳」に合うカードが見つかりません。'), T.kindly('いまは保存できないので動かせません。'), T.kindly('「あれ」は分かりませんでした。例：〇〇を追加、〇〇を済み、今やるを読んで。')];
      // C6 日をまたいで同じ文を言わない
      localStorage.removeItem('qa.recent');
      const st = T.recentStore('qa.recent'), a1 = T.picker(Math.random, st)('hi', ['A', 'B']), a2 = T.picker(Math.random, st)('hi', ['A', 'B']);
      out.recent = a1 !== a2;
      // C7・A5 の文
      const sun = new Date(2026, 9, 25, 18), mon = new Date(2026, 9, 19, 18);
      const wl = [{ title: '古いカード', created: '2026-09-01', done_at: '2026-10-21T10:00:00' }, { title: '新しいカード', created: '2026-10-20', done_at: '2026-10-23T10:00:00' }];
      out.week = [T.weeklyText(wl, sun), T.weeklyText(wl, mon), T.weeklyText([], sun), T.streakText(wl, sun), T.streakText(wl.slice(0, 1), sun)];
      // 会話を作って試す（AI なし）
      const store = [], said = [], moods = [];
      const mem = { all: () => store, put: (it) => { const k = store.findIndex((i) => i.id === it.id); const x = { ...it, at: it.at || new Date().toISOString() }; if (k >= 0) store[k] = x; else store.push(x); return x; }, forget() {}, forgetAll() {} };
      const today = new Date(); const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const mk = (cards, settings = {}) => Talk.create({ settings: { ai: 'off', bargeIn: false, reply: 'text', tidy: false, ...settings }, lanes: { now: '今やる' }, laneWords: [['now', '今やる']], memory: mem,
        board: () => cards.filter((c) => c.lane !== 'done'), queue: () => cards.filter((c) => c.lane === 'now'), card: (t) => cards.find((c) => c.title === t) || null, weekDone: () => [],
        run: () => '', act: (c) => { if (c.type === 'done') c.card.lane = 'done'; return 'ok'; }, pending: () => false, onLine: (k, x) => { if (k === 'ai') said.push(x); }, onMood: (m) => moods.push(m), onState() {} });
      for (const k of ['lk.quietDay', 'lk.moodAskDay', 'lk.moodDay', 'lk.noFollowUntil']) localStorage.removeItem(k);
      // A7 喜び方：1枚目・2枚目は笑顔だけ、3枚目は紙吹雪、期限すぎのカードは「ついに！」
      const cs = [{ title: '一', lane: 'now' }, { title: '二', lane: 'now' }, { title: '三', lane: 'now' }, { title: '期限すぎ', lane: 'now', due: '2000-01-01' }];
      let t = mk(cs); await t.start(); for (let i = 0; i < 4; i++) await t.hear('済み'); t.stop();
      out.joy = { moods: moods.filter((m) => ['happy', 'party', 'wow'].includes(m)), wow: said.some((x) => /ついに/.test(x)) };
      // A9 「今日は静かにして」：その日は自分から話しかけない。「もう話していいよ」で戻る
      said.length = 0;
      t = mk([{ title: '一', lane: 'now' }]); await t.start(); await t.hear('今日は静かにして'); t.stop();
      const quietSet = localStorage.getItem('lk.quietDay') === ymd(today);
      said.length = 0; t = mk([{ title: '一', lane: 'now' }]); await t.start(); const quietSaid = said.length; await t.hear('もう話していいよ'); t.stop();
      out.quiet = { quietSet, quietSaid, back: !localStorage.getItem('lk.quietDay') && said.some((x) => /おしゃべり/.test(x)) };
      // 断られた提案：前回の続きを「いいよ」で断られたら、しばらく聞かない
      mem.put({ id: 'last', kind: 'last', text: '前', follow: '一', at: new Date(Date.now() - 864e5).toISOString() });
      said.length = 0; t = mk([{ title: '一', lane: 'now' }]); await t.start(); const asked = said.some((x) => /どうなった/.test(x)); await t.hear('いいよ'); t.stop();
      mem.put({ id: 'last', kind: 'last', text: '前', follow: '一', at: new Date(Date.now() - 864e5).toISOString() }); // 断られた印だけで止まるか（時間では止まらない形にして試す）
      said.length = 0; t = mk([{ title: '一', lane: 'now' }]); await t.start(); t.stop();
      out.reject = { asked, until: +localStorage.getItem('lk.noFollowUntil') > Date.now(), again: said.some((x) => /どうなった/.test(x)) };
      localStorage.removeItem('lk.noFollowUntil'); mem.put({ id: 'last', kind: 'last', text: '前', follow: '', at: new Date().toISOString() });
      // C4 今日の調子：最初は聞かない。設定で入れると1日1回聞き、しんどいなら1枚で「今日の分はおしまい」
      said.length = 0; t = mk([{ title: '一', lane: 'now' }]); await t.start(); t.stop();
      const offAsk = said.some((x) => /調子/.test(x));
      said.length = 0; t = mk([{ title: '一', lane: 'now' }, { title: '二', lane: 'now' }], { moodAsk: true }); await t.start(); const onAsk = said.some((x) => /調子/.test(x)); await t.hear('しんどい'); await t.hear('済み'); t.stop();
      const done1 = said.join(' ');
      said.length = 0; t = mk([{ title: '一', lane: 'now' }], { moodAsk: true }); await t.start(); t.stop();
      out.mood = { offAsk, onAsk, one: /1枚だけ/.test(done1), enough: /今日の分はおしまい/.test(done1), twice: said.some((x) => /調子/.test(x)), defaults: [T.DEFAULTS.streak, T.DEFAULTS.moodAsk] };
      for (const k of ['lk.quietDay', 'lk.moodAskDay', 'lk.moodDay']) localStorage.removeItem(k);
      // C3 雑談の決まり・C9 考え中のひとこと（にせものの内蔵 AI）
      const prompts = [];
      const keep = window.LanguageModel;
      let slow = 0;
      window.LanguageModel = { availability: () => Promise.resolve('available'), create: () => Promise.resolve({ prompt: (x) => { prompts.push(x); return new Promise((ok) => setTimeout(() => ok(JSON.stringify({ say: 'うん、そうだね。', action: null })), slow)); }, destroy() {} }) };
      const logs = [];
      const ai = Talk.create({ settings: { ai: 'auto', bargeIn: false, reply: 'text', tidy: false }, lanes: { now: '今やる' }, laneWords: [['now', '今やる']], memory: mem, board: () => [{ title: '一', lane: 'now' }], queue: () => [], weekDone: () => [],
        run: () => '', act: () => 'ok', pending: () => false, onLine: (k, x) => logs.push(k + ':' + x), onState() {} });
      await ai.start('text');
      for (const x of ['今日はいい天気', 'カフェ行った', 'ケーキおいしかった', '友だちと話した', '楽しかった']) await ai.hear(x);
      const hint3 = /雑談が続いている/.test(prompts[4] || ''), hint1 = /雑談が続いている/.test(prompts[2] || '');
      await ai.hear('なんか疲れた');
      await ai.hear('映画見たい');
      const tiredNoBack = /疲れているので/.test(prompts[6] || '') && !/雑談が続いている/.test(prompts[6] || '');
      slow = 5600; await ai.hear('うーん');
      ai.stop();
      window.LanguageModel = keep;
      out.chat = { hint3, hint1, tiredNoBack, slow: logs.some((x) => /ちょっと考えさせて/.test(x)) };
      return out;
    });
    check(r.ex.all === 22 && r.ex.n === 6 && r.ex.acts === 3 && r.ex.diff > 1, `見本の会話：22個から毎回入れ替え、動かす見本と会話だけの見本を半分ずつ入れる（${JSON.stringify(r.ex)}）`);
    check(/見つからないや/.test(r.kind[0]) && /つながってないのかも/.test(r.kind[1]) && /ぼくには分からなかった/.test(r.kind[2]), `困ったときの返事：キャラの言葉で、理由と次にどうするかを言う（${r.kind.join(' / ')}）`);
    check(r.recent, '言い回し：日をまたいでも最近言った文を避ける');
    check(/今週は2枚/.test(r.week[0]) && /古いカード/.test(r.week[0]) && !r.week[1] && !r.week[2] && /今週は2日/.test(r.week[3]) && !r.week[4], `週のふりかえり：日曜の夕方だけ・済みが無い週は言わない／週の連続は2日から（${r.week.join(' | ')}）`);
    check(r.joy.moods.join(',') === 'happy,happy,party,wow' && r.joy.wow, `喜び方の大小：1・2枚目は笑顔、3枚目は紙吹雪、期限すぎのカードは「ついに！」（${r.joy.moods.join(',')}）`);
    check(r.quiet.quietSet && r.quiet.quietSaid === 0 && r.quiet.back, `「今日は静かにして」：その日は自分から話しかけず、「もう話していいよ」で戻る（${JSON.stringify(r.quiet)}）`);
    check(r.reject.asked && r.reject.until && !r.reject.again, `断られた提案：前回の続きを断られたら、しばらく聞かない（${JSON.stringify(r.reject)}）`);
    check(!r.mood.offAsk && r.mood.onAsk && r.mood.one && r.mood.enough && !r.mood.twice && r.mood.defaults.join() === 'false,false', `今日の調子：最初は聞かない。設定で入れると1日1回だけ聞き、しんどい日は1枚で「今日の分はおしまい」（${JSON.stringify(r.mood)}）`);
    check(r.chat.hint3 && !r.chat.hint1 && r.chat.tiredNoBack, `雑談の決まり：4往復までは付き合い、5往復目からそっとカードに戻す（毎回戻さない）。疲れた日は戻さない（${JSON.stringify(r.chat)}）`);
    check(r.chat.slow, '考え中：5秒たっても考えていたら「ちょっと考えさせて」と一言');
    const f = await pg.evaluate(() => { const f = document.querySelector('#talkSetForm'); return !!(f.streak && f.moodAsk); });
    check(f, 'キャラの設定：週の連続・今日の調子を設定で入れられる');
    await pg.close();
    check(outside.length === 0, '会話の改善：自分のサイトと GitHub 以外へ通信していない');
  }

  // 声と見た目の改善（2026-10-21 の案の残り）：しぐさ・季節・口の形・待ち時間・声に合わせた耳・題で聞き直し・割り込みの一時停止・うるさいときの一言
  {
    const { pg, outside } = await talkPage({ heard: [] }, '声と見た目');
    await pg.waitForSelector('#lkPochi svg', { timeout: 10000 }).catch(() => {});
    const r = await pg.evaluate(async () => {
      const out = {}, T = Talk;
      // A8 口の形
      out.vowels = T.vowels('おはよう、ポチだよ').join('');
      const d = document.querySelector('#talkDlg'); document.querySelector('#talkAva').innerHTML = T.avatarSvg('maru', '#f59e0b'); d.showModal(); d.classList.add('speaking'); d.dataset.mood = 'normal';
      LK.mouth.start('あいうえお');
      await new Promise((ok) => setTimeout(ok, 450));
      const m = d.dataset.mouth, shown = [...d.querySelectorAll('#talkAva .mouth')].filter((x) => getComputedStyle(x).display !== 'none').map((x) => x.getAttribute('class'));
      out.mouth = { m, shown };
      // B5 声の大きさで耳と輪・うなずき
      d.dataset.state = 'listening'; d.dataset.mood = 'listen';
      dispatchEvent(new CustomEvent('voice:level', { detail: { v: 0.8 } })); dispatchEvent(new CustomEvent('voice:nod'));
      out.level = { lv: d.dataset.lv, v: d.style.getPropertyValue('--lv'), nod: d.classList.contains('nod') };
      LK.mouth.stop(); d.classList.remove('speaking'); d.close();
      // A3 季節と行事
      const days = [[2026, 0, 2], [2026, 1, 2], [2026, 3, 1], [2026, 7, 1], [2026, 9, 31], [2026, 11, 24], [2026, 0, 20], [2026, 5, 10]];
      out.season = days.map(([y, mo, da]) => { const x = T.seasonOf(new Date(y, mo, da)); return (x.event || '-') + ':' + x.wear.join('+'); });
      const box = document.createElement('div'); box.innerHTML = T.avatarSvg('maru', '#3b82f6', ['muffler', 'sakura', 'pumpkin', 'santa', 'oni', 'kagami', 'uchiwa']); document.body.append(box);
      out.seasonWear = ['muffler', 'sakura', 'pumpkin', 'santa', 'oni', 'kagami', 'uchiwa'].filter((k) => box.querySelector('.w-' + k)).length; box.remove();
      out.seasonSay = days.map(([y, mo, da]) => T.seasonOf(new Date(y, mo, da)).say).filter((x) => x && T.PERSONA.neverRe.test(x));
      // B7 題に寄せる
      out.fix = [T.fixTitles('牛乳を買たを済み', ['牛乳を買った']), T.fixTitles('今日はいい天気', ['今日の天気予報']), T.fixTitles('牛乳を済み', ['牛乳']), T.fixTitles('本を返した', ['本を返す']), T.fixTitles('本お返した', ['本を返す'])];
      // A2 しぐさと寝る
      const g = LK.pochiIdle.tick(), b = document.querySelector('#lkPochi');
      out.gesture = { g, on: b.classList.contains(g) };
      LK.pochiIdle.sleepNow(); LK.pochiIdle.tick(); out.sleep = b.dataset.sleep;
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); out.awake = !b.dataset.sleep;
      // 耳の呼び方（待ち時間・手がかり）・うるさいとき・割り込みの一時停止を、にせものの耳と口で試す
      const V = window.Voice, keep = { listen: V.listen, route: V.route, speakAll: V.speakAll, stop: V.stop, bi: LocalAI.bargeIn, gum: navigator.mediaDevices.getUserMedia };
      V.route = async () => 'ear'; // 割り込み（話している最中のマイク）は耳（Whisper）で聞くときだけ
      const calls = [], logs = [];
      let script = [];
      V.listen = (o) => { calls.push(o); const x = script.shift(); return x instanceof Error ? Promise.reject(x) : x ? Promise.resolve(x) : Promise.reject(new Error('聞き取れませんでした')); };
      V.speakAll = () => new Promise((ok) => setTimeout(ok, 200));
      V.stop = () => {};
      navigator.mediaDevices.getUserMedia = async () => new MediaStream();
      let barge = 0;
      LocalAI.bargeIn = (st, cb) => { if (barge-- > 0) setTimeout(cb, 30); return () => {}; };
      const mk = (settings) => T.create({ settings: { ai: 'off', reply: 'voice', tidy: false, cue: false, followUp: false, bargeIn: true, ...settings }, lanes: { now: '今やる' }, laneWords: [['now', '今やる']],
        board: () => [{ title: '牛乳を買った', lane: 'now' }], queue: () => [{ title: '牛乳を買った', lane: 'now' }], weekDone: () => [],
        run: (x) => '「牛乳を買った」は今やるです。', act: () => 'ok', pending: () => false, onLine: (k, x) => logs.push(k + ':' + x), onState() {} });
      const done = (t) => new Promise((ok) => { const i = setInterval(() => { if (!t.on || !t.listening) { clearInterval(i); ok(); } }, 50); setTimeout(() => { clearInterval(i); ok(); }, 6000); });
      localStorage.removeItem('lk.noisyDay');
      // 待ち時間（ゆっくり）・手がかり・うるさいとき・題に寄せる（Whisper のときだけ）
      script = [{ text: '牛乳を買たを読んで', via: 'ear', noise: 0.1 }];
      let t = mk({ endWait: 'slow' }); await t.start('voice'); await done(t); t.stop();
      out.ear = { endMs: calls[0]?.endMs, hint: (calls[0]?.phrases || []).includes('牛乳を買った'), noisy: logs.filter((x) => /にぎやか/.test(x)).length, fixed: logs.some((x) => x === 'you:牛乳を買ったを読んで') };
      // 割り込まれて何も言われなければ「ごめん、続けるね」と言い直す。「待って」なら止まったまま
      logs.length = 0; calls.length = 0; barge = 1;
      script = [{ text: 'なんかいい天気', via: 'local' }];
      t = mk({}); await t.start('voice'); await done(t); t.stop();
      out.resume = logs.some((x) => /ごめん、続けるね/.test(x)) && calls[1]?.waitMs === 2500;
      logs.length = 0; barge = 1;
      script = [{ text: 'なんかいい天気', via: 'local' }, { text: '待って', via: 'local' }];
      t = mk({}); await t.start('voice'); await done(t); t.stop();
      out.wait = logs.some((x) => /待ってるね/.test(x)) && !logs.some((x) => /ごめん、続けるね/.test(x));
      // 「今日なにする？」の3つの選び方：期限すぎ・今日まで → 今やる → 期限が近い順。AI があっても AI に聞かずに同じ3つ
      {
        const said = [], runs = [];
        const today = new Date(), ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const later = new Date(today.getTime() + 20 * 864e5), past = new Date(today.getTime() - 864e5);
        const tt = T.create({ settings: { ai: 'off', reply: 'text', tidy: false, cue: false, followUp: false }, lanes: { now: '今やる' }, laneWords: [['now', '今やる']],
          board: () => [{ title: 'A 今やる', lane: 'now', due: '' }, { title: 'B 寝かせ', lane: 'later', due: '' }, { title: 'C 期限すぎ', lane: 'next', due: ymd(past) }, { title: 'D 先の期限', lane: 'next', due: ymd(later) }, { title: 'E エージェント', lane: 'agent', due: ymd(past) }, { title: 'F 予定待ち', lane: 'wait', due: ymd(past) }, { title: 'G 面接', lane: 'wait', due: '', event_start: ymd(today) + 'T15:00:00' }],
          queue: () => [], weekDone: () => [], run: (x) => { runs.push(x); return '「' + x + '」をやりました。'; }, act: () => 'ok', pending: () => false, onLine: (k, x) => { if (k === 'ai') said.push(x); }, onState() {} });
        await tt.start('text'); said.length = 0;
        await tt.hear('今日は何する？');
        const one = said.join(' ');
        const k = said.length;
        await tt.hear('今日の予定は？');
        const again = said.slice(k).join(' ');
        await tt.hear('今日の予定に牛乳を買うを足して');
        tt.stop();
        out.three = { one, again, runs, last: said.slice(-1)[0] || '' };
      }
      Object.assign(V, { listen: keep.listen, route: keep.route, speakAll: keep.speakAll, stop: keep.stop }); LocalAI.bargeIn = keep.bi; navigator.mediaDevices.getUserMedia = keep.gum;
      return out;
    });
    { const t3 = [...r.three.one.matchAll(/「([^」]+)」/g)].map((m) => m[1]); check(t3.slice(0, 4).join('|') === 'G 面接|C 期限すぎ|A 今やる|D 先の期限' && /今日の予定は「G 面接」（15:00）/.test(r.three.one) && /（期限すぎ）/.test(r.three.one) && /3つにしぼろう/.test(r.three.one) && /まずは1つ目から/.test(r.three.one) && /^1つ目「C 期限すぎ」|「C 期限すぎ」/.test(r.three.again), `「今日なにする？」の3つ：期限すぎ → 今やる → 期限の近い順。エージェント・予定待ち・寝かせたものは後（${r.three.one}｜${r.three.again}）`); }
    check(r.three.runs.includes('今日の予定に牛乳を買うを足して') && !/しぼろう/.test(r.three.last), `「今日の予定に〇〇を足して」は命令として扱う（3つを言わない。${r.three.runs.join('|')}）`);
    check(r.vowels === 'oaounoiao', `口の形：読む文のかなから あいうえお・閉じる を並べる（${r.vowels}）`);
    check(/^[aiueo]$/.test(r.mouth.m || '') && r.mouth.shown.length === 1 && /v-[aiueo]/.test(r.mouth.shown[0]), `口の形：話している間、母音の口を1つだけ見せる（${JSON.stringify(r.mouth)}）`);
    check(r.level.lv === '1' && r.level.v === '0.8' && r.level.nod, `聞いている間：声の大きさで耳と輪を動かし、話の切れ目でうなずく（${JSON.stringify(r.level)}）`);
    check(r.season.join(',') === 'newyear:kagami,setsubun:oni,hanami:sakura,natsu:uchiwa,halloween:pumpkin,xmas:santa,-:muffler,-:' && r.seasonWear === 7 && r.seasonSay.length === 0, `季節と行事：その日だけ小物とひとことが変わる（${r.season.join(',')}・小物 ${r.seasonWear}）`);
    check(r.fix[0] === '牛乳を買ったを済み' && r.fix[1] === '今日はいい天気' && r.fix[2] === '牛乳を済み' && r.fix[3] === '本を返した' && r.fix[4] === '本を返した', `聞き取りの手がかり：Whisper の聞き違いをカードの題に寄せる（少しだけ違うときだけ。「〜した」の活用は壊さない）（${r.fix.join(' / ')}）`);
    check(r.gesture.on && r.sleep === '1' && r.awake, `しぐさ：何もしていないときにしぐさをまぜ、長く放っておくと寝て、さわると起きる（${r.gesture.g}）`);
    check(r.ear.endMs === 1200 && r.ear.hint && r.ear.noisy === 1 && r.ear.fixed, `耳：待ち時間「ゆっくり」は1.2秒、カードの題を手がかりに渡し、うるさいときは1回だけ一言、Whisper の聞き違いは題に寄せる（${JSON.stringify(r.ear)}）`);
    check(r.resume, '割り込み：物音で止まって何も言われなければ「ごめん、続けるね」と続きを話す');
    check(r.wait, '割り込み：「待って」と言われたら止まったまま待つ');
    check(await pg.evaluate(() => !!document.querySelector('#talkSetForm').endWait), 'キャラの設定：話し終わりの待ち時間を選べる');
    await pg.close();
    check(outside.length === 0, '声と見た目：自分のサイトと GitHub 以外へ通信していない');
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
    const firstT = await pg.evaluate(() => LK.queueTitles('now')[0]);
    const t1 = SAMPLE.find((c) => c.title === firstT)?.doc_id;
    await pg.fill('#talkIn', '済み'); await pg.press('#talkIn', 'Enter');
    await waitCards((cs) => !!t1 && cs.find((c) => c.doc_id === t1)?.lane === 'done', `会話（耳なし）で打った「済み」（${t1}）`);
    await pg.click('#talkSetBtn');
    check(await pg.evaluate(() => document.activeElement?.id === 'talkSetTtl'), '設定を開くと見出しにいる（名前の欄でキーボードが勝手に出ない。v42 の点検）');
    await pg.fill('#talkSetForm [name=name]', 'テスト名');
    await pg.click('#talkSetForm [name=icon][value=kaku]');
    await pg.click('#talkSetForm button[value=ok]');
    check((await pg.textContent('#talkName')) === 'テスト名', 'キャラの設定：名前を変えると会話の画面に出る');
    check(await pg.evaluate(() => JSON.parse(localStorage.getItem('lk.talk')).icon === 'kaku'), 'キャラの設定：アイコンの選択を端末に保存した');
    await pg.click('#talkEnd');
    // v35 の点検：設定の欄と見出し（label）がつながっている・⋯ は Esc で閉じて ⋯ に戻る
    check(await pg.evaluate(() => ['name', 'persona', 'color', 'voice', 'reply', 'endWait'].every((n) => document.querySelector(`#talkSetForm [name=${n}]`).labels.length > 0) && document.querySelector('#ghForm [name=owner]').labels.length > 0), '設定：欄と見出し（label）がつながっている（読み上げで欄の名前が出る）');
    await pg.click('#lkMenu summary'); await pg.keyboard.press('Escape');
    check(await pg.evaluate(() => !document.querySelector('#lkMenu').open && document.activeElement === document.querySelector('#lkMenu summary')), '⋯ のメニュー：Esc で閉じて ⋯ にキーボードの位置が戻る');
    await pg.evaluate(() => localStorage.setItem('kanban-keys', '0')); await pg.keyboard.press('t'); await pg.waitForTimeout(300);
    check(!(await pg.evaluate(() => document.querySelector('#talkDlg').open)), '1文字のキー：ボードの「？ 印」で「使う」を外すと t でも会話を開かない（WCAG 2.1.4）');
    await pg.evaluate(() => localStorage.removeItem('kanban-keys')); await pg.keyboard.press('t');
    check(await pg.waitForFunction(() => document.querySelector('#talkDlg').open, null, { timeout: 5000 }).then(() => true, () => false), '1文字のキー：ふだんは t で会話を開く');
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
    const b = await pg.evaluate(() => ({ you: [...document.querySelectorAll('#talkLog .you')].map((d) => d.textContent.replace(/^あなた：/, '')), log: document.querySelector('#talkLog').textContent, spoken: window.__spoken.length, prompts: window.__prompts.length }));
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

  // E. 人の順に開け閉めする（2026-10-20 satouさん「基本的なユースケースはテストで」。Pixel で🎤が固まった件の再発防止）：
  //    💬で開く → 🎤で聞いている途中に Esc で閉じる（聞くのも止まる）→ Ctrl+K で開き直して打つ → 「戻す」→「終わる」で閉じる → もう一度開ける
  {
    const { pg, outside } = await talkPage({ heard: [] }, '人の順');
    const isOpen = () => pg.evaluate(() => document.querySelector('#talkDlg').open);
    await pg.click('#talkBtn');
    await pg.waitForFunction(() => document.querySelector('#talkDlg').open, null, { timeout: 5000 }).catch(() => {});
    check(await isOpen(), '人の順：💬で会話の欄が開く');
    await pg.click('#talkMic');
    await pg.waitForTimeout(150);
    await pg.keyboard.press('Escape');
    await pg.waitForTimeout(600);
    const st = await pg.evaluate(() => ({ open: document.querySelector('#talkDlg').open, mic: document.querySelector('#talkMic').getAttribute('aria-pressed'), on: document.querySelector('#talkMic').classList.contains('on') }));
    check(!st.open && st.mic === 'false' && !st.on, `人の順：🎤で聞いている途中に Esc で閉じると、聞くのも止まり🎤の印も消える（${JSON.stringify(st)}）`);
    await pg.keyboard.press('Control+k');
    await pg.waitForFunction(() => document.querySelector('#talkDlg').open, null, { timeout: 5000 }).catch(() => {});
    check(await isOpen(), '人の順：閉じたあと Ctrl+K でまた開ける');
    const before = 'next'; // 新しいページは見本（s3＝次にやる）から読む（にせの GitHub は保存した中身を返さない）
    await pg.fill('#talkIn', '見本のカード（次にやる・毎週）をあとでへ'); await pg.press('#talkIn', 'Enter');
    await waitCards((cs) => cs.find((c) => c.doc_id === 's3')?.lane === 'later', '人の順：開き直して打った命令');
    check(lastCards().find((c) => c.doc_id === 's3')?.lane === 'later', '人の順：開き直したあとに打った命令が効く');
    await pg.fill('#talkIn', '戻す'); await pg.press('#talkIn', 'Enter');
    await waitCards((cs) => cs.find((c) => c.doc_id === 's3')?.lane === before, '人の順：戻す');
    check(lastCards().find((c) => c.doc_id === 's3')?.lane === before, '人の順：「戻す」と打つと前の列に戻る');
    await pg.click('#talkEnd');
    await pg.waitForTimeout(300);
    check(!(await isOpen()), '人の順：「終わる」で閉じる');
    await pg.click('#talkBtn');
    await pg.waitForFunction(() => document.querySelector('#talkDlg').open, null, { timeout: 5000 }).catch(() => {});
    check(await isOpen() && await pg.isEnabled('#talkIn'), '人の順：3回目も開けて、打てる');
    await pg.click('#talkEnd');
    check(outside.length === 0, '人の順：自分のサイトと GitHub 以外へ通信していない');
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
      const body = (title, lane, due, o) => ({ type: 'task', title, owner: 'you', lane, priority: 'mid', order: o, created: t, updated: t, moves: [{ at: t, to: lane }], due, history: [{ at: t, who: 'claude', text: '検査で足した' }] }); // 本人が触ったばかりのカードはポチが下ろさないので、Claude が足した形にする
      await LK.add(body('見本の今やる1', 'now', '2099-02-01', 10)); // 見本の s1・s2 と合わせて今やるは3枚
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
    const cap = await pg.evaluate(() => {
      const c = (id, lane, extra = {}) => ({ id, title: id, lane, owner: 'you', order: 1, ...extra });
      const p = LK.tidyPlan([c('a', 'now', { owner: 'agent' }), c('b', 'now', { owner: 'agent' }), c('c', 'now', { owner: 'agent' }), c('d', 'next', { due: '2000-01-01' })], '2026-10-20', Date.now(), new Set());
      return p.up.length;
    });
    check(cap === 0, `任せる：動かせない今やるで3枚埋まっているときは、期限すぎを上げない（上げた ${cap} 枚）`);
    // 今やるが多くても、急ぎ・大事なもの（期限が近い・優先度高・メール・下書き・答える確認）は下ろさない。下ろすのは1日2枚まで
    // （2026-10-20 ポチが今やるの8枚を一度に次にやるへ回した）
    const many = await pg.evaluate(() => {
      const c = (id, extra = {}) => ({ id, title: id, lane: 'now', owner: 'you', order: 1, priority: 'mid', ...extra });
      const list = [c('mail', { type: 'mail' }), c('high', { priority: 'high' }), c('soon', { due: '2026-10-21' }), c('draft', { draft: { body: 'x' } }), c('ask', { decision: { question: '?' } }), c('low1', { priority: 'low' }), c('low2', { priority: 'low' }), c('mid1'), c('mid2'), c('mid3'), c('mid4'), c('mid5')];
      const p = LK.tidyPlan(list, '2026-10-20', Date.now(), new Set()).down.map((x) => x.id);
      // ほかの端末で今日もう下ろした分は、カードの履歴から数える（PC とスマホで合わせて2枚）
      const at = new Date(2026, 9, 20, 9).toISOString();
      const other = (n) => Array.from({ length: n }, (_, i) => ({ id: 'o' + i, title: 'o' + i, lane: 'next', owner: 'you', history: [{ at, who: 'ポチ', text: '次にやるへ' }] }));
      const again = LK.tidyPlan([...list, ...other(2)], '2026-10-20', Date.now(), new Set()).down.length;
      const one = LK.tidyPlan([...list, ...other(1)], '2026-10-20', Date.now(), new Set()).down.length;
      const nextDay = LK.tidyPlan([...list, ...other(2)], '2026-10-21', Date.now(), new Set()).down.length;
      return { p, again, one, nextDay };
    });
    check(many.p.length <= 2 && many.p.every((id) => /^(low|mid)/.test(id)) && many.again === 0 && many.one === 1 && many.nextDay >= 1, `任せる：今やるが12枚でも下ろすのは急ぎでない2枚まで・ほかの端末と合わせて1日2枚（下ろした ${many.p.join(',') || 'なし'}、ほかの端末で2枚済み ${many.again}・1枚済み ${many.one}・次の日 ${many.nextDay}）`);
    // 本人がこの1日にコメントしたカード・返事待ちのカードは下ろさない（2026-10-21 「それで進めて」の2分後に下ろした）
    const touched = await pg.evaluate(() => {
      const t = Date.now();
      const c = (id, extra = {}) => ({ id, title: id, lane: 'now', owner: 'you', order: 1, priority: 'mid', ...extra });
      const list = [c('said', { history: [{ at: new Date(t - 120e3).toISOString(), who: 'you', text: 'それで進めて' }] }), c('wait', { comment_status: 'local' }), c('old', { history: [{ at: new Date(t - 3 * 864e5).toISOString(), who: 'you', text: 'x' }], comment_status: 'done' }), c('m1'), c('m2')];
      return LK.tidyPlan(list, '2026-10-20', t, new Set()).down.map((x) => x.id);
    });
    check(!touched.includes('said') && !touched.includes('wait') && touched.includes('old'), `任せる：本人がこの1日にコメントしたカード・返事待ちのカードは今やるから下ろさない（下ろした ${touched.join(',') || 'なし'}）`);
    const msg = puts.find((p) => p.path === 'local-board/cards.json' && /ポチ：.*ほか \d+ 件/.test(p.body.message))?.body.message || [...puts].reverse().find((p) => /ポチ：/.test(p.body.message))?.body.message || '';
    check(/ポチ：/.test(msg) && /ほか \d+ 件/.test(msg), `保存の題（コミット）に、ポチが動かしたことと、まとめて何件かが出る（${msg}）`);
    const agent = await pg.evaluate(() => LK.cards.find((c) => c.title === '見本の調べもの'));
    check(agent?.lane === 'agent' && agent?.owner === 'agent', '任せる：調べものなど Claude ができそうなカードは Claude に回した');
    check(await pg.evaluate(() => LK.cards.filter((c) => (c.history || []).some((h) => h.who === 'ポチ')).length >= 3), '任せる：ポチが動かしたカードの履歴に「ポチ」と残る');
    const type = async (t) => { await pg.fill('#talkIn', t); await pg.press('#talkIn', 'Enter'); await pg.waitForTimeout(400); };
    await type('戻して');
    check(await lane('見本の期限すぎ') === 'next' && await lane('見本の調べもの') === 'later' && await nowN() === 3, `任せる：「戻して」で整理を全部まとめて元に戻す（今やる ${await nowN()} 枚）`);
    await pg.waitForTimeout(900);
    await type('りんごとみかんを済みに、ぶどうは明日');
    const fr = await pg.evaluate(() => Object.fromEntries(['りんご', 'みかん', 'ぶどう'].map((f) => { const c = LK.cards.find((x) => x.title === '見本の' + f); return [f, c?.lane + ':' + (c?.due || '')]; })));
    if (!process.env.LK_BOARD) check(await pg.evaluate(() => window.__moveActor) === 'ポチ', '任せる：ポチが動かすときはボードの move にも「ポチ」を渡す（くり返しの次の回の履歴のため）');
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
    check(await pg.evaluate(() => !Voice.supported && document.querySelector('#talkWhy').hidden), `耳（Whisper）を入れる前も、ボードに説明の文を足さない（🎤を押すと入れる場所を開く。${await pg.textContent('#talkWhy')}）`);
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
    check(await pg.evaluate(() => !!localStorage.getItem('lk.ai') && /もう一度/.test(document.querySelector('#aiDel').textContent)), '消すボタン：1回押しただけでは消さず「もう一度押すと…」に変わる（押し間違えで消さない）');
    await pg.click('#aiDel');
    await pg.waitForFunction(() => /消しました/.test(document.querySelector('#aiMsg').textContent), null, { timeout: 10000 }).catch(() => {});
    check(await pg.evaluate(() => !localStorage.getItem('lk.ai') && window.__deleted === 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC'), '端末の中の AI：「入れた AI を消す」でモデルと印を消した');
    check(await pg.evaluate(() => !Voice.supported), '端末の中の AI：消したら🎤も使えなくなる');
    await pg.click('#talkSetForm button[value=cancel]');
    await pg.evaluate(() => caches.delete('kanban-vendor'));
    fakeVendor = false;
    await pg.close();
  }

  // E. 🎤が聞き取りの途中でエラーで止まった日は、この端末の様子を1回だけ自動で送り、送ったと言う（2026-10-21 satouさん「マイクを押してもすぐ OFF」）。
  // 端末の音声認識（SpeechRecognition）があっても使わない（Android で🎤がすぐ止まった。耳は Whisper だけ）
  {
    const pg = await context.newPage();
    pg.on('pageerror', (e) => errors.push(`pageerror(🎤 止まった): ${e.message}`));
    await pg.addInitScript(fakeEar);
    await pg.addInitScript(() => {
      window.__heard = []; window.__spoken = []; window.__srUsed = 0; window.__earFail = 'audio-capture';
      localStorage.removeItem('lk.micLog'); localStorage.removeItem('lk.diagAuto');
      class FakeSR { static available() { return Promise.resolve('available'); } start() { window.__srUsed++; } stop() {} abort() {} }
      window.webkitSpeechRecognition = FakeSR; window.SpeechRecognition = FakeSR; delete window.LanguageModel;
      window.speechSynthesis.getVoices = () => [{ name: '端末の声', lang: 'ja-JP', localService: true }];
      window.speechSynthesis.speak = (u) => { window.__spoken.push(u.text); setTimeout(() => u.onend && u.onend(), 5); };
      window.speechSynthesis.cancel = () => {};
    });
    await pg.goto(base); await ready(pg);
    const b = puts.length;
    await pg.click('#micBtn');
    await pg.waitForFunction(() => /Claude に送った/.test(document.querySelector('#talkLog')?.textContent || ''), null, { timeout: 10000 }).catch(() => {});
    const r = await pg.evaluate(() => ({ sr: window.__srUsed, ear: window.__earCalls.length, log: document.querySelector('#talkLog')?.textContent || '' }));
    check(r.sr === 0 && r.ear >= 1, `🎤：端末の音声認識があっても使わず、耳（Whisper）で聞く（端末の認識 ${r.sr} 回・耳 ${r.ear} 回）`);
    const diag = puts.slice(b).find((p) => /^local-board\/diagnostics\//.test(p.path));
    const dj = diag ? JSON.parse(diag.text) : {};
    check(!!diag && /Claude に送った/.test(r.log) && dj['聞き取りの失敗']?.[0]?.code === 'audio-capture' && !JSON.stringify(dj).includes('見本'), `🎤が止まった日は、この端末の様子を1回だけ自動で送り、送ったと言う。カードは入れない（${diag?.path || 'なし'}）`);
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
      delete window.webkitSpeechRecognition; delete window.SpeechRecognition; delete window.LanguageModel;
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
    check(/耳 Whisper/.test(await pg.textContent('#aiStat')) && /約 0\.5GB/.test(await pg.textContent('#aiGet')), `CPU 版の AI：耳（Whisper）もいっしょに入れると出す（${await pg.textContent('#aiGet')}）`);
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
    await pg.click('#aiDel'); await pg.click('#aiDel');
    await pg.waitForFunction(() => /消しました/.test(document.querySelector('#aiMsg').textContent), null, { timeout: 10000 }).catch(() => {});
    check(await pg.evaluate(() => !localStorage.getItem('lk.ai') && window.__cpuCleared === true), 'CPU 版の AI：「入れた AI を消す」でモデル（wllama の保存）と印を消した');
    // 日本語が得意な頭（sarashina2.2）を選んで入れる・Qwen に戻すと前の頭を消してから入れる
    await pg.evaluate(() => { window.__cpu = null; window.__cpuCleared = false; });
    await pg.selectOption('#aiBrain', 'sarashina');
    check(/sarashina2\.2/.test(await pg.textContent('#aiGet')) || /約 0\.\dGB/.test(await pg.textContent('#aiGet')), `日本語の頭：選ぶと入れる大きさが変わる（${await pg.textContent('#aiGet')}）`);
    await pg.click('#aiGet');
    await pg.waitForFunction(() => /入りました|入れられません/.test(document.querySelector('#aiMsg').textContent), null, { timeout: 15000 }).catch(() => {});
    const ja = await pg.evaluate(() => ({ url: window.__cpu?.url || '', st: LocalAI.status(), credit: document.querySelector('#aiCredit').textContent }));
    check(/mmnga\/sarashina2\.2-0\.5b-instruct-v0\.1-gguf\/resolve\/[0-9a-f]{40}\/sarashina2\.2-0\.5b-instruct-v0\.1-Q4_0\.gguf$/.test(ja.url) && ja.st.brain === 'sarashina' && ja.st.cpu, `日本語の頭：sarashina2.2 の GGUF（コミットで固定）を CPU で入れた（${ja.url}）`);
    check(/SB Intuitions/.test(ja.credit) && /MIT/.test(ja.credit), '日本語の頭：クレジット（作者・ライセンス）を出す');
    await pg.selectOption('#aiBrain', 'qwen');
    check(/頭を .*替える/.test(await pg.textContent('#aiGet')), `日本語の頭：入れたあとに別の頭を選ぶと「替える」と出す（${await pg.textContent('#aiGet')}）`);
    await pg.click('#aiGet');
    await pg.waitForFunction(() => /入りました|入れられません/.test(document.querySelector('#aiMsg').textContent) && !/sarashina/.test(window.__cpu?.url || 'sarashina'), null, { timeout: 15000 }).catch(() => {});
    const back = await pg.evaluate(() => ({ url: window.__cpu?.url || '', cleared: window.__cpuCleared, brain: LocalAI.status().brain }));
    check(back.cleared === true && /qwen2\.5-0\.5b-instruct-q4_0\.gguf$/.test(back.url) && back.brain === 'qwen', `日本語の頭：Qwen に戻すと、前の頭を消してから入れる（${JSON.stringify(back)}）`);
    await pg.click('#aiDel'); await pg.click('#aiDel');
    await pg.waitForFunction(() => /消しました/.test(document.querySelector('#aiMsg').textContent), null, { timeout: 10000 }).catch(() => {});
    await pg.click('#talkSetForm button[value=cancel]');
    // 頭だけ入れてある端末（耳を入れる前の版で入れた）：「聞き取りを入れる」で Whisper だけ取る（頭は取り直さない）
    await pg.evaluate(() => { localStorage.setItem('lk.ai', JSON.stringify({ llm: LocalAI.CPU.label, engine: 'cpu', at: '2026-10-20', from: ['huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF'] })); window.__cpu = null; window.__asr = null; });
    await pg.click('#lkMenu summary'); await pg.click('#lkMenu [data-m=aiset]');
    check(/聞き取りを入れる/.test(await pg.textContent('#earGet')), `頭だけ入れた端末でも、聞き取り（耳）だけを入れるボタンを出す（${await pg.textContent('#earGet')}）`);
    await pg.click('#earGet');
    await pg.waitForFunction(() => /入りました|入れられません/.test(document.querySelector('#earMsg').textContent), null, { timeout: 15000 }).catch(() => {});
    const earOnly = await pg.evaluate(() => ({ ear: LocalAI.status().ear, llm: LocalAI.status().llm, asr: !!window.__asr, cpu: !!window.__cpu }));
    check(earOnly.ear && earOnly.asr && !earOnly.cpu && !!earOnly.llm, `「聞き取りを入れる」で Whisper だけ取り、頭は取り直さない（${JSON.stringify(earOnly)}）`);
    const after = await pg.evaluate(() => ({ open: document.querySelector('#talkSet').open, vs: document.querySelector('#vstatus')?.textContent || '' }));
    check(!after.open && /入りました.*🎤を押して/.test(after.vs), `聞き取りが入ったら設定を閉じ、ボードの1行で「🎤を押して」と言う（${JSON.stringify(after)}）`);
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
  // 切り離した画面でも、耳（Whisper）の部品 ONNX Runtime が本物の wasm でスレッドを使って動く（2026-10-20 Pixel で🎤が黙って止まった：
  // スレッドの worker（vendor の .mjs）に COEP が無く止められ、初期化が戻らなかった。耳をにせもので調べていたので見逃した）
  // 耳の計算は画面とは別の作業場（ear-worker.js）でする。遅いスマホ（CPU を 6 倍遅くしたまね）でも、その間に画面が 500ms 以上止まらない
  // （2026-10-20 Pixel 6a で🎤を使うと画面が固まった：耳が画面と同じところで動いていた）
  {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
    const ort = await page.evaluate(async () => {
      const lt = [];
      const po = new PerformanceObserver((l) => lt.push(...l.getEntries().map((e) => e.duration)));
      po.observe({ type: 'longtask' });
      let gap = 0, last = performance.now(), run = true;
      const tick = () => { const n = performance.now(); gap = Math.max(gap, n - last); last = n; if (run) setTimeout(tick, 16); };
      tick();
      const t0 = Date.now();
      try {
        const r = await Promise.race([LocalAI.earSelfTest({ size: 384, n: 12 }), new Promise((_, ng) => setTimeout(() => ng(new Error('60秒たっても戻らない')), 60000))]);
        await new Promise((ok) => setTimeout(ok, 200)); // 最後の長い処理も数える
        return { ok: !!r.ok && r.sum > 0, threads: r.threads, s: (Date.now() - t0) / 1000, longMax: Math.round(Math.max(0, ...lt)), gap: Math.round(gap) };
      } catch (e) { return { ok: false, err: String(e?.message || e), s: (Date.now() - t0) / 1000 }; }
      finally { run = false; po.disconnect(); }
    });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    check(ort.ok && ort.threads >= 1, `切り離した画面でも、耳の部品（ONNX Runtime・本物の wasm）が別の作業場でスレッドを使って動く（${JSON.stringify(ort)}）`);
    check(ort.ok && ort.longMax < 500 && ort.gap < 500, `遅いスマホのまね（CPU 6倍遅く）でも、耳の計算の間に画面が 500ms 以上止まらない（最長 ${ort.longMax}ms・間 ${ort.gap}ms）`);
  }
  {
    const sw = readFileSync(resolve(root, 'sw.js'), 'utf8');
    const now = JSON.parse((sw.match(/VENDOR_NOW = (\[[^\]]*\])/) || [, '[]'])[1].replace(/'/g, '"'));
    const dirs = readdirSync(resolve(root, 'vendor'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
    check(JSON.stringify([...now].sort()) === JSON.stringify(dirs), `sw.js の VENDOR_NOW（残す部品の版）が vendor/ のフォルダと同じ（古い版を端末から消すため。${now.join(',')}）`);
  }
  // インストールしたアプリのアイコンに、コメントに返事が来てまだ開いていないカードの枚数を出す（ボード版44の repliedToYou を使う。2026-10-20）
  if (await page.evaluate(() => typeof repliedToYou === 'function')) {
    const b0 = await page.evaluate(() => window.__badge || 0); // 返事あり＋答える（版45から）
    const id = await page.evaluate(async () => {
      const c = cards.find((x) => !x.deleted && x.lane !== 'done');
      const now = new Date().toISOString(), db = await window.claude.use('db');
      await db.collection('cards').doc(c.id).update({ history: [...(c.history || []), { at: now, who: 'you', text: '見本のコメント' }, { at: now, who: 'claude', text: '見本の返事' }] });
      return c.id;
    });
    const up = await page.waitForFunction((n) => window.__badge === n, b0 + 1, { timeout: 5000 }).then(() => true, () => false);
    // 版44は開いたら（reply_seen_at）、版45からは「読んだ」を押したら（reply_ack_at）消える。両方書いて、どちらの版でも減ること
    await page.evaluate(async (id) => { const t = new Date(Date.now() + 1000).toISOString(); await (await window.claude.use('db')).collection('cards').doc(id).update({ reply_seen_at: t, reply_ack_at: t }); }, id);
    const down = await page.waitForFunction((n) => (window.__badge || 0) === n, b0, { timeout: 5000 }).then(() => true, () => false);
    check(up && down, `アプリのアイコンに「返事が来た」カードの枚数を出し、読んだら減らす（${b0}→${b0 + 1}→${b0}、いま ${await page.evaluate(() => window.__badge)}）`);
  }
  // アイコンの数には、答えていない確認も入る（ボード版45「返事あり＋答える」。見本の s2 は答えていない確認）
  if (await page.evaluate(() => typeof needsYou === 'function')) {
    const want = await page.evaluate(() => cards.filter((c) => { const n = needsYou(c); return n && /返事あり|答える/.test(n.why); }).length);
    check(want > 0 && await page.evaluate(() => window.__badge || 0) === want, `アプリのアイコンの数は「返事あり＋答える」と同じ（${want}）`);
  }
  // 声とポチがカードを読む順は、ボードの並び（prioCmp：急ぎ→答える・返事あり→期限が近い→大事さ÷手間）と同じ（ボード版48）
  if (await page.evaluate(() => typeof prioCmp === 'function')) {
    const same = await page.evaluate(() => {
      const mine = LK.queueTitles('now'), board = cards.filter((c) => !c.deleted && c.lane === 'now').sort(prioCmp).map((c) => c.title);
      return JSON.stringify(mine) === JSON.stringify(board) ? '' : mine.join('/') + ' ≠ ' + board.join('/');
    });
    check(!same, `声とポチが「今やる」を読む順は、ボードの並びと同じ${same ? '（' + same + '）' : ''}`);
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
  // ⋯ の中身が画面の外にはみ出さない（v42 の点検：右寄せで左にはみ出すことがあった）
  const outMenu = await phone.$$eval('#lkMenu .items button', (els) => els.filter((e) => e.getClientRects().length)
    .map((e) => { const r = e.getBoundingClientRect(); return r.left < 0 || r.right > innerWidth + 1 ? e.textContent.trim().slice(0, 10) : null; }).filter(Boolean));
  check(outMenu.length === 0, `スマホ幅で ⋯ の中身が画面の中に収まる（はみ出し: ${outMenu.join('、') || 'なし'}）`);
  // つながる前に使えないものは、押せない灰色で並べず、隠す
  check(await phone.evaluate(() => [...document.querySelectorAll('#lkMenu .items button')].every((b) => !b.disabled || b.hidden)), '⋯ に押せない灰色の項目を並べない');
  // 上のバーは1段（2段だとカードが下へ押し出される）。隅のポチがいるときは 💬 を出さない（会話の入口を1つに）
  const bar = await phone.evaluate(() => { const hb = document.querySelector('header .hbtns'); const tops = new Set([...hb.children].filter((e) => e.getClientRects().length && getComputedStyle(e).display !== 'none').map((e) => Math.round(e.getBoundingClientRect().top / 10))); const pochi = document.querySelector('#lkPochi'); return { rows: tops.size, talk: !!document.querySelector('#talkBtn')?.getClientRects().length, pochi: !!pochi && !pochi.hidden }; });
  check(bar.rows <= 1, `スマホ幅で上のバーが1段（${bar.rows}段）`);
  check(!bar.pochi || !bar.talk, `スマホ幅で隅のポチがいるときは 💬 を出さない（ポチ ${bar.pochi}・💬 ${bar.talk}）`);
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
  await swipe(-150); await phone.waitForTimeout(900);
  // 移った先の列（下の列が畳まれて短いと、一番上まで送れないことがある＝ボード v53）。列の頭が画面の上半分に来ていればよい
  const moved = () => phone.evaluate(() => { const id = document.getElementById('board').dataset.swipeLane; const l = id && document.getElementById(id); return l && l.getBoundingClientRect().top < innerHeight / 2 ? id : null; });
  const idx = (id) => phone.evaluate((id) => [...document.querySelectorAll('#board .lane')].findIndex((l) => l.id === id), id);
  const l1 = await moved();
  check(!!l1 && await idx(l1) === await idx(l0) + 1, `左になぞるとちょうど次の列へ（${l0} → ${l1}）`);
  await swipe(-150); await phone.waitForTimeout(900);
  const l2 = await moved();
  check(!!l2 && await idx(l2) === await idx(l0) + 2, `もう一度なぞるとその次の列へ（${l1} → ${l2}。前は畳んだ列があると2つ目で止まった）`);
  await swipe(150); await phone.waitForTimeout(900);
  // 間を空けずに続けてなぞっても数え違えない（v37 の点検）
  await swipe(-150); await phone.waitForTimeout(150); await swipe(150); await phone.waitForTimeout(900);
  check(await phone.evaluate(() => document.getElementById('board').dataset.swipeLane) === l1, `続けて速くなぞっても数え違えない（左・右ですぐ戻すと ${l1} のまま）`);
  await swipe(150); await phone.waitForTimeout(600);
  check(await topLane() === l0, '右になぞると前の列へ戻る');

  // 切り替えボタンは押すと「選ばれている」印（aria-pressed と見た目）が変わること
  // （2026-10-19 claude.ai のボードで、表示だけ変わって印が変わらない不具合があった。shared-workflows incidents/2026-10-19-board-toggle-state.md）
  if (!REAL) {
    await phone.click('#lkMenu summary'); await phone.click('#lkMenu [data-m=look]');
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

  // ---------- 基本の使い方（本物のボードの画面を、アプリの中で人が押す順に。ボード版45から） ----------
  // ボード側の board/check-basics.mjs と同じ流れを、アプリ（鍵・GitHub への保存・アプリの部品が乗った画面）で通す。
  // 2026-10-20 ボード版46〜48 で、PC の詳細を閉じても画面に残った（#detail.wide の display:grid が閉じた dialog を上書き）。
  if (REAL && await phone.evaluate(() => typeof ackReply === 'function')) {
    for (const [w, h] of [[1366, 768], [1280, 640], [390, 844]]) {
      const pg = await context.newPage();
      const tag = `${w}x${h}`;
      pg.on('pageerror', (e) => errors.push(`pageerror(基本 ${tag}): ${e.message}`));
      pg.on('dialog', (d) => { errors.push(`ブラウザのダイアログが出た(基本 ${tag}): ${d.message()}`); d.dismiss(); });
      await pg.setViewportSize({ width: w, height: h });
      // ボード v53 から「エージェント」「保留」「済み」の列は最初は畳まれ、カードが描かれない。基本の検査は全部の列を開いて見る
      await pg.addInitScript(() => { try { localStorage.setItem('kanban-folded2', '{}'); } catch { /* なくてよい */ } });
      await pg.goto(base);
      await ready(pg);
      await pg.evaluate(() => { const d = document.getElementById('talkDlg'); if (d?.open) d.close(); });
      const card = (t) => pg.locator('#board .card', { hasText: t }).first();
      // 畳んだ列（ボード v53：進行中・保留・済みは最初は畳む）の中のカードは、列を開いてから触る（satouさんと同じ手順）
      const reveal = (t) => pg.evaluate((t) => { const c = [...document.querySelectorAll('#board .card')].find((e) => e.textContent.includes(t)); const f = c?.closest('.lane.folded')?.querySelector('h2 button.fold'); if (f) f.click(); return !!f; }, t);
      const shown = () => pg.evaluate(() => { const d = document.getElementById('detail'); return d.open || (getComputedStyle(d).display !== 'none' && d.getBoundingClientRect().height > 0); });
      const openC = async (t) => { await card(t).locator('.ttl').click({ timeout: 3000 }); await pg.waitForTimeout(200); return shown(); };
      const shut = () => pg.evaluate(() => { const d = document.getElementById('detail'); if (d.open) d.close(); });
      const outside = async () => {
        const pt = await pg.evaluate(() => { const r = document.getElementById('detail').getBoundingClientRect(); return [[4, innerHeight - 4], [innerWidth - 4, innerHeight - 4], [4, 4], [innerWidth - 4, 4]].find(([x, y]) => x < r.left || x > r.right || y < r.top || y > r.bottom) || null; });
        return pt ? pg.mouse.click(pt[0], pt[1]) : pg.keyboard.press('Escape');
      };
      for (const [how, act] of [['✕', () => pg.locator('#detail .dx').click({ timeout: 2000 })], ['下の「閉じる」', () => pg.locator('#detail button', { hasText: /^閉じる$/ }).click({ timeout: 2000 })], ['Esc', () => pg.keyboard.press('Escape')], ['外を押す', outside]]) {
        let why = '';
        try {
          if (!(await openC('見本のカード（今やる）'))) why = '詳細が開かない';
          else {
            await act(); await pg.waitForTimeout(250);
            if (await shown()) why = '閉じても詳細が画面に残る';
            else if (!(await openC('見本のカード（次にやる'))) why = '閉じたあと、ほかのカードが開けない';
          }
        } catch (e) { why = e.message.split('\n')[0]; }
        await shut();
        check(!why, `基本 ${tag}：詳細を${how}で閉じると画面から消え、ほかのカードが開ける${why ? '（' + why + '）' : ''}`);
      }
      if (w !== 1366) { await pg.close(); continue; }
      // ここからは書き込む。GitHub への保存（cards.json の PUT）まで届くことを見る
      const saved = async (pred) => { const t0 = Date.now(); while (!pred(lastCards()) && Date.now() - t0 < 10000) await pg.waitForTimeout(100); return pred(lastCards()); };
      const step = async (name, fn) => { let why = ''; try { why = await fn() || ''; } catch (e) { why = e.message.split('\n')[0]; } await shut(); check(!why, `基本 ${tag}：${name}${why ? '（' + why + '）' : ''}`); };
      await step('カードを足すと画面に出て、保存に届く', async () => {
        if (await pg.locator('#compose').isHidden()) await pg.locator('#compose-btn').click();
        await pg.fill('#new-title', '基本の検査で足したカード');
        await pg.locator('#add button[type=submit], #add button').last().click();
        if (!(await saved((cs) => cs.some((c) => c.title === '基本の検査で足したカード')))) return '保存に届かない';
        return (await pg.locator('#board .card', { hasText: '基本の検査で足したカード' }).count()) ? '' : '画面に出ない';
      });
      await step('⋯ から「今やる」へ移すと保存に届く', async () => {
        await card('基本の検査で足したカード').locator('details.menu summary').click();
        await card('基本の検査で足したカード').locator('.pop button', { hasText: '今やるへ' }).click();
        return (await saved((cs) => cs.some((c) => c.title === '基本の検査で足したカード' && c.lane === 'now'))) ? '' : '今やるにならない';
      });
      await step('⋯ から済みにすると保存に届く', async () => {
        await card('基本の検査で足したカード').locator('details.menu summary').click();
        await card('基本の検査で足したカード').locator('.pop button', { hasText: '済みにする' }).first().click();
        return (await saved((cs) => cs.some((c) => c.title === '基本の検査で足したカード' && c.lane === 'done' && c.done_at))) ? '' : '済みにならない';
      });
      await step('詳細からコメントを書くと保存に届く', async () => {
        if (!(await openC('見本のカード（今やる）'))) return '詳細が開かない';
        await pg.locator('#detail textarea').last().fill('基本の検査のコメント');
        await pg.locator('#detail button', { hasText: 'コメントして' }).click();
        return (await saved((cs) => cs.some((c) => c.doc_id === 's1' && (c.history || []).some((x) => x.who === 'you' && x.text === '基本の検査のコメント')))) ? '' : '履歴に書かれない';
      });
      await step('確認に答えると保存に届く', async () => {
        await card('見本の確認').locator('button.opt', { hasText: 'はい' }).first().click();
        return (await saved((cs) => cs.some((c) => c.doc_id === 's2' && c.answer))) ? '' : '答えが書かれない';
      });
      await step('担当で絞る', async () => {
        await pg.locator('button[data-f=agent]').click(); await pg.waitForTimeout(200);
        const a = await pg.locator('#board .card', { hasText: '見本のカード（エージェント）' }).count(), y = await pg.locator('#board .card', { hasText: '見本のカード（今やる）' }).count();
        await pg.locator('button[data-f=all]').click();
        return a && !y ? '' : '絞り込みが効かない';
      });
      await step('探す', async () => {
        await pg.fill('#q', '予定待ち'); await pg.waitForTimeout(300);
        const n = await pg.locator('#board .card:visible').count(); await pg.fill('#q', ''); await pg.waitForTimeout(200);
        return n === 1 ? '' : `探した結果が ${n} 枚`;
      });
      await step('一覧と記録に切り替えて戻る', async () => {
        for (const v of ['list', 'stats', 'board']) { await pg.locator('button[data-v=' + v + ']').click(); await pg.waitForTimeout(200); }
        return (await pg.locator('#lane-now .card').count()) ? '' : 'ボードに戻らない';
      });
      // ボード版50：ひと押しの返事・寝かせる（snooze_until）・返事の印をまとめて消す（reply_ack_at）
      if (await pg.evaluate(() => typeof snoozed === 'function')) {
        await step('ひと押しの返事が保存に届く', async () => {
          if (!(await openC('見本のカード（今やる）'))) return '詳細が開かない';
          const b = pg.locator('#detail .qreply button', { hasText: 'それで進めて' });
          if (!(await b.count())) return 'ひと押しの返事のボタンが無い';
          await b.click();
          return (await saved((cs) => cs.some((c) => c.doc_id === 's1' && (c.history || []).some((x) => /you|satou/.test(x.who) && x.text === 'それで進めて')))) ? '' : '履歴に書かれない';
        });
        await step('寝かせると列から消え、保存に届き、やめると戻る', async () => {
          const t = '見本のカード（エージェント）';
          await reveal(t); await pg.waitForTimeout(100);
          await card(t).locator('details.menu summary').click();
          await card(t).locator('.pop button', { hasText: '明日まで寝かせる' }).click();
          if (!(await saved((cs) => cs.some((c) => c.doc_id === 's4' && c.snooze_until)))) return 'snooze_until が保存されない';
          await pg.waitForTimeout(200);
          if (await pg.locator('#board .card', { hasText: t }).count()) return '寝かせても列に残る';
          await pg.locator('#focus .linkish', { hasText: '寝かせ中' }).click(); await pg.waitForTimeout(200);
          await reveal(t); await pg.waitForTimeout(100);
          await card(t).locator('details.menu summary').click();
          await card(t).locator('.pop button', { hasText: '寝かせをやめる' }).click();
          if (!(await saved((cs) => cs.some((c) => c.doc_id === 's4' && !c.snooze_until)))) return 'やめても snooze_until が残る';
          const hide = pg.locator('#focus .linkish', { hasText: '隠す' }); if (await hide.count()) await hide.click();
          await pg.waitForTimeout(200);
          return (await pg.locator('#board .card', { hasText: t }).count()) ? '' : 'やめても列に戻らない';
        });
        await step('返事の印をまとめて消すと保存に届く', async () => {
          // ボタンは返事ありが3枚以上のときに出る
          await pg.evaluate(async () => {
            const db = await window.claude.use('db'), at = new Date().toISOString();
            for (const c of cards.filter((x) => !x.deleted && x.lane !== 'done' && x.owner !== 'agent').slice(0, 3)) await db.collection('cards').doc(c.id).update({ history: [...(c.history || []), { at, who: 'you', text: '?' }, { at, who: 'claude', text: '見本の返事' }] });
          });
          await pg.waitForTimeout(400);
          const ab = pg.locator('#focus .linkish', { hasText: 'まとめて読んだ' });
          if (!(await ab.count())) return 'まとめて消すボタンが無い';
          await ab.click();
          if (!(await saved((cs) => cs.filter((c) => c.reply_ack_at).length >= 3))) return 'reply_ack_at が保存されない';
          await pg.waitForTimeout(200);
          return (await pg.locator('#board .card.replied').count()) ? 'まとめて消しても印が残る' : '';
        });
      }
      await pg.close();
    }
  }
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

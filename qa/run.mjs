// カンバンの PWA の自動検査（Claude を使わず CI で回す）。
// 本物の GitHub や鍵は使わない。api.github.com への通信はブラウザの中で見本のデータ（qa/cards.sample.json）に差し替える。
//   ❌ 失敗にするもの:
//     - manifest の必須項目・アイコンの大きさ、sw.js の SHELL に書いたファイルが無い
//     - JS のエラー（pageerror / console.error）
//     - 見本のカードが列に出ない、「済み」「答える」が GitHub への保存（PUT）に届かない、保存の中身が違う
//     - 鍵（Authorization）を api.github.com 以外に送った
//     - service worker が動かない、オフラインで開き直すと画面が出ない
//     - スマホ幅（390px）で列がタブにならない
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
const vendorFiles = [...localai.matchAll(/'(vendor\/[^']+)'/g)].map((m) => m[1]).flatMap((p) => (/\.(m?js)$/.test(p) ? [p] : [p + '.mjs', p + '.wasm']));
check(vendorFiles.length === 4, `localai.js が指す同梱の部品を読めた（${vendorFiles.length}）`);
for (const p of vendorFiles) {
  check(existsSync(resolve(root, p)), `同梱の部品 ${p} がある`);
  check(existsSync(resolve(root, dirname(p), 'LICENSE')), `同梱の部品 ${dirname(p)} に LICENSE がある`);
}
const html = readFileSync(resolve(root, 'index.html'), 'utf8');
const csp = (html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/) || [])[1] || '';
const connect = (csp.match(/connect-src ([^;]+)/) || [])[1]?.trim().split(/\s+/) || [];
// 許すのは、自分のサイト・GitHub の API（カードの保存）・モデルの置き場（Hugging Face と WebLLM のモデル用 wasm の GitHub raw）だけ
const MODEL_HOSTS = ['https://huggingface.co', 'https://*.huggingface.co', 'https://*.hf.co', 'https://raw.githubusercontent.com'];
check(connect.length > 0 && connect.every((x) => x === "'self'" || x === 'https://api.github.com' || MODEL_HOSTS.includes(x)), `CSP の connect-src は自分のサイト・GitHub の API・モデルの置き場だけ（${connect.join(' ') || 'なし'}）`);
const isModelHost = (h) => h === 'huggingface.co' || h.endsWith('.huggingface.co') || h.endsWith('.hf.co') || h === 'raw.githubusercontent.com';
check(/default-src 'self'/.test(csp), 'CSP の default-src は自分のサイトだけ');
const sc = manifest.shortcuts || [];
check(sc.length >= 3, `manifest に shortcuts が 3 つ以上ある（${sc.length}）`);
for (const x of sc) check(!!x.name && /^\.\/(#|$)/.test(x.url || '') && (x.icons || []).every((i) => existsSync(resolve(root, i.src))), `shortcut「${x.name}」の url が scope の中で、アイコンがある`);
const st = manifest.share_target || {};
check(st.action === './' && st.method === 'GET' && st.params?.title === 'title' && st.params?.text === 'text' && st.params?.url === 'url', 'manifest の share_target が ./ に GET で title・text・url を渡す');

// ---------- 2. 手元のサーバー（127.0.0.1 だけ） ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
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
export async function deleteModelAllInfoInCache(id) { window.__deleted = id; }`,
  tf: `export const env = { backends: { onnx: { wasm: {} } } };
export class Tensor { constructor(type, data, dims) { Object.assign(this, { type, data, dims }); } }
export async function pipeline(task, model, opts) {
  window.__asr = { task, model, device: opts.device };
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
    vendorHits.push(p);
    if (fakeVendor && /web-llm/.test(p)) { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end(FAKE.llm); }
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

// 保存は cards.json → BOARD.md の順に PUT される。前の保存の BOARD.md を取り違えないよう、cards.json の中身で待つ
const waitCards = async (pred, label) => {
  const t0 = Date.now();
  while (!pred(lastCards()) && Date.now() - t0 < 10000) await page.waitForTimeout(100);
  check(pred(lastCards()), `${label}が GitHub への保存（PUT）に届いた`);
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
  await waitCards((cs) => cs.some((c) => c.doc_id === 's1' && c.lane === 'done'), '「済み」');
  let c1 = lastCards().find((c) => c.doc_id === 's1');
  check(c1?.lane === 'done' && !!c1.done_at, '「済み」にしたカードが lane done・done_at 付きで保存された');
  check(c1?.moves?.at(-1)?.from === 'now' && c1?.moves?.at(-1)?.to === 'done', '列の移動（moves）が記録された');
  check(c1?.local_edit === true, 'ローカルで直した印（local_edit）が付いた');
  check(puts[0]?.body?.sha === 'sha-cards', '読んだときの sha を付けて保存した（上書きの事故を防ぐ）');
  check(lastCards().some((c) => c.doc_id === 's6' && c.deleted), '消したカードの行は保存でも残る');

  // 確認のカードに答える
  await page.locator('#board .card.ask [data-opt="0"]').click();
  await waitCards((cs) => cs.some((c) => c.doc_id === 's2' && c.answer), '確認への答え');
  const c2 = lastCards().find((c) => c.doc_id === 's2');
  check(c2?.answer === 'はい' && c2?.answer_status === 'local', '答え（answer・answer_status）が保存された');
  check(c2?.lane === 'agent' && c2?.owner === 'agent' && !!c2?.started_at && c2?.moves?.at(-1)?.to === 'agent', '答えたカードはエージェントの番（lane・owner agent、started_at・moves 付き。claude.ai のボードと同じ）');
  // 予定待ち（wait）：列があり、予定の日時を出し、期限切れの印を付けない
  const w = page.locator('#board .lane[data-lane=wait] .card', { hasText: '見本のカード（予定待ち）' });
  check(await w.count() === 1, '予定待ちの列（wait）にカードが出る');
  check(/🗓 1\/5 \d\d:30/.test(await w.textContent()), '予定待ちのカードに予定の日時（🗓 1/5 ◯◯:30）を出す');
  check(await w.locator('.chip.late').count() === 0, '予定待ちのカードは期限切れに数えない');

  // カードを足す
  await page.click('#addBtn');
  await page.fill('#addForm [name=title]', 'QA で足したカード');
  await page.click('#addForm button.primary');
  await waitCards((cs) => cs.some((c) => c.title === 'QA で足したカード'), 'カードの追加');
  check(lastCards().some((c) => c.title === 'QA で足したカード' && /^local-/.test(c.doc_id)), '足したカードが local- の ID で保存された');

  check(puts.some((p) => p.path === 'local-board/BOARD.md'), 'BOARD.md も保存した');

  // 声の命令の読み取り（voice.js）
  const parsed = await page.evaluate(() => {
    const L = [['now', '今やる', '今'], ['next', '次にやる', '次'], ['later', '時間があるとき', 'あとで'], ['hold', '保留'], ['agent', 'エージェント'], ['done', '済み']];
    return ['牛乳を買うを追加', '牛乳を買うを今やるに追加', '今やるに牛乳を買うを追加', '請求書を済み', '請求書を保留へ', '今やるを読んで', '戻す', '請求書を消して', '2番', 'はい', 'ほにゃらら']
      .map((t) => JSON.stringify(Voice.parse(t, L)));
  });
  const want = ['{"type":"add","title":"牛乳を買う","lane":null}', '{"type":"add","title":"牛乳を買う","lane":"now"}', '{"type":"add","title":"牛乳を買う","lane":"now"}',
    '{"type":"done","query":"請求書"}', '{"type":"move","query":"請求書","lane":"hold"}', '{"type":"read","lane":"now"}', '{"type":"undo"}',
    '{"type":"delete","query":"請求書"}', '{"type":"pick","n":2}', '{"type":"yes"}', '{"type":"unknown","text":"ほにゃらら"}'];
  parsed.forEach((p, i) => check(p === want[i], `声の文型 ${i + 1}: ${want[i]}（${p}）`));

  // Ctrl+K の命令欄で列を移す
  const cmd = async (t) => { await page.keyboard.press('Control+k'); await page.fill('#cmdIn', t); await page.press('#cmdIn', 'Enter'); };
  await cmd('見本のカード（次にやる・毎週）を保留へ');
  await waitCards((cs) => cs.find((c) => c.doc_id === 's3')?.lane === 'hold', 'Ctrl+K の「〇〇を保留へ」');
  check(lastCards().find((c) => c.doc_id === 's3')?.lane === 'hold', 'Ctrl+K の命令でカードが保留に移った');
  // 消す前に聞き返す → はい で消す → 戻す で戻る
  await page.waitForTimeout(1500);
  const b4 = puts.length;
  await cmd('見本のカード（エージェント）を消して');
  await page.waitForTimeout(1600);
  check(puts.length === b4 && /消しますか/.test(await page.textContent('#status')), '「消して」はすぐ消さずに聞き返す');
  await page.fill('#cmdIn', 'はい'); await page.press('#cmdIn', 'Enter');
  await waitCards((cs) => cs.find((c) => c.doc_id === 's4')?.deleted === true, '聞き返しへの「はい」');
  check(lastCards().find((c) => c.doc_id === 's4')?.deleted === true, '「はい」でカードが消えた（行は残る）');
  await page.waitForTimeout(1500);
  await cmd('戻す');
  await waitCards((cs) => !cs.find((c) => c.doc_id === 's4')?.deleted, '「戻す」');
  check(!lastCards().find((c) => c.doc_id === 's4')?.deleted, '「戻す」で消す前に戻った');

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

  // 音声認識が無いブラウザ（Edge・Firefox）では🎤を出さず、案内を出す
  const noVoice = await context.newPage();
  await noVoice.addInitScript(() => { delete window.SpeechRecognition; delete window.webkitSpeechRecognition; });
  noVoice.on('pageerror', (e) => errors.push(`pageerror(音声認識なし): ${e.message}`));
  await noVoice.goto(base);
  await noVoice.waitForSelector('#board .card', { timeout: 10000 });
  check(await noVoice.$eval('#micBtn', (b) => b.hidden), '音声認識が無いと🎤ボタンを出さない');
  check(!(await noVoice.$eval('#voiceHint', (b) => b.hidden)), '音声認識が無いと Win+H・キーボードのマイクの案内を出す');
  await noVoice.close();
  // 端末の中で聞き取れないブラウザ（サーバーへ送る音声認識しか無い）でも🎤を出さない（プライベートな内容を外に出さない）
  const serverOnly = await context.newPage();
  await serverOnly.addInitScript(() => { class SR { start() { window.__started = true; } } window.webkitSpeechRecognition = SR; delete window.SpeechRecognition; });
  serverOnly.on('pageerror', (e) => errors.push(`pageerror(サーバー版だけ): ${e.message}`));
  await serverOnly.goto(base);
  await serverOnly.waitForSelector('#board .card', { timeout: 10000 });
  await serverOnly.waitForTimeout(300);
  check(await serverOnly.$eval('#micBtn', (b) => b.hidden), 'サーバーに送る音声認識しか無いと🎤ボタンを出さない');
  await serverOnly.keyboard.press('m'); await serverOnly.waitForTimeout(200);
  check(!(await serverOnly.evaluate(() => window.__started)), 'サーバーに送る音声認識は M キーでも動かさない');
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
    window.speechSynthesis.getVoices = () => [{ name: 'ネットの声', lang: 'ja-JP', localService: false }, { name: '端末の声', lang: 'ja-JP', localService: true }];
    window.speechSynthesis.speak = (u) => { window.__spoken.push(u.text); setTimeout(() => u.onend && u.onend(), 10); };
  });
  const b6 = puts.length;
  await mic.goto(base);
  await mic.waitForSelector('#board .card', { timeout: 10000 });
  await mic.click('#micBtn');
  const t6 = Date.now();
  while (!puts.slice(b6).some((p) => p.path === 'local-board/cards.json') && Date.now() - t6 < 12000) await mic.waitForTimeout(100);
  const spoken = await mic.evaluate(() => window.__spoken);
  check(spoken.some((t) => /候補が.*何番/.test(t)), `🎤 候補が複数のときは読み上げて番号を聞く（${spoken[0] || 'なし'}）`);
  const saved6 = JSON.parse(puts.slice(b6).find((p) => p.path === 'local-board/cards.json')?.text || '[]');
  const picked = saved6.filter((c) => c.lane === 'done' && c.moves?.at(-1)?.to === 'done' && c.moves?.at(-1)?.from !== null && c.doc_id !== 's5');
  check(picked.length === 1, `🎤「2番」で選んだカードが済みになった（${picked.map((c) => c.title).join('・') || 'なし'}）`);
  check(spoken.some((t) => /済みにしました/.test(t)), '🎤 結果を読み上げた');
  check(await mic.evaluate(() => Voice.localVoice()?.name === '端末の声'), '🎤 読み上げは端末の中の声を選ぶ（ネット経由の声は使わない）');
  check(await mic.evaluate(() => { const g = speechSynthesis.getVoices; speechSynthesis.getVoices = () => [{ name: 'ネットの声', lang: 'ja-JP', localService: false }]; const n = Voice.localVoice(); speechSynthesis.getVoices = g; return n === null; }), '🎤 端末の中の声が無ければ読み上げない');
  check(await mic.evaluate(() => window.__local), '🎤 端末の中だけで聞き取る設定（processLocally = true）で聞いた');
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
      window.speechSynthesis.speak = (u) => { window.__spoken.push(u.text); setTimeout(() => u.onend && u.onend(), 5); };
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
    await pg.waitForSelector('#board .card', { timeout: 10000 });
    return { pg, outside };
  };
  const waitTalkEnd = async (pg) => { const t0 = Date.now(); while (Date.now() - t0 < 15000 && (await pg.evaluate(() => document.querySelector('#talkDlg').open))) await pg.waitForTimeout(100); };

  // A. AI なし：1枚ずつ読み上げ、「済み」「あとで」で動かし、「終わり」で閉じる
  {
    const { pg, outside } = await talkPage({ heard: ['済み', 'あとで', '終わり'] }, '会話 AI なし');
    await pg.click('#talkBtn');
    await waitTalkEnd(pg);
    const spoken = await pg.evaluate(() => window.__spoken.join(''));
    check(/見本のカード（今やる）/.test(spoken), '会話（AI なし）：最初に「今やる」の1枚目を読み上げた');
    check(/AI なし/.test(await pg.textContent('#talkMode')), '会話（AI なし）：内蔵 AI が無い端末では AI なしで動く');
    await waitCards((cs) => cs.find((c) => c.doc_id === 's1')?.lane === 'done' && cs.find((c) => c.doc_id === 's2')?.lane === 'later', '会話（AI なし）の「済み」「あとで」');
    check(!(await pg.evaluate(() => document.querySelector('#talkDlg').open)), '会話（AI なし）：「終わり」で閉じた');
    check(outside.length === 0, `会話（AI なし）：自分のサイトと GitHub 以外へ通信していない${outside.length ? '（' + outside.join(', ') + '）' : ''}`);
    await pg.close();
  }

  // B. 端末の中の AI（Prompt API）：JSON の命令でカードを動かす。消す前は聞き返す。AI に補足を渡さない
  {
    const { pg, outside } = await talkPage({
      heard: ['毎週のやつ保留にしといて', 'エージェントのやつ消して', 'はい', '終わり'],
      replies: [
        { say: 'オッケー、保留にしたよ', action: { type: 'move', query: '見本のカード（次にやる・毎週）', lane: 'hold' } },
        { say: '消すね', action: { type: 'delete', query: '見本のカード（エージェント）' } },
      ],
    }, '会話 AI');
    await pg.click('#talkBtn');
    await waitTalkEnd(pg);
    check(/端末の中の AI/.test(await pg.textContent('#talkMode')), '会話（AI）：内蔵 AI があれば使う');
    await waitCards((cs) => cs.find((c) => c.doc_id === 's3')?.lane === 'hold' && cs.find((c) => c.doc_id === 's4')?.deleted === true, '会話（AI）の「保留」と「消す（はい）」');
    const spoken = await pg.evaluate(() => window.__spoken.join(''));
    check(/消しますか/.test(spoken), '会話（AI）：AI が消すと言っても、すぐ消さずに聞き返した');
    const prompts = await pg.evaluate(() => window.__prompts.join('\n'));
    check(prompts.includes('見本のカード（次にやる・毎週）') && !prompts.includes('見本の補足'), '会話（AI）：AI に渡すのは題・列・期限だけ（補足は渡さない）');
    check(!prompts.includes('はい'), '会話（AI）：消す確認への「はい」は AI ではなくアプリが受け取る');
    const sys = await pg.evaluate(() => window.__system);
    check(/ポチ/.test(sys) && /タメ口/.test(sys), '会話（AI）：キャラの名前と性格を AI への指示に入れた');
    check(outside.length === 0, `会話（AI）：自分のサイトと GitHub 以外へ通信していない${outside.length ? '（' + outside.join(', ') + '）' : ''}`);
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

  check(vendorHits.length === 0, `ふだんの画面・会話では同梱の AI 部品（vendor/）を読み込まない${vendorHits.length ? '（' + vendorHits.join(', ') + '）' : ''}`);

  // E. 本物の同梱部品が CSP の下で読み込めて、localai.js が使う関数がある（モデルは取らない）
  {
    const pg = await context.newPage();
    pg.on('pageerror', (e) => errors.push(`pageerror(部品の読み込み): ${e.message}`));
    const outside = [];
    pg.on('request', (r) => { const h = new URL(r.url()).host; if (!/^127\.0\.0\.1(:\d+)?$/.test(h) && h !== 'api.github.com') outside.push(r.url()); });
    await pg.goto(base);
    await pg.waitForSelector('#board .card', { timeout: 10000 });
    const got = await pg.evaluate(async (v) => {
      const out = {};
      try { const m = await import('./' + v.llm); out.llm = ['CreateMLCEngine', 'deleteModelAllInfoInCache'].filter((k) => typeof m[k] === 'function'); } catch (e) { out.llmErr = String(e); }
      try { const m = await import('./' + v.tf); out.tf = ['pipeline', 'Tensor'].filter((k) => typeof m[k] === 'function').concat(typeof m.AutoModel?.from_pretrained === 'function' ? ['AutoModel'] : [], m.env?.backends?.onnx?.wasm ? ['wasm'] : []); } catch (e) { out.tfErr = String(e); }
      const w = await fetch('./' + v.ort + '.wasm').then((r) => r.arrayBuffer()).catch(() => null);
      out.wasm = !!w && WebAssembly.validate(new Uint8Array(w));
      out.compiled = !!w && await WebAssembly.compile(w).then(() => true, (e) => String(e)); // CSP の 'wasm-unsafe-eval' で wasm を動かせる
      return out;
    }, await pg.evaluate(() => window.LocalAI.VENDOR));
    check((got.llm || []).length === 2, `同梱の WebLLM を読み込めて、使う関数がある${got.llmErr ? '（' + got.llmErr + '）' : ''}`);
    check((got.tf || []).length === 4, `同梱の transformers.js を読み込めて、使う関数がある（${(got.tf || []).join(',')}${got.tfErr ? ' ' + got.tfErr : ''}）`);
    check(got.wasm === true, '同梱の ONNX Runtime の wasm が壊れていない');
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
    await pg.waitForSelector('#board .card', { timeout: 10000 });
    check(await pg.isHidden('#micBtn'), '端末の中の AI（入れる前）：耳が無いので🎤は出ない');
    await pg.evaluate(() => openTalkSet());
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
    check(await pg.isVisible('#micBtn'), '端末の中の AI：Whisper を入れたら🎤が出る');
    await pg.click('#talkSetForm button[value=cancel]');
    net.length = 0;
    await pg.evaluate(() => {
      window.__heard.push('毎週のやつ今やるにして', '終わり');
      window.__llmReplies.push({ say: 'オッケー、今やるに入れたよ', action: { type: 'move', query: '見本のカード（次にやる・毎週）', lane: 'now' } });
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
    check(net.length === 0, `会話（入れた AI）：会話中は外へ通信していない${net.length ? '（' + net.map((x) => x.url).join(', ') + '）' : ''}`);
    await pg.evaluate(() => openTalkSet());
    await pg.click('#aiDel');
    await pg.waitForFunction(() => /消しました/.test(document.querySelector('#aiMsg').textContent), null, { timeout: 10000 }).catch(() => {});
    check(await pg.evaluate(() => !localStorage.getItem('lk.ai') && window.__deleted === 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC'), '端末の中の AI：「入れた AI を消す」でモデルと印を消した');
    check(await pg.isHidden('#micBtn'), '端末の中の AI：消したら🎤も消える');
    await pg.click('#talkSetForm button[value=cancel]');
    await pg.evaluate(() => caches.delete('kanban-vendor'));
    fakeVendor = false;
    await pg.close();
  }

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
  check(tabs === 7, `スマホ幅で列のタブが 7 つ出た（${tabs}）`);
  const visibleLanes = await phone.$$eval('#board .lane', (e) => e.filter((s) => getComputedStyle(s).display !== 'none').length);
  check(visibleLanes === 1, `スマホ幅で見える列は 1 つ（${visibleLanes}）`);
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(overflow <= 1, `スマホ幅で横にはみ出さない（${overflow}px）`);
  await phone.locator('#tabs button', { hasText: '次にやる' }).click();
  const cur = await phone.$eval('#board .lane.cur', (s) => s.dataset.lane);
  check(cur === 'next', 'タブを押すとその列に切り替わる');

  // 切り替えボタンは押すと「選ばれている」印（aria-pressed と見た目のクラス）が変わること
  // （2026-10-19 claude.ai のボードで、表示だけ変わって印が変わらない不具合があった。shared-workflows incidents/2026-10-19-board-toggle-state.md）
  // 新しい切り替えボタンを足すときも、同じ並びのボタンに aria-pressed を付ければ、ここで全部押して確かめる。
  const unmarked = await phone.$$eval('button.on', (bs) => bs.filter((b) => !b.hasAttribute('aria-pressed')).length);
  check(unmarked === 0, `選ばれている見た目のボタンにはすべて aria-pressed がある（無いもの ${unmarked}）`);
  const groups = await phone.$$eval('[aria-pressed]', (bs) => [...new Set(bs.map((b) => b.parentElement))].map((p) => (p.id ? '#' + p.id : null)).filter(Boolean));
  check(groups.includes('#tabs'), '列のタブが切り替えボタン（aria-pressed）になっている');
  for (const g of groups) {
    const n = await phone.$$eval(`${g} > [aria-pressed]`, (bs) => bs.length);
    for (let i = 0; i < n; i++) {
      await phone.locator(`${g} > [aria-pressed]`).nth(i).click();
      const st = await phone.$$eval(`${g} > [aria-pressed]`, (bs) => bs.map((b) => [b.getAttribute('aria-pressed'), b.classList.contains('on')]));
      const ok = st.every(([a, on], j) => (j === i ? a === 'true' && on : a === 'false' && !on));
      check(ok, `${g} の ${i + 1} 番目を押すと、そのボタンだけが選ばれた印になる`);
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

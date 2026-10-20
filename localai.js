// 端末の中で動く AI の部品。Chrome の内蔵 AI や端末内の音声認識が無い端末（スマホなど）でも、会話モードで AI と話せるようにする。
//   頭       … WebLLM（WebGPU で小さな言葉のモデル Qwen2.5 を動かす）。返事の形は talk.js の Prompt API と同じ（session.prompt）
//              WebGPU が使えない端末（Chrome の対象外の GPU など）は wllama（llama.cpp の wasm。CPU で動く。GGUF）で同じモデルを動かす。遅いが動く
//   耳       … Whisper（transformers.js。声→文字）。端末内の音声認識が使えない端末だけで使う
//   割り込み … Silero VAD（transformers.js。声が始まったかを見る）。入っていなければ talk.js の音の大きさの VAD を使う
// 部品の JS と wasm は vendor/ に同梱（版を固定）。モデル本体は「AI の部品を入れる」を押したときだけ、
// Hugging Face（WebLLM のモデル用 wasm は raw.githubusercontent.com）から GET で取り、ブラウザの Cache API に保存する。以後はオフラインで動く。
// 会話・カードの中身はどこにも送らない（取りに行くのはモデルのファイルだけ。index.html の CSP で通信先を絞っている）。
(function (g) {
  'use strict';
  const VENDOR = {
    llm: 'vendor/web-llm-0.2.85/index.js',
    tf: 'vendor/transformers-4.3.0/transformers.js',
    ort: 'vendor/onnxruntime-web-1.31.0-dev.20260914-8d85527a0/ort-wasm-simd-threaded.asyncify',
    cpu: 'vendor/wllama-3.8.1/index.js',
    cpuWasm: 'vendor/wllama-3.8.1/wllama.wasm',
  };
  // CPU 版の頭（wllama）のモデル。Qwen 公式の GGUF（Apache-2.0）。Q4_0 は ARM の CPU で速い。コミットで固定
  const CPU = {
    label: 'Qwen2.5 0.5B（CPU）', gb: 0.4, from: 'huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF',
    url: 'https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/9217f5db79a29953eb74d5343926648285ec7e67/qwen2.5-0.5b-instruct-q4_0.gguf',
  };
  // 日本語が得意な頭（選んだときだけ）。SB Intuitions の sarashina2.2 0.5B instruct（MIT）。
  // 日本語 MT-Bench 4.55・ELYZA-tasks-100 2.38（Qwen2.5 0.5B instruct は 2.95・1.53。モデルカードの値）。
  // MLC（WebGPU）版が無いので CPU（wllama）で動かす。GGUF は mmnga さんの量子化（コミットで固定・Q4_0 は ARM の CPU で速い）
  const JA = {
    label: 'sarashina2.2 0.5B（CPU・日本語）', gb: 0.5, from: 'huggingface.co/mmnga/sarashina2.2-0.5b-instruct-v0.1-gguf',
    url: 'https://huggingface.co/mmnga/sarashina2.2-0.5b-instruct-v0.1-gguf/resolve/5c71186a7a57b8c0325dec70ba2f295303effcd8/sarashina2.2-0.5b-instruct-v0.1-Q4_0.gguf',
    credit: 'sarashina2.2-0.5b-instruct-v0.1 © SB Intuitions（MIT License）。GGUF：mmnga/sarashina2.2-0.5b-instruct-v0.1-gguf',
  };
  const CPU_MODELS = { qwen: CPU, sarashina: JA };
  // どの頭を入れるか（この端末だけの選択。入れた AI を消しても残す）
  const BRAIN_KEY = 'lk.aiBrain';
  const brainPick = () => { try { return CPU_MODELS[g.localStorage.getItem(BRAIN_KEY)] ? g.localStorage.getItem(BRAIN_KEY) : 'qwen'; } catch { return 'qwen'; } };
  const setBrain = (k) => { try { g.localStorage.setItem(BRAIN_KEY, CPU_MODELS[k] ? k : 'qwen'); } catch { /* 選べなくても標準で動く */ } };
  // 言葉のモデル（日本語が通じる小さなもの）。端末のメモリで選び、WebGPU が16ビットの計算をできなければ f32 版にする
  const MODELS = {
    small: { label: 'Qwen2.5 0.5B', gb: 0.4, f16: 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC', f32: 'Qwen2.5-0.5B-Instruct-q4f32_1-MLC' },
    large: { label: 'Qwen2.5 1.5B', gb: 1.0, f16: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC', f32: 'Qwen2.5-1.5B-Instruct-q4f32_1-MLC' },
  };
  // 耳と割り込みのモデルも版（コミット）で固定する（置き場の中身が変わっても、同じものを取る）
  const EAR = { id: 'onnx-community/whisper-base', revision: '1846881b6b3a3024392c1eea3ad983695bc23925', label: 'Whisper base', gb: 0.1 };
  const VAD = { id: 'onnx-community/silero-vad', revision: 'e71cae966052b992a7eca6b17738916ce0eca4ec', label: 'Silero VAD' };
  const KEY = 'lk.ai';
  const here = (p) => new URL(p, g.document?.baseURI || g.location?.href).href;
  const load = () => { try { return JSON.parse(g.localStorage.getItem(KEY)) || {}; } catch { return {}; } };
  const save = (v) => { try { g.localStorage.setItem(KEY, JSON.stringify({ ...load(), ...v })); } catch { /* 保存できなくても動く */ } };

  // 耳を版の固定より前に入れた端末には「固定していない」印を付ける（次に読むとき取り直さないため）。新しく入れるときは固定した版
  if (load().ear && load().pinned === undefined) save({ pinned: false });

  // ---------- 端末の下調べ ----------
  // いつも 0.5B（約0.4GB）。1.5B（約1GB）は PC で断りなく大きいものを取ってしまったので既定にしない（PC はふつう C ドライブに入る）
  function pickModel() { return MODELS.small; }
  // 端末内の音声認識（Chrome 139 以降）で日本語を聞き取れない端末だけ Whisper を入れる。
  // 関数（SpeechRecognition.available）があっても、Android の Chrome は日本語が 'unavailable' のことがある（2026-10-20 Pixel 6a）ので、
  // 実際の答えで決める。'downloadable' なら入れてみて、EAR_WAIT ミリ秒たっても使えなければ Whisper にする
  const EAR_WAIT = 20000;
  const needEar = () => !g.Voice?.localApi; // すぐ答えが要るとき（画面の目安）の仮の判定
  async function earNeeded({ tryInstall = false } = {}) {
    const V = g.Voice;
    if (!V?.localApi) return true;
    let st = await V.localStatus('ja-JP').catch(() => 'unavailable');
    if (st === 'available') return false;
    if (!tryInstall || (st !== 'downloadable' && st !== 'downloading')) return true;
    const t0 = Date.now();
    if (st === 'downloadable') V.install('ja-JP').catch(() => false);
    // install の終わりは待たず、毎回1秒おいて聞き直す（終わったあとも状態が変わらないと、待たずに聞き続けてしまうため）
    while (Date.now() - t0 < EAR_WAIT) {
      await new Promise((ok) => setTimeout(ok, 1000));
      st = await V.localStatus('ja-JP').catch(() => 'unavailable');
      if (st === 'available') return false;
      if (st === 'unavailable') return true;
    }
    return true;
  }
  // 入れる前に見せる大きさ（目安）。GPU にはまだ触らない（押したときに調べる）
  function plan() {
    const m = brainPick() === 'sarashina' ? JA : g.navigator?.gpu ? pickModel() : CPU;
    return { model: m.label, ear: needEar(), gb: Math.round((m.gb + (needEar() ? EAR.gb : 0)) * 10) / 10 };
  }
  // WebGPU の GPU を探す。既定で見つからなければ、電力の指定違い・互換モード（featureLevel: compatibility）でも探す。
  // 端末の GPU が Chrome の対象外（blocklist）だと全部 null になる（https://developer.chrome.com/docs/web-platform/webgpu/troubleshooting-tips）
  const TRIES = [['default'], ['high', { powerPreference: 'high-performance' }], ['low', { powerPreference: 'low-power' }], ['compat', { featureLevel: 'compatibility' }]];
  async function gpu() {
    const n = g.navigator?.gpu;
    if (!n) return null;
    for (const [mode, opt] of TRIES) {
      try { const a = await n.requestAdapter(opt); if (a) return { f16: a.features.has('shader-f16'), mode }; } catch { /* 次の指定で探す */ }
    }
    return null;
  }

  // ---------- 頭（WebLLM） ----------
  let llmLib = null, engine = null, engineId = '';
  const webllm = () => llmLib || (llmLib = import(here(VENDOR.llm)));
  async function engineFor(id, onProgress) {
    if (engine && engineId === id) return engine;
    const w = await webllm();
    engine = await w.CreateMLCEngine(id, { initProgressCallback: (r) => onProgress?.(r.progress, r.text) });
    engineId = id;
    return engine;
  }
  // ---------- 頭（wllama・CPU） ----------
  let cpuLib = null, cpuEngine = null;
  let cpuKey = '';
  async function cpuEngineFor(onProgress, key = load().cpuModel || 'qwen') {
    if (cpuEngine && cpuKey === key) return cpuEngine;
    try { await cpuEngine?.unload(); } catch { /* なくてよい */ }
    cpuEngine = null;
    const M = CPU_MODELS[key] || CPU;
    cpuLib = cpuLib || await import(here(VENDOR.cpu));
    const w = new cpuLib.Wllama({ default: here(VENDOR.cpuWasm) }, { allowOffline: true, suppressNativeLog: true });
    // WebGPU は使わない（使えない端末のための頭）。スレッドは COOP/COEP が無い GitHub Pages では1本になる
    try {
      await w.loadModelFromUrl(M.url, { n_gpu_layers: 0, n_ctx: CTX, progressCallback: ({ loaded, total }) => onProgress?.(total ? loaded / total : 0, M.url.split('/').pop()) });
    } catch (e) { try { await w.exit(); } catch { /* 片づけられなくてもよい */ } throw e; } // 失敗したら worker と wasm を放す（入れ直しのたびに残らない）
    // WebLLM と同じ形（chat.completions.create）にそろえる
    cpuEngine = {
      chat: { completions: { create: (req) => w.createChatCompletion(cpuReq(req)) } },
      unload: () => w.exit(),
      clear: () => w.cacheManager.clear(),
    };
    cpuKey = key;
    return cpuEngine;
  }
  // WebLLM の形の頼み方を wllama の形に直す（名前の違う項目と、JSON の形の指定）
  function cpuReq({ messages: m, temperature, top_p, repetition_penalty, max_tokens, stream, response_format: rf }) {
    let schema = null;
    try { schema = rf?.schema ? JSON.parse(rf.schema) : null; } catch { schema = null; }
    return {
      messages: m, max_tokens, temp: temperature, top_p, penalty_repeat: repetition_penalty, ...(stream ? { stream: true } : {}),
      ...(schema ? { response_format: { type: 'json_schema', json_schema: { name: 'reply', schema } } } : rf ? { response_format: { type: 'json_object' } } : {}),
    };
  }
  // 入れた頭を返す（WebLLM か wllama）
  const brain = () => (load().engine === 'cpu' ? cpuEngineFor() : engineFor(load().llm));

  // 返事の出し方。Qwen2.5 の公式の既定（generation_config.json：temperature 0.7・top_p 0.8・repetition_penalty 1.1）に合わせる。
  // 0.5 だと毎回同じような返事になり、定型文に聞こえた
  const SAMPLING = { temperature: 0.7, top_p: 0.8, repetition_penalty: 1.1 };
  // 一度に扱える量（トークン）。2048 だと数往復で超えて「うまく考えられなかった」が続いたので 4096 にし、
  // さらに古いやりとりから捨てる（KEEP 往復まで・合わせて BUDGET 字まで）。まとめは作らない（返事のたびに計算が走って遅くなったため）
  const CTX = 4096;
  const KEEP = 6;
  const BUDGET = 1500;
  // AI に渡す messages を組み立てる（検査からも呼ぶ）。ボードの一覧は毎回の発言にだけ入れ、覚える方には入れない
  function messages({ system, examples = [], summary = '', past = [], text }) {
    return [
      { role: 'system', content: system + (summary ? `\nこれまでの話のまとめ: ${summary}` : '') },
      ...examples.flatMap(([u, a]) => [{ role: 'user', content: u }, { role: 'assistant', content: a }]),
      ...recent(past),
      { role: 'user', content: text },
    ];
  }
  // 会話から渡す文の頭のボードの一覧（「いまのボード:」〜空行＋「ユーザー: 」）だけを外す。本人の言葉の中の「ユーザー: 」は残す
  const userPart = (t) => String(t).replace(/^いまのボード:[\s\S]*?\n\nユーザー: /, '');
  // 直近の KEEP 往復のうち、合わせて BUDGET 字に収まる分だけ（古いほうから捨てる）
  function recent(past) {
    let keep = past.slice(-KEEP * 2);
    const size = (l) => l.reduce((n, m) => n + String(m.content || '').length, 0);
    while (keep.length > 2 && size(keep) > BUDGET) keep = keep.slice(2);
    // 1往復だけでも長すぎるときは、こちらの言ったこと（user）を頭から BUDGET に収まる分だけにする（返事は JSON なので切らない）
    if (size(keep) > BUDGET) {
      const rest = size(keep.filter(m => m.role !== 'user'));
      keep = keep.map(m => m.role === 'user' ? { ...m, content: String(m.content || '').slice(0, Math.max(100, BUDGET - rest)) } : m);
    }
    return keep;
  }
  // Prompt API の session と同じ形（prompt(文, { responseConstraint })）で返す
  async function session(system, examples = []) {
    const id = load().llm;
    if (!id) return null;
    const e = await brain();
    const past = [];
    const summary = '';
    const remember = (user, said) => { past.push({ role: 'user', content: userPart(user) }, { role: 'assistant', content: said }); if (past.length > KEEP * 4) past.splice(0, past.length - KEEP * 2); }; // ボードの一覧は覚えない（毎回渡す）
    return {
      async prompt(text, { responseConstraint } = {}) {
        const r = await e.chat.completions.create({
          messages: messages({ system, examples, summary, past, text }), ...SAMPLING, max_tokens: 256,
          ...(responseConstraint ? { response_format: { type: 'json_object', schema: JSON.stringify(responseConstraint) } } : {}),
        });
        const out = r?.choices?.[0]?.message?.content || '';
        remember(text, out);
        return out;
      },
      // 出来たところから受け取る（文ごとに読み上げを始めて、遅さを隠す）。流して返せない頭なら、まとめて1回で返す
      async *promptStreaming(text, { responseConstraint } = {}) {
        const r = await e.chat.completions.create({
          messages: messages({ system, examples, summary, past, text }), ...SAMPLING, max_tokens: 256, stream: true,
          ...(responseConstraint ? { response_format: { type: 'json_object', schema: JSON.stringify(responseConstraint) } } : {}),
        });
        let out = '';
        if (r && typeof r[Symbol.asyncIterator] === 'function') {
          for await (const c of r) { const d = c?.choices?.[0]?.delta?.content ?? c?.choices?.[0]?.text ?? ''; if (d) { out += d; yield d; } }
        } else { out = r?.choices?.[0]?.message?.content || ''; if (out) yield out; }
        remember(text, out);
      },
      // AI を通らなかったやりとり（あいさつ・すぐやった命令）も覚える（「まずは〇〇から？」に「うん」で通じるように）
      note(user, said) { if (said) remember(user || '（会話を始めた）', JSON.stringify({ say: said, action: null })); },
      get summary() { return summary; },
      destroy() { past.length = 0; },
    };
  }

  // 画面が止まった時間（50ms 以上の長い処理）。診断に出す（会話の中身は入れない）
  const blocked = { max: 0, total: 0 };
  let lastListen = null;
  try {
    new g.PerformanceObserver((l) => { for (const e of l.getEntries()) { blocked.max = Math.max(blocked.max, e.duration); blocked.total += e.duration; } })
      .observe({ type: 'longtask', buffered: true });
  } catch { /* 数えられない端末では出さない */ }

  // ---------- 耳（Whisper）と割り込み（Silero VAD） ----------
  // 計算は ear-worker.js（画面とは別の作業場）でする。画面と同じところで動かすと、遅いスマホでは聞き取りの間に画面が固まった（2026-10-20 Pixel 6a）
  let ear = null, earVad = false, earThreads = null, earLoading = null, earState = '', seq = 0;
  const waits = new Map();
  // 耳の準備の時間切れ。過ぎたら止め、次に開いたときはスレッド1本で読む（スレッドの準備で止まる端末があったため。2026-10-20 Pixel）
  const EAR_LIMIT = 60000;
  const ONE_KEY = 'lk.ort1';
  const libPaths = () => {
    let one = false;
    try { one = !!g.localStorage.getItem(ONE_KEY); } catch { /* 読めなければふつうに */ }
    return { tfUrl: here(VENDOR.tf), mjs: here(VENDOR.ort + '.mjs'), wasm: here(VENDOR.ort + '.wasm'), one };
  };
  function earWorker() {
    if (ear) return ear;
    ear = new g.Worker(here('ear-worker.js'), { type: 'module' });
    ear.onmessage = ({ data: d }) => {
      const w = waits.get(d?.re);
      if (!w) return;
      if ('progress' in d) { w.onProgress?.(d.progress, d.file); return; }
      waits.delete(d.re);
      d.err ? w.ng(new Error(d.err)) : w.ok(d);
    };
    ear.onerror = (e) => { e.preventDefault?.(); stopEar(new Error('耳（声の聞き取り）の部品が読めませんでした（' + (e.message || 'worker') + '）')); };
    return ear;
  }
  // 耳を止めて放す（メモリを返す）。待っているものはエラーで返す
  function stopEar(err) {
    try { ear?.terminate(); } catch { /* 止められなくてもよい */ }
    ear = null; earVad = false; earThreads = null; earLoading = null;
    for (const w of waits.values()) w.ng(err || new Error('聞き取れませんでした'));
    waits.clear();
  }
  const call = (type, v = {}, transfer = [], onProgress) => new Promise((ok, ng) => {
    const id = ++seq;
    waits.set(id, { ok, ng, onProgress });
    earWorker().postMessage({ id, type, ...v }, transfer);
  });
  function loadEar(onProgress) {
    if (earState === 'ok' && ear) return Promise.resolve();
    if (earLoading) return earLoading;
    earState = 'pending';
    // 何も進まないまま EAR_LIMIT たったら時間切れ（取ってきている間は進むたびに数え直す。初めて入れるときの大きい取得で切らない）
    let timer, fail;
    const late = new Promise((_, ng) => { fail = ng; });
    const poke = () => { clearTimeout(timer); timer = setTimeout(() => {
      try { g.localStorage.setItem(ONE_KEY, '1'); } catch { /* 覚えられなくても知らせる */ }
      fail(new Error('耳（声の聞き取り）の準備が終わりませんでした。アプリを開き直してください（次は別のやり方で読みます）'));
    }, EAR_LIMIT); };
    poke();
    const work = (async () => {
      // 版を固定する前に入れた端末は、取り直さないよう前と同じ（main）を使う
      const pin = load().pinned !== false;
      const webgpu = (await gpu())?.mode === 'default'; // 互換モードでしか見つからない GPU では wasm（CPU）で聞く
      const r = await call('load', { ...libPaths(), webgpu, ear: { id: EAR.id, revision: pin ? EAR.revision : 'main' }, vad: { id: VAD.id, revision: pin ? VAD.revision : 'main' } }, [],
        (p, file) => { poke(); if (p != null && onProgress) onProgress(p, file || ''); });
      earVad = !!r.vad; earThreads = r.threads ?? null;
    })();
    return (earLoading = Promise.race([work, late])
      .then(() => { earState = 'ok'; earLoading = null; })
      .catch((e) => { earState = 'error'; stopEar(e); throw e; })
      .finally(() => clearTimeout(timer)));
  }

  // Silero VAD を1つ作る（それぞれ自分の状態を持つ）。512 サンプル（16kHz で 32ms）ごとに「声らしさ」0〜1 を返す。end() で片づける
  function sileroProb() {
    const key = ++seq;
    const f = async (frame) => (await call('vad', { key, frame })).p;
    f.end = () => { try { ear?.postMessage({ type: 'vad-end', key }); } catch { /* なくてよい */ } };
    return f;
  }
  // Silero が無いときの代わり：音の大きさ（まわりの音に合わせて基準を動かす）
  function loudnessProb() {
    let floor = 0.01, n = 0;
    return async (frame) => {
      let sum = 0; for (const v of frame) sum += v * v;
      const rms = Math.sqrt(sum / frame.length);
      if (n++ < 10) floor = Math.max(floor, rms); else if (rms < floor * 1.5) floor = floor * 0.95 + rms * 0.05;
      return rms > Math.max(floor * 3, 0.03) ? 1 : 0;
    };
  }

  // マイクの音を 16kHz・512 サンプルずつに区切って渡す
  function capture(stream, onFrame) {
    const AC = g.AudioContext || g.webkitAudioContext;
    const ac = new AC();
    const src = ac.createMediaStreamSource(stream);
    const sp = ac.createScriptProcessor(4096, 1, 1);
    const ratio = ac.sampleRate / 16000;
    let pos = 0, buf = [];
    sp.onaudioprocess = (e) => {
      const x = e.inputBuffer.getChannelData(0);
      while (pos < x.length) {
        const a = Math.floor(pos), b = Math.min(x.length, Math.max(a + 1, Math.floor(pos + ratio)));
        let s = 0; for (let i = a; i < b; i++) s += x[i];
        buf.push(s / (b - a));
        pos += ratio;
      }
      pos -= x.length;
      while (buf.length >= 512) onFrame(Float32Array.from(buf.splice(0, 512)));
    };
    src.connect(sp); sp.connect(ac.destination);
    if (ac.state === 'suspended') ac.resume().catch(() => {});
    return () => { sp.onaudioprocess = null; try { src.disconnect(); sp.disconnect(); ac.close(); } catch { /* 閉じられなくてもよい */ } };
  }

  // 1回分を聞き取って文字にする（Voice.listen から呼ばれる）。cancel() で途中でやめる（打つほうに切り替えたとき）
  let cancelCur = null, releaseCur = null;
  const cancel = () => { try { cancelCur?.(); } catch { /* 止められなくてもよい */ } };
  const release = () => { try { releaseCur?.(); } catch { /* なくてよい */ } };

  const emit = (name, detail) => { try { g.dispatchEvent?.(new CustomEvent(name, { detail })); } catch { /* なくてよい */ } };

  // Whisper の作り話（聞こえていないのに出る決まり文句）。動画の字幕で学んだため、静かなときに「ご視聴ありがとうございました」などを返す
  // （Whisper の hallucination として広く知られている。openai/whisper Discussions #928 など）。
  // 強い：カンバンに向かって言うことがまず無い文。声が短い（3秒未満）か小さいときは捨てる
  // 弱い：本当に言うこともある文（「おやすみなさい」など）。声がとても短い（0.8秒未満）か小さいときだけ捨てる
  const PHANTOM_STRONG = /^(ご視聴|ご清聴|最後までご覧|ご覧いただき).*ありがとうございま(した|す)|チャンネル登録|高評価|字幕|次回もお楽しみに|^(提供|作成|翻訳)[:：]/;
  const PHANTOM_WEAK = /^(おやすみなさい|ありがとうございました|ありがとうございます|お疲れ様でした|おつかれさまでした|さようなら|では、?また)$/;
  function phantom(text, { speechMs = 0, rms = 1 } = {}) {
    const t = String(text || '').replace(/[\s。、．！？!?♪…「」]/g, '');
    if (!t) return true;
    const quiet = rms < 0.015;
    if (PHANTOM_STRONG.test(t)) return quiet || speechMs < 3000;
    if (PHANTOM_WEAK.test(t)) return quiet || speechMs < 800;
    return false;
  }
  // hold: release() まで聞き続ける（間があっても切らない。Whisper は 30 秒ずつなので 28 秒で区切る）
  async function listen({ waitMs = 8000, maxMs = 15000, endMs = 700, hold = false } = {}) {
    if (hold) { maxMs = 28000; waitMs = 28000; }
    await loadEar();
    const md = g.navigator?.mediaDevices;
    if (!md?.getUserMedia) throw new Error('マイクが使えません');
    let stream;
    try { stream = await md.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
    catch { throw new Error('マイクが許可されていません'); }
    const prob = earVad ? sileroProb() : loudnessProb();
    const t0 = Date.now(), block0 = blocked.total;
    let said = [], ambient = 0;
    // 声の大きさを画面へ（耳と輪を声に合わせて動かす。B5）。1秒に10回まで。話し始める前の音の大きさは「まわりの音」として返す（B9）
    let lastLv = 0, quietN = 0, quietSum = 0;
    const level = (f, voice) => {
      let q = 0; for (const v of f) q += v * v;
      const rms = Math.sqrt(q / f.length);
      if (!voice) { quietN++; quietSum += rms; ambient = quietSum / quietN; }
      const now = Date.now();
      if (now - lastLv > 100) { lastLv = now; emit('voice:level', { v: Math.min(1, rms * 8) }); }
    };
    try {
      const audio = await new Promise((ok, ng) => {
        const pre = [];
        let talking = false, quiet = 0, done = false, chain = Promise.resolve(), nodded = false;
        const end = (err) => { if (done) return; done = true; cancelCur = null; releaseCur = null; clearTimeout(t1); clearTimeout(t2); stop(); stream.getTracks().forEach((t) => t.stop()); err ? ng(err) : ok([...pre, ...said]); };
        cancelCur = () => end(new Error('聞き取れませんでした'));
        releaseCur = () => end(talking ? null : new Error('聞き取れませんでした'));
        // 音が届かないときも止まらないように、時間でも区切る
        const t1 = setTimeout(() => { if (!talking) end(new Error('聞き取れませんでした')); }, waitMs + 500);
        const t2 = setTimeout(() => end(talking ? null : new Error('聞き取れませんでした')), maxMs + 500);
        const stop = capture(stream, (f) => {
          chain = chain.then(async () => {
            if (done) return;
            const p = await prob(f);
            level(f, p > 0.5);
            if (p > 0.5) { talking = true; quiet = 0; nodded = false; } else if (talking) { quiet += 32; if (quiet >= 320 && !nodded) { nodded = true; emit('voice:nod'); } } // 話の切れ目でうなずく
            if (talking) said.push(f); else { pre.push(f); if (pre.length > 10) pre.shift(); } // 話し始めの手前 0.3 秒も残す
            if ((talking && quiet >= endMs && !hold) || Date.now() - t0 > maxMs) end();
            else if (!talking && Date.now() - t0 > waitMs) end(new Error('聞き取れませんでした'));
          }).catch((e) => end(e));
        });
      });
      const all = new Float32Array(audio.length * 512);
      audio.forEach((f, i) => all.set(f, i * 512));
      let sum = 0; for (const f of said) for (const v of f) sum += v * v;
      const heard = { speechMs: said.length * 32, rms: Math.sqrt(sum / Math.max(1, said.length * 512)) };
      const { text } = await call('asr', { audio: all }, [all.buffer]);
      if (!text || phantom(text, heard)) throw new Error('聞き取れませんでした');
      return { text, noise: Math.round(ambient * 1000) / 1000 };
    } finally { prob.end?.(); lastListen = { ms: Date.now() - t0, blockedMs: Math.round(blocked.total - block0) }; }
  }

  // 話している途中の割り込み（Silero）。入っていなければ null（talk.js が音の大きさの VAD を使う）
  function bargeIn(stream, onVoice) {
    if (!earVad || !ear || !stream) return null;
    const prob = sileroProb();
    let n = 0, stopped = false, chain = Promise.resolve();
    const stop = capture(stream, (f) => {
      chain = chain.then(async () => {
        if (stopped) return;
        n = (await prob(f)) > 0.6 ? n + 1 : 0;
        if (n >= 4) { stopped = true; stop(); prob.end(); onVoice(); } // 約 0.13 秒続いたら声
      }).catch(() => {});
    });
    return () => { stopped = true; stop(); prob.end(); };
  }

  // ---------- 入れる・消す ----------
  function status() {
    const s = load();
    return { llm: s.llm || '', cpu: s.engine === 'cpu', brain: s.llm ? (s.engine === 'cpu' ? s.cpuModel || 'qwen' : 'qwen') : '', ear: !!s.ear, at: s.at || '', from: s.from || [] };
  }
  // 「AI の部品を入れる」を押したとき。onProgress(0〜1, 何を取っているか)
  // WebGPU が使えない・WebLLM が動かない端末は、CPU で動く頭（wllama）を入れる
  const CPU_NOTE = 'この端末の Chrome は WebGPU が使えないので、CPU で動く AI を入れます（返事はゆっくり）。';
  // earOnly：頭はもう入っていて、耳（Whisper）だけ足すとき
  async function install(onProgress, { earOnly = false } = {}) {
    const ear = await earNeeded({ tryInstall: true });
    const step = (base, part) => (p, what) => onProgress?.(base + part * Math.max(0, Math.min(1, p || 0)), what);
    if (ear && !load().ear) save({ pinned: true });
    if (earOnly && load().llm) {
      if (ear) {
        await loadEar(step(0, 1));
        save({ ear: true, earCache: await hasTfCache(), from: [...new Set([...(load().from || []), `huggingface.co/${EAR.id}`, ...(earVad ? [`huggingface.co/${VAD.id}`] : [])])] });
      }
      onProgress?.(1, '');
      return status();
    }
    // 頭を替えるときは、前の頭を先に消す（端末に2つ残さない）
    const pick = brainPick(), was = load();
    if (was.llm && (was.engine === 'cpu' ? (was.cpuModel || 'qwen') !== pick : pick !== 'qwen')) {
      try { await cpuEngine?.unload(); } catch { /* なくてよい */ }
      cpuEngine = null; cpuKey = '';
      try { if (was.engine === 'cpu') { cpuLib = cpuLib || await import(here(VENDOR.cpu)); await new cpuLib.CacheManager().clear(); } else { engine?.unload?.(); engine = null; engineId = ''; await (await webllm()).deleteModelAllInfoInCache?.(was.llm); } } catch { /* 消せなくても入れ直す */ }
      save({ llm: '', engine: '' });
    }
    const a = pick === 'qwen' ? await gpu() : null; // 日本語の頭は MLC 版が無いので、いつも CPU
    let id = '', from = [], why = '';
    if (a) {
      const m = pickModel();
      id = a.f16 ? m.f16 : m.f32;
      try {
        await engineFor(id, step(0, ear ? 0.8 : 1));
        from = [`huggingface.co/mlc-ai/${id}`, 'raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs'];
        save({ llm: id, engine: 'webllm' });
      } catch (e) {
        why = String(e?.message || e);
        // 途中まで取った WebLLM のモデルを消してから CPU 版へ（端末に残さない。消すボタンは CPU 版しか消さないため）
        try { await (await webllm()).deleteModelAllInfoInCache?.(id); } catch { /* 消せなくても CPU 版へ進む */ }
        id = ''; engine = null; engineId = '';
      }
    }
    if (!id) {
      const M = CPU_MODELS[pick];
      onProgress?.(0, pick === 'sarashina' ? '日本語が得意な AI（sarashina2.2）を入れます。CPU で動くので返事はゆっくりです。' : why ? 'この端末では WebGPU の AI が動かなかったので、CPU で動く AI を入れます（返事はゆっくり）。' : CPU_NOTE);
      await cpuEngineFor(step(0, ear ? 0.8 : 1), pick);
      id = M.label;
      from = [M.from];
      save({ llm: id, engine: 'cpu', cpuModel: pick });
    }
    if (ear) {
      await loadEar(step(0.8, 0.2));
      from.push(`huggingface.co/${EAR.id}`);
      if (earVad) from.push(`huggingface.co/${VAD.id}`);
      save({ ear: true });
    }
    save({ at: new Date().toISOString().slice(0, 10), from, earCache: await hasTfCache() });
    try { await g.navigator.storage?.persist?.(); } catch { /* 保存を守る設定ができなくても動く */ }
    onProgress?.(1, '');
    return status();
  }
  // 入れるときの守り：空きを先に見る・入れているあいだ画面を消さない（Wake Lock）・失敗したら途中まで取った分を消す・エラーは日本語にする
  const GB = 1024 ** 3;
  async function room() {
    try { const e = await g.navigator.storage?.estimate?.(); return e && e.quota ? (e.quota - (e.usage || 0)) / GB : null; } catch { return null; }
  }
  function friendly(e) {
    const m = String(e?.message || e || '');
    if (/quota|QuotaExceeded|storage|空き/i.test(m)) return '端末の空きが足りません。写真やアプリを消して空きを作ってから、もう一度押してください。';
    if (/fetch|network|NetworkError|Load failed|ERR_/i.test(m)) return 'ネットから取ってこられませんでした。Wi-Fi につないで、画面を閉じずにもう一度押してください。';
    if (/abort/i.test(m)) return '途中で止まりました。画面を閉じずに、もう一度押してください。';
    if (/memory|Out of memory|RangeError/i.test(m)) return 'この端末のメモリでは動かせませんでした。ほかのアプリを閉じてから、もう一度押してください。';
    return '入れられませんでした（' + m.slice(0, 80) + '）。';
  }
  async function safeInstall(onProgress, opts = {}) {
    const before = status();
    const need = opts.earOnly ? EAR.gb : plan().gb;
    const free = await room();
    if (free != null && free < need * 1.5) throw new Error(`端末の空きが足りません（あと約 ${Math.max(0.1, Math.round((need * 1.5 - free) * 10) / 10)}GB 要ります）。`);
    let lock = null;
    try { lock = await g.navigator.wakeLock?.request?.('screen'); } catch { lock = null; } // 画面が消えると取得が止まるため
    try { return await install(onProgress, opts); }
    catch (e) {
      if (!before.llm || !status().llm) { try { await remove(); } catch { /* 片づけられなくても続ける */ } } // 初めて入れる・頭を替えるのに失敗したら、途中まで取った分を残さない
      throw new Error(/^端末の空き/.test(e?.message || '') ? e.message : friendly(e));
    } finally { try { await lock?.release?.(); } catch { /* なくてよい */ } }
  }
  const hasTfCache = async () => { try { return (await g.caches.keys()).some((k) => /^transformers-cache/.test(k)); } catch { return false; } };
  // 入れた AI がまだ端末にあるか（ブラウザは空きが少ないと保存したものを消すことがある）。消えていたら印を外す（黙って取り直さない）
  async function present() {
    const s = load();
    const out = { llm: !!s.llm, ear: !!s.ear };
    try {
      if (s.llm && s.engine === 'cpu') { cpuLib = cpuLib || await import(here(VENDOR.cpu)); const l = await new cpuLib.CacheManager().list(); out.llm = l.some((f) => /\.gguf$/i.test(f.key || '') && f.size > 1e8); }
      else if (s.llm) { const f = (await webllm()).hasModelInCache; if (typeof f === 'function') out.llm = !!(await f(s.llm)); }
    } catch { /* 調べられないときは、あるものとして進める */ }
    try { if (s.ear && s.earCache) { const ks = await g.caches.keys(); out.ear = ks.some((k) => /^transformers-cache/.test(k)) ? !!(await (await g.caches.open(ks.find((k) => /^transformers-cache/.test(k)))).keys()).length : false; } } catch { /* 同上 */ }
    if (s.llm && !out.llm) save({ llm: '', engine: '' });
    if (s.ear && !out.ear) save({ ear: false });
    return { llm: !!s.llm && out.llm, ear: !!s.ear && out.ear, lost: (s.llm && !out.llm) || (s.ear && !out.ear) };
  }
  // 診断に使う、この端末の様子（会話の中身は入れない）
  async function info() {
    const a = await gpu().catch(() => null);
    const st = status();
    return { webgpu: a ? a.mode + (a.f16 ? '・f16' : '') : 'なし', isolated: !!g.crossOriginIsolated, threads: g.navigator?.hardwareConcurrency || 0, memoryGB: g.navigator?.deviceMemory || 0,
      freeGB: await room().then((f) => (f == null ? null : Math.round(f * 10) / 10)), ai: st.llm ? st.llm + (st.cpu ? '（CPU）' : '') : 'なし', ear: st.ear ? EAR.label : 'なし',
      earState: earState || 'まだ', ortThreads: earThreads, earWorker: !!ear,
      blockedMaxMs: Math.round(blocked.max), blockedTotalMs: Math.round(blocked.total), lastListen, ortOne: (() => { try { return !!g.localStorage.getItem(ONE_KEY); } catch { return false; } })() };
  }
  async function remove() {
    const s = load();
    try { engine?.unload?.(); } catch { /* なくてよい */ }
    try { await cpuEngine?.unload(); } catch { /* なくてよい */ }
    try { if (s.engine === 'cpu') { cpuLib = cpuLib || await import(here(VENDOR.cpu)); await new cpuLib.CacheManager().clear(); } } catch { /* 消せなくても印は消す */ }
    engine = null; engineId = ''; cpuEngine = null; cpuKey = ''; stopEar(); earState = '';
    try { if (s.llm && s.engine !== 'cpu') await (await webllm()).deleteModelAllInfoInCache?.(s.llm); } catch { /* 消せなくても印は消す */ }
    try { for (const k of await g.caches.keys()) if (/^transformers-cache/.test(k)) await g.caches.delete(k); } catch { /* なくてよい */ }
    try { g.localStorage.removeItem(KEY); } catch { /* なくてよい */ }
  }

  const LocalAI = {
    EAR_LIMIT, MODELS, CPU, JA, CPU_MODELS, brainPick, setBrain, EAR, VAD, VENDOR, TRIES, gpu, earNeeded, safeInstall, present, info, friendly, SAMPLING, KEEP, CTX, BUDGET, recent, userPart, messages, plan, status, install, remove, session, listen, release, phantom, bargeIn,
    llmReady: () => !!load().llm,
    earReady: () => !!load().ear,
    // 耳の部品（ONNX Runtime）が作業場で本物の wasm で動くか（モデルは使わない。検査と診断用）
    earSelfTest: (o = {}) => call('selftest', { ...libPaths(), ...o }),
    prepareEar: () => (load().ear ? loadEar().catch(() => {}) : Promise.resolve()),
  };
  g.LocalAI = LocalAI;
  // 端末内の音声認識が無い端末では、入れた Whisper を🎤と会話モードの耳にする
  g.Voice?.useEar?.({ ready: () => !!load().ear, listen: (o) => listen(o), cancel, release });
})(typeof window !== 'undefined' ? window : globalThis);

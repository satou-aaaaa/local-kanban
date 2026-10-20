// 耳（Whisper：声→文字）と声の区切り（Silero VAD）を、画面とは別の作業場（Worker）で動かす。
// 画面と同じところで動かすと、聞き取りの前後の計算（音を 30 秒にそろえた特徴づくり・推論の呼び出し）の間、
// CPU の遅いスマホでは画面が数秒〜十数秒止まった（2026-10-20 Pixel 6a「動作が重いのか、固まってしまいます」）。
// 部品（transformers.js・ONNX Runtime の wasm）は vendor/ の同梱、モデルは Hugging Face から取り、Cache API に保存する（localai.js と同じ）。
// 声・文字はこの Worker と画面のあいだだけでやりとりし、どこにも送らない。
// localai.js から { id, type, ... } が届き、{ re: id, ... } で返す。取っている途中は { re: id, progress } を何度か返す。
let tf = null, asr = null, vad = null, threads = null;
const vads = new Map(); // 声の区切りの状態（呼び出し元ごと）

self.onmessage = async ({ data: m }) => {
  if (!m?.type) return; // ほかの知らせ（検査のにせものの返事など）は無視する
  const reply = (v, transfer) => self.postMessage({ re: m.id, ...v }, transfer || []);
  try {
    if (m.type === 'load') {
      await load(m, (progress, file) => reply({ progress, file }));
      reply({ ok: true, vad: !!vad, threads });
    } else if (m.type === 'vad') {
      reply({ p: await prob(m.key, m.frame) });
    } else if (m.type === 'vad-end') {
      vads.delete(m.key);
    } else if (m.type === 'asr') {
      const r = await asr(m.audio, { language: 'japanese', task: 'transcribe' });
      reply({ text: String(r?.text || '').trim() });
    } else if (m.type === 'selftest') {
      // 部品が本物の wasm で動くか（検査と診断用。モデルは使わない）。n 回、大きめの掛け算をする
      const lib = await lib0(m);
      const k = m.size || 2, a = new lib.Tensor('float32', Float32Array.from({ length: k * k }, (_, i) => (i % 7) / 7), [k, k]);
      let r = null;
      for (let i = 0; i < (m.n || 1); i++) r = await lib.matmul(a, a);
      reply({ ok: true, threads, sum: Array.from(r.data.slice(0, 4)).reduce((x, y) => x + y, 0) });
    }
  } catch (e) {
    reply({ err: String(e?.message || e) });
  }
};

async function lib0({ tfUrl, mjs, wasm, one }) {
  if (tf) return tf;
  const lib = await import(tfUrl);
  lib.env.allowLocalModels = false;
  lib.env.useWasmCache = false;
  const w = lib.env.backends?.onnx?.wasm;
  if (w) {
    w.wasmPaths = { mjs, wasm }; // CDN（jsdelivr）から読まない
    // スレッドは多くても 2 本（耳は小さいモデルなので十分。スマホで頭と取り合わないように）。
    // 前にスレッドの準備で止まった端末は 1 本で読む
    const hc = self.navigator?.hardwareConcurrency || 2;
    w.numThreads = one || !self.crossOriginIsolated ? 1 : Math.max(1, Math.min(2, hc - 1));
    threads = w.numThreads;
  }
  tf = lib;
  return lib;
}

async function load(m, onProgress) {
  if (asr) return;
  const lib = await lib0(m);
  const progress_callback = (p) => { if (p?.status === 'progress') onProgress((p.progress || 0) / 100, p.file || ''); else onProgress(null, ''); };
  asr = await lib.pipeline('automatic-speech-recognition', m.ear.id, {
    revision: m.ear.revision, device: m.webgpu ? 'webgpu' : 'wasm',
    dtype: m.webgpu ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } : 'q8', progress_callback,
  });
  try { vad = await lib.AutoModel.from_pretrained(m.vad.id, { revision: m.vad.revision, config: { model_type: 'custom' }, dtype: 'fp32', progress_callback }); } catch { vad = null; }
}

// Silero VAD：512 サンプル（16kHz で 32ms）ごとに「声らしさ」0〜1 を返す。呼び出し元（key）ごとに状態を持つ
async function prob(key, frame) {
  if (!vad) return 0;
  const { Tensor } = tf;
  let s = vads.get(key);
  if (!s) vads.set(key, (s = { state: new Tensor('float32', new Float32Array(2 * 128), [2, 1, 128]), sr: new Tensor('int64', BigInt64Array.from([16000n]), []) }));
  const out = await vad({ input: new Tensor('float32', frame, [1, frame.length]), sr: s.sr, state: s.state });
  s.state = out.stateN;
  return out.output.data[0];
}

// 端末の中で動く AI の部品。Chrome の内蔵 AI や端末内の音声認識が無い端末（スマホなど）でも、会話モードで AI と話せるようにする。
//   頭       … WebLLM（WebGPU で小さな言葉のモデル Qwen2.5 を動かす）。返事の形は talk.js の Prompt API と同じ（session.prompt）
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
  };
  // 言葉のモデル（日本語が通じる小さなもの）。端末のメモリで選び、WebGPU が16ビットの計算をできなければ f32 版にする
  const MODELS = {
    small: { label: 'Qwen2.5 0.5B', gb: 0.4, f16: 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC', f32: 'Qwen2.5-0.5B-Instruct-q4f32_1-MLC' },
    large: { label: 'Qwen2.5 1.5B', gb: 1.0, f16: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC', f32: 'Qwen2.5-1.5B-Instruct-q4f32_1-MLC' },
  };
  const EAR = { id: 'onnx-community/whisper-base', label: 'Whisper base', gb: 0.1 };
  const VAD = { id: 'onnx-community/silero-vad', label: 'Silero VAD' };
  const KEY = 'lk.ai';
  const here = (p) => new URL(p, g.document?.baseURI || g.location?.href).href;
  const load = () => { try { return JSON.parse(g.localStorage.getItem(KEY)) || {}; } catch { return {}; } };
  const save = (v) => { try { g.localStorage.setItem(KEY, JSON.stringify({ ...load(), ...v })); } catch { /* 保存できなくても動く */ } };

  // ---------- 端末の下調べ ----------
  function pickModel() { return (g.navigator?.deviceMemory || 4) >= 8 ? MODELS.large : MODELS.small; }
  // 端末内の音声認識（Chrome 139 以降）が無い端末だけ Whisper を入れる
  const needEar = () => !g.Voice?.localApi;
  // 入れる前に見せる大きさ（目安）。GPU にはまだ触らない（押したときに調べる）
  function plan() {
    const m = pickModel();
    return { model: m.label, ear: needEar(), gb: Math.round((m.gb + (needEar() ? EAR.gb : 0)) * 10) / 10 };
  }
  async function gpu() {
    if (!g.navigator?.gpu) return null;
    try { const a = await g.navigator.gpu.requestAdapter(); return a ? { f16: a.features.has('shader-f16') } : null; } catch { return null; }
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
  // 返事の出し方。Qwen2.5 の公式の既定（generation_config.json：temperature 0.7・top_p 0.8・repetition_penalty 1.1）に合わせる。
  // 0.5 だと毎回同じような返事になり、定型文に聞こえた
  const SAMPLING = { temperature: 0.7, top_p: 0.8, repetition_penalty: 1.1 };
  const KEEP = 12; // 覚えておくやりとり（往復）。超えた古い分は端末の中で短くまとめて指示に足す
  // AI に渡す messages を組み立てる（検査からも呼ぶ）。ボードの一覧は毎回の発言にだけ入れ、覚える方には入れない
  function messages({ system, examples = [], summary = '', past = [], text }) {
    return [
      { role: 'system', content: system + (summary ? `\nこれまでの話のまとめ: ${summary}` : '') },
      ...examples.flatMap(([u, a]) => [{ role: 'user', content: u }, { role: 'assistant', content: a }]),
      ...past.slice(-KEEP * 2),
      { role: 'user', content: text },
    ];
  }
  // Prompt API の session と同じ形（prompt(文, { responseConstraint })）で返す
  async function session(system, examples = []) {
    const id = load().llm;
    if (!id) return null;
    const e = await engineFor(id);
    const past = [];
    let summary = '', busy = Promise.resolve();
    // 古いやりとりを1〜2文にまとめる（返事のあとに回すので、待たせない）
    const squeeze = () => {
      if (past.length <= KEEP * 2) return;
      const old = past.splice(0, past.length - KEEP * 2);
      const talk = old.map((m) => `${m.role === 'user' ? 'ユーザー' : 'あなた'}: ${m.role === 'user' ? m.content : (() => { try { return JSON.parse(m.content).say; } catch { return m.content; } })()}`).join('\n');
      busy = busy.then(async () => {
        const r = await e.chat.completions.create({
          messages: [{ role: 'system', content: '会話のまとめ役。ユーザーの好み・気持ち・決めたことを中心に、日本語で2文以内にまとめる。' }, { role: 'user', content: `${summary ? `前のまとめ: ${summary}\n` : ''}${talk}` }],
          temperature: 0.3, max_tokens: 120,
        });
        summary = String(r?.choices?.[0]?.message?.content || summary).trim().slice(0, 300);
      }).catch(() => { /* まとめられなくても会話は続ける */ });
    };
    return {
      async prompt(text, { responseConstraint } = {}) {
        await busy;
        const r = await e.chat.completions.create({
          messages: messages({ system, examples, summary, past, text }), ...SAMPLING, max_tokens: 256,
          ...(responseConstraint ? { response_format: { type: 'json_object', schema: JSON.stringify(responseConstraint) } } : {}),
        });
        const out = r?.choices?.[0]?.message?.content || '';
        past.push({ role: 'user', content: text.replace(/^[\s\S]*\nユーザー: /, '') }, { role: 'assistant', content: out }); // ボードの一覧は覚えない（毎回渡す）
        squeeze();
        return out;
      },
      get summary() { return summary; },
      destroy() { past.length = 0; summary = ''; },
    };
  }

  // ---------- 耳（Whisper）と割り込み（Silero VAD） ----------
  let tfLib = null, asr = null, vadModel = null, earLoading = null;
  async function transformers() {
    if (tfLib) return tfLib;
    const m = await import(here(VENDOR.tf));
    m.env.allowLocalModels = false;
    m.env.useWasmCache = false;
    const w = m.env.backends?.onnx?.wasm;
    if (w) w.wasmPaths = { mjs: here(VENDOR.ort + '.mjs'), wasm: here(VENDOR.ort + '.wasm') }; // CDN（jsdelivr）から読まない
    tfLib = m;
    return m;
  }
  function loadEar(onProgress) {
    if (asr) return Promise.resolve();
    return earLoading || (earLoading = (async () => {
      const m = await transformers();
      const webgpu = !!(await gpu());
      const progress_callback = (p) => { if (p?.status === 'progress' && onProgress) onProgress((p.progress || 0) / 100, p.file || ''); };
      asr = await m.pipeline('automatic-speech-recognition', EAR.id, { device: webgpu ? 'webgpu' : 'wasm', dtype: webgpu ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } : 'q8', progress_callback });
      try { vadModel = await m.AutoModel.from_pretrained(VAD.id, { config: { model_type: 'custom' }, dtype: 'fp32', progress_callback }); } catch { vadModel = null; }
    })().catch((e) => { earLoading = null; throw e; }));
  }

  // Silero VAD を1つ作る（それぞれ自分の状態を持つ）。512 サンプル（16kHz で 32ms）ごとに「声らしさ」0〜1 を返す
  function sileroProb() {
    const { Tensor } = tfLib;
    let state = new Tensor('float32', new Float32Array(2 * 128), [2, 1, 128]);
    const sr = new Tensor('int64', BigInt64Array.from([16000n]), []);
    return async (frame) => {
      const out = await vadModel({ input: new Tensor('float32', frame, [1, frame.length]), sr, state });
      state = out.stateN;
      return out.output.data[0];
    };
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

  // 1回分を聞き取って文字にする（Voice.listen から呼ばれる）
  async function listen({ waitMs = 8000, maxMs = 15000, endMs = 700 } = {}) {
    await loadEar();
    const md = g.navigator?.mediaDevices;
    if (!md?.getUserMedia) throw new Error('マイクが使えません');
    let stream;
    try { stream = await md.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
    catch { throw new Error('マイクが許可されていません'); }
    const prob = vadModel ? sileroProb() : loudnessProb();
    const audio = await new Promise((ok, ng) => {
      const pre = [], said = [];
      let talking = false, quiet = 0, done = false, chain = Promise.resolve();
      const t0 = Date.now();
      const end = (err) => { if (done) return; done = true; clearTimeout(t1); clearTimeout(t2); stop(); stream.getTracks().forEach((t) => t.stop()); err ? ng(err) : ok([...pre, ...said]); };
      // 音が届かないときも止まらないように、時間でも区切る
      const t1 = setTimeout(() => { if (!talking) end(new Error('聞き取れませんでした')); }, waitMs + 500);
      const t2 = setTimeout(() => end(talking ? null : new Error('聞き取れませんでした')), maxMs + 500);
      const stop = capture(stream, (f) => {
        chain = chain.then(async () => {
          if (done) return;
          const p = await prob(f);
          if (p > 0.5) { talking = true; quiet = 0; } else if (talking) quiet += 32;
          if (talking) said.push(f); else { pre.push(f); if (pre.length > 10) pre.shift(); } // 話し始めの手前 0.3 秒も残す
          if ((talking && quiet >= endMs) || Date.now() - t0 > maxMs) end();
          else if (!talking && Date.now() - t0 > waitMs) end(new Error('聞き取れませんでした'));
        }).catch((e) => end(e));
      });
    });
    const all = new Float32Array(audio.length * 512);
    audio.forEach((f, i) => all.set(f, i * 512));
    const r = await asr(all, { language: 'japanese', task: 'transcribe' });
    const text = String(r?.text || '').trim();
    if (!text) throw new Error('聞き取れませんでした');
    return { text };
  }

  // 話している途中の割り込み（Silero）。入っていなければ null（talk.js が音の大きさの VAD を使う）
  function bargeIn(stream, onVoice) {
    if (!vadModel || !stream) return null;
    const prob = sileroProb();
    let n = 0, stopped = false, chain = Promise.resolve();
    const stop = capture(stream, (f) => {
      chain = chain.then(async () => {
        if (stopped) return;
        n = (await prob(f)) > 0.6 ? n + 1 : 0;
        if (n >= 4) { stopped = true; stop(); onVoice(); } // 約 0.13 秒続いたら声
      }).catch(() => {});
    });
    return () => { stopped = true; stop(); };
  }

  // ---------- 入れる・消す ----------
  function status() {
    const s = load();
    return { llm: s.llm || '', ear: !!s.ear, at: s.at || '', from: s.from || [] };
  }
  // 「AI の部品を入れる」を押したとき。onProgress(0〜1, 何を取っているか)
  async function install(onProgress) {
    const a = await gpu();
    if (!a) throw new Error('この端末のブラウザは WebGPU が使えないため、AI を入れられません（Android は Chrome 121 以降、iPhone は iOS 26 以降）。');
    const m = pickModel();
    const id = a.f16 ? m.f16 : m.f32;
    const ear = needEar();
    const step = (base, part) => (p, what) => onProgress?.(base + part * Math.max(0, Math.min(1, p || 0)), what);
    await engineFor(id, step(0, ear ? 0.8 : 1));
    const from = [`huggingface.co/mlc-ai/${id}`, 'raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs'];
    save({ llm: id });
    if (ear) {
      await loadEar(step(0.8, 0.2));
      from.push(`huggingface.co/${EAR.id}`);
      if (vadModel) from.push(`huggingface.co/${VAD.id}`);
      save({ ear: true });
    }
    save({ at: new Date().toISOString().slice(0, 10), from });
    try { await g.navigator.storage?.persist?.(); } catch { /* 保存を守る設定ができなくても動く */ }
    onProgress?.(1, '');
    return status();
  }
  async function remove() {
    const s = load();
    try { engine?.unload?.(); } catch { /* なくてよい */ }
    engine = null; engineId = ''; asr = null; vadModel = null; earLoading = null;
    try { if (s.llm) await (await webllm()).deleteModelAllInfoInCache?.(s.llm); } catch { /* 消せなくても印は消す */ }
    try { for (const k of await g.caches.keys()) if (/^transformers-cache/.test(k)) await g.caches.delete(k); } catch { /* なくてよい */ }
    try { g.localStorage.removeItem(KEY); } catch { /* なくてよい */ }
  }

  const LocalAI = {
    MODELS, EAR, VAD, VENDOR, SAMPLING, KEEP, messages, plan, status, install, remove, session, listen, bargeIn,
    llmReady: () => !!load().llm,
    earReady: () => !!load().ear,
    prepareEar: () => (load().ear ? loadEar().catch(() => {}) : Promise.resolve()),
  };
  g.LocalAI = LocalAI;
  // 端末内の音声認識が無い端末では、入れた Whisper を🎤と会話モードの耳にする
  g.Voice?.useEar?.({ ready: () => !!load().ear, listen: () => listen() });
})(typeof window !== 'undefined' ? window : globalThis);

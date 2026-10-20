// koe.js — ポチの「気持ちで話し分ける声」（端末の中で動かす音声合成）
//
// Style-Bert-VITS2 の JVNV モデル（4人 × 7つの気持ち）を、Karume（WebGPU）で端末の中だけで動かす。
// - 部品は vendor/karume-models-0.14.0/sbv2.js（@karume/models・@hdae/yomi を1つにまとめたもの）。
// - モデル（1人 約250MB）と辞書（約19MB）は「声を入れる」を押したときだけ Hugging Face から取り、
//   ブラウザの Cache API に保存する。以後はオフラインで話す。読む文は外に出さない。
// - WebGPU が無い端末・入れていない端末は、今までどおり端末の声（speechSynthesis）で話す。
// クレジット（CC BY-SA 4.0）は README とキャラの設定に出す。
(function (g) {
  'use strict';
  const VENDOR = './vendor/karume-models-0.14.0/sbv2.js';
  const QUANT = 'i8+bert4'; // 既定。いちばん軽い i4 との差は小さく、音は i8 のほうが良い
  const VOICES = {
    F1: { label: '女性1（明るめ）', size: 248 },
    F2: { label: '女性2（落ち着き）', size: 248 },
    M1: { label: '男性1', size: 248 },
    M2: { label: '男性2', size: 248 },
  };
  // ポチの表情 → 声の気持ち（JVNV の7つ：Neutral・Angry・Disgust・Fear・Happy・Sad・Surprise）
  const STYLE = { normal: 'Neutral', happy: 'Happy', sad: 'Sad', surprise: 'Surprise', think: 'Neutral', listen: 'Neutral', angry: 'Angry', fear: 'Fear', disgust: 'Disgust' };
  const KEY = 'koe.model';

  let lib = null, pipe = null, dict = null, loading = null, ac = null, src = null, gen = 0;
  const ls = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* なくてよい */ } } };

  const gpuOk = () => !!(g.navigator && g.navigator.gpu);
  async function adapterOk() {
    if (!gpuOk()) return false;
    try { return !!(await g.navigator.gpu.requestAdapter()); } catch { return false; }
  }
  function status() {
    const m = ls.get(KEY);
    return { installed: m && VOICES[m] ? m : '', on: ls.get('koe.on') !== 'off', gpu: gpuOk(), loaded: !!pipe };
  }
  const ready = () => { const s = status(); return !!(s.installed && s.on && s.gpu); };

  async function load(model, onProgress) {
    if (pipe && pipe.model === model) return pipe;
    if (loading) return loading;
    loading = (async () => {
      lib = lib || await import(VENDOR);
      if (pipe) { try { await pipe.p.dispose(); } catch { /* なくてよい */ } pipe = null; }
      const prog = (part) => (p) => onProgress && onProgress({ part, loaded: p.loaded, total: p.total });
      dict = dict || await lib.getDictionary({ onProgress: prog('dict') });
      const p = await lib.Sbv2Pipeline.fromPretrained(lib.SBV2_SOURCES['sbv2-jvnv'], { model, quant: QUANT, onProgress: prog('model') });
      pipe = { model, p };
      return pipe;
    })();
    try { return await loading; } finally { loading = null; }
  }

  // 「声を入れる」：取ってきて保存し、試しに一言つくる（壊れていたらここで分かる）
  async function install(model = 'F1', onProgress) {
    if (!VOICES[model]) throw new Error('知らない声です: ' + model);
    if (!(await adapterOk())) throw new Error('この端末のブラウザは WebGPU が使えないので、この声は入れられません（端末の声のまま話します）。');
    await load(model, onProgress);
    await synth('こんにちは。', 'normal', 1, model);
    ls.set(KEY, model); ls.set('koe.on', null);
    return status();
  }
  async function remove() {
    try { await pipe?.p.dispose(); } catch { /* なくてよい */ }
    pipe = null; dict = null; ls.set(KEY, null);
    try {
      for (const k of await g.caches.keys()) if (/karume|yomi|fetch-cache/i.test(k)) await g.caches.delete(k);
    } catch { /* なくてよい */ }
    return status();
  }

  async function synth(text, mood, rate = 1, model = ls.get(KEY) || 'F1') {
    const { p } = await load(model);
    const utt = lib.toSbv2Utterance(lib.analyzeWithWords(dict, text));
    return p.generate(utt, { style: STYLE[mood] || 'Neutral', lengthScale: 1 / Math.min(Math.max(rate, 0.5), 2), seed: 0 });
  }

  // 鳴らす。音の大きさで口を動かす（voice:boundary を出す）
  function play(audio) {
    return new Promise((ok) => {
      const AC = g.AudioContext || g.webkitAudioContext;
      ac = ac || new AC();
      const buf = ac.createBuffer(1, audio.data.length, audio.sampleRate);
      buf.copyToChannel(audio.data, 0);
      const s = ac.createBufferSource(); s.buffer = buf; src = s;
      const an = ac.createAnalyser(); an.fftSize = 512;
      s.connect(an); an.connect(ac.destination);
      const t = new Float32Array(an.fftSize); let last = 0, raf = 0;
      const tick = (now) => {
        an.getFloatTimeDomainData(t);
        let s = 0; for (const v of t) s += v * v;
        if (Math.sqrt(s / t.length) > 0.04 && now - last > 110) { last = now; try { g.dispatchEvent(new CustomEvent('voice:boundary', { detail: { at: -1 } })); } catch { /* なくてよい */ } }
        raf = g.requestAnimationFrame(tick);
      };
      raf = g.requestAnimationFrame(tick);
      s.onended = () => { g.cancelAnimationFrame(raf); if (src === s) src = null; ok(true); };
      if (ac.state === 'suspended') ac.resume().catch(() => {});
      s.start();
    });
  }

  // 文の並びを話す。次の文は今の文を鳴らしているあいだに作る（間を空けない）
  // 発話ごとに番号を持ち、止められた・次の発話が始まった古い発話は鳴らさずに終える
  async function speak(parts, { mood = 'normal', rate = 1 } = {}) {
    stop();
    const id = ++gen, stopped = () => id !== gen;
    let next = parts.length ? synth(parts[0], mood, rate) : null;
    for (let i = 0; i < parts.length; i++) {
      const audio = await next;
      if (stopped()) return false;
      next = i + 1 < parts.length ? synth(parts[i + 1], mood, rate) : null;
      await play(audio);
      if (stopped()) return false;
    }
    return true;
  }
  function stop() {
    gen++;
    try { src?.stop(); } catch { /* なくてよい */ }
  }
  function setOn(on) { ls.set('koe.on', on ? null : 'off'); }

  const CREDIT = '声：Style-Bert-VITS2 JVNV（litagin/style_bert_vits2_jvnv）を hdae/karume-sbv2-jvnv が変換・量子化（i8/i4）したもの。元のコーパス JVNV は Detai Xin・Junfeng Jiang・Shinnosuke Takamichi・Yuki Saito・Akiko Aizawa・Hiroshi Saruwatari（arXiv:2310.06072）。CC BY-SA 4.0（https://creativecommons.org/licenses/by-sa/4.0/）。読みの辞書は naist-jdic（BSD 3-Clause）。';

  g.Koe = { VOICES, STYLE, QUANT, CREDIT, status, ready, install, remove, speak, stop, setOn, adapterOk };
})(typeof window !== 'undefined' ? window : globalThis);

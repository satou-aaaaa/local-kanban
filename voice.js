// 声（と Ctrl+K の命令欄）で操作するための小さな部品。カンバン以外のアプリ（メモなど）からも使える。外部ライブラリなし。
//   Voice.parse(文, 列の一覧)  … 文を命令に直す（ブラウザの機能は使わない。テストしやすいように純粋な関数）
//   Voice.match(言葉, 一覧, 題の取り出し) … あいまい一致で候補を探す
//   Voice.listen()             … 1回だけ聞き取る（端末の中だけ。サーバーで文字にする音声認識は使わない）
//   Voice.localStatus()        … 端末の中で聞き取れるか（'available' など）
//   Voice.speak(文)            … 端末の中の声で読み上げる（ネット経由の声は使わない）
//   Voice.supported            … 端末の中で聞き取れるか（Chrome 139 以降の音声認識、または localai.js で入れた Whisper）
//   Voice.useEar(耳)           … 端末内の音声認識が無いときに使う別の耳（{ ready(), listen() }。localai.js の Whisper）
// 文型（claude.ai のボードと同じ）:
//   「〇〇を追加」「〇〇を今やるに追加」「今やるに〇〇を追加」 → {type:'add', title, lane}
//   「〇〇を済み」「〇〇終わった」「〇〇完了」                → {type:'done', query}
//   「〇〇を<列>へ」「〇〇を<列>に移して」                    → {type:'move', query, lane}
//   「〇〇を消して」「〇〇を削除」                            → {type:'delete', query}（実行する前に聞き返す）
//   「<列>を読んで」「<列>は？」「今やることは？」            → {type:'read', lane}
//   「〇〇はどうなった？」「〇〇の状況」「〇〇の進み具合」      → {type:'status', query}（列・今の段・最後の記録を答える）
//   「戻す」「元に戻して」「取り消し」                        → {type:'undo'}
//   「はい」「いいえ」「2番」                                 → {type:'yes'} / {type:'no'} / {type:'pick', n}
(function (g) {
  'use strict';
  const NUM = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, 'いち': 1, 'に': 2, 'さん': 3, 'よん': 4, 'ご': 5 };
  const clean = (s) => String(s || '').normalize('NFKC').replace(/[\s　、。．.！!？?「」『』]/g, '').trim();
  const norm = (s) => clean(s).toLowerCase().replace(/[ー－―‐]/g, 'ー');

  // lanes: [[key, label, ...aliases]]
  function laneOf(word, lanes) {
    const w = norm(word).replace(/(の列|列|レーン)$/, '').replace(/(のこと|こと|もの)$/, '');
    if (!w) return null;
    for (const [key, ...names] of lanes) if (names.some((n) => norm(n) === w)) return key;
    if (w.length >= 2) for (const [key, ...names] of lanes) if (names.some((n) => norm(n).startsWith(w))) return key;
    return null;
  }

  function parse(text, lanes) {
    const t = clean(text);
    if (!t) return null;
    if (/^(はい|うん|ok|オーケー|お願いします?|消して|実行)$/i.test(t)) return { type: 'yes' };
    if (/^(いいえ|いや|やめて?|やめる|キャンセル|ストップ)$/.test(t)) return { type: 'no' };
    let m = t.match(/^(\d+|[一二三四五六七八九]|いち|に|さん|よん|ご)(番目?|つ目)?$/);
    if (m) return { type: 'pick', n: Number(m[1]) || NUM[m[1]] };
    if (/^(戻す|戻して|元に戻(す|して)|取り消(す|し|して)|アンドゥ|undo)$/i.test(t)) return { type: 'undo' };
    m = t.match(/^(.+?)(を|の)?(読んで|読み上げて|教えて|は)$/);
    if (m && laneOf(m[1], lanes)) return { type: 'read', lane: laneOf(m[1], lanes) };
    // 様子を聞く
    m = t.match(/^(.+?)(は|って|の)?(どうなった|どうなってる|どうなってます|どう|状況|進み具合|進捗|様子)(は|を教えて|教えて)?$/);
    if (m && !laneOf(m[1], lanes)) return { type: 'status', query: m[1] };
    // 追加
    m = t.match(/^(.+?)に(.+?)を(追加|足して|足す|入れて)(して|する)?$/);
    if (m && laneOf(m[1], lanes)) return { type: 'add', title: m[2], lane: laneOf(m[1], lanes) };
    m = t.match(/^(.+)を(.+?)に(追加|足して|足す|入れて)(して|する)?$/);
    if (m && laneOf(m[2], lanes)) return { type: 'add', title: m[1], lane: laneOf(m[2], lanes) };
    m = t.match(/^(.+?)を?(追加|足して|足す)(して|する)?(\(?(.+?)に\)?)?$/);
    if (m) return { type: 'add', title: m[1].replace(/を$/, ''), lane: m[5] ? laneOf(m[5], lanes) : null };
    m = t.match(/^(?:追加|メモ)(.+)$/);
    if (m) return { type: 'add', title: m[1], lane: null };
    // 消す
    m = t.match(/^(.+?)を?(消して|消す|削除(して|する)?)$/);
    if (m) return { type: 'delete', query: m[1] };
    // 済み
    m = t.match(/^(.+?)(を|は|が)?(済み|すみ|完了|終わった|終わり|終わらせた|できた|やった)(に(して|する))?$/);
    if (m) return { type: 'done', query: m[1] };
    // 列へ移す
    m = t.match(/^(.+)を(.+?)(へ|に)(移して|移す|動かして|動かす|して|する)?$/);
    if (m && laneOf(m[2], lanes)) return { type: 'move', query: m[1], lane: laneOf(m[2], lanes) };
    return { type: 'unknown', text: t };
  }

  // 文字の2つ組の重なり（0〜1）
  function similar(a, b) {
    const grams = (s) => { const r = new Set(); for (let i = 0; i < s.length - 1; i++) r.add(s.slice(i, i + 2)); if (s.length === 1) r.add(s); return r; };
    const x = grams(a), y = grams(b);
    if (!x.size || !y.size) return 0;
    let n = 0; for (const k of x) if (y.has(k)) n++;
    return (2 * n) / (x.size + y.size);
  }
  function match(query, items, title = (x) => x.title) {
    const q = norm(query);
    if (!q) return [];
    const scored = items.map((it) => {
      const t = norm(title(it));
      const s = t === q ? 3 : t.includes(q) ? 2 + q.length / t.length / 10 : q.includes(t) && t.length > 1 ? 1.5 : similar(q, t);
      return { it, s };
    }).filter((x) => x.s >= 0.5).sort((a, b) => b.s - a.s);
    if (scored.length && scored[0].s >= 3) return [scored[0].it];
    if (scored.length > 1 && scored[0].s - scored[1].s >= 0.4) return [scored[0].it];
    return scored.slice(0, 5).map((x) => x.it);
  }

  // 見つからないときの「もしかして」：似ている順に n 件（ゆるい基準）
  function nearest(query, items, n = 3, title = (x) => x.title) {
    const q = norm(query);
    if (!q) return [];
    return items.map((it) => ({ it, s: similar(q, norm(title(it))) })).filter((x) => x.s >= 0.2).sort((a, b) => b.s - a.s).slice(0, n).map((x) => x.it);
  }

  const SR = g.SpeechRecognition || g.webkitSpeechRecognition;
  // 声は端末の外に出さない。端末の中で聞き取れる音声認識（Chrome 139 以降の processLocally）だけを使い、
  // サーバーで文字にする音声認識（ふつうの Chrome・Safari・Edge）には落とさない。
  const canLocal = !!SR && typeof SR.available === 'function';

  // 'available'（使える）・'downloadable'（日本語の部品を入れれば使える）・'downloading'・'unavailable'
  async function localStatus(lang = 'ja-JP') {
    if (!canLocal) return 'unavailable';
    try { return await SR.available({ langs: [lang], processLocally: true }); } catch { return 'unavailable'; }
  }
  // 日本語の部品を端末に入れる（ボタンを押したときに呼ぶ）。true なら入った
  async function install(lang = 'ja-JP') {
    if (!canLocal || typeof SR.install !== 'function') return false;
    try { return !!(await SR.install({ langs: [lang], processLocally: true })); } catch { return false; }
  }

  // 端末内の音声認識が無いときの別の耳（これも端末の中だけで動くもの）
  let ear = null;
  function useEar(e) { ear = e; }
  const earReady = () => { try { return !!ear?.ready(); } catch { return false; } };

  // 1回だけ聞き取る。返り値は Promise<{ text }>。端末の中で聞き取れないときは聞かずにエラーにする
  async function listen({ lang = 'ja-JP' } = {}) {
    const st = await localStatus(lang);
    if (st !== 'available' && earReady()) return ear.listen({ lang });
    if (st === 'downloadable' || st === 'downloading') {
      if (st === 'downloadable') install(lang);
      throw new Error('日本語の聞き取りの部品を端末に入れています。少し待ってからもう一度押してください。');
    }
    if (st !== 'available') throw new Error('この端末では、声を端末の中だけで聞き取れません。' + (g.LocalAI ? '「⋯ → 🎤と会話・AI の設定」で AI の部品（耳）を入れると聞き取れます。' : ''));
    return new Promise((ok, ng) => {
      const r = new SR();
      r.lang = lang; r.interimResults = false; r.maxAlternatives = 1; r.continuous = false;
      r.processLocally = true;
      let got = false;
      r.onresult = (e) => { got = true; ok({ text: e.results[0][0].transcript }); };
      r.onerror = (e) => ng(new Error(e.error === 'not-allowed' ? 'マイクが許可されていません' : e.error === 'no-speech' ? '聞き取れませんでした' : '音声認識のエラー: ' + e.error));
      r.onend = () => { if (!got) ng(new Error('聞き取れませんでした')); };
      r.start();
    });
  }

  // 読み上げは端末の中の声（voice.localService が true）だけ。「Google 日本語」などネット経由の声は使わない（文が外に出るため）
  // 同じ端末の中の声でも、名前に Enhanced・Premium・Natural などが付く声のほうがなめらかなので先に選ぶ
  const GOOD = /(enhanced|premium|natural|neural|高品質|拡張)/i;
  function localVoice(lang = 'ja-JP') {
    if (!g.speechSynthesis) return null;
    const vs = g.speechSynthesis.getVoices().filter((v) => v.localService && v.lang && v.lang.replace('_', '-').startsWith(lang.slice(0, 2)));
    let want = '';
    try { want = localStorage.getItem('voice.name') || ''; } catch { /* なくてよい */ }
    const exact = vs.filter((v) => v.lang.replace('_', '-') === lang);
    return vs.find((v) => v.name === want) || exact.find((v) => GOOD.test(v.name)) || vs.find((v) => GOOD.test(v.name)) || exact[0] || vs[0] || null;
  }
  // 読みにくい記号を除く（絵文字・「…」・「〜」・Markdown の記号は、声にすると止まったり変な読みになったりする）
  function speechText(text) {
    return String(text || '')
      .replace(/\p{Extended_Pictographic}|\uFE0F|\u200D/gu, '')
      .replace(/[*#`_>|]+/g, '')
      .replace(/(\d)\s*[〜～~]\s*(\d)/g, '$1から$2')
      .replace(/[〜～~]+/g, 'ー')
      .replace(/(…|\.{3}|・{3})+/g, '、')
      .replace(/[（(]([^）)]{0,40})[）)]/g, '、$1、')
      .replace(/、\s*([、。！？!?])/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
  }
  // 文の区切りで止まりすぎないよう、短い文は 80 字までつなげる（Chrome は長い文を途中で止めることがあるので長すぎにもしない）
  function chunks(text, max = 80) {
    const parts = String(text || '').split(/(?<=[。！？!?\n])/).map((x) => x.trim()).filter(Boolean);
    const out = [];
    for (const p of parts) {
      const last = out[out.length - 1];
      if (last && last.length + p.length <= max) out[out.length - 1] = last + p; else out.push(p);
    }
    return out;
  }
  function tune() {
    const num = (k, d) => { try { const n = parseFloat(localStorage.getItem(k)); return n >= 0.5 && n <= 2 ? n : d; } catch { return d; } };
    return { rate: num('voice.rate', 1), pitch: num('voice.pitch', 1.05) };
  }
  // まとめて読み上げる。間で cancel せずに声の順番待ちに並べるので、文と文のあいだが空かない
  let turn = 0;
  function speakAll(list, lang = 'ja-JP') {
    const parts = (Array.isArray(list) ? list : chunks(list)).map(speechText).filter(Boolean);
    if (!parts.length) return Promise.resolve(false);
    const { rate, pitch } = tune();
    // 「気持ちで話し分ける声」（koe.js）を入れていれば、そちらで今の表情（Voice.mood）に合う気持ちで話す。だめなら端末の声
    if (g.Koe && g.Koe.ready() && lang.startsWith('ja')) {
      const id = ++turn; // 止めた後に失敗しても、端末の声で話し直さない
      return g.Koe.speak(parts, { mood: api.mood, rate }).catch(() => (id === turn ? synthSpeak(parts, lang, rate, pitch) : false));
    }
    return synthSpeak(parts, lang, rate, pitch);
  }
  function synthSpeak(parts, lang, rate, pitch) {
    const v = localVoice(lang);
    if (!v) return Promise.resolve(false); // 端末の中の声が無ければ読み上げず、画面の文字だけにする
    return new Promise((ok) => {
      let done = false, base = 0;
      const end = (r) => { if (!done) { done = true; ok(r); } };
      try {
        g.speechSynthesis.cancel();
        parts.forEach((text, i) => {
          const u = new SpeechSynthesisUtterance(text); u.lang = v.lang; u.rate = rate; u.pitch = pitch;
          try { u.voice = v; } catch { /* 本物の声オブジェクトでないとき（検査）*/ }
          const at = base; base += text.length;
          // 言葉の区切りごとに知らせる（キャラの口を合わせる。音そのものは読めないので区切りで動かす）
          u.onboundary = (e) => { try { g.dispatchEvent(new CustomEvent('voice:boundary', { detail: { at: at + e.charIndex } })); } catch { /* なくてよい */ } };
          u.onerror = (e) => end(e && e.error === 'interrupted' ? true : false);
          if (i === parts.length - 1) u.onend = () => end(true);
          g.speechSynthesis.speak(u);
        });
        setTimeout(() => end(true), 800 + base * 250 / rate); // 読み上げが終わらない環境の保険
      } catch { end(false); }
    });
  }
  const speak = (text, lang) => speakAll(chunks(text), lang);
  function stop() {
    turn++;
    try { g.Koe?.stop(); } catch { /* なくてよい */ }
    try { g.speechSynthesis?.cancel(); } catch { /* なくてよい */ }
  }

  const api = { mood: 'normal', stop, parse, match, nearest, laneOf, listen, localStatus, install, speak, speakAll, speechText, chunks, localVoice, useEar, localApi: canLocal, get supported() { return canLocal || earReady(); }, norm };
  g.Voice = api;
})(typeof window !== 'undefined' ? window : globalThis);

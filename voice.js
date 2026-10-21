// 声（と Ctrl+K の命令欄）で操作するための小さな部品。カンバン以外のアプリ（メモなど）からも使える。外部ライブラリなし。
//   Voice.parse(文, 列の一覧)  … 文を命令に直す（ブラウザの機能は使わない。テストしやすいように純粋な関数）
//   Voice.match(言葉, 一覧, 題の取り出し) … あいまい一致で候補を探す
//   Voice.listen()             … 1回だけ聞き取る（耳＝localai.js の Whisper だけ。端末の中で文字にする。サーバーで文字にする音声認識は使わない）
//   Voice.listen({ hold: true }) … 押している間だけ聞く。Voice.release() で聞き終わり（離した）
//   Voice.cancelListen()       … 聞いている途中でやめる（打つほうに切り替えたとき）
//   Voice.localStatus()        … 前の版との互換のため残す（いつも 'unavailable'。Chrome の音声認識は使わない）
//   Voice.speak(文)            … 端末の中の声で読み上げる（ネット経由の声は使わない）
//   Voice.supported            … 聞き取れるか（localai.js で耳＝Whisper を入れたか）
//   Voice.useEar(耳)           … 聞き取りに使う耳（{ ready(), listen(), cancel(), release() }。localai.js の Whisper）
// 耳は Whisper の1本だけ（2026-10-21 satouさん「減らして固める」）。Chrome の音声認識（processLocally）は、
// いまはパソコンだけで Android は対象外（https://groups.google.com/a/chromium.org/g/blink-dev/c/VNOok2dbmHM/m/TQpe9shjCgAJ）、
// Pixel でマイクの取り合いですぐ止まった（#50）。耳を2本持つと組み合わせごとに壊れたので、1本にした
// 文型（claude.ai のボードと同じ）:
//   「〇〇を追加」「〇〇を今やるに追加」「今やるに〇〇を追加」 → {type:'add', title, lane}
//   「〇〇を済み」「〇〇終わった」「〇〇完了」                → {type:'done', query}
//   「〇〇を<列>へ」「〇〇を<列>に移して」                    → {type:'move', query, lane}
//   「〇〇を消して」「〇〇を削除」                            → {type:'delete', query}（すぐ消して「戻す」で戻せる）
//   「〇〇を Claude に回して」「〇〇は Claude にやらせて」      → {type:'agent', query}（Claude が進める列へ）
//   「〇〇は明日」「〇〇を金曜までに」「〇〇は25日」            → {type:'due', query, when}（期限を決める。日付は Voice.dueDate）
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
    // Claude に回す（カードを Claude が進める列へ）
    m = t.match(/^(.+?)(を|は)?(claude|クロード)(に|へ)(やらせて|やってもらって|回して|まわして|任せて|まかせて|頼んで|たのんで|お願い)(おいて|といて|とい?て|ね|する)?$/i);
    if (m) return { type: 'agent', query: m[1] };
    // 消す
    m = t.match(/^(.+?)を?(消して|消す|削除(して|する)?)$/);
    if (m) return { type: 'delete', query: m[1] };
    // 済み
    m = t.match(/^(.+?)(を|は|が)?(済み|すみ|完了|終わった|終わり|終わらせた|できた|やった)(に(して|する))?$/);
    if (m) return { type: 'done', query: m[1] };
    // 列へ移す
    m = t.match(/^(.+)を(.+?)(へ|に)(移して|移す|動かして|動かす|して|する)?$/);
    if (m && laneOf(m[2], lanes)) return { type: 'move', query: m[1], lane: laneOf(m[2], lanes) };
    // 期限を決める
    m = t.match(/^(.+?)(は|を|の期限は?)(今日|きょう|明日|あした|明後日|あさって|来週|週末|[月火水木金土日]曜日?|\d{1,2}日)(まで|中)?(に)?(して|する|やる|で(いい)?)?$/);
    if (m && dueDate(m[3])) return { type: 'due', query: m[1], when: m[3] };
    return { type: 'unknown', text: t };
  }

  // 「明日」「金曜」「25日」を YYYY-MM-DD に直す（今日から見て次に来る日）。分からなければ ''
  function dueDate(word, today = new Date()) {
    const w = String(word || '').replace(/曜$/, '曜日');
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const add = (n) => d.setDate(d.getDate() + n);
    if (/^(今日|きょう)$/.test(w)) add(0);
    else if (/^(明日|あした)$/.test(w)) add(1);
    else if (/^(明後日|あさって)$/.test(w)) add(2);
    else if (w === '来週') add(7);
    else if (w === '週末') add((6 - d.getDay() + 7) % 7);
    else if (/^[月火水木金土日]曜日$/.test(w)) add(('日月火水木金土'.indexOf(w[0]) - d.getDay() + 7) % 7 || 7);
    else {
      const m = w.match(/^(\d{1,2})日$/); const n = m ? +m[1] : 0;
      if (n < 1 || n > 31) return '';
      if (n < d.getDate()) d.setMonth(d.getMonth() + 1, 1);
      d.setDate(n);
      if (d.getDate() !== n) return ''; // 30日までの月の31日など
    }
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  // 一言に入った複数の命令を区切る（「AとBを済みに、Cは明日」→ 「AとBを済みに」「Cは明日」）。「あとで」を切らないよう「あと」では切らない
  function split(text) {
    return String(text || '').split(/[、。,，]|それと|それから|あとは/).map((x) => x.trim()).filter(Boolean);
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

  // 前の版との互換（メモのアプリなどが呼ぶことがある）。Chrome の音声認識は使わないので、いつも「使えない」
  const localStatus = async () => 'unavailable';
  const install = async () => false;

  // 耳（localai.js の Whisper。端末の中だけで動く）
  let ear = null;
  function useEar(e) { ear = e; }
  const earReady = () => { try { return !!ear?.ready(); } catch { return false; } };

  // 聞いている途中でやめる（会話の途中で打つほうに切り替えたとき）
  // 押している間だけ聞く（hold）の「離した」。聞き取った分を返して終わる
  function release() { try { ear?.release?.(); } catch { /* なくてよい */ } }
  function cancelListen() { try { ear?.cancel?.(); } catch { /* なくてよい */ } }

  // 聞き取りに失敗した記録（理由・何秒で終わったか。聞いた中身は入れない）。診断で送る
  const LOG_KEY = 'lk.micLog';
  function note(v) {
    try { const l = JSON.parse(localStorage.getItem(LOG_KEY) || '[]'); l.push({ at: new Date().toISOString(), ...v }); localStorage.setItem(LOG_KEY, JSON.stringify(l.slice(-20))); } catch { /* 残せなくてもよい */ }
    try { g.dispatchEvent?.(new CustomEvent('voice:fail', { detail: v })); } catch { /* なくてよい */ }
  }
  const micLog = () => { try { return JSON.parse(localStorage.getItem(LOG_KEY) || '[]'); } catch { return []; } };
  const route = async () => (earReady() ? 'ear' : 'none');

  // 1回だけ聞き取る。返り値は Promise<{ text, via: 'ear' }>。耳が無ければ聞かずにエラー（code 'no-ear'）
  // hold: true なら release() を呼ぶまで聞き続ける。waitMs は話し始めを待つ長さ、endMs は話し終わりの待ち
  async function listen({ lang = 'ja-JP', hold = false, waitMs, endMs } = {}) {
    if (!earReady()) { const e = new Error('🎤で話すには、聞き取りの部品（Whisper）を入れてね'); e.code = 'no-ear'; throw e; }
    const t0 = Date.now();
    try { return { ...(await ear.listen({ lang, hold, waitMs, endMs })), via: 'ear' }; } catch (e) {
      // 聞こえなかっただけ（だまっていた）は記録しない。マイクが取れない・耳が落ちたなどは記録して診断で送る
      if (!/聞き取れませんでした/.test(e?.message || '')) note({ code: e?.code || e?.name || 'ear-error', ms: Date.now() - t0 });
      throw e;
    }
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

  const api = { mood: 'normal', stop, cancelListen, release, parse, dueDate, split, match, nearest, laneOf, listen, localStatus, install, speak, speakAll, speechText, chunks, localVoice, useEar, localApi: false, get supported() { return earReady(); }, norm, route, micLog, note };
  g.Voice = api;
})(typeof window !== 'undefined' ? window : globalThis);

// 声（と Ctrl+K の命令欄）で操作するための小さな部品。カンバン以外のアプリ（メモなど）からも使える。外部ライブラリなし。
//   Voice.parse(文, 列の一覧)  … 文を命令に直す（ブラウザの機能は使わない。テストしやすいように純粋な関数）
//   Voice.match(言葉, 一覧, 題の取り出し) … あいまい一致で候補を探す
//   Voice.listen(コールバック) … 1回だけ聞き取る（端末の中で認識できればそちらを使う）
//   Voice.speak(文)            … 読み上げる
//   Voice.supported            … 音声認識が使えるか（Edge・Firefox は false）
// 文型（claude.ai のボードと同じ）:
//   「〇〇を追加」「〇〇を今やるに追加」「今やるに〇〇を追加」 → {type:'add', title, lane}
//   「〇〇を済み」「〇〇終わった」「〇〇完了」                → {type:'done', query}
//   「〇〇を<列>へ」「〇〇を<列>に移して」                    → {type:'move', query, lane}
//   「〇〇を消して」「〇〇を削除」                            → {type:'delete', query}（実行する前に聞き返す）
//   「<列>を読んで」「<列>は？」                              → {type:'read', lane}
//   「戻す」「元に戻して」「取り消し」                        → {type:'undo'}
//   「はい」「いいえ」「2番」                                 → {type:'yes'} / {type:'no'} / {type:'pick', n}
(function (g) {
  'use strict';
  const NUM = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, 'いち': 1, 'に': 2, 'さん': 3, 'よん': 4, 'ご': 5 };
  const clean = (s) => String(s || '').normalize('NFKC').replace(/[\s　、。．.！!？?「」『』]/g, '').trim();
  const norm = (s) => clean(s).toLowerCase().replace(/[ー－―‐]/g, 'ー');

  // lanes: [[key, label, ...aliases]]
  function laneOf(word, lanes) {
    const w = norm(word).replace(/(の列|列|レーン)$/, '');
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

  const SR = g.SpeechRecognition || g.webkitSpeechRecognition;
  let noticed = false;

  // 1回だけ聞き取る。返り値は Promise<{ text, local }>。onInfo には「端末の中で聞き取ります」などの知らせを渡す
  async function listen({ lang = 'ja-JP', onInfo = () => {} } = {}) {
    if (!SR) throw new Error('このブラウザは音声認識が使えません');
    let local = false;
    if (typeof SR.available === 'function') {
      try {
        const st = await SR.available({ langs: [lang], processLocally: true });
        if (st === 'available') local = true;
        else if (st === 'downloadable' && typeof SR.install === 'function') SR.install({ langs: [lang], processLocally: true }).catch(() => {});
      } catch { /* 古い Chrome */ }
    }
    if (!local && !noticed) {
      noticed = true;
      try { if (!localStorage.getItem('voice.noticed')) { localStorage.setItem('voice.noticed', '1'); onInfo('音声は Google のサーバーで文字にします（端末の中だけで聞き取れる Chrome では、次からそちらを使います）。'); } } catch { /* 保存できなくてもよい */ }
    }
    return new Promise((ok, ng) => {
      const r = new SR();
      r.lang = lang; r.interimResults = false; r.maxAlternatives = 1; r.continuous = false;
      if (local) r.processLocally = true;
      let got = false;
      r.onresult = (e) => { got = true; ok({ text: e.results[0][0].transcript, local }); };
      r.onerror = (e) => ng(new Error(e.error === 'not-allowed' ? 'マイクが許可されていません' : e.error === 'no-speech' ? '聞き取れませんでした' : '音声認識のエラー: ' + e.error));
      r.onend = () => { if (!got) ng(new Error('聞き取れませんでした')); };
      r.start();
    });
  }

  function speak(text, lang = 'ja-JP') {
    if (!g.speechSynthesis) return Promise.resolve();
    return new Promise((ok) => {
      try {
        g.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text); u.lang = lang; u.rate = 1.1;
        u.onend = ok; u.onerror = ok;
        g.speechSynthesis.speak(u);
        setTimeout(ok, 400 + text.length * 250); // 読み上げが終わらない環境の保険
      } catch { ok(); }
    });
  }

  g.Voice = { parse, match, laneOf, listen, speak, supported: !!SR, norm };
})(typeof window !== 'undefined' ? window : globalThis);

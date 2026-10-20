// 会話モード：キャラと声でやりとりしながらカードを片づける。すべて端末の中で動く（声も会話も外に出さない）。外部ライブラリなし。
//   耳  … voice.js の Voice.listen()（端末の中だけで聞き取る音声認識。無い端末は localai.js で入れた Whisper）。どちらも無ければ文字を打って話す
//   頭  … Chrome の内蔵 AI（Prompt API の LanguageModel、Gemini Nano）。無ければ localai.js で入れた WebLLM。どちらも無ければ AI なしの「1枚ずつ読み上げ」
//   口  … voice.js の Voice.speak()（端末の中の声だけ）。文ごとに区切ってすぐ話し始める
//   割り込み … 話している間だけマイクを見て、声が続いたら読み上げを止めて聞き始める（localai.js の Silero VAD。無ければ音の大きさを見る自作の簡単な VAD）
// アプリ側（index.html）から渡すもの:
//   board()        … [{title, lane, due}] いまのカード（AI に渡すのは題・列・期限だけ。補足・履歴・リンクは渡さない）
//   queue()        … AI なしのときに順に聞くカード（今やる → 次にやる）
//   run(text)      … 声の命令（voice.js の文型）を実行して返事の文を返す。聞き返し中なら答えとして扱う
//   act(cmd)       … 命令オブジェクト（{type, title|query, lane}）を実行して返事の文を返す
//   pending()      … 聞き返し中か（消す確認・候補えらび）
//   lanes          … { now: '今やる', ... }
(function (g) {
  'use strict';

  const DEFAULTS = {
    name: 'ポチ',
    persona: '気さくな相棒。タメ口で、明るく短く話す。「今日どれからやる？」と一緒に進める友達のように。できたらちゃんとほめる。説教はしない。',
    icon: 'maru',
    color: '#f59e0b',
    voice: '',
    bargeIn: true,
    ai: 'auto', // auto = 端末の中の AI（内蔵 AI か、入れた WebLLM）があれば使う / off = 使わない
  };
  const END = /^(終わり|おわり|おしまい|終わる|またね|バイバイ|ばいばい|ストップ|やめる|もういい)$/;

  // ---------- 返事の言い回し（AI なしのとき）。同じ文を続けて言わないように、毎回この中から選ぶ ----------
  // 人の会話のように言い回しを変えると機械っぽさが減る（Google の会話デザインの指針「Randomize prompts」）
  const PHRASES = {
    greet: { morning: ['おはよう！', 'おはよ〜！', '朝からえらいね！'], day: ['やっほー！', 'おつかれ！', 'こんにちは！'], evening: ['おつかれさま！', '今日もおつかれ！'], night: ['こんばんは！', '夜もおつかれさま。'] },
    hi: ['{name}だよ。今日どれからやる？', '{name}です。一緒に片づけよっか。', '待ってたよ、{name}です。さっそく見ていこう。', '{name}だよ。ちゃちゃっと見ていこう！'],
    ask: ['次は「{t}」。済み？あとで？', '「{t}」はどうする？ 終わってる？', 'じゃあ「{t}」。済んだ？ まだなら「あとで」でもいいよ。', '「{t}」いってみよう。済み、あとで、保留、どれ？'],
    done: ['やったね！', 'えらい！', 'ナイス！', 'いいね、1枚へった！', 'さすが！', 'おお、早い！'],
    later: ['りょうかい、あとでにしとくね。', 'オッケー、後回しね。', '無理しなくていいよ、あとでにしとく。'],
    hold: ['保留にしたよ。', '止めておくね。', 'いったん保留ね。'],
    now: ['今やるに入れたよ。', 'オッケー、今やるね。'],
    skip: ['じゃあ飛ばすね。', 'そのままにしとく。', 'パスね。'],
    empty: ['カードは全部見たよ。ほかにやることある？ 無ければ「終わり」で。', 'これで全部！ ほかに何かある？ 無ければ「終わり」でいいよ。', '一通り見終わったよ。足したいものがあれば言ってね。'],
    again: ['ごめん、もう一回言って？ 「済み」「あとで」「保留」「次」で答えてね。', 'ん？ 聞き取れなかった。「済み」か「あとで」で教えて。', 'ごめんね、分からなかった。「済み」「あとで」「保留」「次」のどれか言ってみて。'],
    thanks: ['どういたしまして！', 'いえいえ、こっちこそ！', 'どういたしまして。続けよっか。'],
    tired: ['おつかれ。ひと息ついてもいいよ。', '無理しないでね。あと1枚だけやってみる？', 'がんばってるね。休んでも大丈夫だよ。'],
    bye: ['オッケー、またね！', 'おつかれさま！また呼んでね。', '今日もありがとう、またね！'],
  };
  // 同じ種類の言い回しを続けて選ばない
  function picker(rand = Math.random) {
    const last = {};
    return (key, list, vars = {}) => {
      const opts = list.length > 1 ? list.filter((x) => x !== last[key]) : list;
      const v = opts[Math.floor(rand() * opts.length)] || '';
      last[key] = v;
      return v.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
    };
  }
  function partOfDay(h = new Date().getHours()) { return h < 5 || h >= 22 ? 'night' : h < 11 ? 'morning' : h < 17 ? 'day' : 'evening'; }
  function dueWords(due, today = new Date()) {
    if (!due) return '';
    const d = new Date(due.slice(0, 10) + 'T00:00:00'), t = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const days = Math.round((d - t) / 864e5);
    if (isNaN(days)) return '';
    if (days < 0) return '期限すぎてるよ。';
    if (days === 0) return '今日が期限だよ。';
    if (days === 1) return '明日が期限。';
    return `期限は${+due.slice(5, 7)}月${+due.slice(8, 10)}日。`;
  }

  // ---------- アイコン（新しく描いたもの。既存の作品の絵は使わない） ----------
  function avatarSvg(kind, color) {
    const c = /^#[0-9a-f]{6}$/i.test(color || '') ? color : DEFAULTS.color;
    const face = kind === 'kaku'
      ? `<rect x="14" y="18" width="92" height="84" rx="22" fill="${c}"/><rect x="54" y="4" width="12" height="16" rx="6" fill="${c}"/><circle cx="60" cy="6" r="6" fill="${c}"/>`
      : kind === 'shizuku'
        ? `<path d="M60 8 C 88 40 104 58 104 76 a44 40 0 0 1 -88 0 C16 58 32 40 60 8 Z" fill="${c}"/>`
        : `<circle cx="60" cy="62" r="48" fill="${c}"/><circle cx="24" cy="26" r="12" fill="${c}"/><circle cx="96" cy="26" r="12" fill="${c}"/>`;
    return `<svg viewBox="0 0 120 120" class="ava" role="img" aria-label="アイコン">${face}
      <circle cx="44" cy="60" r="7" fill="#1d2129"/><circle cx="76" cy="60" r="7" fill="#1d2129"/>
      <circle cx="46" cy="58" r="2.2" fill="#fff"/><circle cx="78" cy="58" r="2.2" fill="#fff"/>
      <ellipse cx="34" cy="74" rx="7" ry="4" fill="#fff" opacity=".35"/><ellipse cx="86" cy="74" rx="7" ry="4" fill="#fff" opacity=".35"/>
      <path class="mouth" d="M50 78 Q60 88 70 78" stroke="#1d2129" stroke-width="4" fill="none" stroke-linecap="round"/></svg>`;
  }

  // ---------- 文ごとに区切って話す（割り込まれたら止める） ----------
  function sentences(text) {
    return String(text || '').split(/(?<=[。！？!?\n])/).map((s) => s.trim()).filter(Boolean);
  }

  // ---------- 割り込み（自作の簡単な VAD：音の大きさがしばらく続いたら声とみなす） ----------
  function vad(stream, onVoice) {
    const AC = g.AudioContext || g.webkitAudioContext;
    if (!AC || !stream) return () => {};
    const ac = new AC();
    const src = ac.createMediaStreamSource(stream);
    const an = ac.createAnalyser(); an.fftSize = 1024;
    src.connect(an);
    const buf = new Float32Array(an.fftSize);
    let floor = 0.01, n = 0, frames = 0, stop = false;
    const tick = () => {
      if (stop) return;
      an.getFloatTimeDomainData(buf);
      let sum = 0; for (const v of buf) sum += v * v;
      const rms = Math.sqrt(sum / buf.length);
      frames++;
      if (frames < 10) floor = Math.max(floor, rms);           // 最初の 0.3 秒でまわりの音の大きさを測る
      else if (rms < floor * 1.5) floor = floor * 0.95 + rms * 0.05;
      n = rms > Math.max(floor * 3, 0.03) ? n + 1 : 0;
      if (n >= 7) { stop = true; onVoice(); return; }          // 約 0.2 秒続いたら声
      setTimeout(tick, 30);
    };
    tick();
    return () => { stop = true; try { src.disconnect(); ac.close(); } catch { /* 閉じられなくてもよい */ } };
  }

  // ---------- 頭：Chrome の内蔵 AI（Prompt API）。端末の中で動く ----------
  const LM = () => g.LanguageModel;
  const LANG = { expectedInputs: [{ type: 'text', languages: ['ja'] }], expectedOutputs: [{ type: 'text', languages: ['ja'] }] };
  async function aiStatus() {
    if (!LM() || typeof LM().availability !== 'function') return 'unavailable';
    try { return await LM().availability(LANG); } catch { return 'unavailable'; }
  }
  const SCHEMA = {
    type: 'object', required: ['say', 'action'],
    properties: {
      say: { type: 'string' },
      action: {
        anyOf: [{ type: 'null' }, {
          type: 'object', required: ['type'],
          properties: {
            type: { enum: ['add', 'done', 'move', 'delete', 'read', 'undo'] },
            title: { type: 'string' }, query: { type: 'string' },
            lane: { enum: ['now', 'next', 'wait', 'later', 'hold', 'agent', 'done'] },
          },
        }],
      },
    },
  };
  function systemPrompt(s, lanes) {
    return [
      `あなたは「${s.name}」。${s.persona}`,
      'ユーザーと声で話しながら、カンバンのカードを一緒に片づける相棒。電話で友だちと話すように、自然な話し言葉で返す。',
      '話し方：1〜2文で短く。まず相手の言ったことに一言反応してから続ける。同じ言い回しを繰り返さない。質問は1回に1つ。説明や箇条書きはしない。',
      '雑談や気持ちの話（疲れた・眠い・うれしい）にも短く付き合い、無理のない範囲で次のカードに戻す。済みにしたらほめる。',
      'ボードの中身（今やるの枚数・期限が近いカード）に触れてよい。ボードに無いカードや知らないことは作らない。分からなければ聞き返す。',
      `列は ${Object.entries(lanes).map(([k, v]) => `${k}=${v}`).join('、')}。`,
      'カードを動かすときだけ action を入れる。add は title、done・move・delete・read は query（カードの題の一部）、move・add・read は lane。消すときは delete（アプリが確認する）。何もしないときは action は null。',
      '出力は JSON {"say": 文, "action": null または {"type", "title", "query", "lane"}} だけ。',
    ].join('\n');
  }
  // 返事の見本（few-shot）。言い回し・長さ・JSON の形をこれに寄せる。カードの題は作り話
  const EXAMPLES = [
    ['いまのボード:\n- [今やる] 牛乳を買う\n- [次にやる] 部屋の片づけ\n\nユーザー: 牛乳買ってきた', { say: 'おかえり！ 牛乳、済みにしといたよ。次は部屋の片づけだけど、いけそう？', action: { type: 'done', query: '牛乳を買う' } }],
    ['いまのボード:\n- [今やる] 部屋の片づけ\n\nユーザー: なんか疲れたなあ', { say: 'おつかれさま。今日はけっこうがんばったもんね。片づけは明日にまわしとく？', action: null }],
    ['いまのボード:\n- [今やる] 部屋の片づけ\n\nユーザー: うん、そうして', { say: 'オッケー、あとでに入れたよ。ゆっくり休んでね。', action: { type: 'move', query: '部屋の片づけ', lane: 'later' } }],
    ['いまのボード:\n- [次にやる] 部屋の片づけ\n\nユーザー: 歯医者の予約するの忘れないようにしたい', { say: 'それ大事だね。「歯医者の予約」を今やるに足したよ。', action: { type: 'add', title: '歯医者の予約', lane: 'now' } }],
  ].map(([u, a]) => [u, JSON.stringify(a)]);
  // Prompt API の initialPrompts の形（指示＋見本）
  function initialPrompts(s, lanes) {
    return [{ role: 'system', content: systemPrompt(s, lanes) }, ...EXAMPLES.flatMap(([u, a]) => [{ role: 'user', content: u }, { role: 'assistant', content: a }])];
  }

  function create(host) {
    let s = { ...DEFAULTS, ...(host.settings || {}) };
    let on = false, speaking = false, stopVad = () => {}, stream = null, session = null, mode = 'script', brain = '', idx = 0, cur = null, doneCount = 0;
    const pick = picker();
    const log = (who, text) => host.onLine?.(who, text);
    const state = (st) => host.onState?.(st);

    async function say(text) {
      if (!text) return;
      log('ai', text);
      speaking = true; state('speaking');
      let interrupted = false;
      const cut = () => { interrupted = true; g.speechSynthesis?.cancel(); };
      if (s.bargeIn && stream) stopVad = g.LocalAI?.bargeIn(stream, cut) || vad(stream, cut); // Silero VAD が入っていればそれ、無ければ音の大きさ
      for (const part of sentences(text)) {
        if (!on || interrupted) break;
        const ok = await g.Voice.speak(part);
        if (ok === false) break; // 端末の中の声が無い → 文字だけ
      }
      stopVad(); stopVad = () => {};
      speaking = false;
      return interrupted;
    }

    function nextCard() {
      const q = host.queue();
      cur = q[idx] || null;
      return cur;
    }
    function askCard() {
      const c = nextCard();
      if (!c) return pick('empty', PHRASES.empty);
      return pick('ask', PHRASES.ask, { t: c.title }) + (c.due ? ' ' + dueWords(c.due) : '');
    }
    const trouble = (r) => /見つかりません|保存できない|分かりません|できません/.test(r || '');

    // AI なし：1枚ずつ聞いて、短い答えで動かす。返事は言い回しを変えながら返す
    function scripted(text) {
      const t = g.Voice.norm(text);
      if (host.pending()) return host.run(text);
      if (/^(ありがとう|ありがと|サンキュー|助かる|助かった)/.test(t)) return pick('thanks', PHRASES.thanks) + ' ' + (cur ? askCard() : '');
      if (/(疲れ|つかれ|しんどい|眠い|ねむい|だるい)/.test(t)) return pick('tired', PHRASES.tired);
      if (cur) {
        const short = [
          [/^(済み|すみ|済んだ|終わった|できた|やった|完了|はい|うん|片づけた|片付けた)$/, 'done'],
          [/^(あとで|後で|いつか|時間があるとき)$/, 'later'],
          [/^(保留|ほりゅう)$/, 'hold'],
          [/^(今やる|いまやる|今)$/, 'now'],
          [/^(次|つぎ|スキップ|パス|飛ばす|とばす|そのまま)$/, 'skip'],
        ].find(([re]) => re.test(t));
        if (short) {
          const k = short[1];
          let r = '';
          if (k === 'skip') { idx++; r = pick('skip', PHRASES.skip); }
          else {
            const got = host.act(k === 'done' ? { type: 'done', card: cur } : { type: 'move', card: cur, lane: k });
            if (trouble(got)) return got;
            if (k === 'done') { doneCount++; r = pick('done', PHRASES.done) + (doneCount >= 3 ? ` これで${doneCount}枚目！` : ''); }
            else r = pick(k, PHRASES[k]);
            if (cur.lane === 'now' || cur.lane === 'next') idx++; // 列から外れたときは同じ番号のまま（次のカードが繰り上がる）
          }
          return r + ' ' + askCard();
        }
      }
      const cmd = g.Voice.parse(text, host.laneWords);
      if (cmd && cmd.type !== 'unknown') return host.run(text) + (host.pending() ? '' : ' ' + askCard());
      return pick('again', PHRASES.again);
    }

    // 内蔵 AI：ボード（題・列・期限だけ）と言ったことを渡し、JSON の返事を読む
    async function smart(text) {
      if (host.pending()) return host.run(text);
      const board = host.board().slice(0, 40).map((c) => `- [${host.lanes[c.lane] || c.lane}] ${c.title}${c.due ? `（期限 ${c.due}）` : ''}`).join('\n');
      let out;
      try {
        const raw = await session.prompt(`いまのボード:\n${board || '（カードなし）'}\n（いまは${new Date().getHours()}時。この会話で済みにしたのは${doneCount}枚）\n\nユーザー: ${text}`, { responseConstraint: SCHEMA });
        out = JSON.parse(raw);
      } catch {
        return 'ごめん、うまく考えられなかった。もう一回言って？';
      }
      const a = out && out.action;
      let r = '';
      if (a && typeof a === 'object' && ['add', 'done', 'move', 'delete', 'read', 'undo'].includes(a.type)) {
        const cmd = { type: a.type };
        if (a.type === 'add') { if (!a.title) return out.say || 'なんて題にする？'; cmd.title = String(a.title).slice(0, 200); cmd.lane = host.lanes[a.lane] ? a.lane : null; }
        if (['done', 'move', 'delete', 'read'].includes(a.type)) { cmd.query = String(a.query || a.title || ''); if (a.type !== 'read' && !cmd.query) return out.say || 'どのカード？'; }
        if (a.type === 'move' || a.type === 'read') { if (!host.lanes[a.lane]) return out.say || 'どの列にする？'; cmd.lane = a.lane; }
        r = host.act(cmd);
        if (a.type === 'done' && !trouble(r)) doneCount++;
      }
      // 動かせた・読めたときは AI の返事、聞き返し（消す確認・候補）や見つからないときはアプリの文を優先
      if (r && (host.pending() || /見つかりません|保存できない|分かりません|空です|枚。/.test(r))) return host.pending() || /枚。|空です/.test(r) ? r : (out.say ? out.say + ' ' : '') + r;
      return String(out?.say || r || 'うん。');
    }

    async function start() {
      if (on) return;
      on = true; idx = 0; cur = null; doneCount = 0;
      state('starting');
      // 割り込み用のマイク（使えなければ割り込みなし）
      if (s.bargeIn && g.navigator?.mediaDevices?.getUserMedia) {
        try { stream = await g.navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); } catch { stream = null; }
      }
      mode = 'script'; brain = '';
      if (s.ai !== 'off') {
        const st = await aiStatus();
        if (st === 'available' || st === 'downloadable' || st === 'downloading') {
          try {
            if (st !== 'available') log('sys', '端末の中の AI を準備しています（初回だけ、ブラウザが部品を入れます）…');
            session = await LM().create({ ...LANG, initialPrompts: initialPrompts(s, host.lanes) });
            mode = 'ai'; brain = 'builtin';
          } catch { session = null; }
        }
        // 内蔵 AI が無い端末（スマホなど）は、「AI の部品を入れる」で入れた WebLLM を使う
        if (mode !== 'ai' && g.LocalAI?.llmReady()) {
          try {
            log('sys', '端末の中の AI を読み込んでいます（数秒〜数十秒）…');
            session = await g.LocalAI.session(systemPrompt(s, host.lanes), EXAMPLES);
            if (session) { mode = 'ai'; brain = 'webllm'; }
          } catch { session = null; log('sys', '端末の中の AI を読み込めなかったので、AI なしで進めます。'); }
        }
      }
      if (!on) return;
      g.LocalAI?.prepareEar(); // Whisper・Silero を入れてあれば先に読み込んでおく
      host.onMode?.(mode, brain, s.ai === 'off' ? 'off' : 'none');
      if (mode !== 'ai') log('sys', s.ai === 'off' ? 'AI は設定で切っています。決まった返事で1枚ずつ聞きます。' : 'いまは AI なし（決まった返事）です。⚙ キャラの設定で AI を入れると、自由に話せます。');
      const q = host.queue();
      const hi = pick('greet', PHRASES.greet[partOfDay()]) + pick('hi', PHRASES.hi, { name: s.name });
      const nowN = host.board().filter((c) => c.lane === 'now').length;
      const first = mode === 'ai'
        ? `${hi} 今やるは${nowN}枚${q[0] ? `、まずは「${q[0].title}」から？` : '。'}`
        : `${hi} ${askCard()}`;
      await say(first);
      loop();
    }

    async function loop() {
      while (on) {
        if (!g.Voice.supported) { state('typing'); return; } // 耳が無い端末は文字で（hear() を呼んでもらう）
        state('listening');
        let text;
        try { text = (await g.Voice.listen()).text; }
        catch (e) {
          if (!on) return;
          if (/端末の中だけで聞き取れません|部品|マイク/.test(e.message)) { log('sys', e.message + ' 文字を打って話してね。'); state('typing'); return; }
          continue; // 聞き取れなかった → もう一度
        }
        if (!on) return;
        await hear(text, true);
      }
    }

    // 1回分の言葉を受け取って返事する（声でも、打った文字でも）
    async function hear(text, fromLoop = false) {
      if (!on || !String(text || '').trim()) return;
      log('you', text);
      if (END.test(g.Voice.norm(text))) { await say((doneCount ? `今日は${doneCount}枚片づけたね。` : '') + pick('bye', PHRASES.bye)); stop(); return; }
      state('thinking');
      const reply = mode === 'ai' ? await smart(text) : scripted(text);
      await say(reply);
      if (!fromLoop && on) state(g.Voice.supported ? 'listening' : 'typing');
    }

    function stop() {
      on = false;
      try { g.speechSynthesis?.cancel(); } catch { /* なくてよい */ }
      stopVad();
      stream?.getTracks().forEach((t) => t.stop()); stream = null;
      try { session?.destroy?.(); } catch { /* なくてよい */ }
      session = null;
      state('off');
    }

    return { start, stop, hear, get on() { return on; }, get speaking() { return speaking; }, set settings(v) { s = { ...DEFAULTS, ...v }; } };
  }

  g.Talk = { create, avatarSvg, DEFAULTS, aiStatus, systemPrompt, initialPrompts, EXAMPLES, PHRASES, picker, partOfDay, dueWords, sentences };
})(typeof window !== 'undefined' ? window : globalThis);

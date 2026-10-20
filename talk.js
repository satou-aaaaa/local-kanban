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
      'ユーザーと一緒にカンバンのカードを片づける。返事は日本語で1〜2文、短く話し言葉で。',
      `列は ${Object.entries(lanes).map(([k, v]) => `${k}=${v}`).join('、')}。`,
      'カードを動かすときだけ action を入れる。add は title、done・move・delete・read は query（カードの題の一部）、move・add・read は lane。消すときは delete（アプリが確認する）。何もしないときは action は null。',
      '知らないことやボードに無いことは作らない。分からなければ聞き返す。',
      '出力は JSON {"say": 文, "action": null または {"type", "title", "query", "lane"}} だけ。',
    ].join('\n');
  }

  function create(host) {
    let s = { ...DEFAULTS, ...(host.settings || {}) };
    let on = false, speaking = false, stopVad = () => {}, stream = null, session = null, mode = 'script', brain = '', idx = 0, cur = null;
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
      if (!c) return 'カードは全部見たよ。ほかにやることある？ 無ければ「終わり」で。';
      return `次は「${c.title}」。${c.due ? `期限は${+c.due.slice(5, 7)}月${+c.due.slice(8, 10)}日。` : ''}済み？あとで？保留？ 飛ばすなら「次」。`;
    }

    // AI なし：1枚ずつ聞いて、短い答えで動かす
    function scripted(text) {
      const t = g.Voice.norm(text);
      if (host.pending()) return host.run(text);
      if (cur) {
        const short = [
          [/^(済み|すみ|済んだ|終わった|できた|やった|完了|はい|うん)$/, 'done'],
          [/^(あとで|後で|いつか|時間があるとき)$/, 'later'],
          [/^(保留|ほりゅう)$/, 'hold'],
          [/^(今やる|いまやる|今)$/, 'now'],
          [/^(次|つぎ|スキップ|パス|飛ばす|とばす|そのまま)$/, 'skip'],
        ].find(([re]) => re.test(t));
        if (short) {
          let r = '';
          if (short[1] === 'skip') idx++;
          else { r = host.act(short[1] === 'done' ? { type: 'done', card: cur } : { type: 'move', card: cur, lane: short[1] }); if (cur.lane !== 'now' && cur.lane !== 'next') { /* 列から外れたので同じ番号のまま */ } else idx++; }
          return (r ? r + ' ' : '') + askCard();
        }
      }
      const cmd = g.Voice.parse(text, host.laneWords);
      if (cmd && cmd.type !== 'unknown') return host.run(text) + (host.pending() ? '' : ' ' + askCard());
      return 'ごめん、もう一回言って？ 「済み」「あとで」「保留」「次」で答えてね。';
    }

    // 内蔵 AI：ボード（題・列・期限だけ）と言ったことを渡し、JSON の返事を読む
    async function smart(text) {
      if (host.pending()) return host.run(text);
      const board = host.board().slice(0, 40).map((c) => `- [${host.lanes[c.lane] || c.lane}] ${c.title}${c.due ? `（期限 ${c.due}）` : ''}`).join('\n');
      let out;
      try {
        const raw = await session.prompt(`いまのボード:\n${board || '（カードなし）'}\n\nユーザー: ${text}`, { responseConstraint: SCHEMA });
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
      }
      // 動かせた・読めたときは AI の返事、聞き返し（消す確認・候補）や見つからないときはアプリの文を優先
      if (r && (host.pending() || /見つかりません|保存できない|分かりません|空です|枚。/.test(r))) return host.pending() || /枚。|空です/.test(r) ? r : (out.say ? out.say + ' ' : '') + r;
      return String(out?.say || r || 'うん。');
    }

    async function start() {
      if (on) return;
      on = true; idx = 0; cur = null;
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
            session = await LM().create({ ...LANG, initialPrompts: [{ role: 'system', content: systemPrompt(s, host.lanes) }] });
            mode = 'ai'; brain = 'builtin';
          } catch { session = null; }
        }
        // 内蔵 AI が無い端末（スマホなど）は、「AI の部品を入れる」で入れた WebLLM を使う
        if (mode !== 'ai' && g.LocalAI?.llmReady()) {
          try {
            log('sys', '端末の中の AI を読み込んでいます（数秒〜数十秒）…');
            session = await g.LocalAI.session(systemPrompt(s, host.lanes));
            if (session) { mode = 'ai'; brain = 'webllm'; }
          } catch { session = null; log('sys', '端末の中の AI を読み込めなかったので、AI なしで進めます。'); }
        }
      }
      if (!on) return;
      g.LocalAI?.prepareEar(); // Whisper・Silero を入れてあれば先に読み込んでおく
      host.onMode?.(mode, brain);
      const q = host.queue();
      const hi = `やあ、${s.name}だよ。今日どれからやる？`;
      const first = mode === 'ai'
        ? `${hi} 今やるは${host.board().filter((c) => c.lane === 'now').length}枚${q[0] ? `、1枚目は「${q[0].title}」` : ''}。`
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
      if (END.test(g.Voice.norm(text))) { await say(`オッケー、またね！`); stop(); return; }
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

  g.Talk = { create, avatarSvg, DEFAULTS, aiStatus, systemPrompt, sentences };
})(typeof window !== 'undefined' ? window : globalThis);

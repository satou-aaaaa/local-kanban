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
//   pending()      … 聞き返し中か（候補えらび）
//   tidy()         … ポチの整理（{ text } か null）。やったことを一言で返す
//   lanes          … { now: '今やる', ... }
(function (g) {
  'use strict';

  // ---------- キャラ設定書（ポチの人物像の正。決まった返事・AI への指示・見本の会話はこれに合わせる） ----------
  // Google の会話デザインの手引き（Create a persona）：性格を4〜6語にしぼり、1段落の人物像を書き、「この人ならどう言う？」で台詞を書く。
  // 言わないこと（never）は、決まった返事と見本の会話に入っていないかを QA が見る（qa/run.mjs）
  const PERSONA = {
    first: 'ぼく',
    traits: ['明るい', 'せかさない', 'ほめ上手', 'ちょっと食いしん坊', '犬っぽく素直'],
    about: 'ボードの相棒の子犬。タメ口で、明るく短く話す。一緒に片づけるのが好きで、できたらちゃんとほめる。急かさず、疲れた日は休ませる。たまに食べものの話をする。',
    habits: ['次に進むときは「よし、」', 'うれしいときは「やったね！」', '語尾はときどき「〜だね」「〜しよっか」'],
    never: ['説教（「〜すべき」「〜しないと」）', '長い説明や箇条書き', '「〜しましょう」「〜してください」などのかしこまった言い方', '「承知しました」などの決まり文句'],
    neverRe: /しましょう|すべき|しないとだめ|してください|承知しました|かしこまりました/,
  };
  // 前の版の決まった人物像（設定に保存されたまま残っている人は、新しい人物像に置きかえる）
  const OLD_PERSONA = ['気さくな相棒。タメ口で、明るく短く話す。「今日どれからやる？」と一緒に進める友達のように。できたらちゃんとほめる。説教はしない。'];
  const DEFAULTS = {
    name: 'ポチ',
    persona: PERSONA.about,
    icon: 'maru',
    color: '#f59e0b',
    voice: '',
    bargeIn: true,
    reply: 'match', // match = 声で話しかけたら声でも返し、打ったら文字だけ / voice = いつも声でも / text = いつも文字だけ
    tidy: true, // 話し始めたら、ポチがボードを自分で整理して報告する（host.tidy。「戻す」で戻せる）
    ai: 'auto', // auto = 端末の中の AI（内蔵 AI か、入れた WebLLM）があれば使う / off = 使わない
    cue: true, // 聞き始め「ポン」・聞き終わり「ポロン」の音と短い振動（音は端末の中で作る。ファイルも通信も無し）
    waitMore: true, // 言いかけ（〜て・〜けど・〜から・えっと）で終わったら、答えずに続きを聞いてつなげる
    followUp: true, // 会話の終わりに一言まとめて覚え、次に開いたとき「昨日の〇〇、どうなった？」から始める
  };
  const settingsOf = (v) => { const s = { ...DEFAULTS, ...(v || {}) }; if (!s.persona || OLD_PERSONA.includes(s.persona)) s.persona = PERSONA.about; return s; };
  const END = /^(終わり|おわり|おしまい|終わる|またね|バイバイ|ばいばい|ストップ|やめる|もういい)$/;

  // ---------- 返事の言い回し（AI なしのとき）。同じ文を続けて言わないように、毎回この中から選ぶ ----------
  // 人の会話のように言い回しを変えると機械っぽさが減る（Google の会話デザインの指針「Randomize prompts」）
  const PHRASES = {
    greet: { morning: ['おはよう！', 'おはよ〜！', '朝からえらいね！'], day: ['やっほー！', 'おつかれ！', 'こんにちは！'], evening: ['おつかれさま！', '今日もおつかれ！'], night: ['こんばんは！', '夜もおつかれさま。'] },
    hi: ['{name}だよ。今日どれからやる？', '{name}です。一緒に片づけよっか。', '待ってたよ、{name}です。さっそく見ていこう。', '{name}だよ。ちゃちゃっと見ていこう！', 'ぼく、{name}。今日もいっしょに片づけよっか。'],
    ask: ['次は「{t}」。済み？あとで？', '「{t}」はどうする？ 終わってる？', 'じゃあ「{t}」。済んだ？ まだなら「あとで」でもいいよ。', '「{t}」いってみよう。済み、あとで、保留、どれ？'],
    done: ['やったね！', 'えらい！', 'ナイス！', 'いいね、1枚へった！', 'さすが！', 'おお、早い！', 'やったね！ ごほうびのおやつ気分！'],
    later: ['りょうかい、あとでにしとくね。', 'オッケー、後回しね。', '無理しなくていいよ、あとでにしとく。'],
    hold: ['保留にしたよ。', '止めておくね。', 'いったん保留ね。'],
    now: ['今やるに入れたよ。', 'オッケー、今やるね。'],
    skip: ['じゃあ飛ばすね。', 'そのままにしとく。', 'パスね。'],
    empty: ['カードは全部見たよ。ほかにやることある？ 無ければ「終わり」で。', 'これで全部！ ほかに何かある？ 無ければ「終わり」でいいよ。', '一通り見終わったよ。足したいものがあれば言ってね。'],
    again: ['ごめん、もう一回言って？ 「済み」「あとで」「保留」「次」で答えてね。', 'ん？ 聞き取れなかった。「済み」か「あとで」で教えて。', 'ごめんね、分からなかった。「済み」「あとで」「保留」「次」のどれか言ってみて。', 'うーん、どれだろ。済んだなら「済み」、まだなら「あとで」って言ってね。'],
    // カードの話をしていないとき（AI なし）。相槌を打ってから、できることをさりげなく伝える
    chat: ['うんうん。カードのことなら「〇〇を追加」とか「今やるを読んで」って言ってね。', 'そっかあ。AI を入れると、もっといろいろ話せるよ。', 'なるほどね。片づけるなら「今やるを読んで」からどう？', 'へえ、そうなんだ。何か足しとく？ 「〇〇を追加」って言ってくれたら入れるよ。'],
    // 考えているあいだの相槌（AI が遅いときだけ。画面には出さない）
    aizuchi: ['うん。', 'なるほど。', 'そっか。', 'うんうん。', 'えっとね。', 'ふむふむ。'],
    // 命令をやったときの最初の一言
    ack: ['オッケー、', 'うん、', '了解、', 'はーい、', 'よし、', 'わかった、'],
    thanks: ['どういたしまして！', 'いえいえ、こっちこそ！', 'どういたしまして。続けよっか。'],
    tired: ['おつかれ。ひと息ついてもいいよ。', '無理しないでね。あと1枚だけやってみる？', 'がんばってるね。休んでも大丈夫だよ。', 'おつかれ。ぼくもおやつ休憩したいな。ひと息つこ？'],
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

  // AI に渡す期限の言い方（小さい AI は日付から「明日」を計算できないので、言葉にして渡す）
  function dueShort(due, today = new Date()) {
    if (!due) return '';
    const d = new Date(due.slice(0, 10) + 'T00:00:00'), t = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const days = Math.round((d - t) / 864e5);
    if (isNaN(days)) return '';
    return days < 0 ? '期限すぎ' : days === 0 ? '今日まで' : days === 1 ? '明日まで' : days <= 7 ? `${days}日後まで` : `${+due.slice(5, 7)}月${+due.slice(8, 10)}日まで`;
  }
  const BOARD_MAX = 10; // AI に渡すカードは上から10枚まで（毎回読ませる量を減らして速くする）

  // ---------- アイコン（新しく描いたもの。既存の作品の絵・Live2D・外の画像は使わない） ----------
  // 動き（まばたき・呼吸・耳・表情・口・演出）は app.css。表情は #talkDlg の data-mood（normal・happy・think・surprise・sad・listen）で切り替える。
  // 口は表情ごとの形を重ねておき、見せる1つを CSS で選ぶ（d: path() の切り替えより多くのブラウザで動く）
  let avaSeq = 0;
  function avatarSvg(kind, color) {
    const c = /^#[0-9a-f]{6}$/i.test(color || '') ? color : DEFAULTS.color;
    const id = 'ava' + (++avaSeq);
    const face = kind === 'kaku'
      ? `<g class="ears"><rect x="54" y="2" width="12" height="18" rx="6" fill="url(#${id}g)"/><circle class="tip" cx="60" cy="5" r="7" fill="#fde68a"/></g>
         <rect x="12" y="18" width="96" height="88" rx="26" fill="url(#${id}g)"/>`
      : kind === 'shizuku'
        ? `<g class="ears"><path d="M60 4 C 66 12 70 16 70 22 a10 10 0 0 1 -20 0 C50 16 54 12 60 4 Z" fill="url(#${id}g)" opacity=".9"/></g>
           <path d="M60 12 C 90 42 106 60 106 78 a46 40 0 0 1 -92 0 C14 60 30 42 60 12 Z" fill="url(#${id}g)"/>`
        : `<g class="ears"><g class="ear l"><circle cx="24" cy="26" r="14" fill="url(#${id}g)"/><circle cx="24" cy="26" r="7" fill="#fecaca" opacity=".8"/></g>
           <g class="ear r"><circle cx="96" cy="26" r="14" fill="url(#${id}g)"/><circle cx="96" cy="26" r="7" fill="#fecaca" opacity=".8"/></g></g>
           <circle cx="60" cy="64" r="48" fill="url(#${id}g)"/>`;
    const eye = (x) => `<g class="eye"><ellipse cx="${x}" cy="60" rx="8" ry="9" fill="#1d2129"/><circle class="shine" cx="${x + 2.5}" cy="56.5" r="2.6" fill="#fff"/><circle cx="${x - 2.5}" cy="63" r="1.2" fill="#fff" opacity=".7"/>
      <rect class="lid" x="${x - 10}" y="49" width="20" height="22" fill="${c}"/></g>`;
    return `<svg viewBox="0 0 120 120" class="ava" role="img" aria-label="キャラの顔">
      <defs><radialGradient id="${id}g" cx="38%" cy="30%" r="80%"><stop offset="0" stop-color="#fff" stop-opacity=".55"/><stop offset=".35" stop-color="${c}"/><stop offset="1" stop-color="${c}" stop-opacity=".9"/></radialGradient></defs>
      <g class="fx-ring"><circle cx="60" cy="64" r="56" fill="none" stroke="${c}" stroke-width="3" opacity=".5"/></g>
      <g class="body">${face}
        <ellipse class="cheek" cx="32" cy="76" rx="8" ry="4.5" fill="#fb7185" opacity=".35"/><ellipse class="cheek" cx="88" cy="76" rx="8" ry="4.5" fill="#fb7185" opacity=".35"/>
        <path class="brow l" d="M36 46 Q44 42 52 46" stroke="#1d2129" stroke-width="3" fill="none" stroke-linecap="round"/>
        <path class="brow r" d="M68 46 Q76 42 84 46" stroke="#1d2129" stroke-width="3" fill="none" stroke-linecap="round"/>
        ${eye(44)}${eye(76)}
        <g class="eyes-happy" stroke="#1d2129" stroke-width="4" fill="none" stroke-linecap="round"><path d="M36 62 Q44 52 52 62"/><path d="M68 62 Q76 52 84 62"/></g>
        <g class="mouths" stroke="#1d2129" stroke-width="4" fill="none" stroke-linecap="round" stroke-linejoin="round">
          <path class="mouth m-normal" d="M50 80 Q60 88 70 80"/>
          <path class="mouth m-happy" d="M46 78 Q60 96 74 78 Z" fill="#7f1d1d"/>
          <path class="mouth m-open" d="M51 80 Q60 94 69 80 Q60 84 51 80 Z" fill="#7f1d1d"/>
          <ellipse class="mouth m-surprise" cx="60" cy="84" rx="6" ry="7" fill="#7f1d1d"/>
          <path class="mouth m-sad" d="M50 88 Q60 80 70 88"/>
          <path class="mouth m-think" d="M52 84 Q58 82 68 85"/>
        </g>
      </g>
      <g class="fx-think" fill="#fff" stroke="${c}" stroke-width="2"><circle cx="104" cy="22" r="4"/><circle cx="112" cy="10" r="6"/></g>
      <g class="fx-sweat"><path d="M100 40 q4 8 0 10 q-4 -2 0 -10 Z" fill="#7dd3fc"/></g>
    </svg>`;
  }

  // ---------- 文ごとに区切って話す（割り込まれたら止める） ----------
  function sentences(text) {
    return String(text || '').split(/(?<=[。！？!?\n])/).map((s) => s.trim()).filter(Boolean);
  }
  // 人の会話は短い。AI の返事は2文までにする
  function short(text, n = 2) { const ss = sentences(text); return ss.length > n ? ss.slice(0, n).join('') : String(text || '').trim(); }
  // 言い出し（最初の「、」「。」までの短い一言）。同じ言い出しが続かないように比べる
  function opening(text) { const m = String(text || '').match(/^(.{1,10}?)[、。！？!?,…]/); return m ? m[1] : ''; }
  // アプリの決まった文（です・ます）を、ポチの話し方（タメ口）にそろえる
  function casual(text) {
    return String(text || '')
      .replace(/を消しますか？ はい か いいえ で答えてください。/g, 'を消していい？ 「はい」か「いいえ」で教えてね。')
      .replace(/何番ですか？/g, '何番？').replace(/どれですか？/g, 'どれ？').replace(/つあります。/g, 'つあるよ。')
      .replace(/見つかりません。/g, '見つからなかった。').replace(/ありません。/g, 'ないよ。')
      .replace(/ました。/g, 'たよ。').replace(/でした。/g, 'だったよ。').replace(/ません。/g, 'ないよ。')
      .replace(/ですか？/g, '？').replace(/です。/g, 'だよ。');
  }
  // 流れてくる途中の JSON から "say" の文だけを取り出す（閉じていない文字列でもよい）
  function partialSay(raw) {
    const m = String(raw || '').match(/"say"\s*:\s*"((?:[^"\\]|\\.)*)/);
    if (!m) return '';
    const body = m[1].replace(/\\(u[0-9a-fA-F]{0,3})?$/, ''); // 途中で切れた \ や \u30 は捨てる
    try { return JSON.parse('"' + body + '"'); } catch { return body; }
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
            type: { enum: ['add', 'done', 'move', 'delete', 'read', 'undo', 'status', 'agent'] },
            title: { type: 'string' }, query: { type: 'string' },
            lane: { enum: ['now', 'next', 'wait', 'later', 'hold', 'agent', 'done'] },
          },
        }],
      },
    },
  };
  function systemPrompt(s, lanes, memo = []) {
    return [
      `あなたは「${s.name}」。${s.persona}`,
      `一人称は「${PERSONA.first}」。性格：${PERSONA.traits.join('・')}。口ぐせ：${PERSONA.habits.join('／')}。`,
      `言わないこと：${PERSONA.never.join('・')}。`,
      ...(memo.length ? ['覚えていること（ユーザーが教えてくれたこと・よくあること。自然に活かす。毎回は口に出さない）:', ...memo.map((m) => '- ' + m)] : []),
      'ユーザーと声で話しながら、カンバンのカードを一緒に片づける相棒。電話で友だちと話すように、自然な話し言葉で返す。',
      '話し方：1〜2文で短く。まず相手の言ったことに「うん」「そっか」「なるほど」などの相槌か一言の反応をしてから続ける。直前と同じ言い出しや言い回しを繰り返さない。分からないときは短く聞き返す。質問は1回に1つ。説明や箇条書きはしない。',
      '雑談や気持ちの話（疲れた・眠い・うれしい）にも短く付き合い、無理のない範囲で次のカードに戻す。済みにしたらほめる。',
      'ボードの中身（今やるの枚数・期限が近いカード）に触れてよい。ボードに無いカードや知らないことは作らない。分からなければ聞き返す。',
      `列は ${Object.entries(lanes).map(([k, v]) => `${k}=${v}`).join('、')}。`,
      'カードを動かすときだけ action を入れる。add は title、done・move・delete・read・status・agent は query（カードの題の一部）、move・add・read は lane。消すときは delete（すぐ消える。「戻して」で戻せる）。「〇〇はどうなった？」と様子を聞かれたら status（アプリが列・今の段・最後の記録を答える）。「Claude にやらせて」と言われたら agent（Claude が進める列へ回す）。何もしないときは action は null。',
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
  function initialPrompts(s, lanes, memo = []) {
    return [{ role: 'system', content: systemPrompt(s, lanes, memo) }, ...EXAMPLES.flatMap(([u, a]) => [{ role: 'user', content: u }, { role: 'assistant', content: a }])];
  }

  // ---------- ポチが覚える（モデルは学び直さない。覚えたことを書きとめて、毎回の指示と返事に使う） ----------
  // 書く → まとめる → 読む の繰り返し（AI エージェントの長期記憶の基本形）。全部は覚えず、
  // 「覚えて」「〇〇って呼んで」と言われたとき・同じ言い直しが2回あったとき・よく片づける時間帯が分かったときだけ書く。
  // 置き場所はデータのリポジトリの local-board/pochi-memory.json（shim.js）。本人が設定の画面か「〇〇を忘れて」で消せる。
  const PART_LABEL = { morning: '朝', day: '昼', evening: '夕方', night: '夜' };
  const SHORT_LABEL = { done: '済み', later: 'あとで', hold: '保留', now: '今やる', skip: '次' };
  const WORD_MIN = 2; // 言い直しを覚えるまでの回数
  function memoryLines(items) {
    const out = [];
    for (const m of items || []) {
      if (m.kind === 'name') out.push(`ユーザーの呼び方: ${m.text}`);
      else if (m.kind === 'word' && (m.count || 0) >= WORD_MIN) out.push(`「${m.word}」は「${SHORT_LABEL[m.means] || m.means}」の意味`);
      else if (m.kind === 'habit' && m.text) out.push(m.text);
      else if (m.kind === 'note') out.push(m.text);
      else if (m.kind === 'last' && m.text) out.push(`前回の会話：${m.text}`);
    }
    return out.slice(-15);
  }
  function habitText(counts) {
    const total = Object.values(counts || {}).reduce((a, b) => a + b, 0);
    const [top, n] = Object.entries(counts || {}).sort((a, b) => b[1] - a[1])[0] || [];
    return total >= 5 && n / total >= 0.5 ? `${PART_LABEL[top]}によく片づける` : '';
  }

  // ---------- 言いかけ：聞き取った文が話の途中で終わっていたら、答えずに続きを聞く ----------
  // 声の AI の部品 LiveKit は、聞き取った文から「話し終わったか」を見て、終わっていなさそうなら待ちを延ばす（英語用なので、日本語は語尾の決まりで作る）。
  // 「〜して」「〜を追加して」のような頼みごと（命令の文型に当たるもの・覚えて・忘れて など）は言い終わりとみなす
  const ASK_END = /(覚えて|忘れて|呼んで|待って|やめて|止めて|教えて|聞いて|見せて|読んで|やって|やらせて|回して|任せて|足して|入れて|消して|戻して|動かして|して|といて|ておいて|どいて)$/;
  const FILLER = /(えっと|えーと|えーっと|ええと|あのー?|あの〜|うーん|んーと|それで|でね)$/;
  function unfinished(text, isCommand = () => false) {
    const t = String(text || '').trim();
    if (!t || t.length > 80 || END.test(t)) return false;
    if (/[、,…]$/.test(t)) return true;
    const u = t.replace(/[。．！？!?\s]+$/, '');
    if (FILLER.test(u)) return true;
    if (!/(けど|けれど|けども|から|ので|て|んで|いで)$/.test(u)) return false; // 「あとで」「これで」のような「で」は言い終わり
    return !ASK_END.test(u) && !isCommand(u);
  }
  // 言いかけと続きをつなぐ（最後の「えっと」「、」は落とす）
  function joinHeard(a, b) {
    const head = String(a || '').trim().replace(/[、,…\s]+$/, '').replace(FILLER, '').replace(/[、,…\s]+$/, '');
    return head ? (head + (/[てでどらの]$/.test(head) ? '、' : '') + String(b || '').trim()) : String(b || '').trim();
  }

  // ---------- 合図の音（B4）。「ポン」＝聞くよ、「ポロン」＝聞いたよ。音は WebAudio でその場で作る（ファイルも通信も無し） ----------
  // Google の手引き（Earcons）：合図の音は意味がすぐ分かるものを少しだけ、短く、いつも同じ場面で
  const cueLog = []; // 検査用（鳴らした合図の種類。最新 10 個）
  let cueAc = null;
  function playCue(kind) {
    cueLog.push(kind); if (cueLog.length > 10) cueLog.shift();
    try { g.navigator?.vibrate?.(kind === 'start' ? 15 : [10, 60, 10]); } catch { /* 震えない端末もある */ }
    try {
      const AC = g.AudioContext || g.webkitAudioContext;
      if (!AC) return Promise.resolve();
      cueAc = cueAc || new AC();
      if (cueAc.state === 'suspended') cueAc.resume().catch(() => {});
      const t0 = cueAc.currentTime + 0.01;
      const notes = kind === 'start' ? [[880, 0]] : [[660, 0], [990, 0.09]];
      for (const [f, d] of notes) {
        const o = cueAc.createOscillator(), v = cueAc.createGain();
        o.type = 'sine'; o.frequency.value = f;
        v.gain.setValueAtTime(0.0001, t0 + d);
        v.gain.exponentialRampToValueAtTime(0.12, t0 + d + 0.012);
        v.gain.exponentialRampToValueAtTime(0.0001, t0 + d + 0.14);
        o.connect(v); v.connect(cueAc.destination);
        o.start(t0 + d); o.stop(t0 + d + 0.16);
      }
    } catch { /* 鳴らなくても会話は続ける */ }
    // 聞き始めは音が鳴り終わってからマイクを開く（自分の合図を声と取り違えない）
    return new Promise((r) => setTimeout(r, kind === 'start' ? 180 : 0));
  }

  // ---------- 前回の続き（C1）。会話の終わりに一言まとめて覚え、次は「昨日の〇〇、どうなった？」から ----------
  const md = (d) => `${d.getMonth() + 1}/${d.getDate()}`;
  function dayWord(at, now = new Date()) {
    const d = new Date(at); if (isNaN(d)) return 'この前の';
    const day = (x) => Math.floor((new Date(x.getFullYear(), x.getMonth(), x.getDate())) / 864e5);
    const diff = day(now) - day(d);
    return diff <= 0 ? 'さっきの' : diff === 1 ? '昨日の' : 'この前の';
  }

  // 1回ごとの速さ（聞き取り・考え・話し始めの秒数）。会話の中身は入れない。「この端末の診断」で使う（最新 20 回）
  const metrics = [];
  function create(host) {
    let s = settingsOf(host.settings);
    let on = false, speaking = false, stopVad = () => {}, stream = null, session = null, mode = 'script', brain = '', idx = 0, cur = null, doneCount = 0, fails = 0;
    let turns = 0, follow = '', extra = false; // 前回の続き：この会話で話した回数・あとに回したカード・いま聞いているのが前回のカードか
    const cue = (kind) => (s.cue === false ? Promise.resolve() : playCue(kind));
    const pick = picker();
    const log = (who, text) => host.onLine?.(who, text);
    const mood = (m) => host.onMood?.(m);
    const M = host.memory || null;
    const mem = () => { try { return M?.all() || []; } catch { return []; } };
    let lastUnknown = '', lastLearned = '', askForgetAll = false;
    const nameOf = () => mem().find((m) => m.kind === 'name')?.text || '';
    function remember(item) { if (!M) return null; try { const r = M.put(item); lastLearned = r?.id || item.id || ''; return r; } catch { return null; } }
    // 言い直しを覚える：分からなかった言葉のすぐあとに短い答えが来たら、その組を数える
    // 1回目はこの端末の中だけで数え、2回目に初めてデータのリポジトリ（pochi-memory.json）に書く（聞き違えた言葉を1回目から GitHub に残さない）
    function learnWord(word, means) {
      if (!M || !word || word.length > 20) return;
      const id = 'word:' + word;
      const old = mem().find((m) => m.id === id && m.means === means);
      if (!old) {
        let seen = {};
        try { seen = JSON.parse(g.localStorage.getItem('lk.wordSeen')) || {}; } catch { seen = {}; }
        const key = means + ':' + word;
        if (!seen[key]) { seen[key] = 1; try { const ks = Object.keys(seen); if (ks.length > 50) delete seen[ks[0]]; g.localStorage.setItem('lk.wordSeen', JSON.stringify(seen)); } catch { /* なくてよい */ } return; }
        try { delete seen[key]; g.localStorage.setItem('lk.wordSeen', JSON.stringify(seen)); } catch { /* なくてよい */ }
      }
      const count = Math.max(old?.count || 0, old ? 0 : 1) + 1;
      remember({ id, kind: 'word', word, means, count, text: `「${word}」は「${SHORT_LABEL[means]}」のこと` });
      if (count === WORD_MIN) log('sys', `「${word}」は「${SHORT_LABEL[means]}」のことだと覚えました（設定の「ポチが覚えたこと」から消せます）。`);
    }
    function learnHabit() {
      if (!M) return;
      const old = mem().find((m) => m.id === 'habit') || { counts: {} };
      const counts = { ...old.counts, [partOfDay()]: ((old.counts || {})[partOfDay()] || 0) + 1 };
      M.put({ id: 'habit', kind: 'habit', counts, text: habitText(counts) });
    }
    const aliasOf = (t) => mem().find((m) => m.kind === 'word' && (m.count || 0) >= WORD_MIN && g.Voice.norm(m.word) === t)?.means || '';
    // 「覚えて」「〇〇って呼んで」「〇〇を忘れて」「何を覚えてる？」。当てはまらなければ null
    function memoryTalk(text) {
      if (!M) return null;
      const t = g.Voice.norm(text);
      if (askForgetAll) {
        askForgetAll = false;
        if (/^(はい|うん|いいよ|お願い|消して)/.test(t)) { M.forgetAll(); return 'わかった、全部忘れたよ。また一から覚えるね。'; }
        if (/^(いいえ|いや|やめ|だめ)/.test(t)) return 'よかった、そのまま覚えとくね。';
      }
      let m = t.match(/^(.{1,20}?)(って|と)呼んで(ね|ほしい)?$/);
      if (m) { remember({ id: 'name', kind: 'name', text: m[1] }); return `オッケー、これから「${m[1]}」って呼ぶね。`; }
      m = t.match(/^(?:覚えて(?:おいて|ね)?[、。:：\s]*)(.{2,80})$/) || t.match(/^(.{2,80}?)(って|と|を|のこと)?覚えて(おいて|ね|て)?$/);
      if (m && !/^(何|なに)/.test(m[1])) { const r = remember({ kind: 'note', text: m[1] }); return r ? 'わかった、覚えとくね。' : null; }
      if (/^(何|なに)を?覚えて(る|いる|ます)/.test(t) || /^覚えてること/.test(t)) {
        const ls = memoryLines(mem());
        return ls.length ? `覚えてるのは、${ls.slice(0, 5).join('、')}。` + (ls.length > 5 ? `ほか${ls.length - 5}つ。` : '') : 'まだ何も覚えてないよ。「〇〇って覚えて」で教えてね。';
      }
      m = t.match(/^(.{0,40}?)を?忘れて(ね|ほしい|いいよ)?$/);
      if (m) {
        const q = m[1];
        if (/^(全部|ぜんぶ|すべて)$/.test(q)) { askForgetAll = true; return 'ほんとに全部忘れていい？ 「はい」か「いいえ」で。'; }
        const all = mem();
        const hit = /^(それ|今の|いまの|さっきの)?$/.test(q) ? all.find((x) => x.id === lastLearned) || all[all.length - 1] : all.find((x) => (x.text || '').includes(q) || (x.word || '') === q);
        if (!hit) return `「${q}」は覚えてないみたい。`;
        M.forget(hit.id); return `「${hit.text || hit.word}」は忘れたよ。`;
      }
      return null;
    }
    const state = (st) => host.onState?.(st);
    // 聞いていないときの様子：耳がある端末は「打つか🎤で」、無い端末は「打って」
    const idle = () => (g.Voice.supported ? 'idle' : 'typing');

    // ---------- 口：出来た文から順に話す（前の文が終わるまで次は待つ）。話している途中で声が来たら止める ----------
    let speech = Promise.resolve(), cut = false, lastOpen = '';
    let turnAt = 0, firstAt = 0;
    async function voiceOut(text) {
      if (!on || cut || !text) return;
      if (turnAt && !firstAt) firstAt = performance.now();
      speaking = true; state('speaking');
      const stopIt = () => { cut = true; g.Voice?.stop ? g.Voice.stop() : g.speechSynthesis?.cancel(); };
      if (s.bargeIn && stream) stopVad = g.LocalAI?.bargeIn(stream, stopIt) || vad(stream, stopIt); // Silero VAD が入っていればそれ、無ければ音の大きさ
      // 文をまとめて声の順番待ちに並べる（1文ずつ止めて読むとカタコトに聞こえる）。割り込まれたら cancel で全部止まる
      try { await (g.Voice.speakAll ? g.Voice.speakAll(text) : g.Voice.speak(text)); } catch { /* 話せなくても会話は続ける */ }
      stopVad(); stopVad = () => {};
      speaking = false;
    }
    const queueSpeech = (text) => (speech = speech.then(() => voiceOut(text)).catch(() => {}));
    // 直前と同じ言い出し（「オッケー、」「いいね、」など）を続けない
    function vary(text) {
      const o = opening(text);
      if (o && o === lastOpen) { const rest = text.slice(o.length).replace(/^[、。！？!?,…\s]+/, ''); if (rest) text = rest; }
      lastOpen = opening(text);
      return text;
    }
    // 画面に出して、声で話しかけられたときは声でも返す（打たれたときは文字だけ。設定で変えられる）
    async function say(text, speak = true) {
      if (!text) return;
      text = vary(casual(text));
      log('ai', text);
      if (speak && on) await queueSpeech(text);
    }

    // AI が通らなかったやりとり（あいさつ・すぐやった命令・整理の報告）も AI の会話の記録に足す（「まずは〇〇から？」に「うん」で通じるように）
    function note(user, said) {
      if (!session || !said) return;
      try {
        if (typeof session.note === 'function') session.note(user, said);
        else if (typeof session.append === 'function') session.append([...(user ? [{ role: 'user', content: user }] : []), { role: 'assistant', content: JSON.stringify({ say: said, action: null }) }])?.catch?.(() => {});
      } catch { /* 足せなくても会話は続ける */ }
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

    // はっきりした命令（voice.js の文型に当たり、カードも1枚に決まる）は AI を待たずにすぐ動かし、結果を一言で返す。
    // カードがあいまい（「〇〇のやつ」など）なら null を返して AI に任せる（AI が無ければ候補を聞き返す）
    // 一言に複数の命令があればまとめてやる（「AとBを済みに、Cは明日」）
    const SKIP = ['unknown', 'pick', 'yes', 'no'];
    const CARD = ['done', 'move', 'delete', 'status', 'agent', 'due'];
    // 題の一部 → 1枚に決まる命令の並び。「AとB」は分けて探す。決まらなければ null
    function expand(cmd) {
      if (!cmd.query || !CARD.includes(cmd.type)) return [cmd];
      const board = host.board();
      if (g.Voice.match(cmd.query, board).length === 1) return [cmd];
      const qs = cmd.query.split(/と|や/).map((x) => x.trim()).filter(Boolean);
      return qs.length > 1 && qs.every((q) => g.Voice.match(q, board).length === 1) ? qs.map((query) => ({ ...cmd, query })) : null;
    }
    function command(text, sure) {
      const parts = g.Voice.split ? g.Voice.split(text) : [text];
      const cmds = parts.map((p) => g.Voice.parse(p, host.laneWords));
      if (!cmds.length || cmds.some((c) => !c || SKIP.includes(c.type))) return null;
      // 1枚に決まらないもの（「〇〇のやつ」など）が入っていたら AI に任せる（AI が無ければアプリが候補を聞き返す）
      const lists = cmds.map(expand);
      if (sure && lists.some((l) => !l)) return null;
      const rs = [];
      cmds.forEach((cmd, i) => {
        if (host.pending()) return; // 前の命令で聞き返しが始まったら、そこで止める
        const list = lists[i];
        const got = list && list.length > 1 ? list.map((c) => host.act(c)) : [cmds.length > 1 ? host.act(cmd) : host.run(text)];
        for (const r of got) {
          rs.push(r);
          if (cmd.type === 'done' && !trouble(r) && !host.pending()) { doneCount++; learnHabit(); mood('happy'); }
          if (cmd.type === 'move' && ['later', 'hold', 'wait'].includes(cmd.lane) && !trouble(r) && !host.pending()) follow = (r.match(/「([^」]+)」/) || [])[1] || follow;
        }
      });
      const r = rs.join(' ');
      if (rs.some(trouble) || host.pending() || cmds.every((c) => c.type === 'read' || c.type === 'status')) return r;
      return pick('ack', PHRASES.ack) + r + (mode !== 'ai' && cur ? ' ' + askCard() : '');
    }

    // AI なし：1枚ずつ聞いて、短い答えで動かす。返事は言い回しを変えながら返す
    function scripted(text) {
      const t = g.Voice.norm(text);
      if (host.pending()) return host.run(text);
      if (/^(ありがとう|ありがと|サンキュー|助かる|助かった)/.test(t)) return pick('thanks', PHRASES.thanks) + ' ' + (cur ? askCard() : '');
      if (/(疲れ|つかれ|しんどい|眠い|ねむい|だるい)/.test(t)) { mood('sad'); return pick('tired', PHRASES.tired); }
      if (cur) {
        const learned = aliasOf(t);
        if (learned) return scripted(learned === 'skip' ? '次' : SHORT_LABEL[learned]);
        const short = [
          [/^(済み|すみ|済んだ|終わった|できた|やった|完了|はい|うん|片づけた|片付けた)$/, 'done'],
          [/^(あとで|後で|いつか|時間があるとき)$/, 'later'],
          [/^(保留|ほりゅう)$/, 'hold'],
          [/^(今やる|いまやる|今)$/, 'now'],
          [/^(次|つぎ|スキップ|パス|飛ばす|とばす|そのまま)$/, 'skip'],
        ].find(([re]) => re.test(t));
        if (short) {
          const k = short[1];
          if (lastUnknown) { learnWord(lastUnknown, k); lastUnknown = ''; }
          let r = '';
          if (k !== 'done') follow = cur.title;
          else if (follow === cur.title) follow = '';
          if (k === 'skip') { if (!extra) idx++; r = pick('skip', PHRASES.skip); }
          else {
            const got = host.act(k === 'done' ? { type: 'done', card: cur } : { type: 'move', card: cur, lane: k });
            if (trouble(got)) return got;
            if (k === 'done') { doneCount++; learnHabit(); mood('happy'); r = pick('done', PHRASES.done) + (doneCount >= 3 ? ` これで${doneCount}枚目！` : ''); }
            else r = pick(k, PHRASES[k]);
            if (!extra && (cur.lane === 'now' || cur.lane === 'next')) idx++; // 列から外れたときは同じ番号のまま（次のカードが繰り上がる）
          }
          extra = false;
          return r + ' ' + askCard();
        }
      }
      const cmd = g.Voice.parse(text, host.laneWords);
      if (cmd && cmd.type !== 'unknown') { lastUnknown = ''; return command(text, false) ?? host.run(text); }
      lastUnknown = cur && t.length <= 20 ? t : '';
      if (!cur) return pick('chat', PHRASES.chat);
      mood('surprise');
      return pick('again', PHRASES.again);
    }

    // 端末の中の AI：ボード（題・列・期限だけ）と言ったことを渡し、JSON の返事を読む。
    // 話しかけられたときは、出来た文から順に読み上げる（遅い端末でも待たされた感じを減らす）。
    // 読み上げた分は画面にも出してあるので、返すのは残りに言うこと（アプリの聞き返しなど）だけ
    async function smart(text, speak, voice) {
      if (host.pending()) return host.run(text);
      const all = host.board();
      const board = all.slice(0, BOARD_MAX).map((c) => `- [${host.lanes[c.lane] || c.lane}] ${c.title}${c.due ? `（${dueShort(c.due)}）` : ''}`).join('\n') + (all.length > BOARD_MAX ? `\n（ほか${all.length - BOARD_MAX}枚）` : '');
      const ask = `いまのボード:\n${board || '（カードなし）'}\n（いまは${new Date().getHours()}時。この会話で済みにしたのは${doneCount}枚。直前のあなたの言い出しは「${lastOpen}」なので、違う言い出しにする）\n\nユーザー: ${text}`;
      let raw = '', said = '', n = 0, first = null; // first: 読み上げた1文目の [元の文, 言い出しを変えた文]
      // 考えているあいだに相槌（すぐに答えが来たときは言わない）
      const filler = voice && speak ? setTimeout(() => { if (!said) queueSpeech(pick('aizuchi', PHRASES.aizuchi)); }, 700) : 0;
      const flush = (final) => {
        if (!speak) return;
        const all = partialSay(raw);
        const ready = final ? all : all.replace(/[^。！？!?\n]*$/, '');
        if (ready.length <= said.length) return;
        for (let part of sentences(ready.slice(said.length))) {
          if (n >= 2) break; // 短く（2文まで）
          if (!first) { const orig = part; part = vary(casual(part)); first = [orig, part]; }
          queueSpeech(part); n++;
        }
        said = ready;
      };
      let out;
      try {
        if (typeof session.promptStreaming === 'function') {
          for await (const ch of session.promptStreaming(ask, { responseConstraint: SCHEMA })) {
            const c = String(ch ?? '');
            raw = raw && c.startsWith(raw) ? c : raw + c; // 前までの分を含めて返すブラウザもある
            flush(false);
          }
          flush(true);
          if (!raw) throw new Error('空');
        } else raw = await session.prompt(ask, { responseConstraint: SCHEMA });
        out = JSON.parse(raw);
      } catch {
        out = partialSay(raw) ? { say: partialSay(raw), action: null } : null;
      } finally { clearTimeout(filler); }
      if (!out) {
        // 2回続けて考えられなかったら、AI なし（決まった返事）に切り替える（同じ失敗を続けない）
        if (++fails >= 2) { mode = 'script'; try { session?.destroy?.(); } catch { /* なくてよい */ } session = null; host.onMode?.(mode, '', 'fail'); log('sys', 'AI がうまく返せなかったので、決まった返事に切り替えたよ。もう一度💬を開くと AI を読み直します。'); return scripted(text); }
        return 'ごめん、うまく考えられなかった。もう一回言って？';
      }
      fails = 0;
      let a = out.action;
      // 消すのは、本人が「消して」などと言ったときだけ（小さい AI の思い違いでカードを消さない。動かすのは「戻す」で戻せるのでそのまま任せる）
      if (a?.type === 'delete' && !/(消|削除|いらない|要らない|捨て)/.test(text)) a = null;
      // Claude に回すのも、本人が「Claude にやらせて」などと頼んだときだけ（話し始めの整理は別。名前が出ただけでは回さない）
      if (a?.type === 'agent' && !/(claude|クロード)\s*(に|へ)\s*(やら|やって|回|まわ|任|まか|頼|たの|お願い)/i.test(text)) a = null;
      let r = '', doneNow = false;
      if (a && typeof a === 'object' && ['add', 'done', 'move', 'delete', 'read', 'undo', 'status', 'agent'].includes(a.type)) {
        const cmd = { type: a.type };
        let bad = '';
        if (a.type === 'add') { if (!a.title) bad = 'なんて題にする？'; else { cmd.title = String(a.title).slice(0, 200); cmd.lane = host.lanes[a.lane] ? a.lane : null; } }
        if (!bad && ['done', 'move', 'delete', 'read', 'status', 'agent'].includes(a.type)) { cmd.query = String(a.query || a.title || ''); if (a.type !== 'read' && !cmd.query) bad = 'どのカード？'; }
        if (!bad && (a.type === 'move' || a.type === 'read')) { if (!host.lanes[a.lane]) bad = 'どの列にする？'; else cmd.lane = a.lane; }
        if (bad) return said ? (out.say ? '' : bad) : (out.say || bad);
        r = host.act(cmd);
        if (a.type === 'done' && !trouble(r)) { doneCount++; learnHabit(); mood('happy'); doneNow = true; }
        if (a.type === 'move' && ['later', 'hold', 'wait'].includes(cmd.lane) && !trouble(r)) follow = (r.match(/「([^」]+)」/) || [])[1] || cmd.query;
      }
      const sayText = short(String(out.say || ''));
      if (doneNow) { /* 済みにできたときは笑顔のまま（「おつかれさま」で悲しい顔にしない） */ }
      else if (/やった|えらい|ナイス|さすが|いいね|すごい/.test(sayText)) mood('happy');
      else if (/おつかれ|無理しない|休んで/.test(sayText)) mood('sad');
      // 動かせた・読めたときは AI の返事、聞き返し（消す確認・候補）や見つからないときはアプリの文を優先
      const appFirst = r && (a?.type === 'status' || host.pending() || /枚。|空です/.test(r)); // 様子・聞き返し・一覧はアプリがカードから答える（AI に作らせない）
      // AI の返事にカードの名前が出てこなければ、何をしたかアプリの文で必ず一言添える（動かしたのに言わない、を無くす）
      const named = (r.match(/「([^」]+)」/) || [])[1];
      const appToo = r && !appFirst && (/見つかりません|保存できない|分かりません/.test(r) || (named && !sayText.includes(named) && !((k) => k && sayText.includes(k))(String(a?.query || a?.title || '').slice(0, 6))));
      if (said) { // もう読み上げ始めている：AI の文は画面に出し、アプリの文は続けて言う
        if (sayText) log('ai', casual(first && sayText.startsWith(first[0]) ? first[1] + sayText.slice(first[0].length) : sayText));
        return appFirst || appToo ? r : '';
      }
      if (appFirst) return r;
      if (appToo) return (sayText ? sayText + ' ' : '') + r;
      return sayText || r || 'うん。';
    }

    // 頭の準備（内蔵 AI か、入れた AI）。会話を開いてすぐは待たせず、うしろで進める
    async function prepare() {
      mode = 'script'; brain = '';
      if (s.ai !== 'off') {
        const st = await aiStatus();
        if (st === 'available' || st === 'downloadable' || st === 'downloading') {
          try {
            if (st !== 'available') log('sys', '端末の中の AI を準備しています（初回だけ、ブラウザが部品を入れます）…');
            session = await LM().create({ ...LANG, initialPrompts: initialPrompts(s, host.lanes, memoryLines(mem())) });
            mode = 'ai'; brain = 'builtin';
          } catch { session = null; }
        }
        // 内蔵 AI が無い端末（スマホなど）は、「AI の部品を入れる」で入れた AI を使う
        // 入れた AI がブラウザに消されていたら、黙って取り直さずに知らせる（取り直すと約0.4GB をモバイル通信で取ることがある）
        if (mode !== 'ai' && g.LocalAI?.llmReady() && g.LocalAI.present) {
          const p = await g.LocalAI.present().catch(() => ({}));
          if (p.lost) log('sys', '入れた AI がこの端末から消えていました（ブラウザが空きを作るために消すことがあります）。もう一度入れるなら「🧠 AI を入れる」を押してね（Wi-Fi のときに）。');
        }
        if (mode !== 'ai' && g.LocalAI?.llmReady()) {
          try {
            log('sys', '端末の中の AI を読み込んでいます（数秒〜数十秒）…');
            session = await g.LocalAI.session(systemPrompt(s, host.lanes, memoryLines(mem())), EXAMPLES);
            if (session) { mode = 'ai'; brain = g.LocalAI.status().cpu ? 'cpu' : 'webllm'; }
          } catch { session = null; log('sys', '端末の中の AI を読み込めなかったので、AI なしで進めます。'); }
        }
      }
      if (!on) return;
      g.LocalAI?.prepareEar(); // Whisper・Silero を入れてあれば先に読み込んでおく
      host.onMode?.(mode, brain, s.ai === 'off' ? 'off' : 'none');
      if (mode !== 'ai') log('sys', s.ai === 'off' ? 'AI は設定で切っています。決まった返事で話します。' : 'いまは AI なし（決まった返事）です。⚙ キャラの設定で AI を入れると、自由に話せます。');
    }
    // 割り込み用のマイク（使えなければ割り込みなし）。声で話すときだけ取る（打つだけなら許可を聞かない）
    async function mic() {
      if (stream || !s.bargeIn || !g.navigator?.mediaDevices?.getUserMedia) return;
      try { stream = await g.navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); } catch { stream = null; }
    }

    // via: 'talk'（💬：あいさつしてから聞く）・'voice'（🎤：すぐ聞く）・'text'（打つ：聞かずに待つ）
    let ready = Promise.resolve();
    async function start(via = 'talk') {
      if (on) return;
      on = true; idx = 0; cur = null; doneCount = 0; fails = 0; cut = false; lastOpen = ''; turns = 0; follow = ''; extra = false; letGo = false;
      state('starting');
      watch(true);
      ready = prepare();
      // ポチの整理（期限すぎを今やるへ・今やるは3枚まで・Claude ができそうなものは Claude へ）。やったことは一言で報告する
      let tidied = null;
      try { tidied = s.tidy !== false && host.tidy ? host.tidy() : null; } catch { tidied = null; }
      if (via === 'hold') { // 🎤の長押し：あいさつも整理の報告の声も出さず、すぐ離すまで聞く
        if (tidied?.text) { log('ai', tidied.text); ready.then(() => note('', tidied.text)); }
        hold(); return;
      }
      if (via === 'voice' || via === 'text') {
        if (tidied?.text) { await say(tidied.text, via === 'voice' && s.reply !== 'text'); ready.then(() => note('', tidied.text)); }
        if (via === 'voice') { await speech; loop(); } else state(idle());
        return;
      }
      await mic();
      await ready;
      if (!on) return;
      const q = host.queue();
      const you = nameOf();
      const hi = pick('greet', PHRASES.greet[partOfDay()]).replace(/[！!]$/, you ? `、${you}！` : '！') + pick('hi', PHRASES.hi, { name: s.name });
      const nowN = host.board().filter((c) => c.lane === 'now').length;
      const back = followUp();
      const first = tidied?.changed ? `${hi} ${tidied.text}` : (back
        ? `${hi} ${back}`
        : mode === 'ai'
          ? `${hi} 今やるは${nowN}枚${q[0] ? `、まずは「${q[0].title}」から？` : '。'}`
          : `${hi} ${askCard()}`) + (tidied?.text && !tidied.changed ? ' ' + tidied.text : '');
      await say(first, s.reply !== 'text');
      note('', first);
      await speech;
      loop();
    }

    // 画面を消した・ほかのアプリに切り替えたら、聞くのと話すのをやめる（裏でマイクを開いたままにしない・空回りさせない）
    const onVis = () => {
      if (!on || !g.document?.hidden) return;
      pause(); cut = true;
      try { g.Voice?.stop ? g.Voice.stop() : g.speechSynthesis?.cancel(); } catch { /* なくてよい */ }
      state(idle());
    };
    function watch(yes) { try { g.document?.[yes ? 'addEventListener' : 'removeEventListener']('visibilitychange', onVis); } catch { /* なくてよい */ } }

    // 聞き続ける（声で話しているあいだ）。2回続けて何も聞こえなければ、いったん止めて🎤を待つ
    let listening = false, gen = 0;
    async function loop() {
      if (listening || !on) return;
      if (!g.Voice.supported) { state('typing'); return; } // 耳が無い端末は文字で（hear() を呼んでもらう）
      listening = true; const my = ++gen; let miss = 0;
      await mic();
      while (on && my === gen) {
        state('listening');
        await cue('start');
        if (!on || my !== gen) break;
        let text; const t0 = performance.now();
        try { text = (await g.Voice.listen()).text; miss = 0; }
        catch (e) {
          if (!on || my !== gen) break;
          const msg = String(e?.message || e || '');
          if (/端末の中だけで聞き取れません|部品|マイク|準備が終わりません/.test(msg)) { log('sys', msg + ' 文字を打って話してね。'); listening = false; state('typing'); return; }
          // 「聞こえなかった」以外のエラーは黙らずに出す（何が起きたか分からないまま止まらないように）
          if (!/聞き取れませんでした/.test(msg)) log('sys', '聞き取れなかった：' + msg);
          if (++miss >= 2) break;
          continue; // 聞き取れなかった → もう一度
        }
        if (!on || my !== gen) break;
        // 言いかけ（〜て・〜けど・えっと）なら、答えずにもう一度聞いてつなげる（1回まで。何も来なければそのまま答える）
        if (s.waitMore !== false && unfinished(text, isCommand)) {
          log('sys', `「${text}」…続けてどうぞ`);
          try { const more = (await g.Voice.listen({ waitMs: 3000 })).text; if (more) text = joinHeard(text, more); } catch { /* 続きが無ければそのまま */ }
          if (!on || my !== gen) break;
        }
        cue('end');
        await hear(text, { voice: true, listenS: (performance.now() - t0) / 1000 });
      }
      if (my === gen) { listening = false; if (on) state(idle()); }
    }
    // 聞くのをやめる（打つほうに切り替えた・🎤をもう一度押した）
    function pause() {
      if (!listening) return;
      listening = false; gen++;
      g.Voice?.cancelListen?.();
    }
    const listen = () => { if (!on) return; if (listening) { pause(); state(idle()); } else { cut = false; loop(); } };
    const isCommand = (t) => { try { const c = g.Voice.parse(t, host.laneWords); return !!c && !SKIP.includes(c.type); } catch { return false; } };

    // 押している間だけ聞く（🎤の長押し）。離したら聞き終わり。考えながらゆっくり話しても途中で切らない
    // Gemini Live は「押して話す」を外したあと、考えながら話すと間で切られるという声が多かった
    let letGo = false, holding = false;
    async function hold() {
      if (!on || holding) return;
      pause(); cut = true; letGo = false;
      try { g.Voice?.stop ? g.Voice.stop() : g.speechSynthesis?.cancel(); } catch { /* なくてよい */ }
      if (!g.Voice.supported) { state('typing'); return; }
      holding = true; listening = true; const my = ++gen;
      state('listening');
      await mic();
      await cue('start');
      let text = '';
      if (on && my === gen && !letGo) {
        try { text = (await g.Voice.listen({ hold: true })).text; }
        catch (e) { const msg = String(e?.message || e || ''); if (on && my === gen && !/聞き取れませんでした/.test(msg)) log('sys', '聞き取れなかった：' + msg); }
      }
      holding = false;
      if (my !== gen || !on) return;
      listening = false;
      if (text) { cue('end'); await hear(text, { voice: true }); }
      if (on && !listening) state(idle());
    }
    function release() { letGo = true; if (holding) g.Voice?.release?.(); }

    // 1回分の言葉を受け取って返事する（声でも、打った文字でも同じ流れ）
    async function hear(text, opts = {}) {
      const voice = opts === true || !!opts?.voice;
      if (!on || !String(text || '').trim()) return;
      if (!voice) { // 打ったら聞くのをやめ、話している途中なら止める（打つ⇄話すを途中で切り替えられる）
        pause(); cut = true;
        try { g.Voice?.stop ? g.Voice.stop() : g.speechSynthesis?.cancel(); } catch { /* なくてよい */ }
        await speech;
      }
      cut = false;
      turnAt = performance.now(); firstAt = 0;
      const speak = s.reply === 'voice' ? true : s.reply === 'text' ? false : voice;
      log('you', text);
      turns++;
      if (END.test(g.Voice.norm(text))) { await say(wrapUp() + pick('bye', PHRASES.bye), speak); await speech; stop(); return; }
      state('thinking');
      let r = memoryTalk(text), viaAi = false;
      if (r == null && host.pending()) r = host.run(text);
      if (r == null) r = command(text, true);
      if (r == null) {
        await ready;
        if (!on) return;
        viaAi = mode === 'ai';
        r = viaAi ? await smart(text, speak, voice) : scripted(text);
      }
      const thinkS = (performance.now() - turnAt) / 1000;
      await say(r, speak);
      if (!viaAi) note(text, r);
      const r1 = (x) => Math.round(x * 10) / 10;
      metrics.push({ at: new Date().toISOString().slice(0, 16), via: voice ? '声' : '打つ', brain: viaAi ? brain : mode === 'ai' ? 'すぐやった命令' : 'AI なし', listen_s: opts.listenS ? r1(opts.listenS) : null, think_s: r1(thinkS), speak_s: firstAt ? r1((firstAt - turnAt) / 1000) : null });
      if (metrics.length > 20) metrics.shift();
      turnAt = 0;
      await speech;
      if (on && !listening) state(idle());
    }

    // 終わりの一言まとめ（「今日は3枚。〇〇はまた聞くね」）
    function wrapUp() {
      const f = follow && host.board().some((c) => c.title === follow) ? follow : '';
      return (doneCount ? `今日は${doneCount}枚片づけたね。` : '') + (f && s.followUp !== false ? `「${f}」はまた今度聞くね。` : '');
    }
    // まとめを覚える（話したときだけ。「前回の会話」として次の会話の始めと AI への指示に使う。設定の「ポチが覚えたこと」から消せる）
    function saveLast() {
      if (!M || !turns || s.followUp === false) return;
      const f = follow && host.board().some((c) => c.title === follow) ? follow : '';
      const text = `${md(new Date())}に${doneCount}枚片づけた` + (f ? `。「${f}」はあとに回した` : '');
      remember({ id: 'last', kind: 'last', text, done: doneCount, follow: f });
    }
    // 前回の続きのひとこと。前回あとに回したカードがまだボードにあれば聞く（30分以内に開き直したときは聞かない）
    function followUp() {
      if (s.followUp === false) return '';
      const last = mem().find((m) => m.id === 'last');
      if (!last?.follow || !last.at || Date.now() - Date.parse(last.at) < 30 * 60e3) return '';
      const q = host.queue(), i = q.findIndex((c) => c.title === last.follow);
      const c = i >= 0 ? q[i] : host.card?.(last.follow);
      if (!c) return '';
      if (i >= 0) { idx = i; cur = c; extra = false; } else { cur = c; extra = true; }
      follow = last.follow;
      return `${dayWord(last.at)}「${c.title}」、どうなった？` + (mode === 'ai' ? '' : ' 済み？あとで？');
    }

    function stop() {
      if (on) { try { saveLast(); } catch { /* 覚えられなくても閉じる */ } }
      on = false; listening = false; gen++; holding = false;
      try { cueAc?.close(); } catch { /* なくてよい */ } cueAc = null;
      watch(false);
      try { g.Voice?.cancelListen?.(); } catch { /* なくてよい */ }
      try { g.Voice?.stop ? g.Voice.stop() : g.speechSynthesis?.cancel(); } catch { /* なくてよい */ }
      stopVad();
      stream?.getTracks().forEach((t) => t.stop()); stream = null;
      try { session?.destroy?.(); } catch { /* なくてよい */ }
      session = null;
      state('off');
    }

    return { start, stop, hear, listen, hold, release, get holding() { return holding; }, get on() { return on; }, get speaking() { return speaking; }, get listening() { return listening; }, set settings(v) { s = settingsOf(v); } };
  }

  g.Talk = { metrics, cueLog, PERSONA, settingsOf, unfinished, joinHeard, create, avatarSvg, DEFAULTS, aiStatus, systemPrompt, initialPrompts, EXAMPLES, PHRASES, picker, partOfDay, dueWords, dueShort, BOARD_MAX, sentences, short, opening, casual, partialSay, memoryLines, habitText, WORD_MIN };
})(typeof window !== 'undefined' ? window : globalThis);

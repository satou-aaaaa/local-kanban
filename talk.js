// 会話モード：キャラと声でやりとりしながらカードを片づける。すべて端末の中で動く（声も会話も外に出さない）。外部ライブラリなし。
//   耳  … voice.js の Voice.listen()（localai.js で入れた Whisper の1本だけ）。入れていなければ文字を打って話す
//   頭  … ふだんは AI なし（決まった言い方と返事）。⚙ で AI を入れた人だけ、Chrome の内蔵 AI（Gemini Nano）か localai.js の WebLLM
//   （2026-10-21 satouさん「減らして固める」：部品の組み合わせが多いほど壊れたので、AI と気持ちの声は入れたい人だけ）
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
    ai: 'off', // off = 使わない（標準）/ auto = 端末の中の AI（内蔵 AI か、入れた WebLLM）があれば使う
    endWait: 'normal', // 話し終わりの待ち時間（Whisper の耳）：normal = 0.7秒 / slow = 1.2秒（間をとって話す人向け）
    cue: true, // 聞き始め「ポン」・聞き終わり「ポロン」の音と短い振動（音は端末の中で作る。ファイルも通信も無し）
    waitMore: true, // 言いかけ（〜て・〜けど・〜から・えっと）で終わったら、答えずに続きを聞いてつなげる
    streak: false, // 「今週は4日片づけたね」と週で数える（1日休んでも切れない）。気持ちに関わるので最初は切
    moodAsk: false, // 1日1回だけ今日の調子を聞き、しんどい日はすすめる枚数を減らす。毎日聞かれるのが嫌かもしれないので最初は切
    corner: true, // ボードの隅に小さなポチを出す（しゃべらない。済みにすると跳ねる・夜は眠そう・押すと会話）
    followUp: true, // 会話の終わりに一言まとめて覚え、次に開いたとき「昨日の〇〇、どうなった？」から始める
  };
  const settingsOf = (v) => { const s = { ...DEFAULTS, ...(v || {}) }; if (!s.persona || OLD_PERSONA.includes(s.persona)) s.persona = PERSONA.about; return s; };
  const END = /^(終わり|おわり|おしまい|終わる|またね|バイバイ|ばいばい|ストップ|やめる|もういい|おやすみ|おやすみなさい)$/; // おやすみでも終わる（10/21）

  // ---------- 返事の言い回し（AI なしのとき）。同じ文を続けて言わないように、毎回この中から選ぶ ----------
  // 人の会話のように言い回しを変えると機械っぽさが減る（Google の会話デザインの指針「Randomize prompts」）
  // あいさつに呼び方を入れる。終わりが「！」でも「。」でも入れる（「夜もおつかれさま。」で呼び方が抜けていた。10/20）
  const withName = (hi, you) => { const m = /[！!。]$/.exec(hi); const end = m ? (m[0] === '!' ? '！' : m[0]) : '！'; const body = m ? hi.slice(0, -1) : hi; return body + (you ? `、${you}` : '') + end; };
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
    thanks: ['どういたしまして！', 'いえいえ、こっちこそ！', 'どういたしまして。いつでも言ってね。'],
    tired: ['おつかれ。ひと息ついてもいいよ。', '無理しないでね。今日はここまででも大丈夫だよ。', 'がんばってるね。休んでも大丈夫だよ。', 'おつかれ。ぼくもおやつ休憩したいな。ひと息つこ？'],
    bye: ['オッケー、またね！', 'おつかれさま！また呼んでね。', '今日もありがとう、またね！'],
  };
  // ---------- 状態の表（減らして固める・2段目。2026-10-22 satouさん「それで進めて」） ----------
  // ポチがいま何を待っているか（状態）× 短い答え → すること。押して答えるボタンも同じ表から出す（ボタンと言葉がずれない）。
  // 表の言葉は全部 qa/run.mjs の「状態の表」で1つずつ試す。AI のあるなしにかかわらず、この表に当たる答えは同じに動く。
  // 会話の設計は「状態ごとに受ける答えを決め、全部をサンプル会話で確かめる」（Google Conversation design「Write sample dialogs」・XState の状態機械）
  //   btn: ボタンの字（無ければボタンに出さない）／words: 受ける言い方（norm した後で全体が一致）／does: すること／loose: 聞いていないときも受ける
  const TABLE = {
    // カードのことを聞いた直後（「〇〇。済み？あとで？」）
    card: [
      { btn: '済み', words: ['済み', 'すみ', '済んだ', '完了', '片づけた', '片付けた'], does: 'done', loose: true },
      { words: ['終わった', 'できた', 'やった', 'はい', 'うん'], does: 'done' }, // 聞いた直後だけ（雑談の「うん」でカードを済みにしない。10/21）
      { btn: 'あとで', words: ['あとで', '後で', 'いつか', '時間があるとき'], does: 'later', loose: true },
      { btn: '保留', words: ['保留', 'ほりゅう'], does: 'hold', loose: true },
      { words: ['今やる', 'いまやる', '今'], does: 'now', loose: true },
      { btn: '次', words: ['次', 'つぎ', 'スキップ', 'パス', '飛ばす', 'とばす', 'そのまま'], does: 'skip', loose: true },
    ],
    // 前回あとに回したカードを聞いた直後（「昨日の〇〇、どうなった？ 済み？あとで？」）。断られたらしばらく聞かない
    // 「もういい」は会話の終わり（END）なので、ここのボタンにしない（押すと会話が閉じてしまう）
    follow: [
      { btn: '済み', words: ['済み', 'すみ', '済んだ', '完了', '片づけた', '片付けた', '終わった', 'できた'], does: 'done' },
      { btn: 'あとで', words: ['あとで', '後で', 'まだ', 'いつか'], does: 'later' },
      { btn: '保留', words: ['保留', 'ほりゅう'], does: 'hold' },
      { btn: 'その話はいい', words: ['いい', 'いいよ', 'いいって', '大丈夫', 'だいじょうぶ', 'ほっといて', 'その話はいい', 'その話はいいよ', '聞かないで', '知らない', '別に'], does: 'drop' },
    ],
    // 雑談が続いたあとの「カードも見る？」
    offer: [
      { btn: '見る', words: ['見る', 'みる', 'うん', 'はい', 'いいよ', 'そうしよ', 'そうする', 'オッケー', 'おっけー', 'ok'], does: 'cards' },
      { btn: '今はいい', words: ['今はいい', 'いまはいい', 'いや', 'ううん', 'あとで', 'まだ', 'いい', 'やめ', 'やめとく'], does: 'notnow' } // 「やめる」は会話の終わり（END）,
    ],
    // 今日の調子（設定で入れたときだけ・1日1回）
    mood: [
      { btn: '元気', words: ['元気', 'げんき', '絶好調', 'いい感じ', 'ばっちり'], does: 'mood3' },
      { btn: 'ふつう', words: ['ふつう', '普通', 'まあまあ', 'そこそこ'], does: 'mood2' },
      { btn: 'しんどい', words: ['しんどい', '疲れ', 'つかれ', 'だるい', '眠い', 'ねむい', 'だめ', 'ダメ', 'いまいち'], does: 'mood1' },
    ],
    // 「全部忘れて」の確かめ
    forgetAll: [
      // ボタンは「はい・いいえ」でなく、することの名前（戻せない操作なので押し間違えにくく。v47 の点検）
      { btn: '忘れる', words: ['忘れる', 'わすれる', 'はい', 'うん', 'いいよ', 'お願い', '消して'], does: 'forget' },
      { btn: 'やめておく', words: ['やめておく', 'いいえ', 'いや', 'やめ', 'やめて', 'だめ'], does: 'keep' },
    ],
  };
  // 言い方の当て方：whole＝全体が一致（標準）／prefix＝言い始めが一致（「うん、見る」「やめとく」）／contains＝どこかに入っている（「元気だよ」）
  const MATCH = { offer: 'prefix', forgetAll: 'prefix', mood: 'contains' };
  // 状態 st で、言われた t（norm 済み。終わりの「。」「！」は落とす）に当たる行。聞いていない（loose）ときは loose の行だけ
  function rowOf(st, t, loose = false) {
    const x = String(t || '').replace(/[。．！!、]+$/, '').toLowerCase();
    const how = MATCH[st] || 'whole';
    const hit = (w) => { w = w.toLowerCase(); return how === 'prefix' ? x.startsWith(w) : how === 'contains' ? x.includes(w) : x === w; };
    return (TABLE[st] || []).find((r) => (!loose || r.loose) && r.words.some(hit)) || null;
  }
  // ---------- AI なしの雑談（2026-10-21 satouさん「普通に人間と喋っているように」） ----------
  // 人どうしの会話は「相手の言葉に反応する → 気持ちを受けとめる → ときどき聞き返す」。毎回カードの話に戻さない。
  // 当てはまる話題を上から探し、無ければ相手の言葉をそのまま受けとめて（反射）、続きを聞く。
  // [正規表現, 返事の候補, 顔] の順。返事の {x} は当たった言葉
  const SMALLTALK = [
    [/((元気|げんき|調子どう|調子は|ちょうしどう)[？?]?$|最近どう|さいきんどう|どうしてた)/, ['ぼくは元気だよ！ そっちはどう？', '元気元気！ きみは？', 'しっぽふってるくらい元気！ そっちは？'], 'happy'],
    [/(元気だよ|元気です|まあまあ|ぼちぼち|いい感じ|絶好調|調子いい)/, ['よかった！ いい日になりそうだね。', 'それはなにより！', 'いいね、その調子でいこ。'], 'happy'],
    [/(内定|受かった|通った|合格|採用され)/, ['えっ、すごい！ おめでとう！！', 'やったね！ ほんとにおめでとう！ がんばってたもんね。'], 'happy'],
    [/(落ちた|ダメだった|だめだった|不採用|お祈り)/, ['そっか…くやしいね。でもちゃんと挑戦したのはえらいよ。', 'うん、それはへこむよね。今日は自分をいたわってね。'], 'sad'],
    [/(面接|選考|説明会|エントリー|転職)/, ['{x}かあ、がんばってるね！ どんな感じ？', '{x}、ドキドキするね。準備で手伝えることある？', '{x}のこと、ぼくも応援してるよ。'], 'think'],
    [/(緊張|不安|心配|こわい|怖い|ドキドキ)/, ['ドキドキするよね。何がいちばん気になってる？', 'そっか、不安だよね。ぼくはそばにいるよ。', 'そっか、ドキドキするね。深呼吸、いっしょにしよ。'], 'sad'],
    [/(うれしい|嬉しい|やった[ー！!]|最高|楽しい|たのしい|よかった)/, ['いいね！ 何があったの？', 'わあ、ぼくまでうれしい！', 'それはよかったね！'], 'happy'],
    [/(悲しい|かなしい|つらい|辛い|落ち込|へこ|さみしい|寂しい)/, ['そっか…。話してくれてありがとう。無理しないでね。', 'うん、そういう日もあるよね。ぼくはここにいるよ。'], 'sad'],
    [/(むかつく|ムカつく|イライラ|腹立|はらた)/, ['うわあ、それはイライラするね。何があったの？', 'そりゃ腹立つよね。ちょっと深呼吸しよ。'], 'sad'],
    [/(忙しい|いそがしい|バタバタ|時間がない)/, ['バタバタだね。今日は大事な1枚だけにしよっか？', 'おつかれさま。急ぎのだけ一緒に見よっか。'], 'think'],
    [/(暇|ひま|退屈|たいくつ)/, ['ひまなら、すぐ終わるカードを1枚やっちゃう？ それともおしゃべりする？', 'いいね、のんびりしよ。何か話す？'], 'happy'],
    [/(お腹すいた|おなかすいた|腹減|はらへ|お腹空)/, ['わかる、ぼくもおなかすいた！ 何食べたい？', 'ごはんにしよっか。何にする？'], 'happy'],
    [/(ラーメン|カレー|寿司|すし|パン|ケーキ|おやつ|ごはん|ご飯|ランチ|夕飯|晩ごはん|朝ごはん)/, ['{x}いいなあ！ ぼくも食べたい。', 'おいしそう！ {x}は何が好き？', '{x}かあ、最高だね。'], 'happy'],
    [/(雨|あめ)(だ|が|降|ふ)/, ['雨だね。家でのんびり片づけ日和かも。', '雨かあ。出かけるなら傘わすれないでね。'], null],
    [/(晴れ|いい天気|天気いい)/, ['いい天気だね！ 気持ちいいね。', '晴れるとうれしいね。お散歩したくなる！'], 'happy'],
    [/(暑い|あつい)/, ['暑いね〜。水分とってね。', 'ぼくも舌が出ちゃう暑さ。こまめに休もうね。'], null],
    [/(寒い|さむい)/, ['寒いね。あったかくしてね。', 'ぶるぶる…。温かい飲みものでもどう？'], null],
    [/(仕事|会議|残業|打ち合わせ|勉強)/, ['{x}おつかれさま。どうだった？', '{x}かあ、えらいね。うまくいった？'], 'think'],
    [/(何してた|なにしてた|何してる|なにしてる)/, ['ボードを見ながら待ってたよ。', 'しっぽ振って待ってた！ そっちは？'], 'happy'],
    [/(かわいい|可愛い|いい子|えらい|好き|すき)/, ['えへへ、うれしい！', 'ほんと？ しっぽが止まらないや。'], 'happy'],
    [/(ばか|バカ|うるさい|だまれ|黙れ)/, ['ごめんね。静かにしてほしいときは「今日は静かにして」って言ってね。'], 'sad'],
    [/(だれ|誰|名前|なまえ)/, ['ぼくはポチ。ボードの相棒だよ。', 'ポチだよ。きみのカードを一緒に片づける係！'], 'happy'],
    [/(何ができる|なにができる|何ができるの|できること)/, ['カードを足したり、済みにしたり、移したり、読んだりできるよ。「〇〇を追加」みたいに言ってみて。'], null],
    [/(おやすみ|もう寝る|寝るね|寝ます|ねるね)/, ['おやすみ！ 今日もおつかれさま。', 'ゆっくり休んでね。おやすみ！'], null],
    [/^(うん|うんうん|そう|そうだね|そうそう|たしかに|だよね|なるほど|ほんと|ほんとに)[。！!、]*$/, ['うんうん。', 'だよね。', 'そうそう。'], null],
    [/^(いや|ううん|違う|ちがう|そうじゃない)[。！!、]*$/, ['そっか、ごめんね。', 'あ、ちがったか。'], null],
  ];
  // 相手の言葉を受けとめる（反射）。「〇〇だった」→「〇〇だったんだ」。長すぎる・短すぎるときは使わない
  function reflect(text) {
    const t = String(text || '').trim().replace(/[。！!？?…\s]+$/g, '');
    if (t.length < 3 || t.length > 24 || /[？?]$/.test(String(text || '').trim())) return '';
    if (/(た|だ)$/.test(t)) return `${t}んだ。`;
    if (/(よ|ね|な|わ|さ)$/.test(t)) return `${t.slice(0, -1)}なんだね。`;
    return `${t}、かあ。`;
  }
  const shortT = (t) => (t.length > 18 ? t.slice(0, 16) + '…' : t);
  const FOLLOW = ['それで？', 'もっと聞かせて。', 'どうだった？', 'いいね。', 'うんうん。'];

  // 同じ種類の言い回しを続けて選ばない
  // recent（{ has, add }）を渡すと、日をまたいでも最近言った文を避ける（昨日と同じあいさつにしない）
  function picker(rand = Math.random, recent = null) {
    const last = {};
    return (key, list, vars = {}) => {
      let opts = list.length > 1 ? list.filter((x) => x !== last[key]) : list;
      if (recent && opts.length > 1) { const fresh = opts.filter((x) => !recent.has(x)); if (fresh.length) opts = fresh; }
      const v = opts[Math.floor(rand() * opts.length)] || '';
      last[key] = v;
      try { recent?.add(v); } catch { /* 覚えられなくてもよい */ }
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
  function avatarSvg(kind, color, wear = []) {
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
          <ellipse class="mouth v-a" cx="60" cy="84" rx="8" ry="8" fill="#7f1d1d"/>
          <ellipse class="mouth v-i" cx="60" cy="83" rx="10" ry="3" fill="#7f1d1d"/>
          <ellipse class="mouth v-u" cx="60" cy="84" rx="4" ry="4.5" fill="#7f1d1d"/>
          <ellipse class="mouth v-e" cx="60" cy="83" rx="9" ry="5" fill="#7f1d1d"/>
          <ellipse class="mouth v-o" cx="60" cy="85" rx="6" ry="7.5" fill="#7f1d1d"/>
        </g>
      </g>
      ${wearSvg(wear)}
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
      '雑談や気持ちの話にも、人どうしのように付き合う。相手の言葉を拾って返し、ときどき「それで？」「どうだった？」と聞く。毎回カードの話に戻さない（雑談が4往復ほど続いたら、軽く戻してよい）。気持ちの話（緊張・落ち込み・疲れ）の直後と、疲れたと言われた日は、カードに戻そうとしない。済みにしたらほめる。',
      'ボードの中身（今やるの枚数・期限が近いカード）に触れてよい。ボードに無いカードや知らないことは作らない。分からなければ聞き返す。',
      `列は ${Object.entries(lanes).map(([k, v]) => `${k}=${v}`).join('、')}。`,
      'カードを動かすときだけ action を入れる。add は title、done・move・delete・read・status・agent は query（カードの題の一部）、move・add・read は lane。消すときは delete（すぐ消える。「戻して」で戻せる）。「〇〇はどうなった？」と様子を聞かれたら status（アプリが列・今の段・最後の記録を答える）。「Claude にやらせて」と言われたら agent（Claude が進める列へ回す）。何もしないときは action は null。',
      '出力は JSON {"say": 文, "action": null または {"type", "title", "query", "lane"}} だけ。',
    ].join('\n');
  }
  // 返事の見本（few-shot）。言い回し・長さ・JSON の形をこれに寄せる。カードの題は作り話。キャラ設定書（PERSONA）に合わせて書く
  // 20個から毎回いくつかを選んで入れ替える（同じ見本ばかりだと毎回同じ形で返す。Google の手引きも「先に見本の会話を書く」）。
  // 端末の小さい AI（CPU）は指示が長いと遅くなるので少なめにする
  const B = (lines, user) => `いまのボード:\n${lines.map(([l, t]) => `- [${l}] ${t}`).join('\n')}\n\nユーザー: ${user}`;
  const EXAMPLES_ALL = [
    [B([['今やる', '牛乳を買う'], ['次にやる', '部屋の片づけ']], '牛乳買ってきた'), { say: 'おかえり！ 牛乳、済みにしといたよ。次は部屋の片づけだけど、いけそう？', action: { type: 'done', query: '牛乳を買う' } }],
    [B([['今やる', '部屋の片づけ']], 'なんか疲れたなあ'), { say: 'おつかれさま。今日はけっこうがんばったもんね。片づけは明日にまわしとく？', action: null }],
    [B([['今やる', '部屋の片づけ']], 'うん、そうして'), { say: 'オッケー、あとでに入れたよ。ゆっくり休んでね。', action: { type: 'move', query: '部屋の片づけ', lane: 'later' } }],
    [B([['次にやる', '部屋の片づけ']], '歯医者の予約するの忘れないようにしたい'), { say: 'それ大事だね。「歯医者の予約」を今やるに足したよ。', action: { type: 'add', title: '歯医者の予約', lane: 'now' } }],
    [B([['今やる', '請求書を出す'], ['次にやる', '本を返す']], '今日何やればいい？'), { say: 'まずは請求書を出すのからどう？ 今やるに入ってるし、期限も近いよ。', action: null }],
    [B([['今やる', '本を返す']], '本返してきたよ'), { say: 'やったね！ 本を返すのは済みにしたよ。', action: { type: 'done', query: '本を返す' } }],
    [B([['次にやる', '部屋の片づけ']], '片づけは週末にする'), { say: 'りょうかい、時間があるときに回しといたよ。週末がんばろ！', action: { type: 'move', query: '部屋の片づけ', lane: 'later' } }],
    [B([['今やる', '企画書の下書き']], '企画書の下書き、Claude にやらせて'), { say: 'オッケー、企画書の下書きは Claude に回したよ。', action: { type: 'agent', query: '企画書の下書き' } }],
    [B([['今やる', '請求書を出す'], ['今やる', '本を返す']], '今やるを読んで'), { say: 'よし、今やるを読むね。', action: { type: 'read', lane: 'now' } }],
    [B([['あとで', '本を返す']], 'あ、間違えた。戻して'), { say: 'オッケー、戻したよ。', action: { type: 'undo' } }],
    [B([['今やる', '洗濯']], 'おなかすいた'), { say: 'わかる、ぼくもおやつ食べたい。何食べる？', action: null }],
    [B([['Claude', '旅行先の比較']], '旅行先の比較どうなってる？'), { say: 'ちょっと見てみるね。', action: { type: 'status', query: '旅行先の比較' } }],
    [B([['今やる', '洗濯']], 'やっと終わった！'), { say: 'やったね、えらい！ 洗濯のこと？ なら済みにしとくよ。', action: { type: 'done', query: '洗濯' } }],
    [B([['今やる', '洗濯']], '洗濯は保留で'), { say: '了解、洗濯は保留にしたよ。', action: { type: 'move', query: '洗濯', lane: 'hold' } }],
    [B([['今やる', '請求書を出す'], ['今やる', '本を返す']], 'うーん、何からやろう'), { say: 'じゃあ、すぐ終わりそうな本を返すのからにしよっか。', action: null }],
    [B([['今やる', '洗濯']], '今日はもういいや'), { say: 'おつかれさま！ 今日はここまでにしよ。また明日ね。', action: null }],
    [B([['次にやる', '本を返す']], '電話の折り返しを今やるに入れて'), { say: '「電話の折り返し」を今やるに入れたよ。', action: { type: 'add', title: '電話の折り返し', lane: 'now' } }],
    [B([['次にやる', '歯医者の予約']], '歯医者のカード、もういらない。消して'), { say: 'わかった、歯医者の予約は消したよ。', action: { type: 'delete', query: '歯医者の予約' } }],
    [B([['今やる', '洗濯']], '雨だね'), { say: 'ほんとだ、けっこう降ってるね。出かける予定あった？', action: null }],
    [B([['今やる', '洗濯']], '明日面接なんだよね、緊張する'), { say: 'そっか、緊張するよね。どんな会社なの？', action: null }],
    [B([['今やる', '洗濯']], '昨日ラーメン食べた'), { say: 'いいなあ！ 何ラーメン？', action: null }],
    [B([['今やる', '会議資料をつくる']], '会議資料できた'), { say: 'さすが！ 会議資料、済みにしたよ。', action: { type: 'done', query: '会議資料をつくる' } }],
  ].map(([u, a]) => [u, JSON.stringify(a)]);
  const EXAMPLES = EXAMPLES_ALL.slice(0, 4); // 前の版と同じ4つ（検査・古い呼び出し用）
  // n 個えらぶ：動かす見本と、動かさない（会話だけの）見本を半分ずつ
  function pickExamples(n = 4, rand = Math.random) {
    const shuf = (l) => l.map((x) => [rand(), x]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
    const act = shuf(EXAMPLES_ALL.filter(([, a]) => !a.includes('"action":null')));
    const talk = shuf(EXAMPLES_ALL.filter(([, a]) => a.includes('"action":null')));
    const k = Math.ceil(n / 2);
    return shuf([...act.slice(0, k), ...talk.slice(0, n - k)]);
  }
  // Prompt API の initialPrompts の形（指示＋見本）
  function initialPrompts(s, lanes, memo = [], ex = EXAMPLES) {
    return [{ role: 'system', content: systemPrompt(s, lanes, memo) }, ...ex.flatMap(([u, a]) => [{ role: 'user', content: u }, { role: 'assistant', content: a }])];
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
      else if (m.kind === 'growth') out.push(growthText(m));
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

  // ---------- 成長（A4）：一緒に済みにした合計で小物と言葉が増える。サボっても下がらない・しおれない ----------
  // たまごっち・Finch のように「お世話で育つ」と愛着がわく。ただし「放っておくと弱る」は仕事の道具には重いので、育つだけにする
  const GROWTH = [
    { at: 10, wear: 'bow', say: 'ねえ見て、10枚記念にリボンつけたよ！' },
    { at: 30, wear: 'scarf', say: '一緒に30枚！ スカーフ巻いてみた。似合う？' },
    { at: 50, wear: 'hat', say: '50枚だよ！ 記念に帽子かぶっちゃった。' },
    { at: 100, wear: 'star', say: '100枚！ 相棒の星をもらったよ。これからもよろしくね。' },
  ];
  function growthOf(total = 0) {
    const got = GROWTH.filter((x) => total >= x.at);
    const next = GROWTH.find((x) => total < x.at) || null;
    return { level: got.length, wear: got.map((x) => x.wear), next: next ? { at: next.at, left: next.at - total } : null };
  }
  const buddyDays = (since, now = new Date()) => { const d = Date.parse(since); return isNaN(d) ? 0 : Math.max(1, Math.floor((now - d) / 864e5) + 1); };
  function growthText(g) { return `一緒に片づけたのは合計${g.total || 0}枚` + (g.since ? `（相棒歴${buddyDays(g.since)}日）` : ''); }
  // 小物（avatarSvg の上に重ねる）。夜の帽子（nightcap）は時間で付ける
  function wearSvg(wear) {
    const w = new Set(wear || []), out = [];
    if (w.has('scarf')) out.push('<g class="wear w-scarf"><path d="M26 98 Q60 114 94 98 L96 106 Q60 122 24 106 Z" fill="#3b82f6"/><path d="M80 104 l6 14 l-10 -2 Z" fill="#2563eb"/></g>');
    if (w.has('bow')) out.push('<g class="wear w-bow"><path d="M84 14 l-12 -8 v16 Z M84 14 l12 -8 v16 Z" fill="#ef4444"/><circle cx="84" cy="14" r="4" fill="#b91c1c"/></g>');
    if (w.has('hat') && !w.has('nightcap')) out.push('<g class="wear w-hat"><ellipse cx="60" cy="20" rx="30" ry="6" fill="#374151"/><rect x="44" y="0" width="32" height="20" rx="4" fill="#374151"/><rect x="44" y="13" width="32" height="5" fill="#f59e0b"/></g>');
    if (w.has('nightcap')) out.push('<g class="wear w-nightcap"><path d="M30 26 Q56 -6 96 10 Q74 14 88 30 Z" fill="#6366f1"/><circle cx="98" cy="10" r="6" fill="#fff"/></g>');
    if (w.has('muffler') && !w.has('scarf')) out.push('<g class="wear w-muffler"><path d="M26 98 Q60 114 94 98 L96 106 Q60 122 24 106 Z" fill="#dc2626"/><path d="M34 104 l-4 14 l10 -2 Z" fill="#b91c1c"/></g>');
    if (w.has('sakura')) out.push('<g class="wear w-sakura" fill="#f9a8d4">' + [0, 72, 144, 216, 288].map((r) => `<ellipse cx="88" cy="10" rx="4" ry="7" transform="rotate(${r} 88 17)"/>`).join('') + '<circle cx="88" cy="17" r="2.5" fill="#fde047"/></g>');
    if (w.has('pumpkin')) out.push('<g class="wear w-pumpkin"><ellipse cx="96" cy="104" rx="13" ry="10" fill="#f97316"/><path d="M96 94 v-6" stroke="#15803d" stroke-width="3"/><path d="M90 102 l3 -3 l3 3 M98 102 l3 -3 l3 3 M90 108 q6 4 12 0" stroke="#7c2d12" stroke-width="1.6" fill="none"/></g>');
    if (w.has('santa')) out.push('<g class="wear w-santa"><path d="M32 22 Q60 -8 94 16 L100 34 Q60 18 28 30 Z" fill="#dc2626"/><rect x="26" y="22" width="70" height="9" rx="4.5" fill="#fff" transform="rotate(-6 60 26)"/><circle cx="100" cy="36" r="6" fill="#fff"/></g>');
    if (w.has('oni')) out.push('<g class="wear w-oni" fill="#fde047" stroke="#ca8a04" stroke-width="1.5"><path d="M42 20 l4 -16 l6 18 Z"/><path d="M68 22 l6 -18 l4 16 Z"/></g>');
    if (w.has('kagami')) out.push('<g class="wear w-kagami"><ellipse cx="96" cy="110" rx="12" ry="5" fill="#f8fafc" stroke="#cbd5e1"/><ellipse cx="96" cy="104" rx="9" ry="4.5" fill="#f8fafc" stroke="#cbd5e1"/><circle cx="96" cy="98" r="3.5" fill="#fb923c"/></g>');
    if (w.has('uchiwa')) out.push('<g class="wear w-uchiwa"><circle cx="98" cy="96" r="11" fill="#38bdf8"/><circle cx="98" cy="96" r="5" fill="#f472b6"/><path d="M98 107 v12" stroke="#a16207" stroke-width="3"/></g>');
    if (w.has('star')) out.push('<g class="wear w-star"><path d="M22 92 l4 8 9 1 -7 6 2 9 -8 -5 -8 5 2 -9 -7 -6 9 -1 Z" fill="#facc15" stroke="#ca8a04" stroke-width="1.5"/></g>');
    return out.join('');
  }

  // 困ったときの返事をキャラの言葉で、理由つきに（C8）。Apple の手引き：何が起きたかを具体的に。Google：一度のまずい失敗が何十回もの成功を打ち消す
  const KIND = [
    [/「(.+?)」に合うカードが見つかりません。/g, '「$1」のカード、見つからないや。題をもう一回言って？'],
    [/いまは保存できないので(足せ|動かせ)ません。/g, 'いま保存できないみたい（つながってないのかも）。つながったら、もう一回言ってね。'],
    [/いつにするか分かりませんでした。/g, 'いつにする？ 「明日」とか「金曜」って言ってね。'],
    [/「(.+?)」は分かりませんでした。例：[^]*$/g, '「$1」はぼくには分からなかった。「〇〇を追加」とか「〇〇を済み」って言ってみて。'],
    [/いまは聞き返していません。/g, 'いまは何も聞いてないよ。'],
    [/まだつないでいません。/g, 'まだボードにつながってないみたい。'],
  ];
  function kindly(text) { let t = String(text || ''); for (const [re, to] of KIND) t = t.replace(re, to); return t; }
  const ymd = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const lsGet = (k) => { try { return g.localStorage.getItem(k) || ''; } catch { return ''; } };
  const lsSet = (k, v) => { try { v == null ? g.localStorage.removeItem(k) : g.localStorage.setItem(k, v); } catch { /* なくてよい */ } };
  // 「今日は静かにして」（A9）：その日は自分から話しかけない（あいさつ・整理・知らせ・質問をしない。話しかけられたら答える）
  const quietToday = () => lsGet('lk.quietDay') === ymd();
  // 週の始まり（月曜）
  const monday = (d = new Date()) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };

  // 週のふりかえりの文（C7）：日曜の17時から。済みが無い週は言わない（責めない）。一番がんばった＝いちばん前から残っていたカード
  // Finch のふりかえり・Duolingo の週のまとめ。やった量が見えると続けやすい
  function weeklyText(list, now = new Date()) {
    if (now.getDay() !== 0 || now.getHours() < 17) return '';
    const week = list.filter((c) => c.done_at && new Date(c.done_at) >= monday(now));
    if (!week.length) return '';
    const best = week.slice().sort((a, b) => String(a.created || a.done_at).localeCompare(String(b.created || b.done_at)))[0];
    return `今週は${week.length}枚片づけたね。一番がんばったのは「${best.title}」だね。`;
  }
  // 週で数える連続の文（A5）：今週（月曜から）片づけた日の数。1日休んでも途切れない（Duolingo も休んでも続く仕組みを足した）
  function streakText(list, now = new Date()) {
    const days = new Set(list.filter((c) => c.done_at && new Date(c.done_at) >= monday(now)).map((c) => ymd(new Date(c.done_at))));
    return days.size >= 2 ? `今週は${days.size}日片づけたね。いい調子！` : '';
  }

  // ---------- 聞き取りの手がかり（B7） ----------
  // Chrome の音声認識には「この言葉が出やすい」と教える仕組み（phrases。端末の中で聞く設定と一緒に使える）がある。
  // Pixel の Whisper には無いので、聞いた後で、カードの題に近い言葉をその題に直す（少しだけ違うときだけ。4文字以上の題）
  function lev(a, b) {
    const m = a.length, n = b.length; let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) { const cur = [i]; for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; }
    return prev[n];
  }
  function fixTitles(text, titles) {
    let t = String(text || '');
    for (const title of [...new Set(titles || [])].filter((x) => x && x.length >= 4 && x.length <= 30).sort((a, b) => b.length - a.length)) {
      // 題の最後の送り仮名は活用で変わる（「本を返す」→「本を返した」）。語幹があれば直さない。直すときも語幹に寄せ、後ろの活用を残す
      const stem = /[ぁ-ん]$/.test(title) ? title.slice(0, -1) : title;
      if (t.includes(title) || t.includes(stem)) continue;
      const L = title.length, max = Math.floor(L / 4);
      let best = null;
      for (const want of new Set([title, stem])) {
        const W = want.length;
        for (let len = W - 1; len <= W + 1; len++) for (let i = 0; i + len <= t.length; i++) {
          const d = lev(t.slice(i, i + len), want);
          if (d <= max && (!best || d < best.d || (d === best.d && want.length < best.want.length))) best = { i, len, d, want };
        }
      }
      if (best && best.d > 0) t = t.slice(0, best.i) + best.want + t.slice(best.i + best.len);
    }
    return t;
  }

  // ---------- 口の形（A8）：読む文のかなから「あ・い・う・え・お・ん（閉じる）」を並べる ----------
  // VTuber のアバターや Duolingo の Lily のように、口の形を音に合わせると「本当に話している」感じが出る。
  // 漢字は読みが分からないので、文字の番号から決まった母音を当てる（毎回同じ文なら同じ動き）。記号は閉じる
  const KANA_V = (() => {
    const rows = ['あかさたなはまやらわがざだばぱぁゃゎ', 'いきしちにひみりぎじぢびぴぃ', 'うくすつぬふむゆるぐずづぶぷぅゅっゔ', 'えけせてねへめれげぜでべぺぇ', 'おこそとのほもよろをごぞどぼぽぉょ'];
    const m = {};
    rows.forEach((r, i) => { for (const ch of r) { m[ch] = 'aiueo'[i]; m[String.fromCharCode(ch.charCodeAt(0) + 0x60)] = 'aiueo'[i]; } });
    m['ん'] = m['ン'] = 'n';
    return m;
  })();
  function vowels(text) {
    const out = [];
    let prev = 'n';
    for (const ch of String(text || '')) {
      if (KANA_V[ch]) prev = KANA_V[ch];
      else if (ch === 'ー' || ch === '〜') { /* のばす：前と同じ */ }
      else if (/[\p{Script=Han}A-Za-z0-9]/u.test(ch)) prev = 'aiueo'[ch.codePointAt(0) % 5];
      else prev = 'n';
      out.push(prev);
    }
    return out;
  }

  // ---------- 季節と行事（A3） ----------
  // どうぶつの森のように、本体の時計どおりに季節・行事が進むと「今日開く理由」になる。小物とひとことが変わる（その日だけ）
  function seasonOf(d = new Date()) {
    const m = d.getMonth() + 1, day = d.getDate(), md2 = m * 100 + day;
    const ev = md2 >= 101 && md2 <= 107 ? 'newyear' : md2 >= 201 && md2 <= 203 ? 'setsubun' : md2 >= 325 && md2 <= 410 ? 'hanami'
      : md2 >= 720 && md2 <= 820 ? 'natsu' : md2 >= 1025 && md2 <= 1031 ? 'halloween' : md2 >= 1220 && md2 <= 1225 ? 'xmas' : '';
    const wear = { newyear: ['kagami'], setsubun: ['oni'], hanami: ['sakura'], natsu: ['uchiwa'], halloween: ['pumpkin'], xmas: ['santa'] }[ev] || [];
    if (!ev && (m === 12 || m <= 2)) wear.push('muffler');
    return { event: ev, wear, say: SEASON_SAY[ev] || '' };
  }
  const SEASON_SAY = {
    newyear: 'あけましておめでとう！ 今年もよろしくね。', setsubun: '今日は節分だね。鬼は外、カードも外！', hanami: '桜の季節だね。お花見の前にちょっと片づけよっか。',
    natsu: '夏祭りの季節だね。かき氷食べたいなあ。', halloween: 'ハッピーハロウィン！ おかしくれないといたずらしちゃうぞ。', xmas: 'メリークリスマス！ ごほうびのケーキが待ってるよ。',
  };

  // 最近言った文（この端末の localStorage。最新 40 個・3日まで）。会話の中身ではなく、決まった言い回しだけ
  function recentStore(key = 'lk.saidRecent', keep = 40, days = 3) {
    const read = () => { try { return JSON.parse(g.localStorage.getItem(key)) || []; } catch { return []; } };
    return {
      has: (v) => read().some(([t, at]) => t === v && Date.now() - at < days * 864e5),
      add: (v) => { if (!v) return; const l = read().filter(([t]) => t !== v); l.push([v, Date.now()]); try { g.localStorage.setItem(key, JSON.stringify(l.slice(-keep))); } catch { /* なくてよい */ } },
    };
  }

  // 1回ごとの速さ（聞き取り・考え・話し始めの秒数）。会話の中身は入れない。「この端末の診断」で使う（最新 20 回）
  const metrics = [];
  function create(host) {
    let s = settingsOf(host.settings);
    let on = false, speaking = false, stopVad = () => {}, stream = null, session = null, mode = 'script', brain = '', idx = 0, cur = null, doneCount = 0, fails = 0;
    let turns = 0, follow = '', extra = false, chatRun = 0, tired = false, goal = 0, goalSaid = false; // 前回の続き：この会話で話した回数・あとに回したカード・いま聞いているのが前回のカードか
    const cue = (kind) => (s.cue === false ? Promise.resolve() : playCue(kind));
    // 喜び方の大小（A7）：1枚ならにっこり、3枚目・10枚ごとは紙吹雪、ずっと残っていた・期限すぎのカードは「ついに！」で特別に。
    // 毎回同じ紙吹雪だと慣れて効かなくなる（Duolingo は区切りの演出を作り直して続ける人が増えた）
    function joy(card) {
      const old = card && ((card.due && card.due < ymd()) || (card.created && Date.now() - Date.parse(card.created) > 14 * 864e5));
      if (old) { mood('wow'); return 'ついに！ '; }
      mood(doneCount === 3 || doneCount % 10 === 0 ? 'party' : 'happy');
      return '';
    }
    const cardIn = (r) => { const t = (String(r || '').match(/「([^」]+)」/) || [])[1]; return t ? host.card?.(t, true) || null : null; };
    // 今日の調子（C4）で決めた枚数に届いたら、1回だけ「今日の分はおしまい」（check=true は言うかどうかだけ見る）
    function goalLine(check = false) {
      if (!goal || goalSaid || doneCount < goal) return '';
      if (!check) goalSaid = true;
      return ' これで今日の分はおしまい！ 続けてもいいし、休んでもいいよ。';
    }
    const pick = picker(Math.random, recentStore());
    const log = (who, text) => host.onLine?.(who, text);
    const mood = (m) => host.onMood?.(m);
    const M = host.memory || null;
    const mem = () => { try { return M?.all() || []; } catch { return []; } };
    let lastUnknown = '', lastLearned = '', againSaid = false;
    // いまポチが何を待っているか（状態の表 TABLE のどれか。'' は何も聞いていない）。prev はこの番の前の状態
    let ask = '', prev = '';
    // カードは id で持つ（題が直された・同じ題があっても取り違えない。CodeRabbit ops-backup #49）。id の無い写しは題で
    const key = (c) => (c ? c.id || c.title || '' : '');
    const fresh = (c) => { if (!c) return null; if (c.id && host.byId) return host.byId(c.id); return host.card?.(c.title) || null; };
    // 「それ」「これ」「さっきの」が指すカード（最後に話に出たカード）。2026-10-21「それは済みにして」が通じなかった
    let lastRef = null; // { id, title }
    const REF = /^(それ|これ|あれ|そっち|こっち|その(カード|やつ|件)|この(カード|やつ|件)|さっきの(カード|やつ|件)?)(?=は|を|も|が|、|,|\s|$)/;
    const refer = (text) => {
      const t = String(text || '').trim();
      const c = REF.test(t) ? fresh(lastRef) : null;
      if (!c || c.lane === 'done') return t;
      const a = t.replace(REF, c.title), b = a.replace(c.title + 'は', c.title + 'を');
      const ok = (x) => { const c = g.Voice.parse(x, host.laneWords); return c && c.type !== 'unknown' && !/[はを]$/.test(c.query || ''); };
      return ok(a) || !ok(b) ? a : b; // 「それは保留にして」→「〇〇を保留にして」（「〇〇は保留にして」は文型に無い）
    };
    const lastCardIn = (r) => { const ts = [...String(r || '').matchAll(/「([^」]+)」/g)].map((m) => m[1]).reverse(); for (const t of ts) { const c = host.card?.(t, true); if (c) return c; } return null; };
    // 「何からやる？」「今日は何する？」：AI なしでも答える（2026-10-21 通じなかった）
    const WHAT_NOW = /(何から|なにから|どれから|何を|なにを|何|なに)(やる|する|やろう|しよう|やれば|すれば)|今日(は|の)?(予定|やること|何|なに)|やること(は|ある|を教えて)/;
    // 「今日なにする？」：やることを3つにしぼって言う（10/21 新機能10。GTD の「今やること」・Todoist の Today）。「何からやる？」は1枚だけ（今のまま）
    const TODAY3 = /今日.*((何|なに)(する|しよう|やる|やろう|すれば|やれば|したら|やったら|を(する|やる))|やること|予定)/;
    // 問いだけ（「今日の予定にAを足して」のような命令は取らない）
    const isToday3 = (t) => TODAY3.test(t) && !/(何から|なにから|どれから)/.test(t) && !/(足し|入れ|追加|移し|消し|済みに|して$|して[。！!]?$)/.test(t);
    let three = [], pinRef = null;
    const ymdOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    function todayThree(today = new Date()) {
      const d0 = ymdOf(today), d1 = ymdOf(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1));
      const all = host.board().filter((c) => !handled.has(key(c)));
      const cs = all.filter((c) => ['now', 'next', 'later'].includes(c.lane));
      // 予定待ちの列の、今日の予定（面接など）は先に一言（「今日の予定は？」で予定が出ないと「無い」と受け取ってしまう）
      // 予定の日時は端末の時刻で読む（+09:00 付きでも、ほかの時間帯の端末で日がずれない）。早い順に2つ、残りは数だけ
      const at = (c) => { const v = String(c.event_start || ''); if (!v) return null; const d = /^\d{4}-\d\d-\d\d$/.test(v) ? new Date(v + 'T00:00:00') : new Date(v); return Number.isNaN(d.getTime()) ? null : d; };
      const hm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      const ev = all.filter((c) => c.lane === 'wait' && at(c) && ymdOf(at(c)) === d0).sort((a, b) => at(a) - at(b));
      const evLine = ev.length ? '今日の予定は' + ev.slice(0, 2).map((c) => `「${c.title}」${/T\d\d:\d\d/.test(c.event_start) ? `（${hm(at(c))}）` : ''}`).join('と') + (ev.length > 2 ? `、ほか${ev.length - 2}つ` : '') + '。 ' : '';
      const rank = (c) => (c.due && c.due.slice(0, 10) <= d1 ? 0 : c.lane === 'now' ? 1 : c.due ? 2 : c.lane === 'next' ? 3 : 4);
      const n = Math.min(3, goal || 3); // しんどい日に「1枚だけ」と決めたら、すすめるのも1枚
      three = cs.map((c, i) => ({ c, i })).sort((a, b) => rank(a.c) - rank(b.c) || String(a.c.due || '9999').localeCompare(String(b.c.due || '9999')) || a.i - b.i).slice(0, n).map((x) => x.c);
      if (!three.length) {
        const rest = [['wait', '予定待ち'], ['hold', '保留'], ['agent', 'エージェント']].map(([k, w]) => [w, all.filter((c) => c.lane === k).length]).filter(([, k]) => k);
        return evLine + '今やる・次にやるは空っぽだよ。' + (rest.length ? rest.map(([w, k]) => `${w}が${k}枚`).join('、') + 'あるけど、いまは待つだけ。' : 'ゆっくりしよ。');
      }
      const tag = (c) => { const w = dueShort(c.due, today); return w === '期限すぎ' || w === '今日まで' || w === '明日まで' ? `（${w}）` : ''; };
      const nth = ['1つ目', '2つ目', '3つ目'];
      cur = three[0]; pinRef = three[0]; // 「それ」「済み」は1つ目のこと。「2つ目を済みに」も通じる
      if (three.length === 1) return evLine + `今日はこれ。「${three[0].title}」${tag(three[0])}。` + (cs.length > 1 ? ' ほかは明日でいいよ。' : '');
      return evLine + (cs.length > three.length ? `今日は${three.length}つにしぼろう。` : `今日は${three.length}つ。`) + three.map((c, i) => `${nth[i]}「${c.title}」${tag(c)}`).join('、') + '。 まずは1つ目からね。';
    }
    // 「2つ目を済みに」「3番目は保留」：直前に言った3つのうちのそのカード
    const NTH = /^(1|2|3|１|２|３|一|二|三|ひと|ふた|みっ)(つ目|番目|こ目|個目)/;
    const nthRef = (t) => { const m = t.match(NTH); if (!m || !three.length) return t; const k = { 1: 0, '１': 0, 一: 0, ひと: 0, 2: 1, '２': 1, 二: 1, ふた: 1, 3: 2, '３': 2, 三: 2, みっ: 2 }[m[1]]; const c = three[k] && (fresh(three[k]) || three[k]); return c ? t.replace(NTH, c.title) : t; };
    const GREET = /^(おはよう|おはよ|こんにちは|こんにちわ|こんばんは|こんばんわ|やあ|やっほー|ただいま|もしもし|ポチ|ねえ)(ございます)?[!！。、\s]*$/;
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
        if (/^(全部|ぜんぶ|すべて)$/.test(q)) { ask = 'forgetAll'; return `ほんとに全部忘れていい？ 覚えたこと${mem().length}つが消えて、戻せないよ。「忘れる」か「やめておく」で。`; } // 戻せないことを先に言う（v47 の点検）
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
    let speech = Promise.resolve(), cut = false, lastOpen = '', interrupted = '', noisySaid = false;
    let turnAt = 0, firstAt = 0;
    async function voiceOut(text) {
      if (!on || cut || !text) return;
      if (turnAt && !firstAt) firstAt = performance.now();
      speaking = true; state('speaking');
      host.onSpeak?.(text); // 口の形（あいうえお）を合わせるため
      // 割り込まれたら止まる。続けて何も言われなければ「ごめん、続けるね」と言い直す（B8。物音で止まったままにしない）
      const stopIt = () => { cut = true; interrupted = text; g.Voice?.stop ? g.Voice.stop() : g.speechSynthesis?.cancel(); };
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
      text = vary(casual(kindly(text)));
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

    // この会話で片づけた・動かしたカードは、保存が画面に返る前でももう聞かない（同じカードを2回聞いていた。10/21）
    const handled = new Set();
    // 答えを待っている確認（decision があって answer が無い）は、ポチの「済み？」の並びに入れない（済みにすると答えずに片づいてしまう。10/24 定期点検・重さ3）。
    // 確認はカードの選択肢で答える（会話の最初に枚数だけ言う）
    const waitsAnswer = (c) => !!(c && c.decision && !c.answer);
    function nextCard() {
      const q = host.queue().filter((c) => !handled.has(key(c)) && !waitsAnswer(c));
      cur = q[idx] || null;
      return cur;
    }
    function askCard() {
      ask = 'card';
      const c = nextCard();
      if (!c) return pick('empty', PHRASES.empty);
      return (c.due ? dueWords(c.due) + ' ' : '') + pick('ask', PHRASES.ask, { t: c.title }); // 期限は問いの前に（問いで話を終える。10/21）
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
          if (['done', 'move', 'delete', 'agent'].includes(cmd.type) && !trouble(r)) { const c = cardIn(r); if (c) handled.add(key(c)); }
          if (cmd.type === 'done' && !trouble(r) && !host.pending()) { doneCount++; learnHabit(); const j = joy(cardIn(r)); if (j) rs[rs.length - 1] = j + r; if (goalLine(true)) rs.push(goalLine()); }
          if (cmd.type === 'move' && ['later', 'hold', 'wait'].includes(cmd.lane) && !trouble(r) && !host.pending()) follow = (r.match(/「([^」]+)」/) || [])[1] || follow;
        }
      });
      const r = rs.join(' ');
      if (rs.some(trouble) || host.pending() || cmds.every((c) => c.type === 'read' || c.type === 'status')) return r;
      return pick('ack', PHRASES.ack) + r + (mode !== 'ai' && cur ? ' ' + askCard() : '');
    }

    // いま聞いているカード（cur）への短い答え（状態の表の done・later・hold・now・skip）
    function cardAnswer(k) {
      chatRun = 0;
      // 聞いているあいだにボードで直された・消された・済みにされたかもしれないので、id で引き直す
      if (host.byId && cur.id) {
        const c = host.byId(cur.id);
        if (!c || c.lane === 'done') { handled.add(key(cur)); extra = false; return `「${shortT(cur.title)}」は${c ? 'もう済みになってるよ' : 'もうボードに無いみたい'}。 ` + askCard(); }
        cur = c;
      }
      let r = '';
      if (k !== 'done') follow = cur.title;
      else if (follow === cur.title) follow = '';
      if (k === 'skip') { if (!extra) idx++; r = pick('skip', PHRASES.skip); }
      else {
        const got = host.act(k === 'done' ? { type: 'done', card: cur } : { type: 'move', card: cur, lane: k });
        if (trouble(got)) return got;
        handled.add(key(cur));
        if (k === 'done') { doneCount++; learnHabit(); const j = joy(cur); r = j + pick('done', PHRASES.done) + ` 「${shortT(cur.title)}」を済みにしたよ。` + (doneCount >= 3 ? ` これで${doneCount}枚目！` : '') + goalLine(); }
        else r = pick(k, PHRASES[k]);
        // 片づけたカードは handled で並びから外れるので、番号はそのまま（次のカードが繰り上がる）
      }
      extra = false;
      return mode === 'ai' ? r : r + ' ' + askCard(); // AI と話しているときは次のカードは AI に任せる
    }
    // カード以外の問い（カードも見る？・今日の調子・前回の続き・全部忘れる？）への答え。状態の表に当たらなければ null（ふつうに続ける）
    function answer(text) {
      if (!prev || prev === 'card') return null;
      const row = rowOf(prev, g.Voice.norm(text));
      if (!row) return null;
      const d = row.does;
      if (d === 'forget') { try { M?.forgetAll(); } catch { /* なくてよい */ } return 'わかった、全部忘れたよ。また一から覚えるね。'; }
      if (d === 'keep') return 'よかった、そのまま覚えとくね。';
      if (d === 'cards') return pick('okc', ['よし！', 'オッケー！', 'いこっか！']) + ' ' + askCard();
      if (d === 'notnow') { chatRun = -4; return pick('nok', ['オッケー、またあとでね。', 'うん、ゆっくり話そ。']); }
      if (d.startsWith('mood')) {
        const m = +d.slice(4);
        goal = m; lsSet('lk.moodDay', `${ymd()}:${m}`);
        if (m === 1) tired = true;
        const say = m === 3 ? 'いいね！ じゃあ今日は3枚いってみよっか。' : m === 2 ? 'オッケー、今日は2枚くらいでいこう。' : 'そっか、無理しないでね。今日は1枚だけにしよ。';
        return say + (mode !== 'ai' ? ' ' + askCard() : '');
      }
      if (d === 'drop') { // 前回の続きを断られたら、しばらく聞かない（断られた提案は覚えておく）
        lsSet('lk.noFollowUntil', String(Date.now() + 3 * 864e5));
        const last = mem().find((m) => m.id === 'last');
        if (last?.follow && M) { try { M.put({ ...last, follow: '' }); } catch { /* なくてよい */ } }
        follow = ''; if (extra) { cur = null; extra = false; }
        return 'わかった、その話はしばらく聞かないね。' + (mode !== 'ai' ? ' ' + askCard() : '');
      }
      return cur ? cardAnswer(d) : null; // 前回の続きへの「済み」「あとで」「保留」（cur は前回のカード）
    }

    // AI なし：1枚ずつ聞いて、短い答えで動かす。返事は言い回しを変えながら返す
    function scripted(text) {
      const t = g.Voice.norm(text);
      const wasAsked = prev === 'card'; prev = ''; // カードのことを聞いた直後か（「うん」「はい」を「済み」と取るのはこのときだけ）
      const wasAgain = againSaid; againSaid = false;
      if (!wasAgain) lastUnknown = ''; // 覚えるのは「もう一回言って」と聞き返した直後の答えだけ（雑談の言葉を済みと覚えない。10/21）
      if (host.pending()) return host.run(text);
      if (/^(ありがとう|ありがと|サンキュー|助かる|助かった)/.test(t)) return pick('thanks', PHRASES.thanks); // お礼のあとにすぐ次のカードを聞かない（人どうしの会話の間。10/21）
      if (GREET.test(t)) return (/^おはよ/.test(t) ? 'おはよう！' : /^こんにち/.test(t) ? 'こんにちは！' : /^こんばん/.test(t) ? 'こんばんは！' : /^ただいま/.test(t) ? 'おかえり！' : withName(pick('greet', PHRASES.greet[partOfDay()]), '')) + ' ' + pick('howru', ['調子どう？', '今日はどんな日？', '元気してた？']);
      if (WHAT_NOW.test(t)) { const c = nextCard(); if (c) { ask = 'card'; return `${c.due ? dueWords(c.due) + ' ' : ''}まずは「${c.title}」かな。もう済んでる？`; } const r = host.run('今やるを読んで'); return r; }
      if (/(疲れ|つかれ|しんどい|眠い|ねむい|だるい)/.test(t)) { tired = true; mood('sad'); return pick('tired', PHRASES.tired); }
      if (cur) {
        const learned = aliasOf(t);
        if (learned) return scripted(learned === 'skip' ? '次' : SHORT_LABEL[learned]);
        const row = rowOf('card', t, !wasAsked); // 状態の表：聞いた直後は全部の行、聞いていないときは「済み」など言い切りの行だけ
        if (row) { if (lastUnknown) { learnWord(lastUnknown, row.does); lastUnknown = ''; } return cardAnswer(row.does); }
      }
      // カードのことを聞いていないときの「うん」「はい」は相づちとして受ける（聞き返しの「はい」と取らない。10/21）
      if (!wasAsked && /^(うん|はい|そう|そうそう|ええ|うんうん|そうなんだ|なるほど)$/.test(t)) { chatRun++; return pick('aizuchi', ['うんうん。', 'そっか。', 'うん！']); }
      // 「最近どう？」「おやすみ」が命令（探す・済み）と取られていた。雑談の話題に合い、命令の言葉が無ければ雑談として受ける（10/21）
      const chatty = SMALLTALK.some(([re]) => re.test(String(text || '').trim())) && !/(にして|に移|へ移|消して|足して|追加|読んで|見せて|戻して|探して|開いて)/.test(t);
      const cmd = chatty ? null : g.Voice.parse(text, host.laneWords);
      if (cmd && cmd.type !== 'unknown') { lastUnknown = ''; return command(text, false) ?? host.run(text); }
      // 雑談：話題に合う返事 → 無ければ相手の言葉を受けとめて続きを聞く。4往復続いたらそっとカードへ（疲れた日は戻さない）
      const st = smalltalk(text);
      const rf = st || (wasAsked && t.length <= 12) ? '' : reflect(text); // カードを聞いた直後の短い分からない言葉は聞き返す（言い直しから言葉を覚える）
      lastUnknown = cur && !st && t.length <= 20 ? t : '';
      if (st || rf) { chatRun++; const said = st || rf + ' ' + pick('follow', FOLLOW); return said + (/[？?]$/.test(said) ? '' : backToCards()); } // 問いかけたあとに別の問いを重ねない
      if (!cur) return pick('chat', PHRASES.chat);
      if (!wasAsked && t.length <= 12) { chatRun++; lastUnknown = ''; return pick('short', [`「${t}」かあ。それで？`, `へえ、「${t}」。もうちょっと聞かせて。`]); }
      mood('surprise');
      if (lastUnknown) againSaid = true;
      ask = 'card'; // 聞き返しのあとはまだカードの問いが続いている
      return pick('again', PHRASES.again);
    }
    function smalltalk(text) {
      const raw = String(text || '').trim();
      for (const [re, list, face] of SMALLTALK) {
        const m = raw.match(re);
        if (!m) continue;
        if (face) mood(face);
        lastFace = face === 'sad' || /おやすみ/.test(re.source) ? 'sad' : face; // 気持ちの話・おやすみのあとはカードへ戻さない
        if (face === 'sad' && /落ち込|へこ|つらい|辛い|悲し/.test(raw)) tired = true; // 気持ちが沈んでいる日はカードに戻さない
        return pick('st:' + re.source.slice(0, 12), list, { x: m[1] || m[0] });
      }
      return '';
    }
    let lastFace = null;
    function backToCards() {
      if (lastFace === 'sad') { lastFace = null; return ''; } // 気持ちを話した直後にはカードへ戻さない
      if (tired || chatRun < 4 || !cur) return '';
      chatRun = 0; ask = 'offer';
      return ' ' + pick('offer', ['ところで、カードも少し見る？', 'そろそろカードも見てみる？', 'あとでカードも一緒に見よっか？']); // 雑談の返事とカードの問いを一度に言わない。「見る？」と聞いて、うんなら次の番でカードへ（10/21）
    }

    // 端末の中の AI：ボード（題・列・期限だけ）と言ったことを渡し、JSON の返事を読む。
    // 話しかけられたときは、出来た文から順に読み上げる（遅い端末でも待たされた感じを減らす）。
    // 読み上げた分は画面にも出してあるので、返すのは残りに言うこと（アプリの聞き返しなど）だけ
    async function smart(text, speak, voice) {
      if (host.pending()) return host.run(text);
      const all = host.board();
      const board = all.slice(0, BOARD_MAX).map((c) => `- [${host.lanes[c.lane] || c.lane}] ${c.title}${c.due ? `（${dueShort(c.due)}）` : ''}`).join('\n') + (all.length > BOARD_MAX ? `\n（ほか${all.length - BOARD_MAX}枚）` : '');
      if (/(疲れ|つかれ|しんどい|眠い|ねむい|だるい)/.test(text)) tired = true;
      // 雑談の付き合い方（C3）：4往復までは付き合い、5往復目からそっとカードに戻してよい。疲れた日は戻さない（10/21「人と喋っているように」で 3→5 往復目に）
      const chatHint = tired ? '今日は疲れているので、カードの話に戻そうとしない。' : chatRun >= 4 ? '雑談が続いているので、話が一段落したら、そっとカードの話に戻してもよい。' : '';
      const ask = `いまのボード:\n${board || '（カードなし）'}\n（いまは${new Date().getHours()}時。この会話で済みにしたのは${doneCount}枚。直前のあなたの言い出しは「${lastOpen}」なので、違う言い出しにする。${chatHint}）\n\nユーザー: ${text}`;
      let raw = '', said = '', n = 0, first = null; // first: 読み上げた1文目の [元の文, 言い出しを変えた文]
      // 考えているあいだに相槌（すぐに答えが来たときは言わない）
      const filler = voice && speak ? setTimeout(() => { if (!said) queueSpeech(pick('aizuchi', PHRASES.aizuchi)); }, 700) : 0;
      // 5秒たっても考え中なら一言（C9。待っているのが分かるように。顔は考え中のまま首をかしげる）
      const slow = setTimeout(() => { if (!said) { log('sys', 'ちょっと考えさせて…'); if (speak) queueSpeech('ちょっと考えさせて。'); } }, 5000);
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
      } finally { clearTimeout(filler); clearTimeout(slow); }
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
      chatRun = a && typeof a === 'object' ? 0 : chatRun + 1;
      if (a && typeof a === 'object' && ['add', 'done', 'move', 'delete', 'read', 'undo', 'status', 'agent'].includes(a.type)) {
        const cmd = { type: a.type };
        let bad = '';
        if (a.type === 'add') { if (!a.title) bad = 'なんて題にする？'; else { cmd.title = String(a.title).slice(0, 200); cmd.lane = host.lanes[a.lane] ? a.lane : null; } }
        if (!bad && ['done', 'move', 'delete', 'read', 'status', 'agent'].includes(a.type)) { cmd.query = String(a.query || a.title || ''); if (a.type !== 'read' && !cmd.query) bad = 'どのカード？'; }
        if (!bad && (a.type === 'move' || a.type === 'read')) { if (!host.lanes[a.lane]) bad = 'どの列にする？'; else cmd.lane = a.lane; }
        if (bad) return said ? (out.say ? '' : bad) : (out.say || bad);
        r = host.act(cmd);
        if (a.type === 'done' && !trouble(r)) { doneCount++; learnHabit(); joy(cardIn(r)); doneNow = true; }
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
            session = await LM().create({ ...LANG, initialPrompts: initialPrompts(s, host.lanes, memoryLines(mem()), pickExamples(6)) });
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
            session = await g.LocalAI.session(systemPrompt(s, host.lanes, memoryLines(mem())), pickExamples(g.LocalAI.status?.().cpu ? 3 : 4));
            if (session) { mode = 'ai'; brain = g.LocalAI.status().cpu ? 'cpu' : 'webllm'; }
          } catch { session = null; log('sys', '端末の中の AI を読み込めなかったので、AI なしで進めます。'); }
        }
      }
      if (!on) return;
      g.LocalAI?.prepareEar(); // Whisper・Silero を入れてあれば先に読み込んでおく
      host.onMode?.(mode, brain, s.ai === 'off' ? 'off' : 'none');
      // AI を切っているときは上の札（📋 AI なし）だけで足りる。入れたのに使えないときだけ一言（同じことを何度も言わない。v40 の点検）
      if (mode !== 'ai' && s.ai !== 'off') log('sys', 'いまは AI なし（決まった返事）です。⚙ 設定で AI を入れると、自由に話せます。');
    }
    // 割り込み用のマイク（使えなければ割り込みなし）。声で話すときだけ取る（打つだけなら許可を聞かない）
    // 耳は Whisper だけ（同じページの中で聞く）なので、割り込み用のマイクと取り合いにならない
    async function mic() {
      if (stream || !s.bargeIn || !g.navigator?.mediaDevices?.getUserMedia) return;
      try { stream = await g.navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); } catch { stream = null; }
    }

    // via: 'talk'（💬：あいさつしてから聞く）・'voice'（🎤：すぐ聞く）・'text'（打つ：聞かずに待つ）
    let ready = Promise.resolve();
    async function start(via = 'talk') {
      if (on) return;
      on = true; idx = 0; cur = null; doneCount = 0; fails = 0; cut = false; lastOpen = ''; turns = 0; follow = ''; extra = false; letGo = false;
      chatRun = 0; tired = false; goalSaid = false; three = []; pinRef = null; lastRef = null; ask = ''; prev = ''; handled.clear(); // 前の会話の「今日の3つ」を持ち越さない（CodeRabbit ops-backup #49）
      goal = (lsGet('lk.moodDay').startsWith(ymd() + ':') && +lsGet('lk.moodDay').split(':')[1]) || 0;
      const quiet = quietToday();
      state('starting');
      watch(true);
      ready = prepare();
      // ポチの整理（期限すぎを今やるへ・今やるは3枚まで・Claude ができそうなものは Claude へ）。やったことは一言で報告する
      let tidied = null;
      try { tidied = s.tidy !== false && !quiet && host.tidy ? host.tidy() : null; } catch { tidied = null; }
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
      if (quiet) { log('sys', '今日は静かにしてるね（話しかけたら答えます。「もう話していいよ」で戻ります）。'); loop(); return; }
      const q = host.queue();
      const you = nameOf();
      const news = growthNews();
      const hi = withName(pick('greet', PHRASES.greet[partOfDay()]), you) + (news ? ' ' + news : pick('hi', PHRASES.hi, { name: s.name }));
      if (news) mood('happy');
      const nowN = host.board().filter((c) => c.lane === 'now').length;
      const back = followUp();
      const ss = seasonOf();
      const seasonLine = ss.say && lsGet('lk.seasonDay') !== ymd() ? (lsSet('lk.seasonDay', ymd()), ss.say) : '';
      const week = seasonLine || weekly() || streakLine();
      const qMood = !back && !tidied?.changed ? moodQuestion() : '';
      const body = tidied?.changed ? tidied.text : back || qMood || (mode === 'ai'
        ? `今やるは${nowN}枚${q[0] ? `、まずは「${q[0].title}」から？` : '。'}`
        : (() => { const c = nextCard(); if (!c) return askCard(); ask = 'card'; return `今やるは${nowN}枚。まずは「${c.title}」。もう済んでる？`; })());
      if (back && body === back) ask = 'follow'; // 前回の続きを聞いた（済み・あとで・保留・もういい で答えられる）
      // 問いは1回に1つ（あいさつの「今日どれからやる？」と本文の問いを重ねない。10/21）
      const hi1 = /[？?]\s*$/.test(body || '') ? (hi.replace(/\s*[^。！!？?]*[？?]\s*$/, '').trim() || hi) : hi;
      const extraT = tidied?.text && !tidied.changed ? (/[？?]\s*$/.test(body || '') ? tidied.text.replace(/[^。！!]*[？?]/g, '').trim() : tidied.text) : '';
      // 問いはいつも最後に（答えのボタンがどのカードの話か迷わないよう、ほかのカードの一言は問いの前へ。10/22 点検）
      // 問いは別の吹き出しにする（ほかのカードの一言と同じ吹き出しだと、ボタンがどのカードの答えか迷う。v47 の点検・重さ3）
      const isQ = /[？?]\s*$/.test(body || '');
      // 問いのカードと別のカードの一言（「〇〇が止まってるね」）は出さない（2枚の話が並ぶと、ボタンがどちらの答えか迷う。10/24 定期点検・重さ3）
      const extraT2 = isQ && ask === 'card' && cur && extraT && !extraT.includes(cur.title) ? '' : extraT;
      // ボードの「❓ 答える」と同じ言葉で、1枚なら題も言う（v51 の点検・重さ2：どのカードか分からない）
      const asksL = q.filter(waitsAnswer), asks = asksL.length;
      const askLine = mode !== 'ai' && asks ? (asks === 1 ? `「${asksL[0].title}」は答えを待ってるよ（カードで選んでね）。` : `答えるカードが${asks}枚あるよ（カードで選んでね）。`) : '';
      const first = (isQ ? [hi1, week, askLine, extraT2] : [hi1, week, body, askLine, extraT2]).filter(Boolean).join(' ');
      if (first) { await say(first, s.reply !== 'text'); note('', first); }
      if (isQ) { await say(body, s.reply !== 'text'); note('', body); }
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
        let text, got; const t0 = performance.now();
        const resume = interrupted; interrupted = '';
        try {
          got = await g.Voice.listen({ endMs: s.endWait === 'slow' ? 1200 : 700, phrases: hints(), ...(resume ? { waitMs: 2500 } : {}) });
          text = got.text; miss = 0;
          if (got.via === 'ear') text = fixTitles(text, host.board().map((c) => c.title)); // Whisper は聞いた後でカードの題に寄せる（B7）
          // まわりがうるさいときは1回だけ一言（B9）
          if (got.noise > 0.03 && !noisySaid && lsGet('lk.noisyDay') !== ymd()) { noisySaid = true; lsSet('lk.noisyDay', ymd()); log('sys', 'ちょっとにぎやかだね。イヤホンだと聞こえやすいよ。'); }
        }
        catch (e) {
          if (!on || my !== gen) break;
          const msg = String(e?.message || e || '');
          if (!e?.code) g.Voice?.note?.({ via: 'ear', code: msg.slice(0, 60), ms: Math.round(performance.now() - t0) }); // 失敗の理由と秒数だけ残す（聞いた中身は残さない）
          // 割り込まれたのに何も言われなかった（物音だった）→ 続きを話す
          if (resume && /聞き取れませんでした/.test(msg)) { cut = false; await say('ごめん、続けるね。' + resume, true); await speech; continue; }
          if (/端末の中だけで聞き取れません|部品|マイク|準備が終わりません/.test(msg)) { log('sys', msg + ' 文字を打って話してね。'); listening = false; state('typing'); return; }
          // 「聞こえなかった」以外のエラーは黙らずに出す（何が起きたか分からないまま止まらないように）
          if (!/聞き取れませんでした/.test(msg)) log('sys', '聞き取れなかった：' + msg);
          if (++miss >= 2) { log('sys', /聞き取れませんでした/.test(msg) ? '2回続けて聞こえなかったので、🎤を止めたよ。話すときはもう一度押してね。' : '🎤を止めたよ。もう一度押すか、打って話してね。'); break; }
          continue; // 聞き取れなかった → もう一度
        }
        if (!on || my !== gen) break;
        // 割り込みで「待って」「ストップ」なら、止まったまま待つ
        if (resume && /^(待って|まって|ストップ|止まって|とまって|静かに|しずかに)[。！!]?$/.test(g.Voice.norm(text))) { log('you', text); log('ai', 'うん、待ってるね。'); continue; }
        // 言いかけ（〜て・〜けど・えっと）なら、答えずにもう一度聞いてつなげる（1回まで。何も来なければそのまま答える）
        if (s.waitMore !== false && unfinished(text, isCommand)) {
          log('sys', `「${text}」…続けてどうぞ`);
          try { const more = (await g.Voice.listen({ waitMs: 3000, endMs: s.endWait === 'slow' ? 1200 : 700, phrases: hints() })).text; if (more) text = joinHeard(text, more); } catch { /* 続きが無ければそのまま */ }
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
    // 聞き取りの手がかり：カードの題と、短い答えの言葉（Chrome の phrases に渡す。ほかの耳は使わない）
    const hints = () => { try { return [...host.board().slice(0, 30).map((c) => c.title), '済み', 'あとで', '保留', '今やる', '次', '終わり']; } catch { return []; } };
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
        catch (e) {
          const msg = String(e?.message || e || '');
          if (!e?.code) g.Voice?.note?.({ via: 'ear', code: msg.slice(0, 60), ms: 0 });
          if (on && my === gen && !/聞き取れませんでした/.test(msg)) log('sys', '聞き取れなかった：' + msg);
        }
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
      prev = ask; ask = ''; // 前の番で聞いたことへの答えはこの番だけ受ける（状態の表）
      text = refer(nthRef(String(text || '').trim()));
      if (END.test(g.Voice.norm(text))) { await say(wrapUp() + (/おやすみ/.test(text) ? 'おやすみ！ ゆっくり休んでね。' : pick('bye', PHRASES.bye)), speak); await speech; stop(); return; }
      state('thinking');
      let r = manners(text), viaAi = false;
      if (r == null) r = answer(text);
      if (r == null) r = memoryTalk(text);
      if (r == null && host.pending()) r = host.run(text);
      if (r == null && isToday3(g.Voice.norm(text))) r = todayThree(); // AI のあるなしにかかわらず同じ3つ（AI に任せると毎回ちがう）
      if (r == null) r = command(text, true);
      if (r == null) {
        await ready;
        if (!on) return;
        viaAi = mode === 'ai';
        r = viaAi ? await smart(text, speak, voice) : scripted(text);
      }
      const thinkS = (performance.now() - turnAt) / 1000;
      await say(r, speak);
      { const ref = pinRef || lastCardIn(r) || cur; if (ref?.title) lastRef = { id: ref.id || '', title: ref.title }; pinRef = null; }
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
    // 決まりごと（A9・C4・前回の続きを断られたとき）。当てはまらなければ null
    function manners(text) {
      const t = g.Voice.norm(text);
      if (/^(今日は)?(静かにして|黙って|だまって|しゃべらないで|話しかけないで)/.test(t)) {
        lsSet('lk.quietDay', ymd());
        return 'わかった、今日は静かにしてるね。話しかけてくれたら答えるよ。';
      }
      if (/^(もう)?(話していいよ|話して(も)?いいよ|しゃべっていいよ|しゃべってもいいよ|静かにしなくていい)/.test(t)) {
        lsSet('lk.quietDay', null);
        return 'やった、またおしゃべりするね！';
      }
      return null; // 前回の続き・今日の調子への答えは状態の表（answer）で受ける
    }
    // 今日の調子を聞く（C4。設定で入れたときだけ・1日1回だけ）
    function moodQuestion() {
      if (!s.moodAsk || lsGet('lk.moodAskDay') === ymd()) return '';
      lsSet('lk.moodAskDay', ymd()); ask = 'mood';
      return '今日の調子はどう？ 元気・ふつう・しんどい、どれ？';
    }
    // 週のふりかえり（C7）：日曜の夕方から、その週に1回だけ
    function weekly(now = new Date()) {
      const key = ymd(monday(now));
      if (lsGet('lk.weeklyDone') === key) return '';
      const t = weeklyText(host.weekDone?.() || [], now);
      if (t) lsSet('lk.weeklyDone', key);
      return t;
    }
    // 週で数える連続（A5。設定で入れたときだけ・1日1回）
    function streakLine(now = new Date()) {
      if (!s.streak || lsGet('lk.streakDay') === ymd(now)) return '';
      const t = streakText(host.weekDone?.() || [], now);
      if (t) lsSet('lk.streakDay', ymd(now));
      return t;
    }
    // 前回の続きのひとこと。前回あとに回したカードがまだボードにあれば聞く（30分以内に開き直したときは聞かない）
    function followUp() {
      if (s.followUp === false) return '';
      const last = mem().find((m) => m.id === 'last');
      if (!last?.follow || !last.at || Date.now() - Date.parse(last.at) < 30 * 60e3) return '';
      if (Date.now() < +lsGet('lk.noFollowUntil')) return ''; // 断られたらしばらく聞かない
      const q = host.queue(), i = q.findIndex((c) => c.title === last.follow);
      const c = i >= 0 ? q[i] : host.card?.(last.follow);
      if (!c) return '';
      if (i >= 0) { idx = i; cur = c; extra = false; } else { cur = c; extra = true; }
      follow = last.follow;
      return `${dayWord(last.at)}「${c.title}」、どうなった？` + (mode === 'ai' ? '' : ' 済み？あとで？');
    }

    // 成長の知らせ：新しい小物をもらったら、会話を開いたときに1回だけ言う。100枚からは1日1回「相棒歴〇日」
    function growthNews() {
      const gr = mem().find((m) => m.id === 'growth');
      if (!gr) return '';
      const lv = growthOf(gr.total).level;
      if (lv > (gr.shown || 0)) { try { M.put({ ...gr, shown: lv }); } catch { /* 覚えられなくても言う */ } return GROWTH[lv - 1].say; }
      if (lv >= GROWTH.length && gr.since) {
        const day = new Date().toDateString();
        let seen = ''; try { seen = g.localStorage.getItem('lk.buddyDay') || ''; } catch { /* なくてよい */ }
        if (seen !== day) { try { g.localStorage.setItem('lk.buddyDay', day); } catch { /* なくてよい */ } return `相棒歴${buddyDays(gr.since)}日だね。今日もよろしく！`; }
      }
      return '';
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

    // 押して答えるボタンの候補（決まった返事のときだけ。いまの問いに合う言い方を、そのまま hear に渡せる言葉で）
    // 2026-10-22 点検（重さ3）：ポチが聞くのに、毎回打つか話す必要があった
    function choices() {
      if (!on || (ask === 'card' && (!cur || mode === 'ai'))) return [];
      return (TABLE[ask] || []).filter((r) => r.btn).map((r) => r.btn); // ボタンの字は状態の表の btn（表に当たる言葉なので、押すと打ったのと同じに動く）
    }
    return { start, stop, hear, listen, hold, release, get choices() { return choices(); }, get state() { return { ask, card: cur ? cur.title : '' }; }, get holding() { return holding; }, get on() { return on; }, get speaking() { return speaking; }, get listening() { return listening; }, set settings(v) { s = settingsOf(v); } };
  }

  g.Talk = { TABLE, rowOf, withName, metrics, cueLog, recentStore, kindly, quietToday, weeklyText, streakText, fixTitles, seasonOf, vowels, PERSONA, GROWTH, growthOf, growthText, buddyDays, wearSvg, settingsOf, unfinished, joinHeard, create, avatarSvg, DEFAULTS, aiStatus, systemPrompt, initialPrompts, EXAMPLES, EXAMPLES_ALL, pickExamples, PHRASES, picker, partOfDay, dueWords, dueShort, BOARD_MAX, sentences, short, opening, casual, partialSay, memoryLines, habitText, WORD_MIN };
})(typeof window !== 'undefined' ? window : globalThis);

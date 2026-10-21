// アプリだけの機能（claude.ai のボードには無いもの）。ボードの画面（index.html＝ボードの HTML から作る）の上に足す。
//   つなぐ（GitHub・PC のフォルダ・cards.json）・会話（talk.js。打つのも🎤で話すのも同じ欄・同じ流れ。命令もここ）・🎤（voice.js。端末の中の AI の耳も使う）
//   スマホでも開く（QR）・ダウンロードで保存・インストール・URL や共有から足す・オフライン（sw.js）・スマホで左右になぞって列を移る
// ボードの関数（move・remove・say・render・openDetail）と cards をそのまま使う。名前が変わったら、データ側の tools/local_board.py check（ボードとの相性）が止める。
'use strict';
(function () {
  const L = window.LK;
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const now = () => new Date().toISOString();
  const ls = L.ls;
  const LANE_LABEL = Object.fromEntries(L.LANES);
  const WORDS = [['now', '今やる', 'いまやる', '今', 'いま'], ['next', '次にやる', 'つぎにやる', '次', 'つぎ'], ['wait', '予定待ち', 'よていまち'], ['later', '時間があるとき', 'あとで', '後で', 'いつか'], ['hold', '保留', 'ほりゅう'], ['agent', 'エージェントが進行中', 'エージェント'], ['done', '済み', 'すみ', '完了', '終わった']];

  // ---------- 画面に足すもの ----------
  const hb = document.querySelector('header .hbtns') || document.querySelector('header');
  hb.insertAdjacentHTML('afterbegin', `
    <button type="button" id="talkBtn" hidden title="キャラと話して片づける（T）" aria-label="会話モード">💬</button>
    <button type="button" id="reloadBtn" hidden title="最新を読み直す" aria-label="読み直す">↻</button>
    <details id="lkMenu"><summary aria-label="アプリのメニュー">⋯</summary><div class="items">
      <button type="button" data-m="github">GitHub でつなぐ（PC・スマホ）</button>
      <button type="button" data-m="folder">PC のフォルダを開く</button>
      <button type="button" data-m="file">cards.json を選ぶ</button>
      <button type="button" data-m="cmd" disabled>打って話す・命令（Ctrl+K）</button>
      <button type="button" data-m="aiset">🎤と会話・AI の設定</button>
      <button type="button" data-m="phone" hidden>スマホでも開く（QR）</button>
      <button type="button" data-m="download" disabled>ダウンロードで保存</button>
      <button type="button" data-m="notify" hidden>🔔 知らせを受け取る</button>
      <button type="button" data-m="install" hidden>アプリとしてインストール</button>
    </div></details>`);
  document.querySelector('header').insertAdjacentHTML('afterend', `
    <div id="lkBar"><div id="lkStatus" role="status" aria-live="polite">まだつないでいません。</div><div id="talkWhy" hidden></div><div id="lkUnsent" hidden></div></div>
    <section class="lk-intro" id="lkIntro">
      <p><b>Claude が使えないあいだのカンバンです。</b>中身は claude.ai のボードと同じです。データの置き場所を選んでください。</p>
      <div class="choices">
        <button type="button" class="primary" data-m="github">GitHub でつなぐ（PC・スマホ）</button>
        <button type="button" data-m="folder" id="folderChoice">PC のフォルダを開く</button>
        <button type="button" id="reopenBtn" hidden>前回のフォルダを開く</button>
        <button type="button" data-m="file">cards.json を選ぶ</button>
        <button type="button" data-m="aiset">🎤と会話・AI の設定</button>
      </div>
      <ol>
        <li><b>GitHub</b>：非公開リポジトリの <code>local-board/cards.json</code> を読み書きします。初回だけ鍵（トークン）を貼ります。鍵はこの端末の中にだけ保存されます。見た目とキャラの設定も同じリポジトリに置くので、PC とスマホで同じになります。</li>
        <li><b>PC のフォルダ</b>：GitHub Desktop で取ってきたデータのリポジトリのフォルダを選びます（Chrome・Edge の PC だけ）。</li>
        <li><b>cards.json を選ぶ</b>：どのブラウザでも読めます。初めての端末は board/index.html も一緒に選びます。保存は「ダウンロードで保存」です。</li>
      </ol>
      <p class="note">ここでは Claude に届けられないので、答え・コメント・依頼は「まだ届いていない」と残り、Claude が戻ったら届きます。使い方の全文はデータのリポジトリの <code>local-board/README.md</code>。</p>
    </section>
    <input type="file" id="fileInput" accept=".json,application/json,.html,text/html" multiple hidden>`);
  document.body.insertAdjacentHTML('beforeend', `
<dialog id="ghDlg" class="lk" aria-labelledby="ghTtl">
  <form method="dialog" id="ghForm">
    <h3 id="ghTtl">GitHub でつなぐ</h3>
    <div class="lk-row">
      <div><label>持ち主</label><input name="owner" required placeholder="GitHub のユーザー名"></div>
      <div><label>リポジトリ</label><input name="repo" required placeholder="データのある非公開リポジトリ"></div>
      <div><label>ブランチ</label><input name="branch" required placeholder="main"></div>
    </div>
    <label>鍵（fine-grained トークン）</label>
    <input name="token" type="password" autocomplete="off" placeholder="github_pat_…">
    <p class="help"><button type="button" id="ghMake">鍵を作るページを開く</button><br>
    開いたページで「Only select repositories」を押して上のリポジトリを選び、いちばん下の <b>Generate token</b> を押す。出てきた <code>github_pat_…</code> をコピーして上に貼る（名前・期限・権限は入力済み）。<br>
    鍵はこの端末のブラウザの中にだけ保存し、GitHub 以外には送りません。空のまま「つなぐ」を押すと、前に貼った鍵を使います。</p>
    <div class="lk-actions"><button type="button" id="ghForget">この端末の鍵を消す</button>
      <span><button value="cancel" formnovalidate>やめる</button> <button value="ok" class="primary">つなぐ</button></span></div>
  </form>
</dialog>
<dialog id="talkDlg" class="lk" aria-labelledby="talkName">
  <div class="who"><span id="talkAva"></span><div><p id="talkName"></p><div id="talkState"></div><div id="talkMode" class="help"></div><button type="button" id="talkAiGet" hidden>🧠 AI を入れて自由に話す</button><progress id="talkAiProg" max="1" value="0" hidden></progress></div></div>
  <div id="talkLog" aria-live="polite"></div>
  <form id="talkForm"><input id="talkIn" autocomplete="off" aria-label="ポチに話す" placeholder="打っても🎤で話してもOK（例：牛乳を買うを追加・済み・今やるを読んで）"><button type="button" id="talkMic" aria-pressed="false" aria-label="声で話す" title="声で話す（押すと聞き続ける・もう一度押すと止める。長押しなら離すまで聞く）">🎤</button><button class="primary">送る</button></form>
  <div class="lk-actions"><button type="button" id="talkSetBtn">⚙ 設定</button><button type="button" id="talkEnd">終わる</button></div>
</dialog>
<dialog id="talkSet" class="lk" aria-labelledby="talkSetTtl">
  <form method="dialog" id="talkSetForm">
    <h3 id="talkSetTtl">🎤と会話・AI の設定</h3>
    <label>名前</label><input name="name" maxlength="20" required>
    <label>性格と話し方（AI への指示）</label><textarea name="persona" maxlength="600"></textarea>
    <label>アイコン</label>
    <div class="icons" id="talkIcons"></div>
    <label>色</label><input name="color" type="color">
    <label>声（この端末の中の声だけ。ネット経由の声は出しません）</label><select name="voice"></select>
    <div class="vtune"><label>話す速さ <input name="rate" type="range" min="0.7" max="1.5" step="0.05"></label><label>声の高さ <input name="pitch" type="range" min="0.7" max="1.5" step="0.05"></label><button type="button" id="voiceTry">試しに聞く</button></div>
    <label>返事のしかた</label><select name="reply"><option value="match">声で話したら声で、打ったら文字で（おすすめ）</option><option value="voice">打っても声で返す</option><option value="text">いつも文字だけ（声を出さない）</option></select>
    <label class="chk"><input type="checkbox" name="tidy"> 話し始めたら、ポチがボードを自分で整理して報告する（期限すぎを今やるへ・今やるが3枚を超えたら急ぎでないものを1日2枚まで次にやるへ・Claude ができそうなものは Claude へ。「戻す」で戻せる）</label>
    <label class="chk"><input type="checkbox" name="bargeIn"> 話の途中で割り込める（話している間だけマイクの音の大きさを端末の中で見る）</label>
    <label>話し終わりの待ち時間（入れた AI の耳のとき）</label><select name="endWait"><option value="normal">ふつう（0.7秒）</option><option value="slow">ゆっくり（1.2秒。間をとって話す人向け）</option></select>
    <label class="chk"><input type="checkbox" name="cue"> 聞き始め「ポン」・聞き終わり「ポロン」の音と短い振動（音は端末の中で作ります）</label>
    <label class="chk"><input type="checkbox" name="waitMore"> 言いかけ（〜て・〜けど・えっと）で終わったら、答えずに続きを待つ</label>
    <label class="chk"><input type="checkbox" name="streak"> 「今週は4日片づけたね」と週で数えて言う（1日休んでも途切れません）</label>
    <label class="chk"><input type="checkbox" name="moodAsk"> 1日1回だけ今日の調子を聞く（しんどい日はすすめる枚数を減らす。答えなくてもよい）</label>
    <label class="chk"><input type="checkbox" name="corner"> ボードの隅に小さなポチを出す（しゃべりません。済みにすると跳ねる・夜は眠そう・押すと会話）</label>
    <label class="chk"><input type="checkbox" name="followUp"> 前回の続きから話す（終わりに一言まとめて覚え、次に「昨日の〇〇、どうなった？」と聞く）</label>
    <label class="chk"><input type="checkbox" name="ai"> 端末の中の AI（Chrome の内蔵 AI か、下で入れた AI）があれば使う</label>
    <p class="help">声も会話も端末の外に出しません。AI が無い端末では、カードを1枚ずつ読み上げて「済み・あとで・保留・次」で片づけます。この設定は、つないでいればデータのリポジトリにも置き、PC とスマホで同じになります。</p>
    <fieldset id="memBox">
      <legend>ポチが覚えたこと</legend>
      <p class="help">会話で「〇〇って呼んで」「〇〇って覚えて」と言うと覚えます。言い直しが2回あった言葉と、よく片づける時間帯も覚えます。置き場所はデータのリポジトリの local-board/pochi-memory.json だけです（外には送りません）。会話で「〇〇を忘れて」と言っても消せます。</p>
      <ul id="memList"></ul>
      <div class="lk-actions"><button type="button" id="memAll" hidden>全部忘れる</button></div>
    </fieldset>
    <fieldset id="koeBox">
      <legend>気持ちで話し分ける声（端末の中で動かす）</legend>
      <p id="koeStat" class="help"></p>
      <label>声の人</label><select id="koeModel"></select>
      <progress id="koeProg" max="1" value="0" hidden></progress>
      <p id="koeMsg" class="help" aria-live="polite"></p>
      <div class="lk-actions"><button type="button" id="koeGet"></button><button type="button" id="koeTry" hidden>試しに聞く</button><button type="button" id="koeDel" hidden>入れた声を消す</button></div>
      <label class="chk"><input type="checkbox" id="koeOn"> この声で話す（外すと端末の声）</label>
      <p class="help">ポチの表情に合わせて、ふつう・うれしい・悲しい・驚き など7つの気持ちで話します。押したときだけ Hugging Face（huggingface.co）から声のモデル（1人 約250MB）と読みの辞書（約19MB）を1回取ってきて、この端末のブラウザに保存します。話す文は外に出しません。WebGPU が使える端末だけです。PC ではブラウザの保存場所（ふつうは C ドライブ）に入るので、空きが少ないときは入れないでください。</p>
      <details><summary>クレジット</summary><p id="koeCredit" class="help"></p></details>
    </fieldset>
    <fieldset id="aiBox">
      <legend>スマホでも AI と話す（端末の中の AI）</legend>
      <p id="aiStat" class="help"></p>
      <progress id="aiProg" max="1" value="0" hidden></progress>
      <p id="aiMsg" class="help" aria-live="polite"></p>
      <label>頭（AI）の種類 <select id="aiBrain"><option value="qwen">Qwen2.5 0.5B（WebGPU があれば速い。WebGPU のある端末の標準）</option><option value="sarashina">sarashina2.2 0.5B（日本語が得意・CPU で動く・約0.5GB。WebGPU の無い端末の標準）</option></select></label>
      <div class="lk-actions"><button type="button" id="aiGet"></button><button type="button" id="aiDel" hidden>入れた AI を消す</button></div>
      <details><summary>頭の選び方とクレジット</summary><p class="help">sarashina2.2 は日本語の受け答えが Qwen2.5 より得意です（モデルカードの日本語 MT-Bench 4.55 対 2.95）。WebGPU 版が無いので CPU で動かし、返事はゆっくりです。替えると前の頭は消してから入れます。<span id="aiCredit"></span></p></details>
      <p class="help">入れるあいだは画面を消さないようにします。空きが足りなければ取りに行きません。失敗したら途中まで取った分は消します。押したときだけ、モデルのファイルを Hugging Face（huggingface.co）と GitHub（raw.githubusercontent.com）から1回取ってきて、この端末に保存します。以後はオフラインで動きます。取りに行くのはモデルだけで、会話やカードは送りません。大きいので Wi-Fi のときに押してください。</p>
    </fieldset>
    <fieldset id="diagBox">
      <legend>この端末の診断</legend>
      <p class="help">うまく動かないときに押すと（🎤がすぐ止まった日は1日1回、自動でも送ります）、この端末の様子（WebGPU の有無・聞き取りの方式・AI の種類・空き・最近の返事にかかった秒数）を、データのリポジトリの local-board/diagnostics/ に書きます。Claude がそれを読んで直します。会話の中身・カードは入れません。</p>
      <div class="lk-actions"><button type="button" id="diagBtn">この端末の診断を送る</button></div>
      <p id="diagMsg" class="help" aria-live="polite"></p>
    </fieldset>
    <div class="lk-actions"><button type="button" id="talkReset">元に戻す</button>
      <span><button value="cancel" formnovalidate>やめる</button> <button value="ok" class="primary">保存</button></span></div>
  </form>
</dialog>
<dialog id="qrDlg" class="lk" aria-labelledby="qrTtl">
  <h3 id="qrTtl">スマホでも開く</h3>
  <p class="help">スマホのカメラでこの QR を読んで開くと、つなぎ先（持ち主・リポジトリ）が入った状態で始まります。鍵は入っていないので、スマホでも「鍵を作るページを開く」から1つ作って貼ってください。</p>
  <div id="qrBox"></div>
  <div class="lk-actions"><span></span><button type="button" id="qrClose" class="primary">閉じる</button></div>
</dialog>`);

  // 設定の欄と見出し（label）をつなぐ。placeholder だけでは読み上げで名前にならない（WCAG 4.1.2。v35 の点検）
  document.querySelectorAll('dialog.lk label:not(.chk)').forEach((lb, i) => {
    if (lb.control || lb.htmlFor) return;
    const f = lb.nextElementSibling;
    if (f && /^(INPUT|SELECT|TEXTAREA)$/.test(f.tagName)) { if (!f.id) f.id = 'lkf' + i; lb.htmlFor = f.id; }
    else if (f && f.id === 'talkIcons') { lb.id = 'talkIconsTtl'; f.setAttribute('role', 'group'); f.setAttribute('aria-labelledby', lb.id); }
  });

  function setStatus(msg, kind = '') { const s = $('#lkStatus'); s.textContent = msg; s.className = kind; }
  L.onStatus(setStatus);

  // ---------- つないだあと ----------
  window.addEventListener('lk:connected', e => {
    $('#lkIntro').hidden = true;
    $('#reloadBtn').hidden = e.detail.kind === 'file' || e.detail.kind === 'cache';
    $('[data-m=download]').disabled = false; $('[data-m=cmd]').disabled = false;
    $('[data-m=phone]').hidden = e.detail.kind !== 'github';
    $('#talkBtn').hidden = !window.Talk;
    drawWhy();
    setTimeout(runEntry, 0);
  });
  // 💬・🎤が使えないときは、その理由を一言出す（出ないと、AI の設定がどこにあるか分からなくなる）
  function drawWhy() {
    const set = '「⋯ → 🎤と会話・AI の設定」';
    let t = '';
    if (!L.ready) t = `💬（会話）は、つないだあとに出ます。AI の部品は${set}から先に入れられます。`;
    else if (!window.Talk) t = '💬が出ません：会話の部品（talk.js）を読めませんでした。↻ か開き直しを試してね。';
    else if (!window.Voice?.supported) t = window.LocalAI && !window.LocalAI.status().ear
      ? `🎤は、この端末では使えません（端末の中だけで聞き取る仕組みが無い）。${set}で AI の部品を入れると、🎤と声の会話が使えます（💬は打って話せます）。`
      : '🎤は、この端末では使えません（声を端末の中だけで聞き取れない）。💬は打って話せます。';
    $('#talkWhy').textContent = t; $('#talkWhy').hidden = !t;
  }

  // ---------- 命令（声・命令欄・会話・URL） ----------
  let pending = null; // 聞き返し中（候補えらび・消す確認）
  const live = () => cards.filter(c => !c.deleted);
  // 並びはボードと同じ（ボード版48の prioCmp：急ぎ→答える・返事あり→期限が近い→大事さ÷手間）。声とポチが読む順もこれ。古いボードでは手で並べた順
  const byPrio = (a, b) => { if (typeof window.prioCmp === 'function') { try { return window.prioCmp(a, b); } catch {} } return (a.order ?? 0) - (b.order ?? 0); };
  const laneCards = lane => live().filter(c => (c.lane || 'next') === lane && (lane !== 'done' || !c.done_at || Date.parse(c.done_at) >= Date.now() - 7 * 864e5))
    .sort((a, b) => lane === 'done' ? String(b.done_at || '').localeCompare(String(a.done_at || ''))
      : lane === 'wait' ? String(a.event_start || a.due || '9999').localeCompare(String(b.event_start || b.due || '9999'))
      : byPrio(a, b));
  L.queueTitles = lane => laneCards(lane).map(c => c.title); // 検査用
  // undo：声・命令で動かしたときは、数秒「戻す」を出す（聞き間違えたらすぐ戻せる）
  let talkUndo = null; // 会話の中でやった命令の「戻す」（会話の画面の返事に付ける）
  function reply(text, voice, undo) {
    const vs = $('#vstatus'); if (vs && !$('#voice').hidden) vs.textContent = text;
    if (undo && $('#talkDlg')?.open) talkUndo = undo;
    if (typeof say === 'function') say(text, undo || undefined); else setStatus(text, 'ok');
    if (voice && window.Voice) Voice.speak(text);
    return text;
  }
  function newBody({ title, owner = 'you', lane = 'next', due = '', link = '', note = '' }, how) {
    const t = now();
    const b = { type: /mail\.google\.com/.test(link) ? 'mail' : 'task', title: String(title).trim().slice(0, 200), owner, lane, priority: 'mid',
      order: Date.now() / 1e6, created: t, updated: t, moves: [{ at: t, to: lane }], started_at: (lane === 'now' || lane === 'agent' || lane === 'done') ? t : null,
      done_at: lane === 'done' ? t : null, due: /^\d{4}-\d{2}-\d{2}$/.test(due) ? due : null, history: [{ at: t, who: 'you', text: how }] };
    if (/^https?:\/\//.test(link)) b.link = link;
    if (note) b.note = String(note).slice(0, 2000);
    return b;
  }
  // Claude に回すときの書きかえ（ボードと同じ形：owner agent・lane agent・列の移動の記録）
  function toAgent(c) {
    const t = now();
    return { owner: 'agent', lane: 'agent', updated: t, order: Date.now() / 1e6, moves: [...(c.moves || []), { at: t, from: c.lane || 'next', to: 'agent' }].slice(-50), ...(c.started_at ? {} : { started_at: t }) };
  }
  // ---------- ポチの整理：会話を始めたとき、ボードを見て自分で直し、やったことを一言で返す（どれも「戻す」で戻せる） ----------
  // ・期限が今日まで・すぎたカード（次にやる・時間があるとき）を今やるへ上げる。予定待ち・保留・Claude の列はさわらない
  // ・今やるは3枚まで（カンバンの WIP 制限。Kanban Guide）。あふれたら、急ぎでも大事でもないものを1日2枚まで次にやるへ（PC とスマホ合わせて）
  // ・調べもの・下書き・コードなど Claude ができそうなカードを Claude に回す（1回に2枚まで。メールのカードは回さない）
  // ・今やるで1週間動いていないカードを1日1回だけ知らせる
  // ポチが一度整理で動かしたカード（端末に id を覚える。履歴に「ポチ」があるものも）は二度と動かさない（本人が戻したら、それが答え）
  const WIP = 3;
  const CLAUDE_CAN = /(調べ|調査|リサーチ|比較|下書き|文案|要約|まとめ|翻訳|コード|プログラム|スクリプト|バグ|レビュー|検索)/;
  const ymd = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  function tidyPlan(list = live(), today = ymd(), at = Date.now(), done = new Set(L.ls.get('tidied') || [])) {
    const mine = c => !done.has(c.id) && !(c.history || []).some(h => h.who === 'ポチ') && c.owner !== 'agent';
    const key = c => (c.due || '9999') + String(1e9 + (c.order || 0));
    const up = list.filter(c => mine(c) && ['next', 'later'].includes(c.lane) && c.due && c.due <= today);
    const nowAll = list.filter(c => c.lane === 'now').concat(up).sort((a, b) => key(a).localeCompare(key(b)));
    const over = nowAll.slice(WIP);
    // 今やるから下ろすのは、急ぎでも大事でもないものだけ・1日2枚まで（大事さの低いものから）。
    // 多すぎること自体はボードが「12 / 3 ⚠」で見せる（WIP 制限は合意の印で、勝手に片付ける決まりではない。Kanban Guide）
    // 2026-10-20 ポチが今やるの8枚（お礼メール・返信など急ぎ）を一度に次にやるへ回した
    const soon = (() => { const d = new Date(today + 'T00:00:00'); d.setDate(d.getDate() + 2); return ymd(d); })();
    // 本人がこの1日にコメント・返事をしたカード、コメントが Claude の返事待ちのカードも下ろさない
    // （2026-10-21 satouさんが「それで進めて」と答えた2分後に、ポチがその2枚を次にやるへ回した）
    const touched = c => ['local', 'new', 'sent'].includes(c.comment_status) || (c.history || []).some(h => h.who === 'you' && at - (Date.parse(h.at) || 0) < 864e5);
    const keep = c => touched(c) || (c.due && c.due <= soon) || c.priority === 'high' || c.type === 'mail' || !!c.draft || (c.decision && !c.answer) || (typeof window.repliedToYou === 'function' && (() => { try { return !!window.repliedToYou(c); } catch { return false; } })());
    // 今日もう下ろした枚数は、端末ごとの印ではなくカードの履歴（データのリポジトリ）から数える。PC とスマホで合わせて1日2枚まで
    const downToday = list.filter(c => (c.history || []).some(h => h.who === 'ポチ' && h.text === '次にやるへ' && h.at && ymd(new Date(h.at)) === today)).length;
    const down = nowAll.filter(c => c.lane === 'now' && mine(c) && !keep(c)).sort((a, b) => byPrio(b, a)).slice(0, Math.max(0, Math.min(2 - downToday, over.length)));
    // 動かせない今やる（ポチが触ったもの・Claude のもの）も数に入れて、上げるのは空いている分だけ
    const room = Math.max(0, WIP - (list.filter(c => c.lane === 'now').length - down.length));
    const upKeep = up.filter(c => !over.includes(c)).slice(0, room);
    const busy = new Set([...upKeep, ...down]);
    const agent = list.filter(c => mine(c) && !busy.has(c) && ['next', 'later'].includes(c.lane) && c.type !== 'mail' && CLAUDE_CAN.test(c.title || '')).slice(0, 2);
    const last = c => Math.max(Date.parse(c.updated || c.created || 0) || 0, ...(c.moves || []).map(m => Date.parse(m.at) || 0));
    const stale = list.find(c => c.lane === 'now' && !down.includes(c) && last(c) > 0 && at - last(c) > 7 * 864e5) || null;
    return { up: upKeep, down, agent, stale };
  }
  L.tidyPlan = tidyPlan; // 検査用
  function tidyUp() {
    if (!L.writable()) return null;
    const p = tidyPlan();
    let stale = p.stale;
    if (stale) { const k = ymd() + ':' + stale.id; if (L.ls.get('tidyStale') === k) stale = null; else L.ls.set('tidyStale', k); }
    if (!p.up.length && !p.down.length && !p.agent.length) return stale ? { text: `「${stale.title}」がしばらく止まってるね。どうする？`, changed: false } : null;
    L.ls.set('tidied', [...(L.ls.get('tidied') || []), ...p.up, ...p.down, ...p.agent].map(c => c.id ?? c).slice(-300));
    L.as('ポチ', () => {
      for (const c of p.up) move(c.id, 'now', true, 'ポチ');
      for (const c of p.down) move(c.id, 'next', true, 'ポチ');
      for (const c of p.agent) L.update(c.id, toAgent(c)).catch(() => {});
    });
    const q = l => l.map(c => `「${c.title}」`).join('と');
    const parts = [];
    if (p.up.length) parts.push(`期限の${q(p.up)}を今やるに上げた`);
    if (p.down.length) parts.push(`今やるが多かったから${q(p.down)}は次にやるに回した`);
    if (p.agent.length) parts.push(`${q(p.agent)}は Claude に回しといた`);
    return { text: 'ちょっと整理したよ。' + parts.join('。') + '。' + (stale ? `あと「${stale.title}」がしばらく止まってるね。` : '') + '戻すなら「戻して」って言ってね。', changed: true, undo: () => L.undo() };
  }
  function runCommand(text, voice = false) {
    if (!L.ready) return reply('まだつないでいません。', voice);
    if (!window.Voice) return reply('声の部品（voice.js）を読めませんでした。', voice);
    const cmd = Voice.parse(text, WORDS);
    if (!cmd) return '';
    if (pending) {
      const p = pending; pending = null; hidePick();
      if (cmd.type === 'pick' && p.choices && p.choices[cmd.n - 1]) return apply({ ...p.cmd, card: p.choices[cmd.n - 1] }, voice);
      if (cmd.type === 'yes' && p.confirm) return apply({ ...p.cmd, card: p.card, sure: true }, voice);
      if (cmd.type === 'no' || cmd.type === 'yes' || cmd.type === 'pick') return reply('やめました。', voice);
    }
    return apply(cmd, voice);
  }
  // 題の一部からカードを探す。1枚に決まれば { card }、決まらなければ聞き返して { say }
  function findCard(cmd, pool, voice) {
    const hits = Voice.match(cmd.query, pool);
    if (hits.length === 1) return { card: hits[0] };
    if (hits.length > 1) { pending = { cmd, choices: hits }; showPick(hits); return { say: reply('候補が' + hits.length + 'つあります。' + hits.map((h, i) => `${i + 1}番、${h.title}`).join('。') + '。何番ですか？', voice) }; }
    const near = Voice.nearest ? Voice.nearest(cmd.query, pool) : [];
    if (!near.length) return { say: reply(`「${cmd.query}」に合うカードが見つかりません。`, voice) };
    pending = { cmd, choices: near }; showPick(near);
    return { say: reply(`「${cmd.query}」は見つかりません。近いのは、` + near.map((h, i) => `${i + 1}番、${h.title}`).join('。') + '。どれですか？ 違えば「いいえ」。', voice) };
  }
  // 候補を押して選べるようにする（声で「2番」と言っても、押してもよい）
  function showPick(list) {
    let box = $('#lkPick');
    if (!box) { box = document.createElement('div'); box.id = 'lkPick'; box.setAttribute('role', 'group'); box.setAttribute('aria-label', '候補'); }
    // 開いている命令欄・会話の中に出す（外に出すと、開いた画面の後ろで押せない）
    (document.querySelector('#talkDlg[open]') || $('#lkBar')).appendChild(box);
    box.innerHTML = list.map((c, i) => `<button type="button" data-pick="${i + 1}">${i + 1}. ${esc(c.title)}</button>`).join('') + '<button type="button" data-pick="0">やめる</button>';
    box.hidden = false;
  }
  const hidePick = () => { const b = $('#lkPick'); if (b) b.hidden = true; };
  document.addEventListener('click', e => {
    const b = e.target.closest?.('#lkPick [data-pick]'); if (!b) return;
    e.preventDefault(); hidePick();
    const t = b.dataset.pick === '0' ? 'いいえ' : b.dataset.pick;
    if (talk?.on && $('#talkDlg').open) talk.hear(t); else runCommand(t);
  });
  // カードの様子：列・担当の今の段（progress か live_line）・最後の記録
  function statusOf(c) {
    const ago = t => { const m = Math.round((Date.now() - Date.parse(t)) / 6e4); return isNaN(m) ? '' : m < 60 ? `${Math.max(1, m)}分前` : m < 1440 ? `${Math.round(m / 60)}時間前` : `${Math.round(m / 1440)}日前`; };
    const now = c.live_line || c.progress || '';
    const last = (c.history || []).slice(-1)[0];
    return `「${c.title}」は${LANE_LABEL[c.lane] || c.lane}。` + (now ? `いまは「${String(now).slice(0, 60)}」。` : '')
      + (last?.text && last.text !== now ? `最後の記録は${last.at ? ago(last.at) + 'の' : ''}「${String(last.text).slice(0, 60)}」。` : '')
      + (c.due ? `期限は${+c.due.slice(5, 7)}月${+c.due.slice(8, 10)}日。` : '');
  }
  function apply(cmd, voice) {
    switch (cmd.type) {
      case 'add': {
        if (!L.writable()) return reply('いまは保存できないので足せません。', voice);
        const lane = cmd.lane || 'next';
        L.add(newBody({ title: cmd.title, lane }, '声・命令で足した')).catch(() => {});
        return reply(`「${cmd.title}」を${LANE_LABEL[lane]}に足しました。`, voice, () => L.undo());
      }
      case 'read': {
        const l = laneCards(cmd.lane);
        document.getElementById('lane-' + cmd.lane)?.scrollIntoView({ block: 'start' });
        if (!l.length) return reply(`${LANE_LABEL[cmd.lane]}は空です。`, voice);
        return reply(`${LANE_LABEL[cmd.lane]}は${l.length}枚。` + l.slice(0, 5).map((c, i) => `${i + 1}、${c.title}`).join('。') + (l.length > 5 ? `。ほか${l.length - 5}枚。` : '。'), voice);
      }
      case 'undo': return reply(L.undo() ? 'ひとつ前に戻しました。' : '戻せるものがありません。', voice);
      case 'done': case 'move': case 'delete': case 'agent': case 'due': {
        if (!L.writable()) return reply('いまは保存できないので動かせません。', voice);
        let c = cmd.card;
        if (!c) {
          const pool = cmd.type === 'done' || cmd.type === 'agent' ? live().filter(x => x.lane !== 'done') : live();
          const r = findCard(cmd, pool, voice); if (!r.card) return r.say;
          c = r.card;
        }
        // 消すのも聞き返さずにすぐやる（消したカードは行が残り「戻す」で戻せる。確認より取り消し：Raskin「Never Use a Warning When You Mean Undo」）
        if (cmd.type === 'delete') {
          remove(c.id);
          return reply(`「${c.title}」を消しました。戻すときは「戻す」。`, voice, () => L.undo());
        }
        // Claude に回す：Claude が進める列へ（ボードの見回りが拾って進める）。回すのはカードだけ（会話の文は渡さない）
        if (cmd.type === 'agent') {
          if (c.lane === 'agent' && c.owner === 'agent') return reply(`「${c.title}」はもう Claude が進めています。`, voice);
          L.update(c.id, toAgent(c)).catch(() => {});
          return reply(`「${c.title}」を Claude に回しました。`, voice, () => L.undo());
        }
        if (cmd.type === 'due') {
          const due = cmd.due || (Voice.dueDate ? Voice.dueDate(cmd.when) : '');
          if (!due) return reply('いつにするか分かりませんでした。', voice);
          L.update(c.id, { due, updated: now() }).catch(() => {});
          return reply(`「${c.title}」の期限を${+due.slice(5, 7)}月${+due.slice(8, 10)}日にしました。`, voice, () => L.undo());
        }
        const lane = cmd.type === 'done' ? 'done' : cmd.lane;
        if (c.lane === lane) return reply(`「${c.title}」はもう${LANE_LABEL[lane]}です。`, voice);
        move(c.id, lane, false, L.actor?.() || undefined); // くり返しのカードの次の回をボードが後から書くときも、ポチの名前で残す（ボード v42 以降）
        return reply(`「${c.title}」を${LANE_LABEL[lane]}にしました。`, voice, () => L.undo());
      }
      case 'status': {
        let c = cmd.card;
        if (!c) { const r = findCard(cmd, live(), voice); if (!r.card) return r.say; c = r.card; }
        return reply(statusOf(c), voice);
      }
      case 'pick': case 'yes': case 'no': return reply('いまは聞き返していません。', voice);
      default: return reply(`「${cmd.text}」は分かりませんでした。例：〇〇を追加、〇〇を済み、今やるを読んで。`, voice);
    }
  }

  // 🎤：ボードの🎤は、会話の欄を開いてすぐ聞く（打つのと同じ流れ。命令ならカードを動かし、そうでなければ会話）。
  // 耳は端末の中の AI の耳も使える voice.js（声は端末の外に出さない）
  function micGo(via = 'voice') {
    if (!L.ready) return;
    if (!window.Voice?.supported) {
      const box = $('#voice'), vs = $('#vstatus'); if (box) box.hidden = false;
      if (vs) vs.textContent = '🎤は、この端末では使えません。「⋯ → 🎤と会話・AI の設定」で AI の部品を入れると使えます。打って話すなら💬から。';
      drawWhy(); return;
    }
    openTalk(via);
  }
  holdable($('#micBtn'), () => micGo('hold'), e => { e.stopImmediatePropagation(); micGo(); });

  // ---------- URL・共有・ショートカットから来た操作（つながってから1回だけ） ----------
  function runEntry() {
    const e = L.entry; if (!e || e.done) return; e.done = true;
    if (e.lane) document.getElementById('lane-' + e.lane)?.scrollIntoView({ block: 'start' });
    if (e.add && e.add.title) {
      if (!L.writable()) setStatus('いまは保存できないので、受け取ったカードを足せませんでした。', 'err');
      else L.add(newBody(e.add, e.add.link ? '共有から足した' : 'URL から足した')).then(() => reply(`「${e.add.title}」を足しました。`)).catch(() => {});
    }
    if (e.cmd) runCommand(e.cmd);
    if (e.form) document.getElementById('compose-btn')?.click();
    if (e.voice) micGo();
    if (e.talk) openTalk('talk');
  }

  // ---------- 会話モード（talk.js。すべて端末の中） ----------
  const talkSettings = () => ({ ...(window.Talk?.DEFAULTS || {}), ...(ls.get('talk') || {}) });
  let talk = null;
  function talkLine(who, text) {
    const d = document.createElement('div'); d.className = 'l ' + who; d.textContent = text;
    if (who === 'you' || who === 'ai') { const w = document.createElement('span'); w.className = 'sr'; w.textContent = who === 'you' ? 'あなた：' : 'ポチ：'; d.prepend(w); } // 読み上げで誰の発言か分かるように（v36 点検）
    if (who === 'you') talkUndo = null;
    if (who === 'ai' && talkUndo) { const u = talkUndo; talkUndo = null; const b = document.createElement('button'); b.type = 'button'; b.className = 'undo'; b.textContent = '戻す'; b.setAttribute('aria-label', '今のを戻す'); b.onclick = () => { b.remove(); u(); }; d.append(' ', b); }
    const box = $('#talkLog'); box.appendChild(d); while (box.children.length > 30) box.firstChild.remove(); box.scrollTop = box.scrollHeight;
  }
  const TALK_STATE = { starting: '準備しています…', listening: '聞いてるよ（話してね。打ってもいいよ）', thinking: '考え中…', speaking: '話しています（話しかけても、打っても割り込めます）', typing: '下の欄に打って話してね', idle: '打つか、🎤を押して話してね', off: '' };
  // 表情（data-mood）。少しのあいだだけ見せて、ふつうに戻す。うれしいときは紙吹雪（動きを減らす設定のときは出さない）
  let moodTimer = 0;
  // party（3枚目・10枚ごと）と wow（ずっと残っていた・期限すぎのカード）は笑顔＋紙吹雪。ふつうの happy は笑顔だけ
  function setMood(m, hold = 2500) {
    const d = $('#talkDlg'); if (!d) return;
    const big = m === 'party' ? 14 : m === 'wow' ? 32 : 0;
    if (big) m = 'happy';
    if (!hold && moodTimer) return; // うれしい・驚いたを見せているあいだは、聞く・考える で消さない
    d.dataset.mood = m; if (window.Voice) Voice.mood = m; // 話す声の気持ちも表情に合わせる（koe.js）
    clearTimeout(moodTimer); moodTimer = 0;
    if (hold) moodTimer = setTimeout(() => { moodTimer = 0; d.dataset.mood = d.dataset.state === 'listening' ? 'listen' : d.dataset.state === 'thinking' ? 'think' : 'normal'; if (window.Voice) Voice.mood = 'normal'; }, hold);
    if (big && !matchMedia('(prefers-reduced-motion: reduce)').matches) confetti(big);
  }
  function confetti(n = 14) {
    const box = $('#talkAva'); if (!box) return;
    const cs = ['#f59e0b', '#22c55e', '#3b82f6', '#ec4899', '#a855f7'];
    for (let i = 0; i < n; i++) {
      const p = document.createElement('i'); p.className = 'confetti';
      p.style.setProperty('--x', (Math.random() * 160 - 80).toFixed(0) + 'px'); p.style.setProperty('--r', (Math.random() * 720 - 360).toFixed(0) + 'deg');
      p.style.background = cs[i % cs.length]; p.style.animationDelay = (Math.random() * 0.15).toFixed(2) + 's';
      box.appendChild(p); setTimeout(() => p.remove(), 1400);
    }
  }
  // 口：読み上げの言葉の区切りで開け閉めする（区切りが来ない声では、話している間ずっと動かす）
  let mouthTimer = 0;
  addEventListener('voice:boundary', () => {
    const d = $('#talkDlg'); if (!d?.open) return;
    d.dataset.sync = '1'; d.classList.add('mouth-open'); clearTimeout(mouthTimer); mouthTimer = setTimeout(() => d.classList.remove('mouth-open'), 140);
  });
  // 口の形（A8）：読む文のかなから あ・い・う・え・お・閉じる を選び、話す速さに合わせて切り替える。
  // 区切りの合図が来る声は、その位置に合わせ直す（Pixel の声は合図が来ないことがあるので、時間で進める）
  let mouthSeq = [], mouthI = 0, mouthT = 0;
  function startMouth(text) {
    const d = $('#talkDlg'); if (!d?.open || !window.Talk?.vowels || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    mouthSeq = Talk.vowels(window.Voice?.speechText ? Voice.speechText(text) : text); mouthI = 0;
    const rate = +(localStorage.getItem('voice.rate') || 1) || 1;
    clearInterval(mouthT);
    mouthT = setInterval(() => {
      if (!d.classList.contains('speaking')) return;
      if (mouthI >= mouthSeq.length) { stopMouth(); return; }
      d.dataset.mouth = mouthSeq[mouthI++];
    }, Math.round(1000 / (7.5 * rate))); // 日本語はおよそ1秒に7〜8拍
  }
  function stopMouth() { clearInterval(mouthT); mouthT = 0; const d = $('#talkDlg'); if (d) delete d.dataset.mouth; }
  L.mouth = { start: startMouth, stop: stopMouth }; // 検査用
  addEventListener('voice:boundary', e => { if (mouthT && typeof e.detail?.at === 'number') mouthI = Math.min(mouthSeq.length, e.detail.at); });
  // 聞いている間：声の大きさで耳と輪を動かし、話の切れ目でうなずく（B5。Whisper の耳のとき）
  addEventListener('voice:level', e => { const d = $('#talkDlg'); if (!d?.open || d.dataset.state !== 'listening') return; d.dataset.lv = '1'; d.style.setProperty('--lv', String(e.detail?.v || 0)); });
  addEventListener('voice:nod', () => { const d = $('#talkDlg'); if (!d?.open) return; d.classList.remove('nod'); void d.offsetWidth; d.classList.add('nod'); setTimeout(() => d.classList.remove('nod'), 500); });

  function drawTalkHead() { const t = talkSettings(); $('#talkAva').innerHTML = Talk.avatarSvg(t.icon, t.color, wearNow()); $('#talkName').textContent = t.name; }

  // ---------- ボードの隅のポチ（A1）と成長（A4） ----------
  // 💬を開かなくても会える相棒（Finch の鳥のように、やったことに反応する）。ただし Clippy にならないよう、しゃべらない・吹き出しを出さない・音を出さない。
  // 済みにすると跳ね、夜は眠そう。押すと会話。設定で消せる。
  // 成長：一緒に済みにした合計（データの cards.json の済みのカード）で小物が増える。合計は覚えたこと（pochi-memory の growth）に置き、減らさない
  const growthItem = () => (L.memory ? L.memory.all().find(m => m.id === 'growth') : null);
  function wearNow() {
    const g = growthItem(), w = window.Talk ? Talk.growthOf(g?.total || 0).wear : [];
    if (Talk.partOfDay() === 'night') w.push('nightcap');
    for (const x of Talk.seasonOf ? Talk.seasonOf().wear : []) w.push(x); // 季節と行事の小物（その日だけ）
    return w;
  }
  let doneSeen = -1, hopTimer = 0;
  function pochiTick() {
    if (!window.Talk || !L.memory) return;
    const n = live().filter(c => c.lane === 'done' && c.owner !== 'agent').length;
    const g = growthItem();
    if (!g) L.memory.put({ id: 'growth', kind: 'growth', total: n, since: ymd(), shown: Talk.growthOf(n).level, text: '' });
    else if (n > (g.total || 0)) L.memory.put({ ...g, total: n });
    const gg = growthItem(); if (gg) { const t = Talk.growthText(gg); if (gg.text !== t) L.memory.put({ ...gg, text: t }); }
    if (doneSeen >= 0 && n > doneSeen) hop();
    doneSeen = n;
    drawPochi();
  }
  function drawPochi() {
    const t = talkSettings();
    let b = $('#lkPochi');
    if (!window.Talk || !L.ready || t.corner === false) { if (b) b.hidden = true; return; }
    if (!b) {
      b = document.createElement('button'); b.type = 'button'; b.id = 'lkPochi';
      b.onclick = () => openTalk('talk');
      document.body.appendChild(b);
    }
    const g = growthItem(), key = [t.icon, t.color, wearNow().join(',')].join('|');
    if (b.dataset.key !== key) { b.innerHTML = Talk.avatarSvg(t.icon, t.color, wearNow()); b.dataset.key = key; }
    b.hidden = false;
    b.dataset.night = Talk.partOfDay() === 'night' ? '1' : '';
    const next = Talk.growthOf(g?.total || 0).next;
    b.setAttribute('aria-label', `${t.name}と話す`);
    b.title = `${t.name}と話す（一緒に片づけたのは${g?.total || 0}枚${next ? `。あと${next.left}枚で次のごほうび` : ''}）`;
  }
  function hop() {
    const b = $('#lkPochi'); if (!b || b.hidden) return;
    b.classList.remove('hop'); void b.offsetWidth; b.classList.add('hop');
    clearTimeout(hopTimer); hopTimer = setTimeout(() => b.classList.remove('hop'), 1200);
  }
  setInterval(() => { if ($('#lkPochi') && !$('#lkPochi').hidden) drawPochi(); }, 60e3); // 夜になったら眠そうにする
  // 何もしていないときのしぐさ（A2）：きょろきょろ・あくび・耳ふり・伸び・しっぽふり を、順番を決めずに 8〜20 秒ごとにまぜる。
  // 10 分さわらなければ寝る（さわると起きる）。Duolingo の Lily は動きを組み合わせて「同じ動きのくり返し」に見えないようにしている
  const GESTURES = ['g-look', 'g-yawn', 'g-ears', 'g-stretch', 'g-tail'];
  let lastTouch = Date.now(), lastGesture = '';
  const wake = () => { lastTouch = Date.now(); const b = $('#lkPochi'); if (b?.dataset.sleep) { b.dataset.sleep = ''; } };
  addEventListener('pointerdown', wake, { passive: true }); addEventListener('keydown', wake);
  function idleTick() {
    const b = $('#lkPochi');
    if (!b || b.hidden || document.hidden || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (Date.now() - lastTouch > 10 * 60e3) { b.dataset.sleep = '1'; return; }
    const g = GESTURES.filter(x => x !== lastGesture)[Math.floor(Math.random() * (GESTURES.length - 1))];
    lastGesture = g; b.classList.add(g); setTimeout(() => b.classList.remove(g), 1600);
    return g;
  }
  (function idle() { setTimeout(idle, 8000 + Math.random() * 12000); idleTick(); })();
  L.pochiIdle = { GESTURES, tick: idleTick, sleepNow: () => { lastTouch = 0; } }; // 検査用
  const order = l => L.LANES.findIndex(([k]) => k === l);
  // via: 'talk'（💬：あいさつしてから聞く）・'voice'（🎤：すぐ聞く）・'text'（Ctrl+K：打つ欄に入る）
  function openTalk(via = 'talk') {
    if (!window.Talk || !L.ready) return;
    if (talk?.on) {
      if (!$('#talkDlg').open) $('#talkDlg').showModal();
      if (via === 'hold') talk.hold(); else if (via === 'voice' && !talk.listening) talk.listen(); else if (via === 'text') $('#talkIn').focus();
      return;
    }
    { const t = talkSettings(); try { for (const k of ['rate', 'pitch']) t[k] ? localStorage.setItem('voice.' + k, String(t[k])) : localStorage.removeItem('voice.' + k); } catch {} } // 速さ・高さはほかの端末で決めたものも使う
    drawTalkHead(); $('#talkLog').innerHTML = ''; $('#talkMode').textContent = ''; $('#talkAiGet').hidden = true;
    talk = Talk.create({
      settings: talkSettings(),
      lanes: LANE_LABEL, laneWords: WORDS,
      // AI に渡すのは題・列・期限だけ（補足・履歴・リンクは渡さない）
      board: () => live().filter(c => c.lane !== 'done').sort((a, b) => order(a.lane) - order(b.lane) || byPrio(a, b)).map(c => ({ title: c.title, lane: c.lane, due: c.due || '' })),
      queue: () => ['now', 'next'].flatMap(laneCards),
      card: (title, any) => live().find(c => c.title === title && (any || c.lane !== 'done')) || null, // 前回あとに回したカード・済みにしたカード（喜び方を決める）
      weekDone: () => live().filter(c => c.lane === 'done' && c.owner !== 'agent' && c.done_at && Date.parse(c.done_at) > Date.now() - 8 * 864e5).map(c => ({ title: c.title, created: c.created || '', done_at: c.done_at })), // 週のふりかえり（題と日付だけ）
      memory: L.memory,
      // 会話で動かしたものは、履歴に「ポチ」と残す
      run: t => L.as('ポチ', () => runCommand(t)),
      act: cmd => L.as('ポチ', () => apply(cmd, false)),
      tidy: () => tidyUp(),
      pending: () => !!pending,
      onLine: talkLine,
      onState: st => {
        $('#talkState').textContent = st === 'listening' && talk?.holding ? '聞いてるよ（離したら答えるね）' : TALK_STATE[st] ?? ''; $('#talkDlg').classList.toggle('speaking', st === 'speaking');
        $('#talkDlg').dataset.state = st;
        if (st !== 'speaking') stopMouth();
        if (st !== 'listening') delete $('#talkDlg').dataset.lv;
        const m = $('#talkMic'); if (m) { const on = st === 'listening' || !!talk?.listening; m.setAttribute('aria-pressed', String(on)); m.classList.toggle('on', on); m.hidden = !window.Voice?.supported; }
        if (st === 'listening') setMood('listen', 0); else if (st === 'thinking') setMood('think', 0); else if (st !== 'speaking' && !moodTimer) setMood('normal', 0);
        if (st === 'off' && $('#talkDlg').open) $('#talkDlg').close();
      },
      onMood: m => setMood(m),
      onSpeak: text => startMouth(text),
      onMode: (m, brain, why) => {
        $('#talkMode').textContent = m === 'ai'
          ? '🧠 AI と話しています（' + (brain === 'cpu' ? '入れた AI・CPU で動かしています（ゆっくり）' : brain === 'webllm' ? '入れた WebLLM' : 'Chrome の内蔵 AI') + '・端末の中だけ）'
          : why === 'off' ? '📋 AI なし：設定で切っています（決まった返事でおしゃべり・カードの確認）' : '📋 AI なし：決まった返事でおしゃべり・カードの確認';
        $('#talkMode').dataset.ai = m === 'ai' ? 'on' : 'off';
        // AI なしで、入れれば使える端末（WebGPU がある）なら、入れる場所への近道を出す
        $('#talkAiGet').hidden = m === 'ai' || why === 'off' || !window.LocalAI || LocalAI.llmReady(); // WebGPU が無くても CPU 版を入れられる
        if (window.LocalAI) $('#talkAiGet').textContent = `🧠 AI を入れて自由に話す（約 ${LocalAI.plan().gb}GB・Wi-Fi で）`;
      },
    });
    $('#talkDlg').showModal();
    if (via === 'text') $('#talkIn').focus();
    talk.start(via);
  }
  $('#talkBtn').onclick = () => openTalk('talk');
  // 🎤：押すと聞き続ける（もう一度押すと止める）。長押しなら離すまで聞く（考えながら話しても途中で切らない）
  const HOLD_MS = 350;
  function holdable(el, onHold, onTap) {
    if (!el) return;
    let t = 0, held = false;
    const up = () => { clearTimeout(t); if (held) talk?.release(); };
    el.addEventListener('pointerdown', e => {
      if (e.button) return;
      held = false; clearTimeout(t);
      try { el.setPointerCapture(e.pointerId); } catch {}
      t = setTimeout(() => { held = true; onHold(); }, HOLD_MS);
    });
    for (const k of ['pointerup', 'pointercancel']) el.addEventListener(k, up);
    addEventListener('pointerup', up); // 開いた会話の画面の上で離しても止める
    el.addEventListener('contextmenu', e => e.preventDefault()); // 長押しでメニューを出さない
    el.addEventListener('click', e => { if (held) { held = false; e.preventDefault(); e.stopImmediatePropagation(); return; } onTap?.(e); }, true);
  }
  holdable($('#talkMic'), () => talk?.hold(), () => talk?.listen());
  $('#talkEnd').onclick = () => { talk?.stop(); if ($('#talkDlg').open) $('#talkDlg').close(); };
  $('#talkDlg').addEventListener('cancel', () => talk?.stop());
  $('#talkForm').onsubmit = e => { e.preventDefault(); const t = $('#talkIn').value; $('#talkIn').value = ''; talk?.hear(t, { voice: false }); };
  function openTalkSet() {
    if (!window.Talk) { setStatus('会話の部品（talk.js）を読めませんでした。開き直してみてください。', 'err'); return; }
    const f = $('#talkSetForm'), t = talkSettings();
    f.name.value = t.name; f.persona.value = t.persona; f.color.value = t.color; f.bargeIn.checked = !!t.bargeIn; f.rate.value = t.rate || 1; f.pitch.value = t.pitch || 1.05; f.ai.checked = t.ai !== 'off'; f.reply.value = t.reply || 'match'; f.tidy.checked = t.tidy !== false; f.cue.checked = t.cue !== false; f.waitMore.checked = t.waitMore !== false; f.followUp.checked = t.followUp !== false; f.corner.checked = t.corner !== false; f.streak.checked = !!t.streak; f.moodAsk.checked = !!t.moodAsk; f.endWait.value = t.endWait === 'slow' ? 'slow' : 'normal';
    $('#talkIcons').innerHTML = ['maru', 'kaku', 'shizuku'].map(k => `<label><input type="radio" name="icon" value="${k}" ${k === t.icon ? 'checked' : ''} aria-label="${{ maru: 'まる', kaku: 'しかく', shizuku: 'しずく' }[k]}">${Talk.avatarSvg(k, t.color)}</label>`).join('');
    const vs = (window.speechSynthesis?.getVoices() || []).filter(v => v.localService && /^ja/.test(v.lang));
    f.voice.innerHTML = '<option value="">おまかせ</option>' + vs.map(v => `<option ${v.name === t.voice ? 'selected' : ''}>${esc(v.name)}</option>`).join('') + (vs.length ? '' : '<option disabled>（この端末に日本語の声がありません）</option>');
    drawAi(); drawMem(); drawKoe();
    $('#talkSet').showModal();
  }
  $('#talkSetBtn').onclick = openTalkSet;
  function drawMem() {
    const items = L.memory ? L.memory.all() : [];
    const shown = items.filter(m => m.kind !== 'word' || (m.count || 0) >= (window.Talk?.WORD_MIN || 2)).filter(m => m.kind !== 'habit' || m.text);
    $('#memList').innerHTML = shown.length
      ? shown.map(m => `<li><span>${esc(m.kind === 'name' ? '呼び方：' + m.text : m.text)}</span> <button type="button" data-forget="${esc(m.id)}" aria-label="「${esc(m.text)}」を忘れる">忘れる</button></li>`).join('')
      : '<li class="help">まだ何も覚えていません。</li>';
    $('#memAll').hidden = !shown.length;
  }
  $('#memList').addEventListener('click', e => { const b = e.target.closest('[data-forget]'); if (!b || !L.memory) return; L.memory.forget(b.dataset.forget); drawMem(); });
  $('#memAll').onclick = () => { if (!L.memory) return; L.memory.forgetAll(); drawMem(); };
  // まだ送っていない変更の数（オフラインなど）。送れたら消える
  setInterval(() => { const n = L.unsent ? L.unsent() : 0, el = $('#lkUnsent'); if (!el) return; el.hidden = !n; if (n) el.textContent = `未送信 ${n}件（つながったら自動で送ります）`; }, 1000);
  // 💬の中の1ボタンで入れる（設定の画面を探さなくてよい）。入ったら会話を開き直して AI で話す
  $('#talkAiGet').onclick = async () => {
    const ok = await installAi(t => { $('#talkMode').textContent = t; }, $('#talkAiProg'));
    if (!ok) return;
    talkLine('sys', '入りました。AI で話します。');
    if (talk?.on) { talk.stop(); openTalk('talk'); }
  };
  // この端末の診断（会話の中身・カードは入れない）
  $('#diagBtn').onclick = async () => {
    const out = $('#diagMsg'); out.textContent = '調べています…';
    try { const name = await sendDiag(); out.textContent = `送りました（local-board/diagnostics/${name}）。会話の中身は入れていません。`; }
    catch (e) { out.textContent = '送れませんでした：' + (e?.message || e); }
  };
  // 🎤がすぐ止まったときは、この端末の様子を1日1回だけ自動で送る（理由と秒数だけ。聞いた中身・カードは入れない）。
  // 2026-10-21 satouさん「マイクを押してもすぐ OFF」：端末でしか起きないことを、頼まなくても Claude が読めるように
  addEventListener('voice:fail', e => {
    if (!e.detail?.fast || !L.ready) return;
    const d0 = new Date(), day = `${d0.getFullYear()}-${d0.getMonth() + 1}-${d0.getDate()}`;
    if (L.ls.get('diagAuto') === day || diagBusy) return;
    diagBusy = true;
    setTimeout(() => sendDiag().then(() => { L.ls.set('diagAuto', day); talkLine('sys', '🎤がすぐ止まったので、この端末の様子を Claude に送ったよ（話した中身・カードは入れていない）。'); }).catch(() => {}).finally(() => { diagBusy = false; }), 3000);
  });
  // その日は耳（Whisper）で聞くと切り替えたことを一言
  addEventListener('voice:switch', () => talkLine('sys', 'この端末の聞き取りがすぐ止まったので、今日はもう一つの耳（Whisper）で聞くね。'));
  let diagBusy = false;
  async function sendDiag() {
    {
      let dev = L.ls.get('device'); if (!dev) { dev = Math.random().toString(36).slice(2, 8); L.ls.set('device', dev); }
      const ua = navigator.userAgentData;
      const d = {
        at: new Date().toISOString(), device: dev,
        端末: ua ? `${ua.platform || ''}${ua.mobile ? '（スマホ）' : ''} ${(ua.brands || []).filter(b => !/Not/.test(b.brand)).map(b => b.brand + ' ' + b.version).join('・')}` : navigator.userAgent.replace(/\s*\([^)]*\)\s*/g, ' ').slice(0, 120),
        聞き取り: window.Voice ? (await Voice.localStatus().catch(() => '?')) + (window.LocalAI?.status().ear ? '・Whisper あり' : '') : 'なし',
        内蔵AI: window.Talk ? await Talk.aiStatus() : 'なし',
        ...(window.LocalAI ? await LocalAI.info() : {}),
        気持ちの声: window.Koe?.status().installed || 'なし',
        最近の返事: (window.Talk?.metrics || []).slice(-20),
        聞き取りの失敗: window.Voice?.micLog?.() || [],
        端末の音声認識を休む日: (() => { try { return localStorage.getItem('lk.srBad') || ''; } catch { return ''; } })(),
      };
      const name = `${d.at.slice(0, 10)}-${dev}.json`;
      await L.diag(name, d);
      return name;
    }
  }
  function drawAi() {
    const A = window.LocalAI; if (!A) { $('#aiBox').hidden = true; return; }
    const st = A.status(), p = A.plan();
    $('#aiBrain').value = A.brainPick(); $('#aiCredit').textContent = A.JA.credit;
    $('#aiStat').textContent = st.llm
      ? `入っています：頭 ${st.llm}${st.cpu ? '（CPU で動かしています。返事はゆっくり）' : ''}${st.ear ? '・耳 ' + A.EAR.label : ''}（${st.at} に ${[...new Set(st.from.map(f => f.split('/')[0]))].join('・')} から取得）`
      : `まだ入っていません。入れると、Chrome の内蔵 AI が無い端末（スマホなど）でも AI と話せます（頭 ${p.model}${p.ear ? '・耳 ' + A.EAR.label : ''}）。`;
    const swap = st.llm && st.brain !== A.brainPick();
    $('#aiGet').textContent = swap ? `頭を ${p.model} に替える（約 ${p.gb}GB）` : st.llm ? '入れ直す' : `AI の部品を入れる（約 ${p.gb}GB）`;
    $('#aiDel').hidden = !st.llm;
    // 頭は入っているが耳が無く、端末の音声認識でも日本語を聞き取れない端末は、耳（Whisper）だけ足せる
    $('#aiGet').dataset.earOnly = '';
    if (st.llm && !st.ear && !swap) A.earNeeded().then(need => {
      if (!need || A.status().ear || aiBusy) return;
      $('#aiGet').textContent = `耳（声の聞き取り）だけ足す（約 ${A.EAR.gb}GB）`; $('#aiGet').dataset.earOnly = '1';
      $('#aiStat').textContent += ' この端末の Chrome は日本語を端末の中で聞き取れないので、🎤には耳（Whisper）が要ります。';
    });
    // 入れる前：WebGPU が使えなければ CPU 版、端末の音声認識で日本語を聞き取れなければ耳も入れる、と目安を直す
    else if (!st.llm && A.brainPick() === 'qwen') Promise.all([A.gpu(), A.earNeeded()]).then(([a, need]) => {
      if (A.status().llm || aiBusy || A.brainPick() !== 'qwen') return;
      const head = a ? p.model : A.CPU.label, gb = (a ? A.MODELS[p.model === A.MODELS.large.label ? 'large' : 'small'].gb : A.CPU.gb) + (need ? A.EAR.gb : 0);
      $('#aiStat').textContent = a
        ? `まだ入っていません。入れると、Chrome の内蔵 AI が無い端末（スマホなど）でも AI と話せます（頭 ${head}${need ? '・耳 ' + A.EAR.label : ''}）。`
        : `まだ入っていません。この端末の Chrome は WebGPU が使えないので、CPU で動く AI（頭 ${head}${need ? '・耳 ' + A.EAR.label : ''}）を入れます。返事はゆっくりです。`;
      $('#aiGet').textContent = `AI の部品を入れる（約 ${Math.round(gb * 10) / 10}GB）`;
    });
  }
  // 気持ちで話し分ける声（koe.js）
  let koeBusy = false;
  async function drawKoe() {
    const K = window.Koe; if (!K) { $('#koeBox').hidden = true; return; }
    const st = K.status();
    $('#koeModel').innerHTML = Object.entries(K.VOICES).map(([k, v]) => `<option value="${k}" ${k === (st.installed || 'F1') ? 'selected' : ''}>${esc(v.label)}</option>`).join('');
    $('#koeCredit').textContent = K.CREDIT;
    $('#koeOn').checked = st.on; $('#koeOn').disabled = !st.installed;
    $('#koeDel').hidden = $('#koeTry').hidden = !st.installed;
    $('#koeGet').textContent = st.installed ? '入れ直す・声の人を変える' : `声を入れる（約 ${K.VOICES.F1.size + 19}MB）`;
    $('#koeStat').textContent = !st.gpu ? 'この端末のブラウザは WebGPU が使えないので、端末の声で話します。'
      : st.installed ? `入っています：${K.VOICES[st.installed].label}` : 'まだ入っていません（端末の声で話しています）。';
    $('#koeGet').disabled = koeBusy || !st.gpu;
    // GPU が Chrome の対象外の端末（navigator.gpu はあるが使えない）も、押す前に理由を出す
    if (st.gpu && !st.installed) K.adapterOk().then(ok => { if (!ok) { $('#koeStat').textContent = 'この端末の Chrome は WebGPU が使えないので、気持ちの声は入れられません。端末の日本語の声で話します。'; $('#koeGet').disabled = true; } });
  }
  $('#koeGet').onclick = async () => {
    if (koeBusy || !window.Koe) return;
    const model = $('#koeModel').value; // 描き直すと選択が戻るので先に取っておく
    koeBusy = true; drawKoe(); $('#koeProg').hidden = false; $('#koeProg').value = 0; $('#koeMsg').textContent = '取ってきています…（画面を閉じずに待ってね）';
    try {
      await Koe.install(model, p => { if (p.part === 'model' && p.total) $('#koeProg').value = p.loaded / p.total; });
      $('#koeMsg').textContent = '入りました。これからはこの声で話します。';
    } catch (e) { $('#koeMsg').textContent = '入れられませんでした：' + (e.message || e); }
    finally { koeBusy = false; $('#koeProg').hidden = true; drawKoe(); }
  };
  $('#koeTry').onclick = async () => {
    if (!window.Koe?.ready()) return;
    $('#koeMsg').textContent = '作っています…';
    const keep = Voice.mood;
    try {
      for (const [m, t] of [['normal', 'ポチだよ。'], ['happy', 'やったね、済みにできたよ！'], ['sad', 'ちょっと疲れちゃったね。'], ['surprise', 'えっ、それ本当？']]) { Voice.mood = m; await Voice.speak(t); }
      $('#koeMsg').textContent = '';
    } catch (e) { $('#koeMsg').textContent = '話せませんでした：' + (e.message || e); }
    finally { Voice.mood = keep; }
  };
  $('#koeDel').onclick = async () => { if (koeBusy || !window.Koe) return; await Koe.remove(); $('#koeMsg').textContent = 'この端末から消しました。'; drawKoe(); };
  $('#koeOn').onchange = e => { window.Koe?.setOn(e.target.checked); drawKoe(); };
  // AI の部品を入れる（設定の画面からも、💬の中の1ボタンからも同じ）。msg・prog は進み具合を出す場所
  let aiBusy = false;
  const onPC = () => /Windows|Macintosh|Linux x86/.test(navigator.userAgent) && !/Android|Mobile/.test(navigator.userAgent);
  async function installAi(msg, prog, opts = {}) {
    if (aiBusy || !window.LocalAI) return false;
    aiBusy = true; $('#aiGet').disabled = true; $('#talkAiGet').disabled = true; prog.hidden = false; prog.value = 0;
    msg('取ってきています…（Wi-Fi で、画面を閉じずに待ってね）' + (onPC() ? ' PC ではブラウザの保存場所（ふつう C ドライブ）に入ります。' : ''));
    try { await LocalAI.safeInstall((v, what) => { prog.value = v; if (what) msg(String(what).slice(0, 120)); }, opts); return true; }
    catch (e) { msg(e?.message || String(e)); return false; }
    finally { aiBusy = false; $('#aiGet').disabled = false; $('#talkAiGet').disabled = false; prog.hidden = true; drawAi(); drawWhy(); }
  }
  $('#aiGet').onclick = async () => {
    const ok = await installAi(t => { $('#aiMsg').textContent = t; }, $('#aiProg'), { earOnly: $('#aiGet').dataset.earOnly === '1' });
    if (ok) $('#aiMsg').textContent = '入りました。会話モードと🎤で使えます。';
  };
  $('#aiBrain').onchange = e => { if (!window.LocalAI || aiBusy) return; LocalAI.setBrain(e.target.value); drawAi(); };
  $('#aiDel').onclick = async () => { if (aiBusy || !window.LocalAI) return; await LocalAI.remove(); $('#aiMsg').textContent = 'この端末から消しました。'; drawAi(); drawWhy(); };
  $('#talkSetForm').onsubmit = e => {
    if (e.submitter?.value !== 'ok') return;
    const f = e.target;
    const t = { name: f.name.value.trim() || Talk.DEFAULTS.name, persona: f.persona.value.trim() || Talk.DEFAULTS.persona, icon: f.icon.value || 'maru', color: f.color.value, voice: f.voice.value, rate: +f.rate.value, pitch: +f.pitch.value, bargeIn: f.bargeIn.checked, reply: f.reply.value, tidy: f.tidy.checked, cue: f.cue.checked, waitMore: f.waitMore.checked, followUp: f.followUp.checked, corner: f.corner.checked, streak: f.streak.checked, moodAsk: f.moodAsk.checked, endWait: f.endWait.value, ai: f.ai.checked ? 'auto' : 'off' };
    try { localStorage.setItem('lk.talk', JSON.stringify(t)); } catch {} // localStorage へ直に書くと、PC とスマホで同じになる（shim.js が見ている）
    voicePrefs(t);
    if (talk) talk.settings = t;
    drawTalkHead(); drawPochi();
  };
  // 声の名前・速さ・高さは voice.js が直に読む（ほかのアプリと同じ置き場）
  function voicePrefs(t) {
    try {
      t.voice ? localStorage.setItem('voice.name', t.voice) : localStorage.removeItem('voice.name');
      for (const k of ['rate', 'pitch']) t[k] ? localStorage.setItem('voice.' + k, String(t[k])) : localStorage.removeItem('voice.' + k);
    } catch {}
  }
  $('#voiceTry').onclick = () => {
    const f = $('#talkSetForm'), keep = {};
    try { for (const k of ['name', 'rate', 'pitch']) keep[k] = localStorage.getItem('voice.' + k); } catch {}
    voicePrefs({ voice: f.voice.value, rate: +f.rate.value, pitch: +f.pitch.value });
    window.Voice?.speak(`${f.name.value || 'ポチ'}だよ。今日もいっしょに片づけよう。この速さでいいかな？`).finally(() => {
      try { for (const k in keep) keep[k] == null ? localStorage.removeItem('voice.' + k) : localStorage.setItem('voice.' + k, keep[k]); } catch {}
    });
  };
  $('#talkReset').onclick = () => { try { for (const k of ['lk.talk', 'voice.name', 'voice.rate', 'voice.pitch']) localStorage.removeItem(k); } catch {} $('#talkSet').close(); drawTalkHead(); openTalkSet(); };

  // ---------- つなぐ ----------
  function idb() { return new Promise((ok, ng) => { const r = indexedDB.open('local-board', 1); r.onupgradeneeded = () => r.result.createObjectStore('h'); r.onsuccess = () => ok(r.result); r.onerror = () => ng(r.error); }); }
  async function saveHandle(h) { try { const db = await idb(); db.transaction('h', 'readwrite').objectStore('h').put(h, 'root'); } catch {} }
  async function loadHandle() { try { const db = await idb(); return await new Promise(ok => { const r = db.transaction('h').objectStore('h').get('root'); r.onsuccess = () => ok(r.result || null); r.onerror = () => ok(null); }); } catch { return null; } }
  async function useFolder(h, ask = true) {
    let p = await h.queryPermission({ mode: 'readwrite' });
    if (p !== 'granted' && ask) p = await h.requestPermission({ mode: 'readwrite' });
    if (p !== 'granted') { if (ask) setStatus('フォルダへの書き込みが許可されませんでした。', 'err'); return false; }
    try { await h.getDirectoryHandle('board'); }
    catch { setStatus('このフォルダには board がありません。データのリポジトリのフォルダそのものを選んでください。', 'err'); return false; }
    await saveHandle(h); ls.set('mode', 'folder');
    await L.connect(L.folderStore(h)).catch(() => {}); return true;
  }
  function tokenUrl(owner) {
    // 鍵の名前はアカウントの中で重ならないようにする（端末ごとに1つ作る）
    const name = 'カンバン-' + (matchMedia('(max-width: 760px)').matches ? 'スマホ' : 'PC') + '-' + new Date().toISOString().slice(0, 16).replace(/\D/g, '');
    const q = new URLSearchParams({ name, description: 'カンバン（local-kanban）がカードを読み書きするための鍵', expires_in: '366', contents: 'write' });
    if (owner) q.set('target_name', owner);
    return 'https://github.com/settings/personal-access-tokens/new?' + q;
  }
  $('#ghMake').onclick = () => window.open(tokenUrl($('#ghForm').owner.value.trim()), '_blank', 'noopener');
  function openGithub() {
    const f = $('#ghForm'), cfg = ls.get('gh') || {};
    f.owner.value = cfg.owner || ''; f.repo.value = cfg.repo || ''; f.branch.value = cfg.branch || 'main'; f.token.value = '';
    f.token.placeholder = cfg.token ? '（前に貼った鍵を使う）' : 'github_pat_…';
    $('#ghDlg').showModal();
  }
  $('#ghForm').onsubmit = e => {
    if (e.submitter?.value !== 'ok') return;
    const f = e.target, old = ls.get('gh') || {};
    const cfg = { owner: f.owner.value.trim(), repo: f.repo.value.trim(), branch: f.branch.value.trim() || 'main', token: f.token.value.trim() || old.token };
    if (!cfg.token) { e.preventDefault(); f.token.focus(); return; }
    ls.set('gh', cfg); ls.set('mode', 'github');
    L.connect(L.ghStore(cfg)).catch(() => {});
  };
  $('#ghForget').onclick = () => { ls.set('gh', null); ls.set('cache', null); if (ls.get('mode') === 'github') ls.set('mode', null); $('#ghDlg').close(); setStatus('この端末の鍵を消しました。', 'warn'); };
  // 消す・戻すボタンは2回押しで（1回目は「もう一度押すと…」に変わり、4秒で元に戻る）。ブラウザの確かめる窓は出さない（v35 の点検：押し間違えで消えた）
  function twoStep(sel, again) {
    const b = $(sel); const go = b.onclick; let t = 0, label = '';
    b.onclick = e => {
      if (b.dataset.sure) { clearTimeout(t); delete b.dataset.sure; b.textContent = label; return go.call(b, e); }
      label = b.textContent; b.dataset.sure = '1'; b.textContent = again;
      t = setTimeout(() => { delete b.dataset.sure; b.textContent = label; }, 4000);
    };
  }
  twoStep('#talkReset', 'もう一度押すと元に戻します'); twoStep('#ghForget', 'もう一度押すと鍵を消します');
  twoStep('#memAll', 'もう一度押すと全部忘れます'); twoStep('#aiDel', 'もう一度押すと AI を消します'); twoStep('#koeDel', 'もう一度押すと声を消します');
  async function openFolder() {
    if (!window.showDirectoryPicker) { setStatus('このブラウザは PC のフォルダを開けません（スマホ・Firefox・Safari）。「GitHub でつなぐ」を使ってください。', 'err'); return; }
    try { await useFolder(await window.showDirectoryPicker({ id: 'kanban-data', mode: 'readwrite' })); }
    catch (e) { if (e.name !== 'AbortError') setStatus('開けませんでした: ' + e.message, 'err'); }
  }
  function download() {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([L.json()], { type: 'application/json' }));
    a.download = 'cards.json'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    setStatus('cards.json をダウンロードしました。データのリポジトリの local-board フォルダに置いてください。', 'warn');
  }
  // 設定のリンク（つなぎ先だけ。鍵は入れない）
  function setupLink() { const cfg = ls.get('gh'); if (!cfg) return null; return location.origin + location.pathname + '#' + new URLSearchParams({ repo: cfg.owner + '/' + cfg.repo, branch: cfg.branch }); }
  async function showPhoneQr() {
    const link = setupLink(); if (!link) return;
    try {
      if (!window.qrcode) await new Promise((ok, ng) => { const s = document.createElement('script'); s.src = 'qrcode.js'; s.onload = ok; s.onerror = ng; document.head.appendChild(s); });
      const qr = qrcode(0, 'M'); qr.addData(link); qr.make();
      $('#qrBox').innerHTML = qr.createSvgTag({ cellSize: 5, margin: 2 });
      $('#qrDlg').showModal();
    } catch { setStatus('QR を出せませんでした。公開ページから開いてください。', 'err'); }
  }
  $('#qrClose').onclick = () => $('#qrDlg').close();
  let installEvt = null;
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; $('[data-m=install]').hidden = false; });
  // 命令も会話と同じ欄で打つ（入口を一つにした。2026-10-20 satouさん「チャットと声で入力のやり方が違う」）
  function openCmd() { if (L.ready) openTalk('text'); }
  // キーボード：Ctrl+K（Mac は ⌘K）で会話の欄に打つ、m で🎤、t で会話（n と / はボードのまま）
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') { e.preventDefault(); openCmd(); return; }
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || document.querySelector('dialog[open]');
    // ボードの「？ 印」の「使う」を外すと 1文字のキーは止まる（ボード v51 と同じ localStorage。WCAG 2.1.4）
    let keysOff = false; try { keysOff = localStorage.getItem('kanban-keys') === '0'; } catch {}
    if (typing || keysOff || e.isComposing || e.ctrlKey || e.metaKey || e.altKey || !L.ready) return;
    if (e.key === 'm' || e.key === 'M') { e.preventDefault(); micGo(); }
    else if (e.key === 't' || e.key === 'T') { e.preventDefault(); openTalk('talk'); }
  });
  const actions = { notify: toggleNotify, aiset: openTalkSet, github: openGithub, phone: showPhoneQr, cmd: openCmd, folder: openFolder, file: () => $('#fileInput').click(), download,
    install: async () => { if (installEvt) { installEvt.prompt(); installEvt = null; $('[data-m=install]').hidden = true; } } };
  // メニューから開いた画面を閉じたら ⋯ にキーボードの位置を戻す（閉じた details の中には戻れない。v35 の点検）
  document.querySelectorAll('[data-m]').forEach(b => b.addEventListener('click', () => { const inMenu = $('#lkMenu').contains(b); $('#lkMenu').open = false; if (inMenu) $('#lkMenu summary').focus(); actions[b.dataset.m](); }));
  $('#lkMenu').addEventListener('keydown', e => { if (e.key === 'Escape' && $('#lkMenu').open) { e.preventDefault(); e.stopPropagation(); $('#lkMenu').open = false; $('#lkMenu summary').focus(); } });
  document.addEventListener('click', e => { if (!$('#lkMenu').contains(e.target)) $('#lkMenu').open = false; });
  $('#reopenBtn').onclick = async () => { const h = await loadHandle(); if (h) { try { await useFolder(h); } catch { setStatus('前回のフォルダを開けませんでした。「PC のフォルダを開く」から選び直してください。', 'err'); } } };
  $('#reloadBtn').onclick = () => L.reload().catch(e => setStatus('読めませんでした: ' + e.message, 'err'));
  $('#fileInput').onchange = async e => {
    const fs = [...e.target.files], f = fs.find(x => !/\.html?$/i.test(x.name)), h = fs.find(x => /\.html?$/i.test(x.name));
    if (!f) { if (fs.length) setStatus('cards.json も一緒に選んでください。', 'err'); e.target.value = ''; return; }
    try { ls.set('mode', null); await L.connect(L.fileStore(f.name, await f.text(), h ? await h.text() : null)); setStatus(`読みました: ${f.name}（このやり方では自動で保存しません。「⋯ → ダウンロードで保存」を使います）`, 'warn'); }
    catch (err) { setStatus('読めませんでした: ' + err.message, 'err'); }
    e.target.value = '';
  };
  if (!window.showDirectoryPicker) $('#folderChoice').hidden = true;

  // ---------- スマホ：カードの所を左右になぞると、隣の列へ ----------
  (() => {
    let s = null;
    const board = document.getElementById('board'); if (!board) return;
    board.addEventListener('pointerdown', e => { s = (e.pointerType === 'touch' && matchMedia('(max-width:760px)').matches) ? { x: e.clientX, y: e.clientY, t: Date.now() } : null; });
    board.addEventListener('pointercancel', () => { s = null; });
    board.addEventListener('pointerup', e => {
      if (!s) return;
      const dx = e.clientX - s.x, dy = e.clientY - s.y, dt = Date.now() - s.t; s = null;
      if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 2 || dt > 800) return;
      const lanes = [...board.querySelectorAll('.lane')]; if (!lanes.length) return;
      const top = 70; // 一番上に見えている列
      let i = lanes.findIndex(l => l.getBoundingClientRect().bottom > top); if (i < 0) i = lanes.length - 1;
      const j = Math.min(lanes.length - 1, Math.max(0, i + (dx < 0 ? 1 : -1))); if (j === i) return;
      document.querySelector(`#jump a[href="#${lanes[j].id}"]`)?.click() || lanes[j].scrollIntoView({ block: 'start' });
    });
  })();

  // ---------- 知らせ（通知）：アプリを開いているあいだ（裏に回していても）、端末の通知で知らせる ----------
  // 知らせるもの：押して答える確認が来た・エージェントから satouさんの番に戻ってきた・今日が期限（1日1回）。
  // 通知は端末の中で作る（Web Push のようにサーバーを通さない）。閉じているあいだは届かない（予定の前の知らせは Google カレンダーに任せる）。
  const canNotify = () => 'Notification' in window && location.protocol !== 'file:';
  const notifyOn = () => canNotify() && ls.get('notify') === true && Notification.permission === 'granted';
  function drawNotify() { const b = $('[data-m=notify]'); b.hidden = !canNotify(); b.textContent = notifyOn() ? '🔔 知らせを止める' : '🔔 知らせを受け取る'; b.setAttribute('aria-pressed', String(notifyOn())); }
  async function toggleNotify() {
    if (notifyOn()) { ls.set('notify', false); drawNotify(); setStatus('この端末への知らせを止めました。', 'ok'); return; }
    const p = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    if (p !== 'granted') { setStatus('通知が許可されませんでした（ブラウザかスマホの設定で、このアプリの通知を許可してね）。', 'warn'); drawNotify(); return; }
    ls.set('notify', true); drawNotify(); scanNotify(L.cards, true);
    setStatus('知らせを受け取ります：確認が来たとき・satouさんの番に戻ったとき・今日が期限のとき（アプリを開いているあいだ）。', 'ok');
  }
  const today = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10); // 日本の日付
  function noteKeys(c) {
    if (c.deleted || c.lane === 'done') return [];
    const k = [];
    // 知らせの文はポチの言葉で、何が起きたかを具体的に短く（C5。Apple の手引き）。鳴らす回数は前と同じ
    const p = (talkSettings().name || 'ポチ') + '：';
    if (c.decision && !c.answer && c.owner !== 'agent') k.push(['ask:' + c.doc_id, p + '確認が来てるよ', c.decision.question || c.title]);
    const back = (c.moves || []).at(-1);
    if (c.owner !== 'agent' && back && back.from === 'agent') k.push(['back:' + c.doc_id + ':' + back.at, p + 'satouさんの番だよ', c.title]);
    if (c.due && c.due <= today() && c.lane !== 'wait') k.push(['due:' + c.doc_id + ':' + today(), p + (c.due < today() ? '期限すぎちゃってるよ' : '今日までだよ！'), c.title]);
    return k;
  }
  // 初めては今あるものを「知らせ済み」にするだけ（いっぺんに鳴らさない。期限だけは知らせる）
  function scanNotify(cs, first) {
    if (!notifyOn() || !Array.isArray(cs)) return;
    const seen = ls.get('notified') || {}, fresh = {}, out = [];
    for (const c of cs) for (const [key, head, body] of noteKeys(c)) { fresh[key] = 1; if (!seen[key] && (!first || key.startsWith('due:'))) out.push({ key, head, body, id: c.doc_id }); }
    // 知らせたものを覚える（同じことを二度鳴らさない。古いものから捨てて 500 件まで）
    ls.set('notified', Object.fromEntries(Object.entries({ ...seen, ...fresh }).slice(-500)));
    for (const n of out.slice(0, 5)) {
      const opt = { body: n.body, tag: n.key, icon: 'icon-192.png', badge: 'icon-192.png', data: { url: './' } };
      (navigator.serviceWorker?.ready || Promise.reject()).then(r => r.showNotification(n.head, opt)).catch(() => { try { new Notification(n.head, opt); } catch {} });
    }
  }
  window.addEventListener('lk:connected', () => {
    drawNotify();
    window.claude.use('db').then(db => { let first = true; db.collection('cards').onSnapshot(() => {
      scanNotify(L.cards, first && !ls.get('notified')); first = false;
      try { pochiTick(); } catch {}
      // インストールしたアプリのアイコンに数を出す（Badging API。対応していない端末では何もしない）。
      // ボードに「返事が来た」の印（repliedToYou・ボード版44）があれば、「返事あり＋答える」の枚数（ボード版45）。無い古いボードでは「今やる」の枚数
      const ask = c => !c.deleted && c.decision && !c.answer && !['done', 'hold', 'wait'].includes(c.lane);
      const n = typeof window.repliedToYou === 'function'
        ? L.cards.filter(c => { try { if (window.repliedToYou({ ...c, id: c.id || c.doc_id })) return true; } catch {} return ask(c); }).length
        : L.cards.filter(c => !c.deleted && c.lane === 'now').length;
      try { if (navigator.setAppBadge) (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {}); } catch {}
    }); });
  });
  drawNotify();

  // ---------- PWA（https か localhost で開いたときだけ。ファイルを直に開いたときは使わない） ----------
  if (location.protocol !== 'file:' && 'serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  // ---------- 前回の置き場所に自動でつなぐ ----------
  drawWhy();
  (async () => {
    const r = L.entry.repo;
    if (r) { // 設定のリンク（#repo=持ち主/リポジトリ&branch=…）で開いたら、つなぎ先を入れて鍵の画面を出す
      const old = ls.get('gh') || {};
      if (old.owner === r.owner && old.repo === r.repo && old.token) { ls.set('mode', 'github'); return L.connect(L.ghStore(old)).catch(() => {}); }
      ls.set('gh', r); openGithub(); return;
    }
    // ボードの画面を入れて開き直した直後は、選んだ cards.json でもう一度つなぐ
    let picked = null; try { picked = JSON.parse(sessionStorage.getItem('lk.file') || 'null'); sessionStorage.removeItem('lk.file'); } catch {}
    if (picked?.text) return L.connect(L.fileStore(picked.name, picked.text)).catch(() => {});
    const mode = ls.get('mode'), gh = ls.get('gh');
    if (mode === 'github' && gh?.token) return L.connect(L.ghStore(gh)).catch(() => {});
    const h = window.showDirectoryPicker ? await loadHandle() : null;
    if (h) { $('#reopenBtn').hidden = false; if (mode === 'folder') { try { await useFolder(h, false); } catch {} } }
  })();
})();

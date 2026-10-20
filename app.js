// アプリだけの機能（claude.ai のボードには無いもの）。ボードの画面（index.html＝ボードの HTML から作る）の上に足す。
//   つなぐ（GitHub・PC のフォルダ・cards.json）・会話モード（talk.js）・🎤（voice.js。端末の中の AI の耳も使う）・命令欄（Ctrl+K）
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
      <button type="button" data-m="cmd" disabled>命令を打つ（Ctrl+K）</button>
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
<dialog id="ghDlg" class="lk">
  <form method="dialog" id="ghForm">
    <h3>GitHub でつなぐ</h3>
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
<dialog id="cmdDlg" class="lk">
  <form method="dialog" id="cmdForm">
    <label for="cmdIn">命令（声と同じ言い方）</label>
    <input id="cmdIn" name="cmd" autocomplete="off" placeholder="例：牛乳を買うを追加 ／ 請求書を済み ／ 請求書を保留へ ／ 今やるを読んで ／ 戻す">
    <p class="help">「〇〇を追加」「今やるに〇〇を追加」「〇〇を済み」「〇〇を&lt;列&gt;へ」「〇〇を消して」「&lt;列&gt;を読んで」「戻す」。n でカードを足す欄、m で🎤、t で会話、/ で探す、Esc で閉じる。</p>
  </form>
</dialog>
<dialog id="talkDlg" class="lk" aria-labelledby="talkName">
  <div class="who"><span id="talkAva"></span><div><p id="talkName"></p><div id="talkState"></div><div id="talkMode" class="help"></div><button type="button" id="talkAiGet" hidden>🧠 AI を入れて自由に話す</button></div></div>
  <div id="talkLog" aria-live="polite"></div>
  <form id="talkForm"><input id="talkIn" autocomplete="off" placeholder="打って話す（例：済み・あとで・保留・次）"><button class="primary">送る</button></form>
  <div class="lk-actions"><button type="button" id="talkSetBtn">⚙ キャラの設定</button><button type="button" id="talkEnd">終わる</button></div>
</dialog>
<dialog id="talkSet" class="lk">
  <form method="dialog" id="talkSetForm">
    <h3>キャラの設定</h3>
    <label>名前</label><input name="name" maxlength="20" required>
    <label>性格と話し方（AI への指示）</label><textarea name="persona" maxlength="600"></textarea>
    <label>アイコン</label>
    <div class="icons" id="talkIcons"></div>
    <label>色</label><input name="color" type="color">
    <label>声（この端末の中の声だけ。ネット経由の声は出しません）</label><select name="voice"></select>
    <label class="chk"><input type="checkbox" name="bargeIn"> 話の途中で割り込める（話している間だけマイクの音の大きさを端末の中で見る）</label>
    <label class="chk"><input type="checkbox" name="ai"> 端末の中の AI（Chrome の内蔵 AI か、下で入れた AI）があれば使う</label>
    <p class="help">声も会話も端末の外に出しません。AI が無い端末では、カードを1枚ずつ読み上げて「済み・あとで・保留・次」で片づけます。キャラの設定は、つないでいればデータのリポジトリにも置き、PC とスマホで同じになります。</p>
    <fieldset id="aiBox">
      <legend>スマホでも AI と話す（端末の中の AI）</legend>
      <p id="aiStat" class="help"></p>
      <progress id="aiProg" max="1" value="0" hidden></progress>
      <p id="aiMsg" class="help" aria-live="polite"></p>
      <div class="lk-actions"><button type="button" id="aiGet"></button><button type="button" id="aiDel" hidden>入れた AI を消す</button></div>
      <p class="help">押したときだけ、モデルのファイルを Hugging Face（huggingface.co）と GitHub（raw.githubusercontent.com）から1回取ってきて、この端末に保存します。以後はオフラインで動きます。取りに行くのはモデルだけで、会話やカードは送りません。大きいので Wi-Fi のときに押してください。</p>
    </fieldset>
    <div class="lk-actions"><button type="button" id="talkReset">元に戻す</button>
      <span><button value="cancel" formnovalidate>やめる</button> <button value="ok" class="primary">保存</button></span></div>
  </form>
</dialog>
<dialog id="qrDlg" class="lk">
  <h3>スマホでも開く</h3>
  <p class="help">スマホのカメラでこの QR を読んで開くと、つなぎ先（持ち主・リポジトリ）が入った状態で始まります。鍵は入っていないので、スマホでも「鍵を作るページを開く」から1つ作って貼ってください。</p>
  <div id="qrBox"></div>
  <div class="lk-actions"><span></span><button type="button" id="qrClose" class="primary">閉じる</button></div>
</dialog>`);

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
  const laneCards = lane => live().filter(c => (c.lane || 'next') === lane && (lane !== 'done' || !c.done_at || Date.parse(c.done_at) >= Date.now() - 7 * 864e5))
    .sort((a, b) => lane === 'done' ? String(b.done_at || '').localeCompare(String(a.done_at || '')) : (a.order ?? 0) - (b.order ?? 0));
  // undo：声・命令で動かしたときは、数秒「戻す」を出す（聞き間違えたらすぐ戻せる）
  function reply(text, voice, undo) {
    const vs = $('#vstatus'); if (vs && !$('#voice').hidden) vs.textContent = text;
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
    (document.querySelector('#cmdDlg[open] form, #talkDlg[open]') || $('#lkBar')).appendChild(box);
    box.innerHTML = list.map((c, i) => `<button type="button" data-pick="${i + 1}">${i + 1}. ${esc(c.title)}</button>`).join('') + '<button type="button" data-pick="0">やめる</button>';
    box.hidden = false;
  }
  const hidePick = () => { const b = $('#lkPick'); if (b) b.hidden = true; };
  document.addEventListener('click', e => {
    const b = e.target.closest?.('#lkPick [data-pick]'); if (!b) return;
    e.preventDefault(); hidePick();
    const t = b.dataset.pick === '0' ? 'いいえ' : b.dataset.pick;
    if (talk?.on && $('#talkDlg').open) talk.hear(t); else runCommand(t);
    if (!pending && $('#cmdDlg').open) $('#cmdDlg').close();
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
      case 'done': case 'move': case 'delete': {
        if (!L.writable()) return reply('いまは保存できないので動かせません。', voice);
        let c = cmd.card;
        if (!c) {
          const pool = cmd.type === 'done' ? live().filter(x => x.lane !== 'done') : live();
          const r = findCard(cmd, pool, voice); if (!r.card) return r.say;
          c = r.card;
        }
        if (cmd.type === 'delete') {
          if (!cmd.sure) { pending = { cmd, card: c, confirm: true }; return reply(`「${c.title}」を消しますか？ はい か いいえ で答えてください。`, voice); }
          remove(c.id);
          return reply(`「${c.title}」を消しました。戻すときは「戻す」。`, voice, () => L.undo());
        }
        const lane = cmd.type === 'done' ? 'done' : cmd.lane;
        if (c.lane === lane) return reply(`「${c.title}」はもう${LANE_LABEL[lane]}です。`, voice);
        move(c.id, lane);
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

  // 🎤：ボードの🎤を、端末の中の AI の耳も使える voice.js に置き換える（声は端末の外に出さない）
  let listening = false;
  async function listenOnce() {
    if (listening || !L.ready) return;
    const box = $('#voice'), vs = $('#vstatus'); if (box) box.hidden = false;
    if (!window.Voice?.supported) { if (vs) vs.textContent = '🎤は、この端末では使えません。「⋯ → 🎤と会話・AI の設定」で AI の部品を入れると使えます。'; return; }
    listening = true; $('#micBtn')?.setAttribute('aria-pressed', 'true'); if (vs) vs.textContent = '聞いています…（端末の中だけで聞き取ります）';
    let heard = false;
    try { const { text } = await Voice.listen(); heard = true; if (vs) vs.textContent = '「' + text + '」'; runCommand(text, true); }
    catch (e) { if (vs) vs.textContent = e.message; drawWhy(); }
    finally { listening = false; $('#micBtn')?.setAttribute('aria-pressed', 'false'); }
    if (heard && pending) setTimeout(listenOnce, 2500); // 聞き返したときは、読み上げが終わってから続けて聞く
  }
  $('#micBtn')?.addEventListener('click', e => { e.stopImmediatePropagation(); listenOnce(); }, true);

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
    if (e.voice) listenOnce();
    if (e.talk) openTalk();
  }

  // ---------- 会話モード（talk.js。すべて端末の中） ----------
  const talkSettings = () => ({ ...(window.Talk?.DEFAULTS || {}), ...(ls.get('talk') || {}) });
  let talk = null;
  function talkLine(who, text) {
    const d = document.createElement('div'); d.className = 'l ' + who; d.textContent = text;
    const box = $('#talkLog'); box.appendChild(d); while (box.children.length > 30) box.firstChild.remove(); box.scrollTop = box.scrollHeight;
  }
  const TALK_STATE = { starting: '準備しています…', listening: '聞いてるよ（話してね）', thinking: '考え中…', speaking: '話しています（割り込めます）', typing: '下の欄に打って話してね', off: '' };
  function drawTalkHead() { const t = talkSettings(); $('#talkAva').innerHTML = Talk.avatarSvg(t.icon, t.color); $('#talkName').textContent = t.name; }
  const order = l => L.LANES.findIndex(([k]) => k === l);
  function openTalk() {
    if (!window.Talk || !L.ready) return;
    if (talk?.on) { if (!$('#talkDlg').open) $('#talkDlg').showModal(); return; }
    drawTalkHead(); $('#talkLog').innerHTML = ''; $('#talkMode').textContent = ''; $('#talkAiGet').hidden = true;
    talk = Talk.create({
      settings: talkSettings(),
      lanes: LANE_LABEL, laneWords: WORDS,
      // AI に渡すのは題・列・期限だけ（補足・履歴・リンクは渡さない）
      board: () => live().filter(c => c.lane !== 'done').sort((a, b) => order(a.lane) - order(b.lane) || (a.order || 0) - (b.order || 0)).map(c => ({ title: c.title, lane: c.lane, due: c.due || '' })),
      queue: () => ['now', 'next'].flatMap(laneCards),
      run: t => runCommand(t),
      act: cmd => apply(cmd, false),
      pending: () => !!pending,
      onLine: talkLine,
      onState: st => { $('#talkState').textContent = TALK_STATE[st] ?? ''; $('#talkDlg').classList.toggle('speaking', st === 'speaking'); if (st === 'off' && $('#talkDlg').open) $('#talkDlg').close(); },
      onMode: (m, brain, why) => {
        $('#talkMode').textContent = m === 'ai'
          ? '🧠 AI と話しています（' + (brain === 'webllm' ? '入れた WebLLM' : 'Chrome の内蔵 AI') + '・端末の中だけ）'
          : why === 'off' ? '📋 AI なし：設定で切っています（決まった返事で1枚ずつ聞きます）' : '📋 AI なし：決まった返事で1枚ずつ聞きます';
        $('#talkMode').dataset.ai = m === 'ai' ? 'on' : 'off';
        // AI なしで、入れれば使える端末（WebGPU がある）なら、入れる場所への近道を出す
        $('#talkAiGet').hidden = m === 'ai' || why === 'off' || !window.LocalAI || !navigator.gpu || LocalAI.llmReady();
      },
    });
    $('#talkDlg').showModal();
    talk.start();
  }
  $('#talkBtn').onclick = openTalk;
  $('#talkEnd').onclick = () => { talk?.stop(); if ($('#talkDlg').open) $('#talkDlg').close(); };
  $('#talkDlg').addEventListener('cancel', () => talk?.stop());
  $('#talkForm').onsubmit = e => { e.preventDefault(); const t = $('#talkIn').value; $('#talkIn').value = ''; talk?.hear(t); };
  function openTalkSet() {
    if (!window.Talk) { setStatus('会話の部品（talk.js）を読めませんでした。開き直してみてください。', 'err'); return; }
    const f = $('#talkSetForm'), t = talkSettings();
    f.name.value = t.name; f.persona.value = t.persona; f.color.value = t.color; f.bargeIn.checked = !!t.bargeIn; f.ai.checked = t.ai !== 'off';
    $('#talkIcons').innerHTML = ['maru', 'kaku', 'shizuku'].map(k => `<label><input type="radio" name="icon" value="${k}" ${k === t.icon ? 'checked' : ''} aria-label="${{ maru: 'まる', kaku: 'しかく', shizuku: 'しずく' }[k]}">${Talk.avatarSvg(k, t.color)}</label>`).join('');
    const vs = (window.speechSynthesis?.getVoices() || []).filter(v => v.localService && /^ja/.test(v.lang));
    f.voice.innerHTML = '<option value="">おまかせ</option>' + vs.map(v => `<option ${v.name === t.voice ? 'selected' : ''}>${esc(v.name)}</option>`).join('') + (vs.length ? '' : '<option disabled>（この端末に日本語の声がありません）</option>');
    drawAi();
    $('#talkSet').showModal();
  }
  $('#talkSetBtn').onclick = openTalkSet;
  // まだ送っていない変更の数（オフラインなど）。送れたら消える
  setInterval(() => { const n = L.unsent ? L.unsent() : 0, el = $('#lkUnsent'); if (!el) return; el.hidden = !n; if (n) el.textContent = `未送信 ${n}件（つながったら自動で送ります）`; }, 1000);
  $('#talkAiGet').onclick = () => { openTalkSet(); $('#aiBox')?.scrollIntoView({ block: 'center' }); $('#aiGet')?.focus(); };
  function drawAi() {
    const A = window.LocalAI; if (!A) { $('#aiBox').hidden = true; return; }
    const st = A.status(), p = A.plan();
    $('#aiStat').textContent = st.llm
      ? `入っています：頭 ${st.llm}${st.ear ? '・耳 ' + A.EAR.label : ''}（${st.at} に ${[...new Set(st.from.map(f => f.split('/')[0]))].join('・')} から取得）`
      : `まだ入っていません。入れると、Chrome の内蔵 AI が無い端末（スマホなど）でも AI と話せます（頭 ${p.model}${p.ear ? '・耳 ' + A.EAR.label : ''}）。`;
    $('#aiGet').textContent = st.llm ? '入れ直す' : `AI の部品を入れる（約 ${p.gb}GB）`;
    $('#aiDel').hidden = !st.llm;
  }
  let aiBusy = false;
  $('#aiGet').onclick = async () => {
    if (aiBusy || !window.LocalAI) return;
    aiBusy = true; $('#aiGet').disabled = true; $('#aiProg').hidden = false; $('#aiProg').value = 0; $('#aiMsg').textContent = '取ってきています…（画面を閉じずに待ってね）';
    try { await LocalAI.install((v, what) => { $('#aiProg').value = v; if (what) $('#aiMsg').textContent = String(what).slice(0, 120); }); $('#aiMsg').textContent = '入りました。会話モードと🎤で使えます。'; }
    catch (e) { $('#aiMsg').textContent = '入れられませんでした：' + (e?.message || e); }
    finally { aiBusy = false; $('#aiGet').disabled = false; $('#aiProg').hidden = true; drawAi(); drawWhy(); }
  };
  $('#aiDel').onclick = async () => { if (aiBusy || !window.LocalAI) return; await LocalAI.remove(); $('#aiMsg').textContent = 'この端末から消しました。'; drawAi(); drawWhy(); };
  $('#talkSetForm').onsubmit = e => {
    if (e.submitter?.value !== 'ok') return;
    const f = e.target;
    const t = { name: f.name.value.trim() || Talk.DEFAULTS.name, persona: f.persona.value.trim() || Talk.DEFAULTS.persona, icon: f.icon.value || 'maru', color: f.color.value, voice: f.voice.value, bargeIn: f.bargeIn.checked, ai: f.ai.checked ? 'auto' : 'off' };
    try { localStorage.setItem('lk.talk', JSON.stringify(t)); } catch {} // localStorage へ直に書くと、PC とスマホで同じになる（shim.js が見ている）
    try { t.voice ? localStorage.setItem('voice.name', t.voice) : localStorage.removeItem('voice.name'); } catch {}
    if (talk) talk.settings = t;
    drawTalkHead();
  };
  $('#talkReset').onclick = () => { try { localStorage.removeItem('lk.talk'); localStorage.removeItem('voice.name'); } catch {} $('#talkSet').close(); drawTalkHead(); openTalkSet(); };

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
  function openCmd() { if (!L.ready) return; $('#cmdIn').value = ''; $('#cmdDlg').showModal(); $('#cmdIn').focus(); }
  $('#cmdForm').onsubmit = e => {
    e.preventDefault();
    const t = $('#cmdIn').value; $('#cmdIn').value = '';
    runCommand(t);
    if (pending) $('#cmdIn').placeholder = '番号か、はい／いいえ'; else { $('#cmdIn').placeholder = '例：牛乳を買うを追加'; $('#cmdDlg').close(); }
  };
  // キーボード：Ctrl+K（Mac は ⌘K）で命令欄、m で🎤、t で会話（n と / はボードのまま）
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') { e.preventDefault(); openCmd(); return; }
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || document.querySelector('dialog[open]');
    if (typing || e.ctrlKey || e.metaKey || e.altKey || !L.ready) return;
    if (e.key === 'm' || e.key === 'M') { e.preventDefault(); listenOnce(); }
    else if (e.key === 't' || e.key === 'T') { e.preventDefault(); openTalk(); }
  });
  const actions = { notify: toggleNotify, aiset: openTalkSet, github: openGithub, phone: showPhoneQr, cmd: openCmd, folder: openFolder, file: () => $('#fileInput').click(), download,
    install: async () => { if (installEvt) { installEvt.prompt(); installEvt = null; $('[data-m=install]').hidden = true; } } };
  document.querySelectorAll('[data-m]').forEach(b => b.addEventListener('click', () => { $('#lkMenu').open = false; actions[b.dataset.m](); }));
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
    if (c.decision && !c.answer && c.owner !== 'agent') k.push(['ask:' + c.doc_id, '確認が来ました', c.decision.question || c.title]);
    const back = (c.moves || []).at(-1);
    if (c.owner !== 'agent' && back && back.from === 'agent') k.push(['back:' + c.doc_id + ':' + back.at, 'satouさんの番になりました', c.title]);
    if (c.due && c.due <= today() && c.lane !== 'wait') k.push(['due:' + c.doc_id + ':' + today(), c.due < today() ? '期限を過ぎています' : '今日が期限です', c.title]);
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
      // インストールしたアプリのアイコンに「今やる」の枚数（Windows・Mac）
      const n = L.cards.filter(c => !c.deleted && c.lane === 'now').length;
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

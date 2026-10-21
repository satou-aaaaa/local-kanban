// claude.ai のボードの HTML を、そのままこのアプリで動かすための部品。
// ボードは window.claude.use("db"/"comments"/"user"/"assets") でデータを読み書きする。
// ここではそれを、データのリポジトリ（非公開）の local-board/cards.json を読み書きする形に差し替える。
// ボードの HTML 自体も、データのリポジトリの board/index.html（毎日の写し）から読む（boot.js）。このリポジトリ（公開）にはボードを置かない。
//   読む : local-board/cards.json（無ければ board/cards.json＝毎日の写し）・local-board/settings.json・board/today.json・board-src/kanban.html（無ければ board/index.html）
//   書く : local-board/cards.json・local-board/BOARD.md・local-board/settings.json・local-board/pochi-memory.json・local-board/diagnostics/*.json（この端末の診断。会話の中身は入れない）だけ（board/ は毎日の書き出しが上書きするので触らない）
// 置き場所は3通り：GitHub（端末に貼った鍵）・PC のフォルダ（File System Access API）・cards.json を選ぶ（保存はダウンロード）。
// 鍵はこの端末の localStorage（lk.gh）にだけ置き、api.github.com 以外へは送らない。
'use strict';
(function () {
  const LOCAL = 'local-board/cards.json', BASE = 'board/cards.json', MD = 'local-board/BOARD.md';
  const SETTINGS = 'local-board/settings.json', MEMORY = 'local-board/pochi-memory.json', TODAY = 'board/today.json', BOARD_HTML = 'board/index.html', BOARD_SRC = 'board-src/kanban.html';
  const INBOX = 'local-board/inbox.json', INBOX_BRANCH = 'app-inbox';
  const LANES = [['now', '今やる'], ['next', '次にやる'], ['wait', '予定待ち'], ['later', '時間があるとき'], ['hold', '保留'], ['agent', 'エージェントが進行中'], ['done', '済み']];
  // PC とスマホで同じにする設定（見た目・カードの文字の量・キャラ）。並べ替え・絞り込み・開いた列などは端末ごと
  const SYNC_KEYS = ['kanban-theme', 'kanban-pal', 'kanban-wp', 'kanban-veil', 'kanban-glass', 'kanban-daily', 'kanban-density', 'lk.talk', 'voice.name'];
  const now = () => new Date().toISOString();
  const raw = { get: Storage.prototype.getItem, set: Storage.prototype.setItem, del: Storage.prototype.removeItem };
  const ls = {
    get(k) { try { return JSON.parse(raw.get.call(localStorage, 'lk.' + k)); } catch { return null; } },
    set(k, v) { try { v == null ? raw.del.call(localStorage, 'lk.' + k) : raw.set.call(localStorage, 'lk.' + k, JSON.stringify(v)); } catch {} },
  };

  // ---------- URL から来た操作は、ボードが読む前に取っておく（#add はボードでは入力欄に入れるだけなので、アプリの側で足す） ----------
  const entry = {};
  try {
    const q = new URLSearchParams(location.search), h = new URLSearchParams(location.hash.slice(1));
    const shared = [q.get('title'), q.get('text')].filter(Boolean).join(' ').trim();
    const url = q.get('url') || (shared.match(/https?:\/\/\S+/) || [])[0] || '';
    if (shared || url) entry.add = { title: shared.replace(url, '').trim() || url, link: url, lane: 'next' };
    const okLane = l => LANES.some(([k]) => k === l);
    if (h.get('add')) entry.add = { title: h.get('add'), lane: okLane(h.get('lane')) ? h.get('lane') : 'next', due: h.get('due') || '', note: h.get('note') || '' };
    if (h.get('cmd')) entry.cmd = h.get('cmd');
    if (h.has('new')) entry.form = true;
    if (h.has('voice')) entry.voice = true;
    if (h.has('talk')) entry.talk = true;
    if (h.get('card')) entry.card = h.get('card'); // 知らせを押して開いた（sw.js）
    if (!entry.add && okLane(h.get('lane'))) entry.lane = h.get('lane');
    const [owner, repo] = (h.get('repo') || '').split('/');
    if (owner && repo) entry.repo = { owner, repo, branch: h.get('branch') || 'main' };
    if (location.search || location.hash.length > 1) history.replaceState(null, '', location.pathname);
    // 新しいボードを取って開き直したとき（下の connect）にも、URL から来た操作をなくさない
    const kept = sessionStorage.getItem('lk.entry'); sessionStorage.removeItem('lk.entry');
    if (kept && !Object.keys(entry).length) Object.assign(entry, JSON.parse(kept));
  } catch {}

  // ================= 置き場所 =================
  function ghStore(cfg) {
    const api = p => `https://api.github.com/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/contents/${p}`;
    const hdr = () => ({ 'Authorization': 'Bearer ' + cfg.token, 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' });
    const dec = b64 => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, '')), c => c.charCodeAt(0)));
    const enc = s => { const b = new TextEncoder().encode(s); let t = ''; for (let i = 0; i < b.length; i += 0x8000) t += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(t); };
    const shas = {}, tags = {}, texts = {};
    async function get(p) {
      // 前と同じなら 304 が返る（GitHub の回数制限に数えられない）
      const h = hdr(); if (tags[p]) h['If-None-Match'] = tags[p];
      const r = await fetch(api(p) + '?ref=' + encodeURIComponent(cfg.branch), { headers: h, cache: 'no-store' });
      if (r.status === 304 && p in texts) return texts[p];
      if (r.status === 404) { delete shas[p]; delete tags[p]; return null; }
      if (r.status === 401) throw new Error('鍵が違うか、期限が切れています（⋯ →「GitHub でつなぐ」から貼り直す）');
      if (r.status === 403) throw new Error('鍵にこのリポジトリを読む権限がありません');
      if (!r.ok) throw new Error('GitHub から読めません（' + r.status + '）');
      const j = await r.json(); shas[p] = j.sha; texts[p] = dec(j.content);
      if (r.headers.get('ETag')) tags[p] = r.headers.get('ETag');
      return texts[p];
    }
    async function put(p, text, why) {
      const body = { message: 'ローカル版ボード: ' + why, content: enc(text), branch: cfg.branch };
      if (shas[p]) body.sha = shas[p];
      const r = await fetch(api(p), { method: 'PUT', headers: { ...hdr(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (r.status === 409 || r.status === 422) { const e = new Error('conflict'); e.conflict = true; throw e; }
      if (r.status === 401 || r.status === 403) throw new Error('鍵に書く権限がありません（Contents を Read and write にする）');
      if (!r.ok) throw new Error('GitHub に書けません（' + r.status + '）');
      shas[p] = (await r.json()).content.sha; delete tags[p];
    }
    // Claude を起こす印（データ側の app-inbox ブランチの local-board/inbox.json）。中身は時刻と件数だけ。ブランチが無ければ何もしない
    async function ping(n) {
      const u = api(INBOX) + '?ref=' + INBOX_BRANCH, h = hdr();
      const g = await fetch(u, { headers: h, cache: 'no-store' });
      let sha;
      if (g.status === 404) {
        // ブランチはあるのに印のファイルだけ無いときは、sha なしで新しく作る（ブランチが無ければ何もしない）
        const b = await fetch(api(INBOX).replace(/\/contents\/.*$/, '/branches/' + INBOX_BRANCH), { headers: h, cache: 'no-store' });
        if (!b.ok) return false;
      } else if (!g.ok) throw new Error('inbox ' + g.status);
      else sha = (await g.json()).sha;
      const body = { message: 'アプリから：Claude に届けるものがある', content: enc(JSON.stringify({ pending: true, at: new Date().toISOString(), n }) + '\n'), branch: INBOX_BRANCH, sha };
      const r = await fetch(api(INBOX), { method: 'PUT', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return r.ok;
    }
    return {
      kind: 'github', canSave: true, label: `GitHub ${cfg.owner}/${cfg.repo}`, dest: `${cfg.owner}/${cfg.repo}@${cfg.branch}`, ping,
      async read(p) { return get(p); },
      async write(p, text, why) {
        try { await put(p, text, why); }
        catch (e) { if (!e.conflict || p === LOCAL) throw e; await get(p); await put(p, text, why); } // BOARD.md・設定は上書きでよい
      },
      async loadCards() {
        let t = await get(LOCAL), from = LOCAL;
        if (t == null) { t = await get(BASE); from = BASE + '（毎日の写し。保存すると local-board に書きます）'; delete shas[LOCAL]; }
        if (t == null) throw new Error('このリポジトリに board/cards.json がありません');
        if (!(MD in shas)) { try { await get(MD); } catch {} }
        return { text: t, from };
      },
    };
  }

  function folderStore(root) {
    const stamps = {};
    async function file(path) { const parts = path.split('/'); let d = root; for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p); return (await d.getFileHandle(parts.at(-1))).getFile(); }
    async function put(path, text) { const parts = path.split('/'); let d = root; for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true }); const fh = await d.getFileHandle(parts.at(-1), { create: true }); const w = await fh.createWritable(); await w.write(text); await w.close(); return (await fh.getFile()).lastModified; }
    return {
      kind: 'folder', canSave: true, label: 'PC のフォルダ',
      async read(p) { try { const f = await file(p); stamps[p] = f.lastModified; return await f.text(); } catch { return null; } },
      async write(p, text) {
        if (p === LOCAL && stamps[p]) { try { const cur = await file(p); if (cur.lastModified !== stamps[p]) { const e = new Error('conflict'); e.conflict = true; throw e; } } catch (e) { if (e.conflict) throw e; } }
        stamps[p] = await put(p, text);
      },
      async loadCards() {
        let t = await this.read(LOCAL), from = LOCAL;
        if (t == null) { t = await this.read(BASE); from = BASE + '（毎日の写し。保存すると local-board に書きます）'; delete stamps[LOCAL]; }
        if (t == null) throw new Error('このフォルダに board/cards.json がありません。データのリポジトリのフォルダそのものを選んでください。');
        return { text: t, from };
      },
    };
  }

  // html：一緒に選んだボードの画面（board/index.html）。初めての端末はこれが無いと画面が作れない
  // アプリが当てにするボードの部品（AGENTS.md の一覧の要）が文字としてあるか
  function boardOk(t) { return typeof t === 'string' && /<html/i.test(t) && /id=["']?board\b/.test(t) && ['move', 'openDetail', 'say', 'render', 'WPS'].every(n => new RegExp('\\b' + n + '\\b').test(t)); }
  function fileStore(name, text, html = null) {
    return { kind: 'file', canSave: false, label: name, text, async read(p) { return p === BOARD_HTML ? html : null; }, async write() {}, async loadCards() { return { text, from: name }; } };
  }

  // ================= カード =================
  let cards = [];          // cards.json の形のまま（doc_id）
  let store = null, ready = false, dirty = false, saving = false, saveTimer = null, lastWhy = '';
  let rev = 0;             // 変更のたびに増える（読み直しのあいだに変更があったかを見る）
  let ops = [];            // まだ保存していない変更（保存がぶつかったら、読み直した上にもう一度かける）
  const undo = [];         // 「戻す」用（変更の前のカード）
  const listeners = [], todayListeners = [];
  let today = null;
  const statusFns = [];
  const status = (msg, kind = '') => statusFns.forEach(f => { try { f(msg, kind); } catch {} });

  const copy = x => JSON.parse(JSON.stringify(x));
  const byId = id => cards.find(c => c.doc_id === id);
  function toDoc(c) { const d = { ...c }; delete d.doc_id; return { id: c.doc_id, exists: true, data: () => copy(d) }; }
  function emit() {
    const snap = { docs: cards.map(toDoc), size: cards.length, empty: !cards.length };
    for (const [cb] of listeners) { try { cb(snap); } catch (e) { console.error(e); } }
  }
  const newId = () => 'local-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  // Claude に届けられなかった答え・コメント・頼みごと（ボードは "new" にする）は "local" にする。Claude が戻ったら取り込んで届ける（local-board/README.md）
  const DELIVERY = ['answer_status', 'comment_status', 'request_status'];
  const markLocal = o => { for (const k of DELIVERY) if (o && o[k] === 'new') o[k] = 'local'; return o; };
  function applyOp(op) {
    const c = byId(op.id);
    if (op.body) markLocal(op.body); if (op.patch) markLocal(op.patch);
    if (op.kind === 'set') {
      const body = copy(op.body);
      if (c) { Object.keys(c).forEach(k => { if (k !== 'doc_id') delete c[k]; }); Object.assign(c, body, { doc_id: op.id, local_edit: true }); }
      else { delete body.no; cards.push({ doc_id: op.id, ...body, by: body.by || 'you-local', local_edit: true }); } // 番号は Claude が戻って取り込むときに振る（重ならないように）
      return true;
    }
    if (!c) return false;
    for (const [k, v] of Object.entries(op.patch)) { if (v && typeof v === 'object' && v.__delete__) delete c[k]; else c[k] = copy(v); }
    c.local_edit = true; // Claude が戻ったときに取り込む目印
    return true;
  }
  // 誰が直したか。ポチ（会話）が動かしたときは「ポチ」と履歴に残す（ボードの move・remove は履歴を書かないので、ここで足す）
  let actor = '';
  function as(who, fn) { const prev = actor; actor = who; try { return fn(); } finally { actor = prev; } }
  function stamp(op, before) {
    if (!actor) return;
    const at = now();
    if (op.kind === 'set') { const h = op.body.history || []; op.body.history = before ? [...(before.history || []), { at, who: actor, text: '直した' }].slice(-50) : h.length ? h.map((x) => ({ ...x, who: actor })) : [{ at, who: actor, text: '足した' }]; return; }
    if (op.patch.history) return; // 履歴を自分で書く操作（コメントなど）はそのまま
    op.patch.history = [...((before && before.history) || []), { at, who: actor, text: describe(op, true) || '直した' }].slice(-50);
  }
  function mutate(op, why) {
    if (!ready) return Promise.reject(Object.assign(new Error('まだつないでいません'), { code: 'unavailable' }));
    if (!writable()) return Promise.reject(Object.assign(new Error('保存できません'), { code: 'permission_denied' }));
    const before = byId(op.id);
    stamp(op, before);
    undo.push({ id: op.id, before: before ? copy(before) : null, t: Date.now() }); if (undo.length > 60) undo.shift();
    if (!applyOp(op)) { undo.pop(); return Promise.reject(Object.assign(new Error('カードがありません'), { code: 'not_found' })); }
    ops.push(op); rev++; keepOps();
    queueMicrotask(emit);
    persist(why || describe(op), actor);
    return Promise.resolve();
  }
  // bare：題を付けずに何をしたかだけ（履歴の文。題に「」が入っていても崩れない）
  function describe(op, bare) {
    const c = byId(op.id), t0 = (c && c.title || '').slice(0, 30);
    if (bare) return describe(op).replace('「' + t0 + '」', '').replace(/^[をの]/, '');
    const t = t0;
    if (op.kind === 'set') return `「${t}」を足した`;
    const p = op.patch;
    if (p.deleted === true) return `「${t}」を消した`;
    if (p.lane) return `「${t}」を${(LANES.find(([k]) => k === p.lane) || [, p.lane])[1]}へ`;
    if (p.due !== undefined && Object.keys(p).every((k) => ['due', 'updated', 'history'].includes(k))) return `「${t}」の期限を${p.due || 'なし'}に`;
    if (p.answer) return `「${t}」に「${p.answer}」と答えた`;
    return `「${t}」を直した`;
  }
  // ひとつの操作で続けて書いたもの（ボードは「消す」と一緒に印も書く）は、まとめて戻す
  function undoLast() {
    const last = undo.at(-1); if (!last) return false;
    while (undo.length && last.t - undo.at(-1).t <= 800) {
      const u = undo.pop();
      const op = u.before ? { kind: 'set', id: u.id, body: (({ doc_id, ...b }) => b)(u.before) } : { kind: 'update', id: u.id, patch: { deleted: true, deleted_at: now() } };
      applyOp(op); ops.push(op);
    }
    keepOps(); queueMicrotask(emit); persist('ひとつ前に戻した');
    return true;
  }
  const writable = () => !!store && (store.canSave || store.kind === 'file');
  // まだ保存していない変更は端末にも残す（オフラインで直してアプリを閉じても消えない。次に開いたとき、読んだ中身にかけ直して保存する）
  const where = () => store && (store.kind === 'github' ? 'github:' + (ls.get('gh') || {}).owner + '/' + (ls.get('gh') || {}).repo : store.kind);
  function keepOps() { if (store && store.canSave) ls.set('pending', ops.length ? { where: where(), ops } : null); }

  // 保存の題（コミットの文）：まとめて保存するときは「〜ほか N 件」、ポチが動かしたものは「ポチ：」を付ける
  // （2026-10-20 ポチが今やるの8枚を一度に次にやるへ回したのに、コミットの題が1枚分だけで、だれが動かしたか分からなかった）
  // まだ保存していない変更の理由。保存できた分だけ消す（失敗したら次の保存の題に残す）
  let whys = [];
  const relabel = () => { if (whys.length) lastWhy = whys.length > 1 ? `${whys[0]}ほか ${whys.length - 1} 件` : whys[0]; };
  function persist(why, who) {
    if (store.kind === 'github') ls.set('cache', cards);
    if (!store.canSave) { status(`変更しました（${why}）。「⋯ → ダウンロードで保存」で cards.json を local-board に置いてください。`, 'warn'); return; }
    whys.push((who ? who + '：' : '') + why);
    dirty = true; relabel();
    clearTimeout(saveTimer); saveTimer = setTimeout(flush, 1200);
  }
  async function flush() {
    if (!dirty || saving || !store?.canSave) return;
    saving = true; saveTimer = null;
    const why = lastWhy, sent = ops.length, sentWhys = whys.length;
    try {
      await store.write(LOCAL, JSON.stringify(cards, null, 2) + '\n', why);
      ops = ops.slice(sent); dirty = ops.length > 0; keepOps(); whys = whys.slice(sentWhys); relabel();
      try { await store.write(MD, boardMd(cards), why); } catch {}
      status(`保存しました（${why}）${new Date().toLocaleTimeString('ja-JP')}`, 'ok');
      if (!dirty) wakeClaude(); // 保存待ちの変更があるあいだは印を付けない（次の保存のあとで付ける）
    } catch (e) {
      if (e.conflict) {
        // ほかの端末か AI が先に書いていた：読み直して、まだ保存していない変更をその上にかけ直す
        try {
          // 読み直しを待つあいだに増えた変更もかけ直す。送った分だけを消す（あとから来た変更は残して次に送る）
          const { text } = await store.loadCards(); cards = JSON.parse(text);
          ops.forEach(applyOp); emit();
          const n = ops.length, nWhys = whys.length;
          await store.write(LOCAL, JSON.stringify(cards, null, 2) + '\n', why + '（読み直してかけ直した）');
          ops = ops.slice(n); dirty = ops.length > 0; keepOps(); whys = whys.slice(nWhys); relabel(); try { await store.write(MD, boardMd(cards), why); } catch {}
          status('ほかの端末の変更と合わせて保存しました。', 'ok'); if (!dirty) wakeClaude();
        } catch (e2) { status('保存できませんでした（ほかの端末と同時に書いたため）。↻ で読み直してください: ' + (e2.message || e2), 'err'); }
      } else if (!navigator.onLine) status('オフラインのため、まだ保存していません。つながったら自動で保存します。', 'warn');
      else status('保存できませんでした: ' + e.message, 'err');
    } finally { saving = false; if (dirty && navigator.onLine && !saveTimer) saveTimer = setTimeout(flush, 3000); }
  }
  // 答え・コメント・依頼・「AI に頼む」がまだ Claude に届いていなければ、保存のあとに Claude を起こす印を置く（毎時の取り込みを待たずに数分で届く）。
  // 同じものでは1回だけ。印が置けなくても、毎時の取り込みで届く
  const waiting = () => cards.filter(c => !c.deleted && (DELIVERY.some(k => c[k] === 'local') || c.ai_job?.status === 'new'));
  async function wakeClaude() {
    if (!store?.ping) return;
    const w = waiting(); if (!w.length) return;
    // 記録はつなぎ先（リポジトリ・ブランチ）ごとに持つ（つなぎ替えて戻っても、同じものでは起こし直さない）
    const dest = store.dest || store.kind, sig = w.map(c => c.doc_id + '@' + (c.updated || '')).sort().join(',');
    const seen = () => { const v = ls.get('woke'); return v && typeof v === 'object' ? v : {}; }; // v43 までは文字列だった
    if (seen()[dest] === sig) return;
    try { if (await store.ping(w.length)) ls.set('woke', { ...seen(), [dest]: sig }); } catch {}
  }
  window.addEventListener('online', () => { if (dirty) flush(); });
  window.addEventListener('beforeunload', e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && dirty) flush(); });

  // データのリポジトリの tools/export.py の board_md と同じ形
  function boardMd(cs) {
    const live = cs.filter(c => !c.deleted);
    const rows = ['# ボード（ローカル版の写し）', '', 'local-board のカンバンで直したもの。Claude が戻ったら取り込む（local-board/README.md）。', ''];
    for (const [lane, label] of LANES) {
      let l = live.filter(c => c.lane === lane).sort((a, b) => (a.order || 0) - (b.order || 0));
      if (lane === 'done') l = l.sort((a, b) => (b.done_at || '').localeCompare(a.done_at || '')).slice(0, 20);
      rows.push(`## ${label}（${l.length}）`, '');
      for (const c of l) {
        const who = c.owner === 'agent' ? 'エージェント' : '自分';
        let line = `- [${lane === 'done' ? 'x' : ' '}] ${c.title || ''}（${who}${c.due ? '・期限 ' + c.due : ''}）`;
        if (c.link) line += ` [リンク](${c.link})`;
        rows.push(line);
        const d = c.decision;
        if (d) { (d.options || []).forEach((o, i) => rows.push(`  - ${o.label}${i === d.recommended ? '（おすすめ）' : ''}: ${o.consequence}`)); if (c.answer) rows.push(`  - 答え: ${c.answer}`); }
        else if (c.note) rows.push(`  - ${c.note}`);
      }
      rows.push('');
    }
    return rows.join('\n');
  }

  // ================= 設定を PC とスマホで同じにする（local-board/settings.json） =================
  // 形：{ "updated": "...", "values": { "kanban-pal": "sea", ... }, "at": { "kanban-pal": "2026-10-20T..." } }。キーごとに新しいほうを使う
  let setAt = ls.get('settings-at') || {}, setTimer = null, applying = false;
  Storage.prototype.setItem = function (k, v) { raw.set.call(this, k, v); if (this === localStorage && !applying && SYNC_KEYS.includes(k)) noteSetting(k); };
  Storage.prototype.removeItem = function (k) { raw.del.call(this, k); if (this === localStorage && !applying && SYNC_KEYS.includes(k)) noteSetting(k); };
  function noteSetting(k) { setAt[k] = now(); ls.set('settings-at', setAt); clearTimeout(setTimer); setTimer = setTimeout(saveSettings, 1500); }
  function localSettings() { const v = {}; for (const k of SYNC_KEYS) { const x = raw.get.call(localStorage, k); if (x != null) v[k] = x; } return v; }
  async function saveSettings() {
    if (!store?.canSave) return;
    try { await store.write(SETTINGS, JSON.stringify({ updated: now(), values: localSettings(), at: setAt }, null, 2) + '\n', '見た目・キャラの設定'); } catch {}
  }
  // 読んだ設定を当てる。変わったものがあれば true（ボードは開いたときに設定を読むので、開き直す）
  function mergeSettings(text) {
    let d; try { d = JSON.parse(text || 'null'); } catch { d = null; }
    if (!d || typeof d.values !== 'object') return { changed: false, newer: Object.keys(setAt).length > 0 };
    let changed = false, mine = false;
    applying = true;
    try {
      for (const k of SYNC_KEYS) {
        const their = d.at?.[k] || (d.values && k in d.values ? d.updated : '') || '', ours = setAt[k] || '';
        if (ours > their) { mine = true; continue; }
        let v = d.values[k];
        // 「自分の写真」は claude.ai の中にだけあるので、ここでは使えない（壁紙は「湖と山なみ」にする）
        if (k === 'kanban-wp' && v === 'own' && !(raw.get.call(localStorage, 'kanban-wp-owns') || '').startsWith('["')) v = 'lake';
        const cur = raw.get.call(localStorage, k);
        if (v == null) { if (cur != null && their) { raw.del.call(localStorage, k); changed = true; } }
        else if (cur !== v) { raw.set.call(localStorage, k, v); changed = true; }
        if (their) setAt[k] = their;
      }
    } finally { applying = false; }
    ls.set('settings-at', setAt);
    return { changed, newer: mine };
  }

  // ================= ポチが覚えたこと（local-board/pochi-memory.json） =================
  // 形：{ "updated": "...", "items": [{ id, kind: name|note|word|habit, text, at, ... }] }。忘れたものは { id, forgotten: true, at } だけ残す（中身は消す）。
  // 端末どうしは id ごとに at が新しいほうを使う。最大 60 件（古いものから捨てる）
  let memory = ls.get('memory') || { updated: '', items: [] }, memTimer = null;
  const MEM_MAX = 60;
  function mergeMemory(a, b) {
    const by = {};
    for (const it of [...(a?.items || []), ...(b?.items || [])]) { if (!it?.id) continue; const o = by[it.id]; if (!o || (it.at || '') >= (o.at || '')) by[it.id] = it; }
    const items = Object.values(by).sort((x, y) => (x.at || '').localeCompare(y.at || ''));
    const live = items.filter(i => !i.forgotten), dead = items.filter(i => i.forgotten).slice(-MEM_MAX);
    return { updated: now(), items: [...dead, ...live.slice(-MEM_MAX)] };
  }
  function keepMemory() {
    ls.set('memory', memory);
    clearTimeout(memTimer);
    memTimer = setTimeout(async () => {
      if (!store?.canSave) return;
      try { const t = await store.read(MEMORY); if (t) memory = mergeMemory(JSON.parse(t), memory); } catch {}
      try { await store.write(MEMORY, JSON.stringify(memory, null, 2) + '\n', 'ポチが覚えたこと'); } catch {}
    }, 1200);
  }
  const memoryApi = {
    all: () => memory.items.filter(i => !i.forgotten).map(copy),
    put(item) {
      const it = { ...copy(item), id: item.id || 'm-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), at: now() };
      for (const k of ['text', 'word']) if (typeof it[k] === 'string') it[k] = it[k].slice(0, 200);
      memory = mergeMemory(memory, { items: [it] }); keepMemory(); return copy(it);
    },
    forget(id) { memory = mergeMemory(memory, { items: [{ id, forgotten: true, at: now() }] }); keepMemory(); },
    forgetAll() { memory = mergeMemory(memory, { items: memory.items.filter(i => !i.forgotten).map(i => ({ id: i.id, forgotten: true, at: now() })) }); keepMemory(); },
  };
  async function loadMemory() {
    try { const t = await store.read(MEMORY); if (t) { memory = mergeMemory(memory, JSON.parse(t)); ls.set('memory', memory); } } catch {}
  }

  // ================= つなぐ =================
  let resolveDb; const dbReady = new Promise(r => { resolveDb = r; });
  async function connect(s) {
    if (ready) { // ボードはもう動いているので、置き場所を変えたら開き直す
      if (dirty) await flush();
      location.reload(); return;
    }
    store = s;
    status('読んでいます…');
    let from;
    try {
      const r = await s.loadCards(); from = r.from;
      const d = JSON.parse(r.text);
      if (!Array.isArray(d)) throw new Error('cards.json が配列ではありません');
      cards = d;
      if (s.kind === 'github') ls.set('cache', cards);
    } catch (e) {
      const cached = s.kind === 'github' ? ls.get('cache') : null;
      if (!cached) { store = null; status('読めませんでした: ' + e.message, 'err'); throw e; }
      cards = cached; store = { ...s, canSave: false, kind: 'cache' };
      status('読めませんでした（' + e.message + '）。前に読んだ写しを表示しています。直すのはつながってからにしてください。', 'err');
    }
    // ボードの新しい版・設定・今日の予定（どれも無くてよい）。ボードか設定が変わっていたら開き直す（ボードは開いたときに読むので）
    let again = false;
    // ボードの元（board-src/kanban.html＝マージ済みのボード）を先に読む。毎朝の写し（board/index.html）は翌朝まで古いので、無いときだけ使う
    // 元が壊れていたら（アプリが当てにする部品が無い・開いたら動かなかった）、その版は飛ばして毎朝の写しを使う
    // 中身全体の指紋（FNV-1a）。直した版を、壊れた版と取り違えない
    const sig = t => { let h = 0x811c9dc5; for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193); } return t.length + ':' + (h >>> 0).toString(36); };
    const boardBad = window.LKBoot && LKBoot.hasBoard && (typeof window.move !== 'function' || typeof window.openDetail !== 'function');
    if (boardBad && ls.get('board-from') === 'src') ls.set('src-bad', ls.get('board-sig'));
    try {
      // 元が読めなかった（電波など）ときは、取っておいた画面のまま（写しに切り替えると、次に元へ戻って開き直しが行ったり来たりする）
      let t = null, from = 'src', failed = false; try { t = await store.read(BOARD_SRC); } catch { failed = true; }
      if (failed && window.LKBoot?.hasBoard && !boardBad) t = null;
      else if (!boardOk(t) || sig(t) === ls.get('src-bad')) { t = await store.read(BOARD_HTML); from = 'html'; }
      if (t && window.LKBoot && LKBoot.save(t)) { again = true; ls.set('board-from', from); ls.set('board-sig', sig(t)); try { sessionStorage.setItem('lk.boardNew', from); } catch {} }
    } catch {}
    if (boardBad && again) sessionStorage.removeItem('lk.reloaded'); // 壊れた版から戻すときは、もう一度開き直してよい
    try {
      const { changed, newer } = mergeSettings(await store.read(SETTINGS));
      if (changed) again = true;
      if (newer) saveSettings();
    } catch {}
    if (!again && s.kind === 'file' && window.LKBoot && !LKBoot.hasBoard) {
      store = null; cards = [];
      const e = new Error('この端末にはまだボードの画面がありません。cards.json と一緒に board/index.html も選んでください（Ctrl か ⌘ を押しながら2つ選ぶ）。');
      status(e.message, 'err'); throw e;
    }
    if (again && !sessionStorage.getItem('lk.reloaded')) {
      sessionStorage.setItem('lk.reloaded', '1');
      if (s.kind === 'file') try { sessionStorage.setItem('lk.file', JSON.stringify({ name: s.label, text: s.text })); } catch {} // 開き直したあと同じファイルでつなぐ
      try { if (Object.keys(entry).length) sessionStorage.setItem('lk.entry', JSON.stringify(entry)); } catch {}
      location.reload(); return;
    }
    sessionStorage.removeItem('lk.reloaded');
    try { const t = await store.read(TODAY); today = t ? JSON.parse(t) : null; } catch { today = null; }
    await loadMemory();
    // 前に開いたとき保存できなかった変更をかけ直す
    const kept = store.canSave ? ls.get('pending') : null;
    if (kept && kept.where === where() && Array.isArray(kept.ops) && kept.ops.length) {
      kept.ops.forEach(applyOp); ops = kept.ops; dirty = true; lastWhy = '前に保存できなかった変更 ' + kept.ops.length + ' 件';
      saveTimer = setTimeout(flush, 500);
      from = '';
      status(`前に開いたとき保存できなかった変更 ${kept.ops.length} 件をかけ直しました。保存します…`, 'warn');
    }
    // 端末の保存（ボードの写し・まだ送っていない変更）を、空き容量が減っても消さないでほしいと頼む
    try { navigator.storage?.persist?.().catch(() => {}); } catch {}
    ready = true; lastRead = Date.now();
    const boardNew = sessionStorage.getItem('lk.boardNew'); sessionStorage.removeItem('lk.boardNew');
    if (from) status(boardNew === 'src' ? 'ボードを新しい版にしました' : boardNew === 'html' && ls.get('src-bad') ? 'ボードの新しい版が動かなかったので、毎朝の写しで開きました' : `${store.label} から読みました・${new Date().toLocaleTimeString('ja-JP')}`, 'ok');
    resolveDb(db);
    emit(); todayListeners.forEach(f => f());
    window.dispatchEvent(new CustomEvent('lk:connected', { detail: { kind: store.kind } }));
  }
  async function reload(quiet) {
    if (!store || store.kind === 'file' || store.kind === 'cache') return;
    if (dirty) await flush();
    if (dirty) return; // まだ送れていない（オフラインなど）。読み直すと直したものが見えなくなるので、送れてから
    lastRead = Date.now();
    const r0 = rev;
    const { text } = await store.loadCards();
    if (dirty || rev !== r0) return; // 読んでいるあいだに直したものがある。上書きしない（送ったあと、次の読み直しで合わせる）
    const same = text === JSON.stringify(cards, null, 2) + '\n';
    if (!same) { cards = JSON.parse(text); undo.length = 0; if (store.kind === 'github') ls.set('cache', cards); emit(); }
    if (!quiet || !same) status(`${store.label} から読み直しました・${new Date().toLocaleTimeString('ja-JP')}`, 'ok');
  }
  // 画面に戻ったとき（1分以上たっていたら）と、開いているあいだ5分ごとに、ほかの端末や Claude の変更を読む
  let lastRead = 0;
  const autoRead = gap => { if (ready && !saving && Date.now() - lastRead > gap && navigator.onLine) reload(true).catch(() => {}); };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') autoRead(60e3); });
  setInterval(() => autoRead(5 * 60e3), 60e3);

  // ================= window.claude（ボードが使う形） =================
  function docRef(col, id) {
    id = id || newId();
    return {
      id,
      set: body => col === 'cards' ? mutate({ kind: 'set', id, body }) : Promise.resolve(),
      update: patch => col === 'cards' ? mutate({ kind: 'update', id, patch }) : Promise.resolve(),
      onSnapshot: (cb, err) => col === 'cards' ? listen(snap => cb(snap.docs.find(d => d.id === id) || { id, exists: false, data: () => undefined }), err) : () => {},
    };
  }
  function listen(cb, err) { const e = [cb, err]; listeners.push(e); if (ready) queueMicrotask(() => cb({ docs: cards.map(toDoc), size: cards.length, empty: !cards.length })); return () => { const i = listeners.indexOf(e); if (i >= 0) listeners.splice(i, 1); }; }
  const db = {
    collection: name => ({
      doc: id => docRef(name, id),
      onSnapshot: (cb, err) => name === 'cards' ? listen(cb, err) : () => {},
    }),
    doc(path) {
      if (path === 'meta/today') return { onSnapshot(cb) { const f = () => cb(today ? { exists: true, data: () => copy(today) } : { exists: false, data: () => undefined }); todayListeners.push(f); if (ready) queueMicrotask(f); return () => {}; } };
      const [col, id] = String(path).split('/'); return docRef(col, id);
    },
  };
  window.claude = {
    async use(name) {
      if (name === 'db') return dbReady;
      if (name === 'user') { await dbReady; return { id: async () => 'you-local', can: async () => writable() }; }
      // comments（Claude に届ける）は無い：ボードは答え・依頼を「まだ届いていない」（"new" → ここで "local"）と残し、Claude が戻ったら取り込んで届ける。
      // assets（自分の写真）も claude.ai の中だけ
      return null;
    },
  };

  // ================= アプリ（app.js）から使う =================
  window.LK = {
    LANES, SYNC_KEYS, ls, entry, memory: memoryApi, unsent: () => (dirty ? ops.length : 0), ghStore, folderStore, fileStore, boardOk, connect, reload, flush, undo: undoLast, writable, as, actor: () => actor,
    get store() { return store; }, get ready() { return ready; }, get dirty() { return dirty; },
    get cards() { return cards; },
    add(body) { const id = newId(); return mutate({ kind: 'set', id, body }).then(() => id); },
    update(id, patch, why) { return mutate({ kind: 'update', id, patch }, why); },
    onStatus(f) { statusFns.push(f); },
    // この端末の診断を書く（local-board/diagnostics/ の下だけ）
    async diag(name, obj) {
      if (!store?.canSave) throw new Error('いまは保存できません（GitHub かフォルダでつないでね）');
      if (!/^[\w.-]{1,80}\.json$/.test(name)) throw new Error('名前が違います');
      await store.write('local-board/diagnostics/' + name, JSON.stringify(obj, null, 2) + '\n', 'この端末の診断');
    },
    json: () => JSON.stringify(cards, null, 2) + '\n',
  };
})();

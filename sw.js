// アプリの画面だけを端末に保存して、オフラインでも開けるようにする。
// カードのデータ（api.github.com など他のサイト）と AI のモデル（Hugging Face など）には触らない（モデルは localai.js の部品が自分で保存する）。
// 先にネットを見て、つながらないときだけ保存したものを使う（更新はすぐ届く）。
// vendor/（同梱の AI 部品。数十MB）と bg/（壁紙の写真）は、一度取ったら保存したものを使う（中身は変わらない。スマホの通信量のため。見た目で選んだ写真だけ取る）。
const CACHE = 'kanban-v15';
const VENDOR_CACHE = 'kanban-vendor';
const SHELL = ['./', './index.html', './boot.js', './shim.js', './app.js', './app.css', './manifest.webmanifest', './icon-192.png', './icon-512.png', './qrcode.js', './voice.js', './localai.js', './talk.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  // 同じ場所のメモアプリ（notes/）のキャッシュ（notes-…）と、AI 部品の保存（kanban-vendor）は消さない
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('kanban-') && k !== CACHE && k !== VENDOR_CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// 知らせ（通知）を押したら、開いているアプリを前に出す（無ければ開く）
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
    const c = cs.find(x => new URL(x.url).pathname.startsWith(new URL('./', self.registration.scope).pathname));
    return c ? c.focus() : self.clients.openWindow('./');
  }));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.includes('/vendor/') || url.pathname.includes('/bg/')) {
    e.respondWith(caches.open(VENDOR_CACHE).then(c => c.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      if (res.ok) c.put(e.request, res.clone());
      return res;
    }))));
    return;
  }
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return res;
    // 共有メニューや #add で開いたとき（?title=… 付き）も、オフラインなら保存した画面を出す
    }).catch(() => caches.match(e.request, { ignoreSearch: e.request.mode === 'navigate' }).then(r => r || caches.match('./index.html')))
  );
});

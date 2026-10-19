// アプリの画面だけを端末に保存して、オフラインでも開けるようにする。
// カードのデータ（api.github.com など他のサイト）には触らない。
// 先にネットを見て、つながらないときだけ保存したものを使う（更新はすぐ届く）。
const CACHE = 'kanban-v5';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './qrcode.js', './voice.js', './talk.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  // 同じ場所のメモアプリ（notes/）のキャッシュ（notes-…）は消さない
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('kanban-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return res;
    // 共有メニューや #add で開いたとき（?title=… 付き）も、オフラインなら保存した画面を出す
    }).catch(() => caches.match(e.request, { ignoreSearch: e.request.mode === 'navigate' }).then(r => r || caches.match('./index.html')))
  );
});

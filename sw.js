// アプリの画面だけを端末に保存して、オフラインでも開けるようにする。
// カードのデータ（api.github.com など他のサイト）と AI のモデル（Hugging Face など）には触らない（モデルは localai.js の部品が自分で保存する）。
// 先にネットを見て、つながらないときだけ保存したものを使う（更新はすぐ届く）。
// vendor/（同梱の AI 部品。数十MB）と bg/（壁紙の写真）は、一度取ったら保存したものを使う（中身は変わらない。スマホの通信量のため。見た目で選んだ写真だけ取る）。
const CACHE = 'kanban-v47';
const VENDOR_CACHE = 'kanban-vendor';
// vendor/ の今の版（localai.js の VENDOR と koe.js と同じフォルダ）。これ以外の版を保存していたら消す（版を上げたあと、古い数十MB が端末に残らないように）
const VENDOR_NOW = ['web-llm-0.2.85', 'transformers-4.3.0', 'onnxruntime-web-1.31.0-dev.20260914-8d85527a0', 'wllama-3.8.1', 'karume-models-0.14.0'];
const SHELL = ['./', './index.html', './boot.js', './shim.js', './app.js', './app.css', './manifest.webmanifest', './icon-192.png', './icon-512.png', './qrcode.js', './voice.js', './koe.js', './localai.js', './ear-worker.js', './talk.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  // 同じ場所のメモアプリ（notes/）のキャッシュ（notes-…）と、AI 部品の保存（kanban-vendor）は消さない
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('kanban-') && k !== CACHE && k !== VENDOR_CACHE).map(k => caches.delete(k))))
    .then(() => caches.open(VENDOR_CACHE)).then(c => c.keys().then(rs => Promise.all(rs
      .filter(r => { const m = new URL(r.url).pathname.match(/\/vendor\/([^/]+)\//); return m && !VENDOR_NOW.includes(m[1]); })
      .map(r => c.delete(r)))))
    .then(() => self.clients.claim()));
});

// 知らせ（通知）を押したら、開いているアプリを前に出す（無ければ開く）
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
    const c = cs.find(x => new URL(x.url).pathname.startsWith(new URL('./', self.registration.scope).pathname));
    // 押した知らせのカードを開く（開いている画面へは postMessage、無ければ #card=<id> を付けて開く）
    const id = e.notification.data && e.notification.data.card;
    if (c) { if (id) c.postMessage({ card: id }); return c.focus(); }
    return self.clients.openWindow(id ? './#card=' + encodeURIComponent(id) : './');
  }));
});

// カンバンの画面（index.html）に COOP・COEP（credentialless）を付けて、ページを「ほかのサイトから切り離した」状態（crossOriginIsolated）にする。
// こうすると SharedArrayBuffer が使え、端末の中の AI（wllama・ONNX Runtime）が CPU のスレッドを何本も使えて速くなる。守りを強める側の変更。
// credentialless なので、GitHub の API・モデルの取得（CORS）・自分の写真はそのまま読める（https://web.dev/articles/coop-coep ・ https://developer.chrome.com/blog/coep-credentialless-origin-trial）。
// 同じ場所のメモ（notes/）には付けない。最初に開いたとき（まだこの仕組みが動いていない）は付かず、次に開いたときから付く
const SCOPE = new URL('./', self.registration.scope).pathname;
function isolate(res) {
  if (!res || res.type === 'opaque' || res.status === 0) return res;
  const h = new Headers(res.headers);
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cross-Origin-Embedder-Policy', 'credentialless');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (e.request.mode === 'navigate' && (url.pathname === SCOPE || url.pathname === SCOPE + 'index.html')) {
    e.respondWith(fetch(e.request).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return isolate(res);
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('./index.html')).then(isolate)));
    return;
  }
  if (url.pathname.includes('/vendor/') || url.pathname.includes('/bg/')) {
    // 部品にも COEP を付ける。切り離した画面から部品の .mjs を worker（ONNX Runtime のスレッド）として読むとき、
    // COEP の無い応答は止められ、耳（Whisper）の準備が永久に終わらなかった（2026-10-20 Pixel で🎤が黙って止まった）
    e.respondWith(caches.open(VENDOR_CACHE).then(c => c.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      if (res.ok) c.put(e.request, res.clone());
      return res;
    }))).then(isolate));
    return;
  }
  // worker として読むもの（自分のサイトの .js）にも COEP を付ける（上と同じ理由。画面そのものではないので、メモ（notes/）の画面は切り離さない）
  const asWorker = /worker$/.test(e.request.destination);
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return asWorker ? isolate(res) : res;
    // 共有メニューや #add で開いたとき（?title=… 付き）も、オフラインなら保存した画面を出す
    }).catch(() => caches.match(e.request, { ignoreSearch: e.request.mode === 'navigate' }).then(r => r || caches.match('./index.html')).then(r => (asWorker ? isolate(r) : r)))
  );
});

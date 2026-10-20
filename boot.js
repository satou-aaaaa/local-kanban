// はじめに動く部品。claude.ai のボードの HTML を、そのままこのアプリの画面にする。
//   ボードの HTML は公開しない（このリポジトリには置かない）。データのリポジトリ（非公開）の board/index.html＝毎日の写しを
//   つないだあとに shim.js が読み、この端末に取っておく（LKBoot.save）。次に開いたときからは、それを画面にする（オフラインでも開ける）。
//   まだ取っていないとき（初めて開いたとき）は、つなぐための小さな画面（SKELETON）を出す。
//   どちらの場合も、頭に app.css・shim.js を、最後に voice.js・koe.js・localai.js・talk.js・app.js を足す。
'use strict';
(function () {
  const KEY = 'lk.board';
  // CSP（外へ通信しない決まり）は index.html の <head> にあるものがそのまま効く
  const HEAD = `
<meta name="theme-color" content="#2f6b8a">
<meta name="apple-mobile-web-app-capable" content="yes">
<link rel="manifest" href="manifest.webmanifest">
<link rel="apple-touch-icon" href="icon-192.png">
<link rel="stylesheet" href="app.css">
<script src="shim.js"></script>
`;
  const TAIL = '<script src="voice.js"></script>\n<script src="koe.js"></script>\n<script src="localai.js"></script>\n<script src="talk.js"></script>\n<script src="app.js"></script>\n';
  // まだボードを取っていないときの画面（app.js が当てにする部品だけ）
  const SKELETON = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>カンバン</title>
<style>:root{--bg:#f3f4f1;--lane:#e8eae4;--card:#fff;--fg:#22261f;--muted:#62695d;--line:#d3d7cd;--you:#b5462f;--agent:#2f6b8a;--done:#5b7a3a;--warn:#a36a00}
@media (prefers-color-scheme:dark){:root{--bg:#171a16;--lane:#20241e;--card:#2a2f27;--fg:#e7eae2;--muted:#9ba393;--line:#3a4035;--you:#f08a72;--agent:#7fb6d4;--done:#9cc072;--warn:#e0b050;color-scheme:dark}}
body{background:var(--bg);color:var(--fg);font-family:"Hiragino Sans","Yu Gothic",sans-serif;line-height:1.6;padding:20px max(16px,env(safe-area-inset-left)) 32px}
header{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px 16px;margin-bottom:12px}h1{font-size:1.35rem;margin:0}
input,select,button{font:inherit;font-size:.9rem;color:var(--fg);background:var(--card);border:1px solid var(--line);border-radius:6px;padding:4px 10px;min-height:36px}
button.primary{background:var(--fg);color:var(--bg);border-color:var(--fg);font-weight:600}.hbtns{margin-left:auto;display:flex;gap:6px}.note{color:var(--muted);font-size:.82rem}
[hidden]{display:none!important}</style></head><body>
<header><h1>カンバン</h1><span id="status" class="note"></span><span class="hbtns"><button type="button" id="micBtn" hidden>🎤</button></span></header>
<section id="voice" hidden><p id="vstatus"></p></section>
<nav id="jump" hidden></nav><main id="board" hidden></main>
</body></html>`;

  function load() { try { return localStorage.getItem(KEY) || ''; } catch { return ''; } }
  function inject(html) {
    let h = html;
    h = /<head>/i.test(h) ? h.replace(/<head>/i, m => m + HEAD) : HEAD + h;
    h = h.replace(/<title>[^<]*<\/title>/i, '<title>カンバン</title>');
    const end = h.toLowerCase().lastIndexOf('</body>');
    return end >= 0 ? h.slice(0, end) + TAIL + h.slice(end) : h + TAIL;
  }
  window.LKBoot = {
    // 新しいボードを取っておく。前と違えば true（開き直す）
    save(html) {
      if (typeof html !== 'string' || !/<html/i.test(html) || html === load()) return false;
      try { localStorage.setItem(KEY, html); return true; } catch { return false; }
    },
    get hasBoard() { return !!load(); },
  };
  // 読み込みの途中（index.html の <head> の中）で書き足す。重なった <html>・<head>・<body> はブラウザが1つにまとめる。
  // （DOMContentLoaded のあとに document.open で書き直すと、Chrome が最初のスクリプトの読み込みを止めてしまう）
  document.write(inject(load() || SKELETON));
})();

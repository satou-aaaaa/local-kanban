# AGENTS.md

データを外に置かないカンバンの PWA（GitHub Pages で公開）。使い方・鍵の作り方・安全のための決まりは README.md。

- アプリの本体は `index.html` 1枚（QR 表示だけ qrcode.js＝qrcode-generator 1.4.4、MIT を同梱）。`sw.js`・`manifest.webmanifest`・アイコンは手書き。
- **データ・鍵（トークン）・データのリポジトリの名前を、このリポジトリに入れない**（公開リポジトリ）。
- `index.html` を直したら、データ側のリポジトリの `local-board/kanban.html` も同じ中身にする。
- カードの形を変えるときは、データ側の `local-board/cards.schema.json` と `tools/local_board.py` も合わせる。
- 確かめ方：`python3 -m http.server` で開き、Chrome の DevTools → Application で Manifest と Service worker にエラーが無いこと、スマホ幅（390px）で列がタブになることを見る。
- `notes/` はメモ（Notion の代わり）の PWA。カンバンと同じ鍵（localStorage の `lk.gh`）とフォルダ（IndexedDB `local-board` の `root`）を使う。データはデータ側のリポジトリの `notes/`（形は向こうの `notes/README.md`）。公開の印を付けたページだけを公開用リポジトリ satou-aaaaa/articles に書き出す。
- `notes/index.html` の `==md-begin==`〜`==md-end==`（Markdown 表示）を直したら、articles の `tools/md.js` にも写す。

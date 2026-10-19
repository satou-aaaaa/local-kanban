# AGENTS.md

データを外に置かないカンバンの PWA（GitHub Pages で公開）。使い方・鍵の作り方・安全のための決まりは README.md。

- アプリの本体は `index.html` 1枚（外部ライブラリなし）。`sw.js`・`manifest.webmanifest`・アイコンは手書き。
- **データ・鍵（トークン）・データのリポジトリの名前を、このリポジトリに入れない**（公開リポジトリ）。
- `index.html` を直したら、データ側のリポジトリの `local-board/kanban.html` も同じ中身にする。
- カードの形を変えるときは、データ側の `local-board/cards.schema.json` と `tools/local_board.py` も合わせる。
- 確かめ方：`python3 -m http.server` で開き、Chrome の DevTools → Application で Manifest と Service worker にエラーが無いこと、スマホ幅（390px）で列がタブになることを見る。

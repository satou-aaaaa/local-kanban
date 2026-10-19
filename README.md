# カンバン（local-kanban）

データを外に置かないカンバンの PWA。PC でもスマホでもインストールして使える。
公開ページ：https://satou-aaaaa.github.io/local-kanban/

**このリポジトリにはアプリの画面（プログラム）だけを置く。カードのデータは置かない。**
カードは、使う人の非公開リポジトリか PC のフォルダにあり、アプリはそれを端末の中で読み書きするだけ。

## データの置き場所（アプリの「⋯」で選ぶ）

| 置き場所 | 使える端末 | しくみ |
| --- | --- | --- |
| GitHub | PC・スマホ（Chrome・Edge・Safari） | 非公開リポジトリの `local-board/cards.json` を、端末に貼った鍵（fine-grained トークン）で GitHub の API から読み書きする |
| PC のフォルダ | PC の Chrome・Edge | GitHub Desktop などで取ってきたフォルダを File System Access API で読み書きする |
| cards.json を選ぶ | どれでも | 読むだけ。保存はダウンロード |

読むのは `local-board/cards.json`（無ければ `board/cards.json`）、書くのは `local-board/cards.json` と `local-board/BOARD.md` だけ。
データの形・取り込み方・AI への説明は、データ側のリポジトリの `local-board/README.md`・`AGENTS.md`・`cards.schema.json`。

## つなぎ方（端末ごとに1回）

1. アプリの「⋯ → GitHub でつなぐ」で、持ち主・リポジトリを入れる。`#repo=持ち主/リポジトリ&branch=main` を付けたリンクで開くと、入った状態で始まる。
2. **鍵を作るページを開く** を押す。GitHub の fine-grained トークンの画面が、名前・期限（1年）・権限（Contents の Read and write だけ）を入れた状態で開く。**Only select repositories** でデータのリポジトリだけを選び、**Generate token**。
3. 出てきた `github_pat_…` を鍵の欄に貼って **つなぐ**。

2台目は、つないだ端末の「⋯ → スマホでも開く（QR）」を読むと手順 1 が済んだ状態で開く。QR には鍵を入れない（画面に映るもの・URL に鍵を載せない）ので、鍵は端末ごとに作る。なくした端末の鍵だけを https://github.com/settings/personal-access-tokens で消せる。

## 安全のために

- 鍵はその端末のブラウザの保存領域（localStorage）にだけ置き、GitHub（api.github.com）以外には送らない。
- 同じ `satou-aaaaa.github.io` で公開しているほかのページも同じ保存領域を読める。ほかのページに外のスクリプトを入れるときは気をつける。
- 鍵を貼った端末を人に使わせない。なくしたら、すぐに GitHub で鍵を消す。
- このリポジトリにはデータ・鍵・データのリポジトリ名を書かない。

## インストール

- PC（Chrome・Edge）：ページを開き、アドレスバー右の「インストール」か、アプリの「⋯ → アプリとしてインストール」。
- Android（Chrome）：メニュー →「ホーム画面に追加」→「インストール」。
- iPhone（Safari）：共有ボタン →「ホーム画面に追加」。

アプリの画面はオフラインでも開ける（service worker が端末に保存する）。GitHub につながらないときは前に読んだ写しを表示し、保存はつながってからにする。

## 直すとき

- `index.html` が本体（外部ライブラリなし）。データ側のリポジトリの `local-board/kanban.html` は同じもの（ダブルクリックで開く予備）。直したら両方そろえる。
- `sw.js` の `CACHE` の版は、`index.html` 以外のファイルを足したり消したりしたときに上げる。
- 直したら `node qa/run.mjs`（見本データでの自動検査。CI の QA と同じ）を通す。QA が ✅ の PR は自動でマージされる。

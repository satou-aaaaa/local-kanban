# AGENTS.md

データを外に置かないカンバンの PWA（GitHub Pages で公開）。使い方・鍵の作り方・安全のための決まりは README.md。

- **画面は claude.ai のボードそのもの**：ボードの HTML（データ側の `board/index.html`＝毎日の写し）をつないだあとに読み、`boot.js` が画面にする。ボードの HTML はこのリポジトリに入れない（公開リポジトリ）。データの読み書きは `shim.js`（ボードの `window.claude.use("db")` の代わり）、アプリだけの機能は `app.js`・`app.css`。ボードの機能・見た目はここで作り直さない（ボードを直せばアプリにも入る）。声と命令欄の文の読み取りは `voice.js`（ほかのアプリからも使う。文型を変えたら qa/run.mjs の「声の文型」も直す）。会話モードは `talk.js`。スマホ向けの端末の中の AI は `localai.js`（同梱の部品は `vendor/`、版を上げる手順は `vendor/README.md`）。声・会話・AI は端末の中だけで動かし、外へ通信する部品を足さない（`index.html` の CSP の connect-src は、自分・GitHub の API・モデルの置き場だけ。広げない。QA が見る）。モデルはボタンを押したときだけ取る。QR 表示だけ qrcode.js＝qrcode-generator 1.4.4、MIT を同梱。`sw.js`・`manifest.webmanifest`・アイコンは手書き。
- **データ・鍵（トークン）・データのリポジトリの名前を、このリポジトリに入れない**（公開リポジトリ）。検査の見本データ（`qa/cards.sample.json`）も作り話だけにする。
- `index.html`・`boot.js`・`shim.js`・`app.js`・`app.css`・`bg/`・`voice.js`・`talk.js`・`localai.js`・`vendor/` を直したら、データ側のリポジトリの `local-board/` の同じ名前のファイル（`index.html` は `kanban.html`）も同じ中身にする。
- カードの形を変えるときは、データ側の `local-board/cards.schema.json` と `tools/local_board.py` も合わせる。
- `notes/` はメモ（Notion の代わり）の PWA。カンバンと同じ鍵（localStorage の `lk.gh`）とフォルダ（IndexedDB `local-board` の `root`）を使う。データはデータ側のリポジトリの `notes/`（形は向こうの `notes/README.md`）。公開の印を付けたページだけを公開用リポジトリ satou-aaaaa/articles に書き出す。
- `notes/index.html` の `==md-begin==`〜`==md-end==`（Markdown 表示）を直したら、articles の `tools/md.js` にも写す。

## push する前の確認

```bash
cd qa && npm ci && npx playwright install chromium && cd ..   # 最初に一度（PW_CHROMIUM にブラウザのパスがあればそれを使う）
node qa/run.mjs        # にせもののボード（qa/board.fixture.html）と見本データで：壁紙・設定の同期・保存・ぶつかったとき・知らせ・鍵の送り先・オフライン・スマホ幅（390px）
LK_BOARD=<board/index.html> node qa/run.mjs   # 本物のボードの写しで（写しはこのリポジトリに入れない）
```

- app.js が当てにするボードの部品（`move`・`remove`・`say`・`render`・`openDetail`・`cards`・`WPS`・`#micBtn`・`#voice`・`#vstatus`・`.hbtns`・`#board` の `lane-<列>`・`#jump`・`#compose-btn`・`#toast-msg`・`#toast-undo`・`#wall`・`dialog#detail`）は `qa/board.fixture.html` に同じ名前で置く。増やしたらにせものにも、データ側の `tools/local_board.py` の相性の検査にも足す。
- アプリの部品（`#lkMenu`・`#lkIntro`・`#lkStatus`・`#talkWhy`・`#cmdIn`・`#talkBtn`・`#talkDlg`・`#talkIn`・`#talkSetForm`・`#aiGet`）を変えたら `qa/run.mjs` も合わせて直す。
- ボードに壁紙が足されたら写真を `bg/`・`bg/t/` に置く（本物のボードで回す QA が、ボードの `WPS` の写真がすべてあるかを見る）。
- 切り替えボタン（選んだものに色が付くボタン）は、見た目のクラス `.on` と `aria-pressed` を必ず一緒に変える。QA が `aria-pressed` の付いたボタンを全部押して確かめる（2026-10-19 claude.ai のボードで印が変わらない不具合があった）。

## 公開

- GitHub Pages は `main` のルート（`/`）を公開する。マージすれば反映される。
- PR の QA が ✅ になると `automerge.yml` が自動でマージする。止めたいときは下書きにするか、ラベル「自動マージしない」を付ける。

## 共通のきまり

- PR の作り方・マージの仕方は satou-aaaaa/shared-workflows の `routines/pr.md`、全体のきまりは `routines/common.md` に従う。
- CI の部品（CI失敗Issue・死活監視・Lighthouse・ブランチ片付け・自動マージ）は shared-workflows の共通部品を呼ぶ。
  リポジトリ側の .github/workflows には呼び出しと設定値だけを書く。
- Claude 以外の AI・人が作業するときは、shared-workflows の `routines/tool-map.md`（道具の置き換え）と `routines/without-claude.md` を読む。

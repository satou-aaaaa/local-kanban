# AGENTS.md

データを外に置かないカンバンの PWA（GitHub Pages で公開）。使い方・鍵の作り方・安全のための決まりは README.md。

- アプリの本体は `index.html` 1枚。声と命令欄の文の読み取りは `voice.js`（ほかのアプリからも使う。文型を変えたら qa/run.mjs の「声の文型」も直す）。QR 表示だけ qrcode.js＝qrcode-generator 1.4.4、MIT を同梱。`sw.js`・`manifest.webmanifest`・アイコンは手書き。
- **データ・鍵（トークン）・データのリポジトリの名前を、このリポジトリに入れない**（公開リポジトリ）。検査の見本データ（`qa/cards.sample.json`）も作り話だけにする。
- `index.html`・`voice.js` を直したら、データ側のリポジトリの `local-board/kanban.html`・`local-board/voice.js` も同じ中身にする。
- カードの形を変えるときは、データ側の `local-board/cards.schema.json` と `tools/local_board.py` も合わせる。

## push する前の確認

```bash
cd qa && npm ci && npx playwright install chromium && cd ..   # 最初に一度（PW_CHROMIUM にブラウザのパスがあればそれを使う）
node qa/run.mjs        # manifest・SHELL・見本データでの表示と保存・鍵の送り先・service worker・オフライン・スマホ幅（390px）
```

- 画面の作り（`#board .lane[data-lane]`・`.card`・`[data-act]`・`[data-opt]`・`#addForm`・`#tabs`・`#micBtn`・`#cmdIn`）を変えたら `qa/run.mjs` も合わせて直す。
- 切り替えボタン（選んだものに色が付くボタン）は、見た目のクラス `.on` と `aria-pressed` を必ず一緒に変える。QA が `aria-pressed` の付いたボタンを全部押して確かめる（2026-10-19 claude.ai のボードで印が変わらない不具合があった）。

## 公開

- GitHub Pages は `main` のルート（`/`）を公開する。マージすれば反映される。
- PR の QA が ✅ になると `automerge.yml` が自動でマージする。止めたいときは下書きにするか、ラベル「自動マージしない」を付ける。

## 共通のきまり

- PR の作り方・マージの仕方は satou-aaaaa/shared-workflows の `routines/pr.md`、全体のきまりは `routines/common.md` に従う。
- CI の部品（CI失敗Issue・死活監視・Lighthouse・ブランチ片付け・自動マージ）は shared-workflows の共通部品を呼ぶ。
  リポジトリ側の .github/workflows には呼び出しと設定値だけを書く。
- Claude 以外の AI・人が作業するときは、shared-workflows の `routines/tool-map.md`（道具の置き換え）と `routines/without-claude.md` を読む。

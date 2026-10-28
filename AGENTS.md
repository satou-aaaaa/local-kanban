# AGENTS.md

データを外に置かないカンバンの PWA（GitHub Pages で公開）。使い方・鍵の作り方・安全のための決まりは README.md。

**作業を始める前に `docs/agents-detail.md`（決まりの全文）を必ず読む。** ここには毎回の会話で読まれる要点だけを置く（2026-10-28、トークン節約のため全文を移した）。

## 要点

- 画面は claude.ai のボードそのもの（`boot.js` がボードの HTML を画面にする）。ボードの機能・見た目はここで作り直さない。ボードの HTML はこのリポジトリに入れない。
- 公開リポジトリ：データ・鍵（トークン）・データのリポジトリの名前を入れない。見本データも作り話だけ。
- 声・会話・AI は端末の中だけで動かし、外へ通信する部品を足さない（CSP の connect-src・worker-src を広げない。QA が見る）。モデルはボタンを押したときだけ取る。
- 画面に出るファイルを直したら、データ側の `local-board/` の同じ名前のファイルも同じ中身にする。カードやポチの記憶の形を変えたらデータ側の schema と `tools/local_board.py` も合わせる。
- `notes/` の Markdown 表示（`==md-begin==`〜`==md-end==`）を直したら articles の `tools/md.js` にも写す。
- 機能を足す・直すたびに `qa/run.mjs` に検査も足す。ボードやアプリの部品の名前を変えたら `qa/` とにせもののボードも直す（一覧は詳しい決まり）。

## push する前の確認

```bash
bash scripts/setup.sh   # 最初に一度（クラウドのセッションでは自動で動く）
node qa/run.mjs        # にせもののボードと見本データで全体を検査
LK_BOARD=<board-src/kanban.html> node qa/run.mjs   # 本物のボードで
node qa/check-uiux.mjs   # 使いやすさの数字
node qa/check-review.mjs origin/main   # 画面を変えたら：版を上げ、reviews/v<版>.md に2役の点検を書いたか
```

画面に出るファイルを変えたら `reviews/README.md` の手順で点検する。速さは `qa/speed.mjs`。CI だけ落ちるときの調べ方は詳しい決まり。

## 公開

- GitHub Pages は `main` のルート（`/`）を公開する。PR の QA が ✅ になると `automerge.yml` が自動でマージする。止めたいときは下書きにするか、ラベル「自動マージしない」を付ける。

## 共通のきまり

- PR の作り方・マージの仕方は satou-aaaaa/shared-workflows の `routines/pr.md`、全体のきまりは `routines/common.md` に従う。
- CI の部品は shared-workflows の共通部品を呼ぶ。リポジトリ側の .github/workflows には呼び出しと設定値だけを書く。
- Claude 以外の AI・人が作業するときは、shared-workflows の `routines/tool-map.md` と `routines/without-claude.md` を読む。

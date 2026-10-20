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

## メモ（notes/）

Notion の代わりのメモ：https://satou-aaaaa.github.io/local-kanban/notes/ （PC・スマホにインストールできる）

- カンバンと同じ置き場・同じ鍵。カンバンをつないだ端末なら、開くだけで同じリポジトリの `notes/` を読み書きする。
- 1ページ＝1つの Markdown ファイル。左の一覧でページの下にページを作れる。題と本文はどの端末からでも直せ、画像は貼り付けで入る。
- 「設定 → 公開する」の印を付けたページだけを、公開用リポジトリ satou-aaaaa/articles に書き出す（https://satou-aaaaa.github.io/articles/ に出る）。
  そのためには、鍵の Repository access に articles も足す（https://github.com/settings/personal-access-tokens で鍵を開き、Edit → Repository access に articles を足して Update）。
- データの形は、データ側のリポジトリの `notes/README.md`。

## 声・キーボード・ほかの入口

| 入口 | 使い方 | 使える所 |
| --- | --- | --- |
| 🎤ボタン（M キー） | 押して話す。「〇〇を追加」「今やるに〇〇を追加」「〇〇を済み」「〇〇を保留へ」「〇〇を消して」（聞き返す）「今やるを読んで」「戻す」。候補が複数なら読み上げるので番号で答える | 端末の中で聞き取れる Chrome（139 以降）。ほかのブラウザはボタンが出ないので、足す欄で Win+H かキーボードのマイク（音声が Microsoft・Google に送られることがあるので、プライベートな内容には使わない） |
| 命令欄（Ctrl+K） | 声と同じ言い方を打つ。N で足す欄 | PC |
| URL | `…/local-kanban/#add=牛乳を買う&lane=now&due=2026-10-25`（足す）、`#cmd=請求書を済み`（命令）、`#voice`（🎤で聞く）、`#lane=now`（列を出す） | どこでも。iPhone は「ショートカット」アプリの「URL を開く」に入れると Siri から使える |
| アイコンのショートカット | 長押し（Android）・右クリック（Windows）で「足す」「🎤 話す」「今やる」 | インストールしたとき |
| 共有メニュー | ほかのアプリの「共有」→ カンバン。題と URL がカードになる（次にやる） | Android にインストールしたとき |
| アイコンのバッジ | 「今やる」の枚数 | Windows・Mac にインストールしたとき |

声は端末の外に出さない。🎤は、声を端末の中だけで聞き取れる Chrome（139 以降。初回は日本語の部品を端末に入れる）でだけ出し、サーバーで文字にする音声認識には落とさない。読み上げも端末の中の声だけ（「Google 日本語」などネット経由の声は使わず、無ければ画面の文字だけ）。文の読み取りは `voice.js` の `Voice.parse`（ほかのアプリからも使える）。

## 会話モード（💬・T キー・`#talk`）

キャラ（仮の名前「ポチ」、気さくな相棒・タメ口）と話しながらカードを片づける。**声も会話も端末の外に出さない。**

| 役 | 使うもの | 無いとき |
| --- | --- | --- |
| 耳 | 端末の中だけで聞き取る音声認識（Chrome 139 以降）。無い端末は、入れた Whisper | 下の欄に打って話す |
| 頭 | Chrome の内蔵 AI（Prompt API。PC の Chrome、日本語は 149 以降。初回はブラウザが部品を入れる）。無い端末（スマホなど）は、入れた WebLLM（Qwen2.5） | AI なし：「今やる」「次にやる」を1枚ずつ読み上げ、「済み」「あとで」「保留」「次」で動かす |
| 口 | 端末の中の声（「Google 日本語」などネット経由の声は使わない） | 画面の文字だけ |
| 割り込み | 話している間だけマイクを端末の中で見て、声が続いたら止めて聞く（入れた Silero VAD。無ければ音の大きさを見る自作の VAD） | 割り込みなし |

- AI に渡すのは題・列・期限だけ（補足・履歴・リンクは渡さない）。AI が「消す」と言っても、アプリが「消しますか？」と聞き返してから。
- 「終わり」「またね」で閉じる。名前・性格（AI への指示）・アイコン・色・声は「⚙ キャラの設定」で変えられる（端末に保存）。
- 外に出さない保証：ページの CSP で、通信できる先を自分のサイト・GitHub の API（カードの保存）・モデルの置き場（下）だけにしている。QA が会話中は外へ通信しないこと、モデルを取るときは置き場に GET するだけなことを確かめる。

### スマホでも AI と話す（端末の中の AI を入れる）

「⋯ → 🎤と会話・AI の設定」（つなぐ前の最初の画面にもある。💬→「⚙ キャラの設定」と同じ画面）の「AI の部品を入れる（約 0.5GB）」を押すと、その端末に AI を入れる。**押したときだけ**モデルを取りに行き、以後はオフラインで動く（Wi-Fi のときに押す）。

| 役 | モデル | 取ってくる場所 |
| --- | --- | --- |
| 頭 | WebLLM で Qwen2.5（メモリ 8GB 以上の端末は 1.5B、それ以外は 0.5B） | huggingface.co/mlc-ai、モデル用 wasm は raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs |
| 耳 | Whisper base（端末内の音声認識が無い端末だけ。iPhone など） | huggingface.co/onnx-community/whisper-base |
| 割り込み | Silero VAD（耳と一緒に入る） | huggingface.co/onnx-community/silero-vad |

- 要るもの：WebGPU（Android は Chrome 121 以降・Android 12 以降、iPhone は iOS 26 以降）。使えない端末は「入れられませんでした」と出て、AI なしの会話のまま。
- 動かす部品（WebLLM・transformers.js・ONNX Runtime）はこのリポジトリの `vendor/` に版を固定して同梱（出どころ・ライセンスは `vendor/README.md`）。
- 取りに行くのはモデルのファイルだけ。会話・カードは送らない。どこから取ったかは設定画面に出る。「入れた AI を消す」で端末から消せる。
- 小さなモデルなので、カードの操作と短いやりとりは十分、長い雑談は苦手。返事まで数秒かかる。

## 直すとき

- `index.html` が本体（声の命令は `voice.js`、会話モードは `talk.js`、端末の中の AI は `localai.js`＋`vendor/`、QR は `qrcode.js`）。データ側のリポジトリの `local-board/kanban.html` は同じもの（ダブルクリックで開く予備）。直したら両方そろえる。
- `sw.js` の `CACHE` の版は、`index.html` 以外のファイルを足したり消したりしたときに上げる。
- 直したら `node qa/run.mjs`（見本データでの自動検査。CI の QA と同じ）を通す。QA が ✅ の PR は自動でマージされる。

# カンバン（local-kanban）

データを外に置かないカンバンの PWA。PC でもスマホでもインストールして使える。
公開ページ：https://satou-aaaaa.github.io/local-kanban/

**このリポジトリにはアプリの部品（プログラム）だけを置く。カードのデータも、ボードの画面も置かない。**
カードは、使う人の非公開リポジトリか PC のフォルダにあり、アプリはそれを端末の中で読み書きするだけ。

## 画面は claude.ai のボードそのもの

アプリの画面は、claude.ai のボード（毎日 `board/index.html` に書き出される写し）を、つないだあとに非公開の置き場から読んで、そのまま動かしたもの。
だから、ボードに足された機能（見た目・壁紙・一覧・記録・絞り込み・頼む・答える…）は、次の書き出しのあと、アプリを開き直すだけで入る。アプリの側で作り直さない。

| 部品 | 役目 |
| --- | --- |
| `index.html`・`boot.js` | 端末に取っておいたボードの HTML を画面にする（初めてのときは、つなぐための小さな画面） |
| `shim.js` | ボードが使う `window.claude.use("db")` を、置き場所の `local-board/cards.json` の読み書きに置き換える。保存がぶつかったら読み直してかけ直す。送れなかった変更は端末に残す |
| `app.js`・`app.css` | アプリだけの機能：つなぐ・会話モード・🎤（端末の中の AI の耳も使う）・命令欄・知らせ・QR・ダウンロード・インストール・URL や共有から足す・スマホで左右になぞる |
| `bg/` | ボードの壁紙の写真（Unsplash・Pexels。出典はボードの「見た目」の中） |

Claude には届けられないので、答え・依頼は「まだ届いていない」（`answer_status` などが `local`）で残り、Claude が戻ったら取り込んで届ける（データ側の `local-board/README.md`）。

## データの置き場所（アプリの「⋯」で選ぶ）

| 置き場所 | 使える端末 | しくみ |
| --- | --- | --- |
| GitHub | PC・スマホ（Chrome・Edge・Safari） | 非公開リポジトリの `local-board/cards.json` を、端末に貼った鍵（fine-grained トークン）で GitHub の API から読み書きする |
| PC のフォルダ | PC の Chrome・Edge | GitHub Desktop などで取ってきたフォルダを File System Access API で読み書きする |
| cards.json を選ぶ | どれでも | 読むだけ。保存はダウンロード。初めての端末は board/index.html も一緒に選ぶ |

読むのは `local-board/cards.json`（無ければ `board/cards.json`）・`local-board/settings.json`・`board/index.html`・`board/today.json`、書くのは `local-board/cards.json`・`local-board/BOARD.md`・`local-board/settings.json` だけ。

**見た目とキャラは PC とスマホで同じになる**：色・壁紙・すりガラス・カードの文字の量・キャラの設定は `local-board/settings.json` に置き、つないだときに新しいほうを当てる（鍵は入れない）。並べ替え・絞り込みなどは端末ごと。claude.ai の中だけにある「自分の写真」の壁紙は、アプリでは「湖と山なみ」になる。
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

アプリの画面はオフラインでも開ける（部品は service worker、ボードの HTML は端末に取っておく。一度見た壁紙の写真も）。GitHub につながらないときは前に読んだ写しを表示する。
オフラインで直した変更は端末に残り、次に開いたとき（つながったとき）に保存する。画面に戻ったとき（1分以上たっていたら）と、開いているあいだ5分ごとに、ほかの端末や Claude の変更を読む（変わっていなければ GitHub は 304 を返し、回数制限に数えない）。

## 知らせ（「⋯ → 🔔 知らせを受け取る」）

確認が来たとき・エージェントから satouさんの番に戻ったとき・今日が期限のとき（1日1回）に、端末の通知で知らせる。通知はアプリの中で作り、外のサーバーを通さない。
そのかわり、**アプリを開いているあいだ（裏に回していても）だけ**届く。閉じていても届く形（Web Push）は、Google・Apple の中継を通るので入れていない（案は共有フォルダの `local-kanban/proposals.md`）。予定の前の知らせは Google カレンダーに任せる。

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
| 🎤ボタン（M キー） | ボードの🎤を、アプリの🎤に置き換える。押して話す。「〇〇を追加」「今やるに〇〇を追加」「〇〇を済み」「〇〇を保留へ」「〇〇を消して」（聞き返す）「今やるを読んで」「戻す」。候補が複数なら読み上げるので番号で答える | 端末の中で聞き取れる Chrome（139 以降）か、AI の部品（Whisper）を入れた端末。ほかでは押すと使えない理由が出るので、足す欄で Win+H かキーボードのマイク（音声が Microsoft・Google に送られることがあるので、プライベートな内容には使わない） |
| 命令欄（Ctrl+K） | 声と同じ言い方を打つ（N・/ はボードのまま） | PC |
| URL | `…/local-kanban/#add=牛乳を買う&lane=now&due=2026-10-25`（足す）、`#cmd=請求書を済み`（命令）、`#voice`（🎤で聞く）、`#lane=now`（列を出す） | どこでも。iPhone は「ショートカット」アプリの「URL を開く」に入れると Siri から使える |
| アイコンのショートカット | 長押し（Android）・右クリック（Windows）で「足す」「🎤 話す」「今やる」 | インストールしたとき |
| 共有メニュー | ほかのアプリの「共有」→ カンバン。題と URL がカードになる（次にやる） | Android にインストールしたとき |
| アイコンのバッジ | 「今やる」の枚数 | Windows・Mac にインストールしたとき |

声は端末の外に出さない。🎤は、声を端末の中だけで聞き取れる Chrome（139 以降。初回は日本語の部品を端末に入れる）か入れた Whisper でだけ聞き、サーバーで文字にする音声認識には落とさない。読み上げも端末の中の声だけ（「Google 日本語」などネット経由の声は使わず、無ければ画面の文字だけ）。文の読み取りは `voice.js` の `Voice.parse`（ほかのアプリからも使える）。

## 会話モード（💬・T キー・`#talk`）

キャラ（仮の名前「ポチ」、気さくな相棒・タメ口）と話しながらカードを片づける。**声も会話も端末の外に出さない。**

| 役 | 使うもの | 無いとき |
| --- | --- | --- |
| 耳 | 端末の中だけで聞き取る音声認識（Chrome 139 以降）。無い端末は、入れた Whisper | 下の欄に打って話す |
| 頭 | Chrome の内蔵 AI（Prompt API。PC の Chrome、日本語は 149 以降。初回はブラウザが部品を入れる）。無い端末（スマホなど）は、入れた WebLLM（Qwen2.5）。WebGPU が使えない端末は CPU で動く wllama（Qwen2.5 0.5B。返事はゆっくり） | AI なし：「今やる」「次にやる」を1枚ずつ読み上げ、「済み」「あとで」「保留」「次」で動かす |
| 口 | 端末の中の声（「Google 日本語」などネット経由の声は使わない） | 画面の文字だけ |
| 割り込み | 話している間だけマイクを端末の中で見て、声が続いたら止めて聞く（入れた Silero VAD。無ければ音の大きさを見る自作の VAD） | 割り込みなし |

- AI に渡すのは題・列・期限だけ（補足・履歴・リンクは渡さない）。AI が「消す」と言っても、アプリが「消しますか？」と聞き返してから。
- 「終わり」「またね」で閉じる。名前・性格（AI への指示）・アイコン・色・声は「⚙ キャラの設定」で変えられる（端末に保存）。
- **ポチが覚える**：「〇〇って呼んで」「〇〇って覚えて」で覚える。言い直しが2回あった言葉（例「ばっちり」＝済み）と、よく片づける時間帯（5回以上・半分以上のとき）も覚える。覚えたことは AI への指示とあいさつに使う（モデル自体は学び直さない）。置き場所はデータのリポジトリの `local-board/pochi-memory.json`（PC とスマホで同じ）。「何を覚えてる？」で聞ける。「〇〇を忘れて」「全部忘れて」か、設定の「ポチが覚えたこと」の「忘れる」で消す（中身ごと消し、消した印だけ残す）。
- **気持ちで話し分ける声**（`koe.js`）：設定の「声を入れる」を押した端末だけ、ポチの表情（ふつう・うれしい・悲しい・驚き など）に合わせて7つの気持ちで話す。声の人は4人（女性2・男性2）から選ぶ。Style-Bert-VITS2 の JVNV モデルを Karume（WebGPU）で端末の中だけで動かす。モデル（1人 約250MB）と読みの辞書（約19MB）は押したときだけ Hugging Face から取り、ブラウザに保存する。WebGPU が無い端末・入れていない端末は端末の声（speechSynthesis）で話す。PC ではブラウザの保存場所（ふつう C ドライブ）に入るので、空きが少ないときは入れない。
  - クレジット：声は [litagin/style_bert_vits2_jvnv](https://huggingface.co/litagin/style_bert_vits2_jvnv) を [hdae/karume-sbv2-jvnv](https://huggingface.co/hdae/karume-sbv2-jvnv) が変換・量子化（i8/i4）したもの。元のコーパス JVNV は Detai Xin, Junfeng Jiang, Shinnosuke Takamichi, Yuki Saito, Akiko Aizawa, Hiroshi Saruwatari（[arXiv:2310.06072](https://arxiv.org/abs/2310.06072)）。[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)。読みの辞書は naist-jdic（BSD 3-Clause）。
- 外に出さない保証：ページの CSP で、通信できる先を自分のサイト・GitHub の API（カードの保存）・モデルの置き場（下）だけにしている。QA が会話中は外へ通信しないこと、モデルを取るときは置き場に GET するだけなことを確かめる。

### スマホでも AI と話す（端末の中の AI を入れる）

「⋯ → 🎤と会話・AI の設定」（つなぐ前の最初の画面にもある。💬→「⚙ キャラの設定」と同じ画面）の「AI の部品を入れる（約 0.5GB）」を押すと、その端末に AI を入れる。**押したときだけ**モデルを取りに行き、以後はオフラインで動く（Wi-Fi のときに押す）。

| 役 | モデル | 取ってくる場所 |
| --- | --- | --- |
| 頭 | WebLLM で Qwen2.5（メモリ 8GB 以上の端末は 1.5B、それ以外は 0.5B） | huggingface.co/mlc-ai、モデル用 wasm は raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs |
| 頭（WebGPU が使えない端末） | wllama（llama.cpp の wasm、CPU で動く）で Qwen2.5 0.5B Instruct の Q4_0 GGUF（約430MB、Apache-2.0） | huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF（コミットで固定） |
| 耳 | Whisper base（端末内の音声認識が無い端末だけ。iPhone など） | huggingface.co/onnx-community/whisper-base |
| 割り込み | Silero VAD（耳と一緒に入る） | huggingface.co/onnx-community/silero-vad |

- WebGPU（Android は Chrome 121 以降・Android 12 以降、iPhone は iOS 26 以降）があれば WebLLM。GPU が Chrome の対象外などで WebGPU が使えない端末（例：Pixel 6a）は、電力の指定違い・互換モードでも GPU を探し、それでもだめなら CPU 版（wllama）を入れる。CPU 版は1本のスレッドで動くので返事はゆっくり（GitHub Pages では多スレッドに要る COOP/COEP のヘッダを付けられないため）。Chrome のフラグ（unsafe-webgpu など）を変えるようには勧めない。気持ちで話し分ける声は WebGPU 必須のまま（使えない端末は端末の日本語の声で話す）。
- 動かす部品（WebLLM・wllama・transformers.js・ONNX Runtime）はこのリポジトリの `vendor/` に版を固定して同梱（出どころ・ライセンスは `vendor/README.md`）。
- 取りに行くのはモデルのファイルだけ。会話・カードは送らない。どこから取ったかは設定画面に出る。「入れた AI を消す」で端末から消せる。
- 小さなモデルなので、カードの操作と短いやりとりは十分、長い雑談は苦手。返事まで数秒かかる。

## 直すとき

- アプリだけの機能は `app.js`・`app.css`、データの読み書きは `shim.js`、画面の組み立ては `boot.js`（声の命令は `voice.js`、会話モードは `talk.js`、気持ちで話し分ける声は `koe.js`＋`vendor/karume-models-…/`、端末の中の AI は `localai.js`＋`vendor/`、QR は `qrcode.js`）。
- **ボードの画面・機能はここで直さない**（claude.ai のボードを直せば、書き出しのあとアプリにも入る）。app.js が当てにするボードの部品（`move`・`remove`・`say`・`render`・`openDetail`・`cards`・`#micBtn`・`#voice`・`#vstatus`・`.hbtns`・`#board` の `lane-<列>`・`#jump`・`#compose-btn`・`#toast-msg`・`#wall`・`WPS`）は `qa/board.fixture.html`（にせもののボード）に同じ名前で置いてある。ボードがこれを変えたら、データ側の `tools/local_board.py check` が止める。
- ボードに壁紙が足されたら、写真を `bg/`（小さい見本は `bg/t/`）にも置く（QA が本物のボードで回すときに確かめる）。
- データ側のリポジトリの `local-board/` に同じ部品の写し（`index.html` は `kanban.html`）がある。直したら両方そろえる。
- `sw.js` の `CACHE` の版は、部品のファイルを足したり消したりしたときに上げる。
- 直したら `node qa/run.mjs`（にせもののボードと見本データでの自動検査。CI の QA と同じ）を通す。本物のボードの写しで回すときは `LK_BOARD=<board/index.html のパス> node qa/run.mjs`（写しはこのリポジトリに入れない）。QA が ✅ の PR は自動でマージされる。

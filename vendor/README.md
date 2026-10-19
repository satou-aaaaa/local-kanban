# vendor/（同梱している外の部品）

会話モードの「端末の中の AI」（`localai.js`）が使う部品。CDN から毎回読まず、自分のサイトから配る。
版はフォルダ名で固定し、`sw.js` は `vendor/` を一度取ったら端末に保存して使い回す（版を上げるときはフォルダ名を変える）。

| フォルダ | 中身 | 出どころ（npm） | ライセンス |
|---|---|---|---|
| `web-llm-0.2.85/` | `index.js`（WebGPU で言葉のモデルを動かす。`lib/index.js` から sourceMappingURL の行だけ削除） | `@mlc-ai/web-llm@0.2.85`（integrity `sha512-CwUiSAvDCYnmAZlpPMkurPHDfBLq6fvdRB3vRgoA894hRG/V/BSeY9bmMm6iIIU5VpjJxfb/dLPpJX2at0L9rw==`） | Apache-2.0（`LICENSE`） |
| `transformers-4.3.0/` | `transformers.js`（Whisper と Silero VAD を動かす。`dist/transformers.js` から sourceMappingURL の行を削除し、1か所だけ `"Mistral3ForConditionalGeneration"` を `"Mistral3For" + "ConditionalGeneration"` に分けた（同じ文字列。モデル名が GitHub の秘密の検査で Mistral の API キーと誤判定され push できないため。縮めた版 `transformers.min.js` も同じ理由で使わない） | `@huggingface/transformers@4.3.0`（integrity `sha512-fL1A/WUZwouPrOlYxU5dzIwD2T5J781JiB2jDR8bFe5DwCj0Gfudq+NEXCMno49kQgajHA7xQkrRLJlqG1veEA==`） | Apache-2.0（`LICENSE`） |
| `onnxruntime-web-1.31.0-dev.20260914-8d85527a0/` | `ort-wasm-simd-threaded.asyncify.mjs`・`.wasm`（transformers.js が使う ONNX Runtime の本体。transformers.js 4.3.0 が指定する版と同じ） | `onnxruntime-web@1.31.0-dev.20260914-8d85527a0`（integrity `sha512-Iy7rtadoBgxS/LLvDr3QW38DB1PNXRnr0GJMcL0TAt7c9qjgVQl83UlGCVyeAnK2InpmW8Uc3PL8XIuqtDeF6g==`） | MIT（`LICENSE`。npm の包みに LICENSE ファイルが無いため MIT の全文を置いた） |

モデル本体（数百MB〜1GB）はここに置かない（GitHub Pages の1ファイル 100MB の制限とリポジトリの重さのため）。
「AI の部品を入れる」を押したときだけ、次の場所から GET で取り、ブラウザの Cache API に保存する。

- 言葉のモデル: `huggingface.co/mlc-ai/Qwen2.5-0.5B-Instruct-q4f16_1-MLC` など（WebLLM の既定の置き場）
- 言葉のモデル用の wasm: `raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs`（WebLLM の既定の置き場）
- 声→文字: `huggingface.co/onnx-community/whisper-base`
- 割り込み: `huggingface.co/onnx-community/silero-vad`

## 版を上げるとき

```bash
npm pack @mlc-ai/web-llm@<版> @huggingface/transformers@<版>
# transformers の package.json の dependencies にある onnxruntime-web の版も npm pack する
```

フォルダ名・`localai.js` の `VENDOR` を新しい版にし、古いフォルダを消す。WebLLM の版を上げるとモデル用 wasm の版（`modelVersion`）も変わることがある。

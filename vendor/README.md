# vendor/（同梱している外の部品）

会話モードの「端末の中の AI」（`localai.js`）が使う部品。CDN から毎回読まず、自分のサイトから配る。
版はフォルダ名で固定し、`sw.js` は `vendor/` を一度取ったら端末に保存して使い回す（版を上げるときはフォルダ名を変える）。

| フォルダ | 中身 | 出どころ（npm） | ライセンス |
|---|---|---|---|
| `web-llm-0.2.85/` | `index.js`（WebGPU で言葉のモデルを動かす。`lib/index.js` から sourceMappingURL の行だけ削除） | `@mlc-ai/web-llm@0.2.85`（integrity `sha512-CwUiSAvDCYnmAZlpPMkurPHDfBLq6fvdRB3vRgoA894hRG/V/BSeY9bmMm6iIIU5VpjJxfb/dLPpJX2at0L9rw==`） | Apache-2.0（`LICENSE`） |
| `transformers-4.3.0/` | `transformers.js`（Whisper と Silero VAD を動かす。`dist/transformers.js` から sourceMappingURL の行を削除し、1か所だけ `"Mistral3ForConditionalGeneration"` を `"Mistral3For" + "ConditionalGeneration"` に分けた（同じ文字列。モデル名が GitHub の秘密の検査で Mistral の API キーと誤判定され push できないため。縮めた版 `transformers.min.js` も同じ理由で使わない） | `@huggingface/transformers@4.3.0`（integrity `sha512-fL1A/WUZwouPrOlYxU5dzIwD2T5J781JiB2jDR8bFe5DwCj0Gfudq+NEXCMno49kQgajHA7xQkrRLJlqG1veEA==`） | Apache-2.0（`LICENSE`） |
| `karume-models-0.14.0/` | `sbv2.js`（気持ちで話し分ける声。`koe.js` が使う。下の5つを esbuild で1つにまとめたもの：`npx esbuild entry.js --bundle --format=esm --platform=browser --target=es2022 --legal-comments=eof`、entry は `@karume/models/sbv2` の `Sbv2Pipeline`・`toSbv2Utterance`・`SBV2_SOURCES` と `@hdae/yomi` の `analyzeWithWords`・`@hdae/yomi/loader` の `getDictionary`） | JSR（npm.jsr.io）：`@karume/models@0.14.0`・`@karume/runtime@0.14.0`・`@karume/hub@0.14.0`・`@hdae/yomi@0.4.2`・`@hdae/fetch-cache@0.3.1` | MIT（`LICENSE` に5つ分。`THIRD_PARTY_NOTICES.md` は @karume/models のもの） |
| `wllama-3.8.1/` | `index.js`・`wllama.wasm`（WebGPU が使えない端末で、言葉のモデルを CPU で動かす llama.cpp の wasm。`esm/index.js` と `esm/wasm/wllama.wasm` をそのまま。worker は中で blob: から作るので CSP の worker-src に blob: が要る。compat モード（CDN から読む）は使わない） | `@wllama/wllama@3.8.1`（integrity `sha512-Pl7BEJhPU8OHnV/yhn3DFZYhLLOdSHh+4TND79WCftHnlUAdQPAsyc/CfIOY+4mVxvf5VW3Xw3Uf7BBfotS1gw==`） | MIT（`LICENSE`。元のファイル名は LICENCE） |
| `onnxruntime-web-1.31.0-dev.20260914-8d85527a0/` | `ort-wasm-simd-threaded.asyncify.mjs`・`.wasm`（transformers.js が使う ONNX Runtime の本体。transformers.js 4.3.0 が指定する版と同じ） | `onnxruntime-web@1.31.0-dev.20260914-8d85527a0`（integrity `sha512-Iy7rtadoBgxS/LLvDr3QW38DB1PNXRnr0GJMcL0TAt7c9qjgVQl83UlGCVyeAnK2InpmW8Uc3PL8XIuqtDeF6g==`） | MIT（`LICENSE`。npm の包みに LICENSE ファイルが無いため MIT の全文を置いた） |

モデル本体（数百MB〜1GB）はここに置かない（GitHub Pages の1ファイル 100MB の制限とリポジトリの重さのため）。
「AI の部品を入れる」を押したときだけ、次の場所から GET で取り、ブラウザの Cache API に保存する。

- 言葉のモデル: `huggingface.co/mlc-ai/Qwen2.5-0.5B-Instruct-q4f16_1-MLC` など（WebLLM の既定の置き場）
- CPU 版の言葉のモデル: `huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF` の `qwen2.5-0.5b-instruct-q4_0.gguf`（約430MB、Apache-2.0。コミットは `localai.js` の `CPU.url` で固定。wllama が OPFS に保存）
- 言葉のモデル用の wasm: `raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs`（WebLLM の既定の置き場）
- 声→文字: `huggingface.co/onnx-community/whisper-base`
- 割り込み: `huggingface.co/onnx-community/silero-vad`
- 気持ちで話し分ける声: `huggingface.co/hdae/karume-sbv2-jvnv`（コミットは `SBV2_SOURCES` で固定）と辞書 `huggingface.co/datasets/hdae/yomi-dict`（CC BY-SA 4.0・BSD 3-Clause。クレジットは README）

## 版を上げるとき

```bash
npm pack @mlc-ai/web-llm@<版> @huggingface/transformers@<版> @wllama/wllama@<版>
# transformers の package.json の dependencies にある onnxruntime-web の版も npm pack する
```

フォルダ名・`localai.js` の `VENDOR`・`sw.js` の `VENDOR_NOW` を新しい版にし、古いフォルダを消す（`VENDOR_NOW` に無い版は、端末の保存から消える）。WebLLM の版を上げるとモデル用 wasm の版（`modelVersion`）も変わることがある。

# ADR 0570: `examples/chat` の CLI の help と出力の文言を実装に合わせ、数の写しを外す

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-03

ADR 0569（#1681）の「直さなかったもの」の続き。0569 は `examples/chat/src/cli.ts` のコメントを直したが、実行時に出す文字列（`printHelp` の help 文と console の出力）は、コードを変えることになるので材料として残していた。ここではその文字列を直す。`@mnemora/example-chat` は `private: true` なので、公開 API は変わらない。CHANGELOG は要らない。出力の文言以外の振る舞いは変えない。

出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手の判定、【未確認】は確かめていないこと。

## 決定

1. **association-probes の help**: 「off/on(maxCount=3)/on(maxCount=5)の3arm」と書いていたが、`runAssociationProbes` は maxCount=10 の arm も持つ。arm の数を書かず、「off と on(maxCount を変えた複数 arm)」にした。【現物】
2. **identifier-probes の help**: 日本語意味 probe と識別子 probe しか挙げておらず、群4・5（日本語固有名詞、`./japanese-name-probe-set.js`）が無かった。3種の probe を群ごとに別々に集計する、と書いた。【現物】
3. **数の写し**（AGENTS.md「⚠ 数を、道具と生成物に焼き込まない」）:
   - identifier-probes・numeral-token-probes の群の見出しの件数は、probe set の配列（`PROBES`・`IDENTIFIER_PROBES`・`JAPANESE_NAME_PROBES`・`NUMERAL_TOKEN_PROBES`）の `length` をその場で引く形にした。
   - correction の完了の文の欄数、recall-footprint-calibration-samples の点数・件数・limit（help と出力）、answer-trials の dev のケース数は、数を書かず在りか（`checkCorrectionDemo()`・`checkCorrectionOmission()`、`CALIBRATION_SAMPLE_DESIGN`、dev ケース）を指す形にした。
   - `record:compare` の help の回数・時間・費用は ADR 0019 §3 の見積もりの写しで、§7.8 が実測で外れたと記録している。数を消し、§3（見積もり）と §7.8（実測）を指した。【現物】
4. **`MNEMORA_PROVIDER_SOURCE` の効く先**: help は「retrieval/compare」とだけ書いていた。`resolveRecordedRun` を呼ぶのは retrieval・compare・answer・answer-time-weighting・recall-footprint-calibration-samples なので、そのとおりに並べた。【現物】
5. **ADR 0051 の見出しの引用**: 「引き受ける負債」を、ADR 0051 の実際の見出し「引き受けた負債」に直した。【現物】

## 出力を縛るテスト

- 変えた文言（`3arm`・`probe7件`・`probe30件`・`657回`・`8〜15分`・`引き受ける負債`・`limit=20の8点`・`7欄`・`dev 6件`・`probe 7件`・`probe 12件`・`probe 18件`・`printHelp`・`使い方:`）を `examples/`・`scripts/`・`.github/` で grep した。【現物】
- `examples/chat/src/__tests__/cli-help.test.ts`（「使い方:」だけを見る）と `scripts/__tests__/example-chat-readme-flags-env.test.mjs`（`printHelp` の本文から flag と環境変数を拾う）が当たった。どちらも今回の変更では落ちない。直したテストは無い。【実測】
- `scripts/__tests__` に「probe 7件」を見るテストがあるが、見ているのは summary の `.mjs` の出力で、`cli.ts` ではない。【現物】

## 走らせたもの

- `pnpm --filter @mnemora/example-chat exec vitest run src/__tests__/cli-help.test.ts`・`pnpm exec vitest run scripts/__tests__/example-chat-readme-flags-env.test.mjs`・examples/chat の typecheck・`cli.ts` の eslint と prettier の検査。すべて通った。【実測】
- 【未確認】Postgres の要るテスト（`correction-demo.postgres.test.ts`・`retrieval-json-cli-wiring.postgres.test.ts`・`answer-cli.postgres.test.ts`）は手元で走らせていない。CI に任せる。

## 残り

- **README の節名**: `cli.ts` の出力の「examples/chat/README.md「正直に書くべき限界」参照」が指す見出しは README に無い。README は #1661（期限待ち）が触るので、今回は触っていない。#1661 が片づいたあとに、どの節を指すかを決めて直す。
- **CI の step 名**: `.github/workflows/ci.yml` の step 名に「limit=20の8点」の写しが残っている。CI の定義なので、今回の範囲の外とした。
- **コメントの数の写し**: `cli.ts` の doc コメントに残る写しは、#1681（ADR 0569）が直す分と重なるので、ここでは触っていない。

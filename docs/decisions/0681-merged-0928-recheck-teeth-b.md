# ADR 0681: 09/28 にマージされた B 群4本（#1331・#1340・#1374・#1383）の確かめ直しで見つかった穴に歯を足す（Issue #1827）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-07

**これはクローン（miku）の判断で、オーナーの判断ではない**（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。出所は Issue [#1827](https://github.com/takecchi/mnemora/issues/1827)。
これは試験だけの変更で、実装・`*-conformance.ts`・`__fixtures__/` は触らない（変異を一時的に当てただけで、控えを `cp` で取り、`cp` で戻して `cmp` で一致を確かめた）。B 群の4本には、これまで確かめ直しの記録が無かった。

## 経緯【実測】

約束ごとに、足りない側とやりすぎた側の変異を当てた。結果の表は Issue #1827 のコメントにある。約束が後の採用済み ADR で動いていた点は次のとおり。

- ADR 0360（`completeStructured` は送れない zod の形を送る前に `schema_unsupported` で落とす）は、#1331 の C5（`z.record` は空の object しか許さない形で送る）を逆にした。この点は当てていない。
- ADR 0368（統合先・内省の記憶は材料の有効期間の積を引き継ぐ）は、#1383 の「統合先の有効期間は今どおり null」を逆にした。この点は当てていない。
- #1802（`retry.attempts` に `±Infinity` を渡すと構築時に `RangeError`）は、#1340 の「`Infinity` のときの振る舞いは変えていない」を置き換えた。この点は当てていない。
- #1374 の話者の一文が指す「speaker」を、候補経路の入力に出す変更（ADR 0348 の追記）は広がっただけなので、今の約束に当てた。

## 足した歯

| PR | すり抜けた変異 | 歯 |
|---|---|---|
| #1340 | 読み込みの再試行が `sleep` を待たずに次の試行へ進む／種類の付いた失敗（`kind`）でも、投げ直す前に待つ | `packages/local-embedding/src/__tests__/retry-wait-before-next-attempt.test.ts` |
| #1331 | `completeStructured` が空の `system` を `""` で送る | `packages/anthropic/src/__tests__/complete-structured-empty-system.test.ts` |
| #1331 | 根が object で `$defs` を持つスキーマまで包む | `packages/openai/src/__tests__/structured-root-object-with-defs-not-wrapped.test.ts` |
| #1331 | 上限を宣言していないモデルの失敗の案内から `options.modelId` が消える | `packages/local-embedding/src/__tests__/unknown-input-limit-guidance.test.ts` |
| #1374 | `subjectCandidates` と `extractionContext` を併用した抽出で言語の一文が消える／統合・内省の言語の一文が記憶の件数で出入りする／Runtime が builder の `system` を捨てて LLM へ渡す | `packages/core/src/__tests__/language-instruction-prompts.test.ts` |
| #1383 | status の判定を `forgotten` だけ先にする／ゲートの時刻を `{ query }` の `validAt` で決める／`{ seedMemoryId }`・`{ query }` では未到来を見ない | `packages/core/src/__tests__/consolidate-validity-gate-shapes.test.ts` |

歯は、元の変異を当てると赤になることを確かめてから入れた。

## 塞がなかったもの

- #1331: Anthropic の `toAnthropicRequest` が空白だけの `system` も捨てる変異は、TSDoc が「空文字」だけを書いているので約束の外。`wrapRootSchema` が包みの `additionalProperties: false` を落とす変異は、#1331 の約束（`$ref: "#"` を書き換えない・`$defs` を根に残す）の外で、#1147 の側の約束。
- #1374: 言語・話者の指示を候補の一覧の前に置く変異と、2つの指示の間の空白を外す変異は、TSDoc が「文面はこの PR の裁量」と書いているので外。

## これが覆るとしたら

provider の空の `system` を送る形、根が object のスキーマを包まないこと、読み込みの再試行の待ち、抽出・統合・内省の言語の指示を足す条件、`consolidate` が有効期間の外の記憶を統合元にしないこと、のどれかが変わるとき。

# ADR 0481: 穴探し52巡目 — 実 Postgres の `recall` の出力が自分の `RecallResultSchema` を満たすかを `outputValidation` で当てる（草稿・作業中）

- **状態**: 草稿 (2026-10。作業中。実測の結果で書き換える)
- **日付**: 2026-10-02

クローン miku の委譲先（担い手。マネージャー mgr-0d3098f9 の指示による）が書いた。直す線（約束に実装を戻す・落ちる入力を減らす・文書の直し・前例のある同種の穴は直す。オーナーの領分の6つ〔前例の無い新しい断り・既定値の変更・公開 API を足す・suite に約束を足す・遡ってのデータの書き換え・適用済みの migration の編集〕は材料に回す）は依頼主が決めた。オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手の判定、【未確認】は確かめていないこと。

## 下調べの要点（この草稿の時点。器の入れ替えで文脈が失われても引き継げるように、先に書く）

- **選んだ面**: `Runtime.recall` の出力が、`@mnemora/core` 自身の `RecallResultSchema` を、**実 Postgres の store** で満たすか。
- **仕掛けは既にある**【現物】: `packages/core/src/recall-output-validation.ts` の `validateRecallOutput`（mode は `"off" | "report" | "throw"`、既定は `"report"`）が、`packages/core/src/recall-runtime.ts:3439-3443` で `draft` を `RecallResultSchema`（`packages/core/src/recall.ts:2724`）に毎回かけ、`outputValidation: { ok, issues }` を結果に載せる。`"throw"` なら `RecallOutputValidationError`（`kind: "recall_output_validation"`）を投げる。
- **なぜこの面か**: この仕掛けを**名指すテストは core の 4 ファイルだけ**（`recall-output-validation.test.ts`・`recall-pipeline.test.ts`・`recall-channels.test.ts`・`runtime-fakes.ts`）で、すべて core の fake store。`packages/postgres` と `examples/chat` には 0 件【実測。grep】。ADR 0434〜0480 の本文にも 0 行。実 Postgres の recall（`Date` の列、`real` の丸め、`explain.stages` の `detail`、連想・labels・budget・channels の組み合わせ）に `ok: true` を当てた歯が無いので、型と実際の出力のずれを見つけるための専用の道具が、実 store に対して使われていない。
- **gh の件数**（レート制限で取れた分）: `outputValidation` は closed の issue 4・PR 10、`RecallOutputValidation` は closed の issue 1、`recall_output_validation` は closed の PR 1。open は 0。既出の中身は mode の導入（Issue #131・ADR 0098）。
- **当て方**: 実 Postgres + fake の LLM・埋め込み。次の形の `RecallQuery` を `runtime.recall` に当て、`outputValidation` が `{ ok: true, issues: [] }` かを見る: 既定、`channels: ["ann","lexical"]`、`association`、`labels` + `taxonomyGroups`、`budget` で切り詰める形、`validAt` の外、`scopeAggregate: "skip"`。従として `explain.stages` の `detail` と `omitted` の各種類。陽性対照は、スキーマに反する draft で `ok: false` になる既存の歯（`recall-output-validation.test.ts`）と、`outputValidation: "throw"` で投げること。
- **線**: 食い違いが出れば、実装を型に戻すのは内側（直す。直す前の赤を先に見せる）。スキーマを緩めるのは公開の型の変更なので外側（材料）。何も出なければ、当てた記録（この ADR）と実 Postgres の歯が成果。
- **ADR 0480（`RecallRecord`・`getRecall`）との境**: こちらは **`recall` が返す `RecallResult`**。**`recall` の戻り値と `getRecall` の戻り値を比べる形は外す**（0480 の面。依頼主了承済み）。
- **見送った候補**: `createOptionalTrigramIndex[Concurrently]` の失敗経路（INVALID な索引の掃除まで TSDoc にあり、テスト 3 ファイルが見ている。ADR 0460・0464 の隣）、`listActiveClaimPredicates?`（テスト 14 ファイルが厚く、ADR 0473 の隣）、`InlineScheduler`（3 行の class）、`getObservation` の payload 往復（uuid の大文字小文字は今日の面、jsonb 往復は 0472 の隣）。
- **避けた面**: 50巡目（テナント設定、ADR 0479）、47巡目（labels の deadlock、ADR 0476）、0480（`RecallRecord`・`getRecall`）、今日までの面全部。

## 実測の結果

（作業中。追記する。）

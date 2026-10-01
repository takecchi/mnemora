# ADR 0495: 文書とコードのずれを横に掃く — パッケージの README・約束の文書・公開の型の TSDoc を、今の main の型と実装に照らす

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-02

クローン miku の委譲先（担い手。マネージャー mgr-86b4be97 の指示による）が書いた。文書の側だけを直した。コードの側を文書に合わせる必要がある食い違いは見つからなかった。

出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手の判定。

- **文脈**: ADR 0459 以来の、文書とコードのずれの掃き。今日 main に入った直し（ADR 0476・0478〜0485・0487・0489・0491）のあとで、古くなった所が無いかを、機械で照らせる形を中心に見た。`docs/migration-v1.md`・CHANGELOG・`examples/chat/README.md`・`docs/decisions/*`・`docs/north-star.md` は対象外。

- **照らした形と結果**【実測】（スクリプトは `.mgr-notes/` にあり、コミットしていない）:
  1. **識別子の実在**: 7 つのパッケージ README と `docs/` の 4 文書のバッククォートの識別子（camelCase・snake_case）を、コメントを除いたソース全体の語に照らした。ずれは `docs/recall.md` の `score.semanticSimilarity`（実在しない。`ScoreBreakdown` の欄は `similarity`）1 件。残りは外部（Postgres・openai・BullMQ・alteroid）の名前、テスト専用の Fake、将来の設計、「落とした」と書く否定の文だった。
  2. **TSDoc の識別子**: `packages/*/src` の TSDoc（`` `…` `` と `{@link …}`）を同じ要領で照らした。ずれは 2 件: `strategies/decay.ts` の `floorSeqAt`（実在しない。時刻側も活動時計側も `floorAt`）と、`postgres/src/pgvector-capability.ts` の `PostgresVectorStore` 内の `assertPgvectorCapability`（実在しない。`vector-store.ts` の `PgvectorCapabilityGate`）。
  3. **パスとリンク**: README・4 文書の `packages/…`・`docs/…` のパスと相対リンクの実在。ずれは無い（`memory-model.md` の `packages/core/src/store.ts` は alteroid のリポジトリのパスで、mnemora のものではない）。
  4. **README の `import { … } from "@mnemora/…"` の名前**: TypeScript の型検査器で各パッケージの公開の入口が export する名前を取り、全 README・約束の文書の import と照らした。ずれは無い。
  5. **architecture.md §5 の port の写し**: `interfaces/*.ts` とメソッドの名前・署名を 1 つずつ突き合わせた（ADR 0459 の道具）。ずれは無い。
  6. **`Runtime` のメンバー・`RuntimeDeps` の欄・`DEFAULT_*` の数値**: 文書に出る `Runtime.x`・`RuntimeDeps.x`・`DEFAULT_*` の数値を、型と定数に照らした。ずれは無い。パッケージの版（`openai@7.10.0`・`@anthropic-ai/sdk@0.124.0`・`bullmq`）、`DEFAULT_LOCK_TIMEOUT_MS`、`jobName` の既定も一致した。
  7. **README のコード片**: `pnpm run build` のあとで `scripts/check-doc-snippets.mjs` を走らせた。印の付いた片は全部通った。
  8. **今日の直しごとの古くなった所**: 0479（Fake の設定）・0480（fixture の `createRecall`）・0488 以外のうち main にある直しが触れた振る舞いを文書で引いた。古くなった所は無かった（`memory-model.md` の「1件ずつ届く経路は直っていない」は ADR 0491 の限界と矛盾しない）。

- **直したもの（文書の側だけ）**: `docs/recall.md` の `score.similarity`、`packages/core/src/strategies/decay.ts` の TSDoc（`floorAt`）、`packages/postgres/src/pgvector-capability.ts` の TSDoc（`PgvectorCapabilityGate`）。実装は変えていない。

- **コードの側を直すべき食い違い**: 見つからなかった。

- **陽性対照**【実測】: (a) architecture.md の写しの `getRecall` を `getRecallX` に変えると、§5 の突き合わせが `missing in doc: getRecall | extra in doc: getRecallX` を出す。(b) 存在しない名前を import する片を書くと、import の照合が `@mnemora/core has no …` を出す。(c) 識別子の照合は、上の `semanticSimilarity`・`floorSeqAt` を拾った。

- **見ていない形**【未確認】: 散文の中の定性的な主張（「〜は〜しない」）の全数、図、表の中の数値の全て。実 API を要する記述（外部 SDK の挙動の実測値）は、版の一致だけを見た。

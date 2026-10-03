# ADR 0559: 注入した時計は outbox の `available_at` と監査ログの `at` に届く——古い「届かない」「DB の `now()` で書かれる」記述を、いまの実装に合わせて直す（コメントと doc だけ）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-03

クローンの委譲先（担い手。マネージャー mgr-cb86a0fd の指示による）が書いた。決めたのはクローンで、オーナーではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード・文書、【判断】は担い手の判定、【未確認】は確かめていないこと。

## 何が古かったか【現物】

次の2つの主張が、コメントと doc に残っていた。

1. 「注入した時計（`RuntimeDeps.clock`）は、outbox の `availableAt`/`available_at` や監査ログの `at` には届かない。壁時計より過去の時計では `tick` がジョブを取らない」。
2. 「outbox の `available_at` は DB の `now()`（SQL の `now()`・マイクロ秒精度・壁時計）で書かれる」。

どちらも [Issue #1237](https://github.com/takecchi/mnemora/issues/1237) の頃（[ADR 0355](./0355-inject-clock-into-store-writes.md) の前）の実測としては正しかった。ADR 0355 で実装が直った後も、`RuntimeDeps.clock` の公開 TSDoc と、それを写した多くのテスト・example のコメントが残った。

## いまの事実【現物】（main 748b1587 で確認）

- Runtime は outbox を積む呼び出しすべてに `clock.now()` 由来の `now` を渡す（`packages/core/src/runtime.ts` の `const clock = deps.clock ?? systemClock`）。
- `@mnemora/postgres` の `PostgresMemoryStore`（`packages/postgres/src/memory-store.ts`）は `outboxNow = opts?.now ?? new Date()` を outbox の `available_at`・`created_at` に入れる（`createObservationWithOutbox`・`createMemoryWithOutbox`・`supersedeWithNewMemories`・`requeueEmbedJobs` ほか。`requeueEmbedJobs` は `toPgTimestamp(outboxNow)`）。testkit の InMemory も `opts?.now ?? new Date()`。**SQL の `now()` で outbox を埋める箇所は無い**。`opts.now` を渡さないときも JS の `new Date()`（ミリ秒）である。
- `restoreArchived` の `restored` イベントの `at` は clock、`sweepArchive` の `archived` は呼び出し側が渡す `opts.now`。
- 正しい記述の正本は `packages/core/src/interfaces/clock.ts` の TSDoc（本 ADR では触らない）。

## 直したもの

数は焼き込まない。現物は `git diff origin/main...HEAD --stat` と、下の分類を見ること。

- 公開 TSDoc: `packages/core/src/runtime.ts` の `RuntimeDeps.clock`。「届かない」を「届く」に書き直し、`clock.ts` を指す。
- fuzz の注記（core の harness・テスト、postgres の fuzz テスト）。時計の起点を実時刻より先に置く処理は変えず、理由を「歴史的な理由で残している」に書き直した。harness の「時計に依らない時刻」の列挙から outbox の `created_at`/`available_at` とイベントの `at` を外した。
- `packages/postgres/src/__tests__/` の `*.postgres.test.ts` のうち、時計を実時刻より先へ進める理由を「`available_at` が DB の `now()`」と書いていたもの。進める処理は残し、理由を書き直した。
- `packages/testkit/src/memory-store-conformance.ts` の、`available_at` を DB の `now()` と書いていた注記。
- `examples/chat/src` の同種の注記と、参照先の `mutable-clock.ts` の docstring。

## 直さないもの【判断】

- **式・値・`T0` の置き方・時計を先へ進める処理そのもの。** 今の事実では先へ進める必要はもう無いが、挙動を変えない約束の仕事であり、消すのは別の判断（コードは消さない）。
- **過去の実行の記録**: 既存の ADR（0355・0227・0422・0526・0532・0427・0058・0079 ほか）、CHANGELOG の `[1.2.0]` 以前の節、`docs/memory-model.md` の経緯の注記。当時の実測であり、書き換えると記録でなくなる。
- **PR #1666（ADR 0555、未マージ）が触るファイル**: `packages/core/src/__tests__/` の abort-signal・consolidate・decay-activity-clock-memory-own-subject・embed-job-error-cause・embed-job-missing-vector・extract-redelivery-unsaveable-fake・fake-outbox-opts-now・observe-attributes・reflect・runtime-branch-teeth・runtime-fakes.ts・runtime・tick-batch-lease-expiry・tick-last-error-cause・tick-last-error-redacts-params の各テスト。同じ主張があっても、衝突を避けるためここでは触らない。#1666 のマージ後に残っていれば別に直す。
- `packages/core/src/interfaces/clock.ts`（正本）。

## 放置した実害【現物】

古い公開 TSDoc は、後続の ADR に誤りとして写された。

- [ADR 0526](./0526-tick-jobs-after-delete-and-reextract-after-correction.md) 「結果 (1)」の「時計」の項は、「`RuntimeDeps.clock` に過去の時計を注入すると、`tick` は outbox の `availableAt`（壁時計）より前としてジョブを取らない（`processed: 0`）。`RuntimeDeps.clock` の TSDoc の注意（Issue #1237）どおり」と書いた。`availableAt` が壁時計だという主張を、TSDoc から確かめずに写している。歯は時計を注入しないので、実測した主張ではない。
- [ADR 0532](./0532-tick-job-sources-lowercase.md) の注意は、「ジョブの `available_at` は壁時計で積まれるので（`RuntimeDeps.clock` の TSDoc、ADR 0526）、この試験は runtime の時計を壁時計より先へ進め…」と書いた。TSDoc と ADR 0526 を二重に根拠に引いている。その試験のコメント（`packages/postgres/src/__tests__/tick-job-sources-lowercase.postgres.test.ts` の「ジョブの available_at は壁時計（`RuntimeDeps.clock` の TSDoc の注意、ADR 0526）」）も同じ。本 ADR でコメントは直したが、両 ADR は記録なので書き換えていない。

古い記述は、読んだ人が「注入した時計は届かない」を前提に設計・試験を組む誤りを再生産する。

## 検査

`pnpm typecheck`、`pnpm format:check`、`pnpm api:check`、ADR 目次の鮮度テスト、リンク・引用系の scripts テスト、触った core のテストの名指し実行（結果は PR に書く）。実装は変えていないので、DB テストは走らせなくてよい（コメントだけの変更）。

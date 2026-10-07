# ADR 0679: 09/17 にマージされた #464・#524（`restoreSuperseded` とその `dryRun`）の確かめ直しで見つかった穴に歯を足す（Issue #1812、まとまり G1）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-07

**これはクローン（miku）の判断で、オーナーの判断ではない**（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。出所は Issue [#1812](https://github.com/takecchi/mnemora/issues/1812)。[ADR 0676](./0676-merged-0917-recheck-teeth.md) が「Postgres が要るので測っていない」と残した G1 を、手元の Postgres 17 + pgvector（`initdb`、[ADR 0183](./0183-local-postgres-makes-postgres-mutation-testing-possible.md) の手順）を立てて測った。
試験だけの変更で、実装・`*-conformance.ts`・`__fixtures__/` は触らない（変異を一時的に当てただけで、控えを `cp` で取り、`cp` で戻して `cmp` で一致を確かめた）。

## 経緯【実測】

main `ed61bd67` の上で、`Runtime.restoreSuperseded`（`packages/core/src/runtime.ts`）・`groupSupersededCandidatesByOperation`・`PostgresMemoryStore.restoreSupersededBy`／`previewRestoreSupersededBy`・`InMemoryMemoryStore` の同名の口に、変異を1本ずつ当てた（core 43・testkit の in-memory 38・postgres 37、計118本）。走らせたのは、これらを名指しする core 19本・testkit 12本・postgres 23本（うち適合テスト1本は `-t upersede`）の試験ファイルである。core の変異で穴に見えたものは `core` の `dist` を、testkit の変異で穴に見えたものは `testkit` の `dist` を作り直して、testkit・postgres の試験も当て直した（両パッケージは `dist` から読むため）。

当てた約束は、#464（ADR 0230）と #524（ADR 0237）に、後の採用済み ADR で変わった分を重ねた今の形である。ADR 0230 の訂正1・訂正4と2026-09-26の追記で「群は1回の操作の単位とは限らない」が確定した契約になり、[ADR 0258](./0258-restore-superseded-operation-scope.md) が `onlyMemoryIds` と `groupSupersededCandidatesByOperation` で絞る口を足した。群を1回の操作に切る約束は取り下げられているので、当てていない。

## 穴と足した歯【実測】

穴は12本。

| 側                  | 変異                                                                                       | 足した歯                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| core                | `actor` の既定を `system` 以外にする                                                       | `restore-superseded-recheck-0917.test.ts`                                            |
| core                | `outcomes` の順を、store が返した `restored` の逆にする（束ねた強化・1件ずつの強化の両方） | 同上                                                                                 |
| core                | `dryRun` で置き換えた側／候補を `reinforce` する（2本）                                    | 同上                                                                                 |
| core                | `groupSupersededCandidatesByOperation` が空文字の reason を `null` と同じグループにする    | 同上                                                                                 |
| in-memory           | `previewRestoreSupersededBy` が別の置き換えた側の群を含める                                | `restore-superseded-recheck-0917-teeth.ts`（in-memory と postgres に同じ本文を流す） |
| in-memory・postgres | `previewRestoreSupersededBy` が `kind = 'superseded'` 以外のイベントの reason を読む       | 同上                                                                                 |
| in-memory・postgres | `previewRestoreSupersededBy` が候補の `updatedAt` を書く                                   | 同上                                                                                 |
| in-memory・postgres | `restoreSupersededBy` が置き換えた側の `updatedAt` を書く                                  | 同上                                                                                 |

`teeth.ts` を呼ぶのは `packages/testkit/src/__tests__/restore-superseded-recheck-0917.test.ts` と `packages/postgres/src/__tests__/restore-superseded-recheck-0917.postgres.test.ts`。これは ADR 0458 の `memory-store-round31-teeth.ts` と同じ置き方で、`*-conformance.ts` には足していない。全部、足した後に赤、戻して緑、`cmp` 一致。実バグは無し。

## 等価と判断した根拠【判断】

- `restoreSupersededBy` の `target` CTE から `superseded_by_id`／`status` の絞りを外す: 直後の `UPDATE` が同じ2条件を `m` に重ねて確認する（並行の forget への備え）ので、結果は変わらない。
- 束ねた強化が失敗したあとの `reinforcedById.clear()` を外す: `reinforcedById` は束ねた強化が成功した後でしか埋めないので、失敗時は元々空である。
- in-memory の `restoreSupersededBy`／`previewRestoreSupersededBy` からテナントの絞りを外す: ADR 0439 により、別テナントの anchor を指す行は API で作れず、到達しない（Postgres は生 SQL の歯がある）。

約束に無いので歯にしない: `unsuperseded` イベントの `size_before_bytes` が `NULL` か `0` か（doc は `digestSnapshot` だけを約束する）。

## 決定【判断】

1. 実装・`*-conformance.ts`・`__fixtures__/` は変えない。足すのは試験だけである。
2. 試験は新規4ファイル（core 1、testkit 2〔本体と共有の `teeth.ts`〕、postgres 1）。
3. 実バグは無し。

## 確かめていないこと

- migration 0018（`memory_events_kind_check` に `unsuperseded` を足す）の変異は当てていない。DB の作り直しが要るため。既存の `memory-events-kind-check.postgres.test.ts` が見ている。
- 並行（2接続）の歯は、`UPDATE` の再確認を外す変異が赤になることまでは見た。別プロセス・別 `Pool` の並行は測っていない。
- core の変異は core の試験で測り、穴に見えたものだけ `dist` を作り直して testkit・postgres の試験で当て直した。残りの core の変異は postgres・testkit の試験では測っていない。
- 全テストは流していない。関係するファイルを明示して走らせた。

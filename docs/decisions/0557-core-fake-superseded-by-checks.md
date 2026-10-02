# ADR 0557: core の Fake も `supersededById` の断り（ADR 0503・0515）を持つ（InMemory・Postgres と揃える）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-03

クローン miku の委譲先（担い手。マネージャー mgr-1eb52294 の指示による）が書いた。決めたのはクローンで、オーナーではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード、【実測】は手元で走らせた結果、【判断】は担い手の判定、【未確認】は走らせていないもの。

## 文脈【現物】

- [ADR 0550](./0550-doc-code-drift-sweep-0515.md) の材料1: Fake は ADR 0503・0515 の `supersededById` の断りを持たない。
- [ADR 0503](./0503-superseded-by-checks-resolve-contested-update-status.md)・[ADR 0515](./0515-superseded-by-remaining-checks.md) は、testkit の `InMemoryMemoryStore` と `PostgresMemoryStore` に断りを入れ、「Fake は揃えていない」を負債として引き受けていた。
- 割れ: `packages/core/src/__tests__/runtime-fakes.ts` の `FakeMemoryStore` は、`updateStatus`・`updateStatusWithEvent`・`resolveContestedPair`・`resolveContestedGroup` のどれでも、`superseded` に `supersededById` が無い・自己置換・`active` などへの付与・メンバー間の循環・対や群の外の `forgotten` を指す、を断らず、そのまま書いた。Fake に頼るテストが、本物（Postgres）なら例外になる入力で緑になりうる。

## 決定【判断】

1. Fake に、testkit の `assertSupersededByShape`・`assertNoSupersededCycle` と同じ文面の検査（`assertFakeSupersededByShape`・`assertFakeNoSupersededCycle`）を置いた。core は testkit を import できない（`dependency-boundary`）ので複製で、コメントに「testkit の○○と同じ（ADR 0503・0515）」と書いた（[ADR 0549](./0549-core-fake-cas-rejects-purged-row.md) の `casMismatch` と同じ作法）。例外は `RangeError`、message は InMemory・Postgres と一字一致。
2. 断る入力と口:

| 断る入力 | 口 |
|---|---|
| `superseded` で `supersededById` が無い | `updateStatus`・`updateStatusWithEvent`・pair・group |
| 自己置換 | 同上 |
| `superseded` 以外（pair・group では `active`）に付与（`forbidWhenNotSuperseded: true`） | 同上 |
| メンバー間の循環 | pair・group |
| 対の外の `forgotten` を指す（ADR 0515） | pair |
| 群の外の `forgotten` を指す（ADR 0503） | group |

3. 対の相手、外の `active`・`archived`・`superseded`・`contested` を指すのは断らない（InMemory・Postgres と同じ）。
4. 自己置換と循環は、両側を `normId` で畳んだもの同士で比べる（Postgres と同じ）。
5. Fake の `updateStatus` が `contested` を断らないこと（Issue #768、`fake-input-checks-round2.test.ts`）は変えていない。

## 位置【現物】

- `updateStatus`・`updateStatusWithEvent`: `id = normId(id)` の直後、`beforeUpdateStatus` hook と存在確認より前に形の検査。
- `resolveContestedPair`・`resolveContestedGroup`: `normPairSide`・`assertFakeMemoryColumn`・same-id（group は length・unique）のあと、存在確認より前に形と循環の検査。`forgotten` の検査は、ref の検査（`assertOwnMemoryRef`）の直後、書く前。

## 直した既存テスト2件【実測】

Fake が断るようになったので、`superseded` に置き換えた側を渡していなかった2件に、勝者になる別の記憶を `supersededById` に渡した。期待は変えていない（ADR 0503 決定8 と同じ扱い）。

- `packages/core/src/__tests__/fake-memory-store-tsdoc-edges-round3.test.ts`（`listLabels` が status 変更で変わらない it。`memories[2]` を `superseded` にするところで `memories[1]` を渡す）
- `packages/core/src/__tests__/recall-companion-status-gate.test.ts`（`it.each(["superseded","archived"])`。`superseded` のときだけ `supersededById: a.id` を付ける）

## 歯と赤の記録【実測】

- 歯: `packages/core/src/__tests__/fake-superseded-by-checks.test.ts`（20 本。DB 不要）。上の表の断りを口ごとに、message の照合つきで確かめ、断られたとき行（status・`supersededById`・`updatedAt`）もイベント数も変わらないことを見る。陽性対照（勝者・相手・外の `active`・外の `archived` を指す、`supersededById` 無しの非 superseded）が4口に1本ずつ。
- 直す前の赤: 20 本中 16 本が赤、4 本（陽性対照）が緑。赤は pair 5・group 5・`updateStatus` 3・`updateStatusWithEvent` 3。直した後は 20 本とも緑。

## 変異試験【実測】

足した検査を1つずつ外し、新しい歯だけを走らせた（戻した後は `git diff` が空）。

| 外した検査 | 赤になった it（本数） |
|---|---|
| 欠落（helper。4口まとめて） | 4（pair・group・`updateStatus`・`updateStatusWithEvent` の欠落） |
| 自己置換（helper。4口まとめて） | 4（4口の自己置換） |
| 非 superseded への付与（helper） | 4（4口） |
| 自己置換の `normId`（大小違いの自己置換） | 2（`updateStatus`・`updateStatusWithEvent`） |
| 循環（helper の判定そのもの） | 2（pair・group） |
| 循環の `normId`（`next.set` の両側） | **0（緑のまま）** |
| 対の外の `forgotten` | 1（pair） |
| 群の外の `forgotten` | 1（group） |
| `updateStatus` の呼び出し | 3 |
| `updateStatusWithEvent` の呼び出し | 3 |
| pair の形の検査の呼び出し | 3（欠落・自己・active への付与） |
| group の形の検査の呼び出し | 3（同上） |
| pair の循環の呼び出し | 1 |
| group の循環の呼び出し | 1 |

- **生き残った変異**: 循環の `normId` を外しても緑。pair・group の入力は呼び出しの先頭の `normPairSide` が id を畳み済みなので、helper 内の `normId` は今の呼び出し経路からは観測できない（防御）。Postgres の helper は自前で畳むので同じ形を残した。歯は足していない。
- 自己置換の `normId` は、pair・group では `normPairSide` の畳みで足りるため外しても赤にならない（上の表の「2」は `updateStatus*` だけ）。

## 走らせたテスト【実測】

名指しで走らせた 39 ファイル・577 本、すべて緑。全テストは走らせていない（CI が全部を走らせる）。

fake-superseded-by-checks・fake-memory-store-tsdoc-edges-round3・recall-companion-status-gate・fake-input-checks-round2・fake-referential-integrity・fake-event-write-atomicity・fake-event-target-belongs-to-ctx-tenant・fake-claim-key-parity・fake-uppercase-target-id・fake-cas-purged-row・fake-memory-store-supersede-with-new-memories・fake-store-postgres-parity・fake-runtime-tick-jobs-and-correction-reextract-parity・contested-pair-invariant・contested-group-event-growth・contested-unresolved-note-growth・mark-contested・mark-contested-group・resolve-contested・resolve-contested-group・resolve-contested-loser-invariant・resolve-contested-unknown-kind・resolve-orphaned-contested・reextract 系・consolidate 系・forget 系・restore-archived・restore-superseded 系・superseded-operation-grouping・superseded-reason-writer-consistency・is-contested-without-companion・recall-association-contested-companion（vitest の名前一致で拾うため、`reextract`・`consolidate`・`forget`・`restore-superseded`・`resolve-contested`・`mark-contested` は前方一致する別ファイルも含む）。

## 保険（Postgres の歯）

`packages/postgres/src/__tests__/store-superseded-by-checks.postgres.test.ts` の `KITS` に「core の Fake」を足した（`store-input-current-behaviour.postgres.test.ts` の `createFakeRuntimeStores` の相対 import と同じ形。イベント数は Fake の裏の `events` を読む）。これで同じ入力を testkit の InMemory・Postgres・core の Fake に流し、message まで同じであることが見張られる。DB が要るので手元では走らせていない。CI の Postgres ジョブで確かめる【未確認】。

## CHANGELOG・migration-v1 を変えない理由

Fake は `packages/core/src/__tests__` の非公開のテスト用実装で、公開 API・利用者に見える振る舞いは変わらないため。

## 材料A（今回は入れない）

Fake の pair・group には [ADR 0499](./0499-store-write-checks-nul-named-status-range-purged-cas-int4-days.md) の `assertResolvedStatus`（`"active" | "superseded"` の外の status を断る）も無い。範囲外なので入れていない。入れるなら、列挙の検査（`assertFakeMemoryColumn`）の後に置くこと。先に置くと、`fake-input-checks-round2.test.ts` の「`"bogus"` が `/memories\.status must be one of/` で断られる」期待（614-625 行付近）が赤になる。

## 【判断・未確認】InMemory の大文字小文字

testkit の InMemory の `updateStatus*` は `opts.supersededById` の大文字小文字を畳まずに自己置換と比べるので、大小違いの自己置換を断れない可能性がある（コードを読んだだけで、走らせていない）。この PR では直さない。Fake・Postgres は畳む。

## 採らなかった案

- testkit から共有する。core は testkit に依存しない。写しが増える負債は、Fake・InMemory・Postgres に同じ入力を流す歯（上の保険）で見張る。
- `assertResolvedStatus` も一緒に入れる。範囲外（材料A）。

## これが覆るとしたら

ADR 0503・0515 の断りが変わる（たとえば `forgotten` を指すのを許す）とき。3実装を一緒に直す。

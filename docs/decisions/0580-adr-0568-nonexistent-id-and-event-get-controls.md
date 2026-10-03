# ADR 0580: ADR 0568 の歯が通した「存在しない id」と「別のイベント id」の変異を塞ぐ

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-03

クローン miku の委譲先（担い手。マネージャー mgr-dcc786b9 の指示による）が書いた。決めたのはクローンで、オーナーではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果（PostgreSQL 17 + pgvector を自分専用のポート 55891 で。`C.UTF-8`）、【判断】は担い手の判定。
これは試験だけの変更で、実装・CHANGELOG は触らない（[ADR 0572](./0572-core-fake-supersede-atomic-controls.md)・[0574](./0574-adr-0557-superseded-by-controls.md)・[0575](./0575-outbox-negative-limit-teeth-independent-of-planner-stats.md) の試験だけの PR も CHANGELOG を触っていない【現物】）。

## 経緯【実測】

[ADR 0568](./0568-abort-if-superseded-controls-and-duplicate-id-changed.md)（PR #1680）は、ADR 0556 の穴 M2〜M5 を塞ぎ、`abortIfSuperseded` が綴り違いの同じ id（`[x, X]`）を Postgres と同じ1件として数えるようにした。そのマージ済みの状態に対して変異試験で確かめ直した（変異は約40件）。0568 の約束は次の9つに読んだ。

| 約束 | 内容 |
|---|---|
| P1 | 大文字の id でも superseded を見つけて断り、何も書かない |
| P2 | 別テナントの superseded な記憶は大文字の id でも見ない |
| P3 | ctx のテナントの綴りは畳まない（`abortIfSuperseded`） |
| P4 | 同じく `EventStore.get` のテナントの綴りは畳まない |
| P5 | superseded 以外の status は断らない |
| P6 | `[x, X]` は1件 |
| P7 | `changed` は id の昇順 |
| P8 | `changed[].id` は小文字 |
| P9 | 存在しない id は断らない（Postgres と同じ） |

大半の変異は既存の歯が赤くした。生き残ったのは次の3つ【実測】。

| 変異 | 内容 | 生き残った理由 |
|---|---|---|
| A19 / A19b | testkit `InMemoryMemoryStore` の `assertNoneSuperseded` が、存在しない id を superseded 扱いにする（`changed` に積む・直接 `SourceMemoryStatusChangedError` を投げる） | P9 の入力（形の正しい、どの記憶でもない id）を渡す歯が無かった |
| E5 | testkit `InMemoryEventStore.get` の id の比較を `e.id.includes(lowered)` に緩める | 「別のイベント id は null」を見る歯が無かった（当たる側と、別テナントの側しか見ていない） |
| G4 | core `FakeEventStore.get`（`runtime-fakes.ts`）の同じ緩め | 同上 |

## 決定【判断】

1. 実装は変えない。3つとも実装が Postgres と違うのではなく、歯が足りなかった。Postgres の `assertNotSupersededForUpdate`（`packages/postgres/src/memory-store.ts`）は、存在しない id では行が選ばれず投げない【現物】。
2. 歯を3本足す（試験だけ）。
   - `packages/postgres/src/__tests__/uppercase-target-id-parity.postgres.test.ts`: 「abortIfSuperseded: 存在しない id は断らず、書く」。3つの口（`createMemoryWithOutbox`・`createMemoriesWithOutboxAndEvents`・`supersedeWithNewMemories`）それぞれに1本（計3本）で、Postgres が `NO THROW || wrote=true` であること（基準）と、testkit が同じになることを見る。既存の `observeAbortIfSuperseded` に `"ABSENT"` の variant（形の正しい、どの記憶でもない uuid）を足した。Fake は `abortIf*` を持たない（ADR 0493）ので pg と testkit だけ。
   - `packages/testkit/src/__tests__/in-memory-uppercase-target-id.test.ts`: `EventStore.get` に、実在のイベント id の末尾1字を落とした id（`startsWith`・`includes` なら当たる）を渡すと null。実在の id では当たることも見る。
   - `packages/core/src/__tests__/fake-uppercase-target-id.test.ts`: core の Fake に同じ。

## 変異試験【実測】

実装ファイルを `cp` で退避し、変異を入れ、新しい歯だけを走らせ、`cp` で戻して `cmp` で同一を確かめ、同じ歯を緑に戻した。

| 歯 | 変異 | 赤 | 戻して |
|---|---|---|---|
| 存在しない id（3本） | A19: `memory === undefined` のとき `changed.push({ id, observedStatus: "superseded" })` | 3本とも赤（`Received: "THROW SourceMemoryStatusChangedError <口> [{"id":"<other>",...}] \|\| wrote=false"`、期待は `NO THROW \|\| wrote=true`） | 3本緑 |
| testkit `EventStore.get` | E5: `e.id === lowered` → `e.id.includes(lowered)` | 1本赤（13本中。`get(ctx, prefix)` が null でなくイベントを返す） | 13本緑 |
| core Fake `EventStore.get` | G4: 同じ緩め | 1本赤（11本中） | 11本緑 |

A19b（直接 throw）は別に走らせていない。同じ分岐で、赤くなる条件（存在しない id で `NO THROW` でなくなる）が同じなので、A19 の赤が覆う【判断・未確認】。

## 直さないもの

- **Pg6**（Postgres の `assertNotSupersededForUpdate` から `isUuidLike` の絞り込みを外す）: 0568 の約束の外。Postgres は 0568 が変えないと明記した基準で、形が壊れた id を「存在しない」扱いにする作法は識別子の形式の ADR の領分（[ADR 0423](./0423-identifier-well-formed-and-error-message-without-params.md)、参照の書き込みの [ADR 0439](./0439-memory-store-reference-writes-check-target-belongs-to-ctx-tenant.md)。`isUuidLike` 自体の由来は `packages/postgres/src/mapping.ts` の TSDoc が書く「存在確認のための `"does-not-exist"` が `invalid input syntax for type uuid` になる」問題）。単一の ADR が「形式に合わない id は存在しない扱い」を決めているわけではないので、特定の1本は名指ししない【判断】。
- **Pg7**（`FOR UPDATE` を外す）: 行ロックによる競合の窓は [ADR 0420](./0420-consolidate-reflect-abort-on-superseded-and-all-conflicted.md) の領分で、直列に走る試験では有る場合と無い場合を区別できない。並行に走らせる歯は別の仕事。

## これが覆るとしたら

Postgres が存在しない id でも `abortIfSuperseded` を断るように変わったとき（そのとき3実装と、この歯の期待値を一緒に直す）。`EventStore.get` が id の部分一致を許す契約に変わったとき。

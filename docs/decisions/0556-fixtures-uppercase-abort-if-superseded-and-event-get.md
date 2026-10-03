# ADR 0556: testkit の InMemory の `abortIfSuperseded` と、testkit・core の Fake の `EventStore.get` も、大文字の id を Postgres と同じに扱う

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-03

クローン miku の委譲先（担い手。マネージャー mgr-d2a63d5d の指示による）が書いた。決めたのはクローンで、オーナーではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果（PostgreSQL 17 + pgvector を自分専用のポートで。`C.UTF-8`）、【判断】は担い手の判定、【未確認】は確かめていないこと。

⚠ 問21 の「操作対象 id は Postgres のみ」という前提は、[ADR 0521](./0521-fixtures-accept-uppercase-target-id-like-postgres.md) で古くなった（fixture も大文字の対象 id を受ける）。本 ADR は、その残り2点を揃える。

## 割れ【現物・実測】

[ADR 0521](./0521-fixtures-accept-uppercase-target-id-like-postgres.md) は、操作の対象の id を取る口の入口で id を小文字にそろえた。次の2点が残っていた。

1. **`InMemoryMemoryStore` の `assertNoneSuperseded`**（`packages/testkit/src/__fixtures__/in-memory-memory-store.ts`）。`abortIfSuperseded` の id を `this.memories.get(id)` にそのまま渡していた。fixture の id は小文字の `mem-N` なので、大文字の id（`MEM-N`）は引けず、superseded を見落として書き込んだ。Postgres は `id = ANY($1::uuid[])` で比べるので大文字でも当たり、`SourceMemoryStatusChangedError` を投げて何も書かない。効く口は3つ: `createMemoryWithOutbox`・`supersedeWithNewMemories`・`createMemoriesWithOutboxAndEvents`。
2. **`EventStore.get`**（testkit の `InMemoryEventStore`、core の `FakeEventStore`＝`packages/core/src/__tests__/runtime-fakes.ts`）。`e.id === id` で比べていたので、大文字のイベント id は `null` だった。Postgres は `id = ${id}`（uuid 型の列）で比べるので当たる。

## 決定【判断】

1. `assertNoneSuperseded` で、渡された id に `normId`（ADR 0521 が入れた小文字化）を掛けてから引く。
2. 両方の `EventStore.get` で、渡された id を小文字にして比べる。この2つの fixture のイベント id は小文字の `evt-N` だけなので、小文字にそろえても別の id と混ざらない。
3. **`SourceMemoryStatusChangedError` の `changed[].id` は小文字**にする（下の実測）。

## `changed[].id` の綴り【実測】

- やり方: `uppercase-target-id-parity.postgres.test.ts` に足した歯が、本物の `PostgresMemoryStore` に、superseded の記憶の id を**大文字に変えて** `abortIfSuperseded` へ渡し、投げられた `SourceMemoryStatusChangedError.changed[].id` を、渡した綴り（大文字）・小文字・そのほか、の3つに分類して記録する（3つの口それぞれで）。別に、`psql` で `select 'ABCDEF01-2345-6789-ABCD-EF0123456789'::uuid::text` を打って確かめた。
- 結果: **3つの口とも `changed[].id` は小文字**（大文字で渡しても。`observedStatus` は `superseded`）。`psql` も `abcdef01-2345-6789-abcd-ef0123456789`（uuid 型の列は読み戻すと小文字の正規形）。Postgres は `SELECT id, status FROM memories` の行の `id` を `changed[].id` に入れており（`packages/postgres/src/memory-store.ts` の `assertNotSupersededForUpdate`）、渡した綴りのエコーではない。
- 帰結: InMemory も小文字にそろえる（決定3）。渡した綴りのままにすると、歯が `<UPPER>` で赤くなる（変異試験の表）。

## 直さないもの【判断】

- **`supersedeWithNewMemories` の `conflicted[].id` の綴り**: ADR 0521 が「比べない」と決めている。変えていない。
- **Fake の `abortIf*` が無いこと**: [ADR 0493](./0493-fake-and-inmemory-input-checks-aligned-to-postgres.md) のとおり。Fake の `memoryStore` は渡された `abortIf*` を見ないので、(1) の歯は Postgres と testkit だけで比べ、Fake は `EventStore.get` だけを比べる。
- **Postgres の振る舞い**。

## 歯と実測【実測】

歯は、ADR 0521 の3本のテストに足した。

- `packages/postgres/src/__tests__/uppercase-target-id-parity.postgres.test.ts`: (a) `abortIfSuperseded` を3つの口 × 小文字・大文字で、Postgres を基準に testkit と比べる（投げた例外の種類・`method`・`changed[]` の綴りの分類・書き込みが残っていないこと）。(b) `EventStore.get` を小文字・大文字で、Postgres・testkit・Fake の3実装で比べる。
- `packages/testkit/src/__tests__/in-memory-uppercase-target-id.test.ts`: `EventStore.get`、3つの口の `abortIfSuperseded`（`changed[].id` は小文字、何も書かない）。
- `packages/core/src/__tests__/fake-uppercase-target-id.test.ts`: `EventStore.get`。

**直す前の赤**（歯だけを足した状態。Postgres の基準の assertion は緑）:

- 3実装の突き合わせ: `abortIfSuperseded` の3口とも、testkit は `NO THROW || wrote=true`（期待は `THROW SourceMemoryStatusChangedError <口> [{"id":"<lower>","observedStatus":"superseded"}] || wrote=false`）。`EventStore.get` は `lo=true UP=false kind=undefined`（期待は `lo=true UP=true kind=updated`）。4本赤。
- testkit の単体: `EventStore.get` が `expected undefined to be 'evt-48'`。`abortIfSuperseded` が `createMemoryWithOutbox: expected false to be true`（`SourceMemoryStatusChangedError` が出ない）。2本赤（9本緑）。
- core の Fake の単体: `EventStore.get` が `expected undefined to be 'evt-48'`。1本赤（9本緑）。

直した後は、突き合わせ 55 本・testkit 11 本・core 10 本とも緑。

**変異試験**（直した箇所を1つずつ元へ戻し、歯が赤になることを確かめ、`git checkout -- <ファイル>` で戻した。戻した後は緑）:

| 戻した箇所 | 赤になった歯 |
|---|---|
| `assertNoneSuperseded` の `normId` を外す（`const id = raw`） | testkit の単体 `abortIfSuperseded`（`createMemoryWithOutbox: expected false to be true`）。突き合わせの3口（`NO THROW || wrote=true`） |
| `assertNoneSuperseded` の `changed` に渡した綴り（`raw`）を入れる（引きは小文字のまま） | testkit の単体 `abortIfSuperseded`（`MEM-n` と `mem-n` の不一致）。突き合わせの3口（`id` が `<UPPER>`） |
| testkit `InMemoryEventStore.get` の小文字化を外す | testkit の単体 `EventStore.get`。突き合わせ `EventStore.get` |
| core `FakeEventStore.get` の小文字化を外す（testkit は直したまま） | core の単体 `EventStore.get`。突き合わせ `EventStore.get`（`lo=true UP=false kind=undefined`。testkit は緑なので、赤は Fake だけから） |

## CHANGELOG【判断】

- **書く**（`[1.3.0]` の `### Fixed`）: `@mnemora/testkit` は `private` でなく、`package.json` の `exports` に `./fixtures` があり、`files` は `dist`。`InMemoryMemoryStore`・`InMemoryEventStore` は公開物（`@mnemora/testkit/fixtures`）である。ADR 0521 も同じ理由で項目を足している。`[1.2.0]` には触らない。
- **core の Fake は書かない**: `FakeEventStore` は `packages/core/src/__tests__/runtime-fakes.ts`（テスト専用、`files` は `dist` だけで出荷物に入らない）。ADR 0549 と同じ。
- `docs/migration-v1.md` は触っていない。落ちる入力が減る側の変更で、新しく断る入力は無い。

## 採らなかった案

- `changed[].id` を渡した綴りのままにする: Postgres の実測（小文字）と合わない。
- 歯を conformance suite に足す: ADR 0434 決定5のとおり、約束を足すのはオーナーの判断。

## これが覆るとしたら

Postgres が `changed[].id` に渡した綴りをエコーするようになったとき、または `EventStore.get` が id の大文字小文字を区別するようになったとき（ADR 0446・0469・0475・0521 と一緒に見直す）。

## 【未確認】

- Fake の `memoryStore` に `abortIf*` が入ったときの綴り（ADR 0493 が決めるまで比べない）。

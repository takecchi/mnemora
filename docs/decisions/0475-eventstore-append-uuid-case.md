# ADR 0475: `InMemoryEventStore.append`・`FakeEventStore.append` も、`event.memoryId` の大文字小文字を区別しない（ADR 0469 の残りを揃える）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-02

クローン miku の委譲先（担い手。マネージャー mgr-86b4be97 の指示による）が書いた。直す線はクローン miku が決めた。オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
**オーナーが覆せる点は「これが覆るとしたら」にまとめてある。**
出所の区別: 【現物】は読んだコード、【実測】は名指しのテストで走らせた結果、【判断】は担い手の判定。

- **文脈**: [ADR 0469](./0469-fake-event-target-and-uuid-case.md) は、`MemoryStore` の9口の `NewMemoryEvent.memoryId` の検査で、uuid の大文字小文字を3実装（`@mnemora/postgres`・testkit の `InMemoryMemoryStore`・core の `FakeMemoryStore`）で小文字にそろえて受ける側に揃えた。ただし `EventStore.append` は9口の外で、「引き受けた負債」に残した:
  - `PostgresEventStore.append` は `normalizeUuidCase` で小文字にそろえるので、大文字の uuid を通す【現物。`event-store.ts`】。
  - `InMemoryEventStore.append` は `memoryStore.get(ctx, event.memoryId)` の完全一致で、大文字の `memoryId` を断った【現物。`in-memory-event-store.ts`】。
  - `FakeEventStore.append` も `backing.memories.get(event.memoryId)` の完全一致で、同じく断った【現物。`runtime-fakes.ts`】。
  - 実測（直す前）: 大文字の自テナントの記憶 id は、postgres だけが通し、InMemory・Fake は `memory not found for tenant` で断った【実測。`.mgr-notes/red-before-0475-*.txt`】。

- **決めたこと**:

  1. **`InMemoryEventStore.append` と `FakeEventStore.append` で、`event.memoryId` を小文字にして記憶を引く。**postgres と同じく、大文字の自テナントの記憶 id は通る。断るときの message は渡された id のまま（ADR 0469 と同じ。postgres の `memoryNotFound` は小文字にそろえた id を載せるが、message の id の大文字小文字は揃えない——`kind`・`code` は無く、接頭辞だけが実装ごとに違うという既存の扱いの範囲）。
  2. **別テナントの記憶は、大文字で渡されても断る。**`null`（`events_purged`）は検査しない（変えない）。空文字・uuid でない id・実在しない id は、今までどおり断る。
  3. **積む `memoryId` は、ADR 0469 で入れた小文字化（`buildStoredMemoryEvent`・`buildStoredEvent`）をそのまま使う**ので、矛盾しない（`append` の戻り値も小文字で返る）。
  4. **操作の対象の `id`（ADR 0446 の既存の違い）には触れていない。**`append` に渡すのはイベントの指し先であり、操作の対象の id ではない。
  5. **落ちる入力が減る変更**で、新しく断る入力は無い（直す前に断っていた大文字の自テナントの記憶 id が通るようになるだけ）。
  6. **conformance suite には何も足していない**（ADR 0434 決定5）。`EventStoreConformanceOptions` の約束は変えていない。
  7. 歯は既存のファイルに足した:
     - `packages/testkit/src/__tests__/in-memory-event-target-belongs-to-ctx-tenant.test.ts`（`InMemoryEventStore.append` の1本）。
     - `packages/core/src/__tests__/fake-event-target-belongs-to-ctx-tenant.test.ts`（`FakeEventStore.append` の1本）。
     - `packages/postgres/src/__tests__/event-vector-tenant-check.postgres.test.ts`（`PostgresEventStore.append` の基準の1本）。
     - `packages/postgres/src/__tests__/event-target-parity.postgres.test.ts`（postgres と InMemory に同じ入力を流し、結果・積まれた `memoryId`・別テナントのイベント数が一致する1本）。

- **3実装の一致**【実測】:

  | `event.memoryId` | postgres | InMemory（直した後） | Fake（直した後） |
  |---|---|---|---|
  | 自テナントの記憶（小文字） | 通る・小文字で積む | 同じ | 同じ |
  | 自テナントの記憶（大文字） | 通る・**小文字で積む** | 同じ | 同じ |
  | 別テナントの記憶（小文字） | 断る | 同じ | 同じ |
  | 別テナントの記憶（大文字） | 断る | 同じ | 同じ |
  | uuid でない id・実在しない id・空文字 | 断る | 同じ | 同じ |
  | `null`（`events_purged`） | 検査しない | 同じ | 同じ |

  postgres と InMemory は `event-target-parity.postgres.test.ts` が同じ入力で比べる。Fake は、同じ表を `fake-event-target-belongs-to-ctx-tenant.test.ts` が縛る（postgres の package から core のテスト専用の Fake を import しないため）。

- **変異試験**【実測。`.mgr-notes/mutations-0475.txt`・`red-before-0475-*.txt`】:

  - **直す前で赤**: InMemory の歯 12 本中 1 本、Fake の歯 11 本中 1 本、postgres の一致の歯 11 本中 1 本（postgres の基準の歯は、元から緑）。
  - **やりすぎで赤**: 大文字で渡された id なら別テナントでも通す（InMemory の歯 1 本と一致の歯 1 本・Fake の歯 1 本）、`null` まで検査する（InMemory 1 本・Fake 1 本）。
  - **足りなくて赤**: 小文字にそろえない（InMemory 1 本と一致の歯 1 本・Fake 1 本）、積む `memoryId` を小文字にそろえない（InMemory 2 本と一致の歯 1 本・Fake 2 本）、message に小文字にした id を載せる（InMemory 1 本）。

- **走らせたテスト**（名指し）: `in-memory-event-target-belongs-to-ctx-tenant.test.ts`・`in-memory-event-kind-check.test.ts`（14 本）、`fake-event-target-belongs-to-ctx-tenant.test.ts`・`fake-event-write-atomicity.test.ts`・`fake-event-store-list.test.ts`（24 本）、`event-vector-tenant-check.postgres.test.ts`・`event-target-parity.postgres.test.ts`（17 本）が緑。

- **検討した代替案**:

  1. **`EventStore.append` は9口の外なので揃えない。** 採らなかった。同じ `event.memoryId` の検査で、3実装の割れが残る。落ちる入力が減る側に揃えるだけで、新しい断りを足さない。
  2. **message の id も小文字にそろえる（postgres の `memoryNotFound` に揃える）。** 採らなかった。ADR 0469 と同じく、渡された id のまま載せるほうが、利用者が見つけやすい。message の id の大文字小文字は、実装ごとの違い（接頭辞と同じ種類）として残す。

- **引き受けた負債**:

  - 操作の対象の `id` の大文字小文字は、Postgres が受け、fixture（InMemory・Fake）は受けない（ADR 0446 の既存の違い）。
  - message に載る id の大文字小文字は、postgres（小文字にそろえた id）と fixture（渡された id）で違う。
  - Fake の歯と postgres・InMemory の一致の歯は別のファイルで、3者を1つの表で比べているわけではない（core のテスト専用の Fake を postgres の package から import しない）。

- **これが覆るとしたら**: オーナーが、fixture は大文字の uuid を断ってよい（postgres とは違ってよい）と決めたとき。その場合は ADR 0469 の小文字化と、この ADR の直しと歯を外す。

- **測っていないこと**: 実 API。

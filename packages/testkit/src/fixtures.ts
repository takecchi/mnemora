// packages/testkit — `src/index.ts` とは別の入口。
//
// `src/index.ts` 冒頭の宣言（「プレースホルダ実装（`__fixtures__`）は意図的にここから
// export しない。adapter 作者は自分の実装を `createStore` に渡して conformance suite を
// 走らせる」）は、そのまま維持する。**このファイルはその宣言を弱めるものではない。**
//
// ⚠ なぜ別の入口が要るか、そして危険:
//
// **adapter 作者がこれを `createStore` に渡して適合スイートを走らせると、自分の実装を
// 1文字も測らないまま緑になる。** `index.ts` から出さないのはそのためである。
//
// この入口は**リポジトリ内のテストが `Runtime` を組み立てるため**のものである
// （例: `packages/openai` が本物の `OpenAILLMProvider` を `@mnemora/core` の
// `createRuntime` に渡して、`runtime.observe()` を実際に走らせる通しの歯を書く場合。
// `runtime.observe()` が呼ぶストアは `MemoryStore` / `VectorStore` / `EventStore` /
// `OutboxStore` / `TenantSettingsStore` の5種すべてであり、全メソッドが throw する
// 偽ストアでは最初の1歩で止まってしまう——本物の provider を配線するには、
// 何かしら実際に動くインメモリ実装が要る）。
//
// **この入口は適合スイートの入力にしてはいけない。**「別の目的のための入口」であって、
// 「`index.ts` の制約を回避する裏口」ではない——適合テストを書く・走らせるときは、
// 引き続き自分の adapter 実装を `createStore` に渡すこと。
//
// ## Postgres が拒む入力を、同じ入力で拒む（現状の振る舞いを約束として書く）
//
// `@mnemora/postgres` が DB の例外（型の変換・CHECK 制約・`text`/`jsonb` が受け付けない文字）
// で拒む入力を、この入口の fixture は**書き込みの前に `Error` で**拒む。例外の種類と文面は
// Postgres と違う（Postgres は drizzle が包んだ DB の例外、こちらは下の文面の `Error`）。揃えて
// あるのは「拒むかどうか」と「拒んだときに何も書かないこと」だけである。
//
// - `limit` が整数でない（`NaN`・`Infinity` を含む）・負・2^63 以上 →
//   `<口>: limit must be an integer / must not be negative / must fit in a Postgres bigint`。
//   対象: `InMemoryOutboxStore.claimBatch`・`InMemoryVectorStore.search`・
//   `InMemoryLexicalStore.search`・`InMemoryEventStore.list`・
//   `InMemoryMemoryStore.purgeExpiredEvents`・`.aggregateScope`（`digestBand.limit`）・
//   `.archiveDecayed`・`.requeueEmbedJobs`（#804・#813・#923・#1058・#1061）。
//   ⚠ `purgeExpiredEvents` の `limit: -1` だけは Postgres が例外にならない（`MemoryStore` の doc
//   の表のとおり。揃えていない）。
// - `InMemoryOutboxStore.claimBatch` の `now - leaseMs` が有効な `Date` にならない
//   （`leaseMs` が `NaN`・`±Infinity`・範囲外、`now` が Invalid Date）→
//   `claimBatch: now - leaseMs must be a valid Date`（#1059）。
// - NUL（U+0000）を含む値 → `<欄> must not contain NUL characters (U+0000)`。
//   対象: `createMemory` 系の `content`・`subjectId`・`tags`・`digest`・`attributes`・`provenance`、
//   `createObservation`（`WithOutbox` を含む）の `subjectId`・`externalId`・`kind`・`payload`・
//   `attributes`（#923・#928・#1073）。
// - Invalid Date → `<欄> must be a valid Date`。対象: `createMemory` 系の日時の欄、
//   `reinforce` の `at`、イベントの `at`（#807）。
// - Postgres の `real`（float4）列に収まらない数 → `… does not fit in a Postgres "real" (float4) column`。
//   対象: `createMemory` 系の `halfLifeHours` など、
//   `InMemoryTenantSettingsStore.setDefaultHalfLifeRecalls`（#815・#817）。
//
// ## `memory_events` を1か所で見るには、`InMemoryEventStore` に `memoryStore.events` を渡す
//
// `InMemoryEventStore` を既定の形（`new InMemoryEventStore(memoryStore)`）で組むと、
// `InMemoryMemoryStore` が自分の中で書くイベント（forget・archive・purge・contested・
// supersede・unsuperseded・events_purged など）は `eventStore.list` に出ない——別の配列に
// 入るためである。`@mnemora/postgres` は1つの表なので、観測の形が割れる。Postgres と同じく
// 全部を1か所で見るには、次のように組む（詳細は `InMemoryEventStore` の TSDoc）:
//
//   const memoryStore = new InMemoryMemoryStore();
//   const eventStore = new InMemoryEventStore(memoryStore, memoryStore.events);
//   const outboxStore = new InMemoryOutboxStore(memoryStore.outboxJobs);
//
// 揃えていないもの（Postgres だけが拒む、または値を変える。それぞれの doc・Issue を参照）:
// 孤立サロゲート（`MemoryStore.createMemory` の doc、#1075）、紀元前4713年より前の日時（#1041）、
// 索引の行の上限を超える識別子（#1074）、1MB を超える本文（tsvector の上限、#1063）、
// JSON で往復しない値（#1076）。

export { InMemoryMemoryStore } from "./__fixtures__/in-memory-memory-store.js";
export { InMemoryVectorStore } from "./__fixtures__/in-memory-vector-store.js";
export { InMemoryLexicalStore } from "./__fixtures__/in-memory-lexical-store.js";
export { InMemoryEventStore } from "./__fixtures__/in-memory-event-store.js";
export { InMemoryOutboxStore } from "./__fixtures__/in-memory-outbox-store.js";
export { InMemoryTenantSettingsStore } from "./__fixtures__/in-memory-tenant-settings-store.js";

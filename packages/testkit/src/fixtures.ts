// ⚠ この入口の fixture を `createStore` に渡して適合スイートを走らせないこと。自分の実装を測らずに緑になる。
// `index.ts` から出さないのはそのためで、この入口はリポジトリ内のテストが `Runtime` を組むためのもの。
//
// Postgres が DB の例外（型の変換・CHECK 制約・`text`/`jsonb` が受け付けない文字）で拒む入力を、
// fixture は書き込みの前に `Error` で拒む（何も書かない）。例外の種類と文面は Postgres と違い、
// 揃えてあるのは「拒むかどうか」だけ。冪等の鍵が同じ既存の行が在っても、値は先に検査する。
// 対象は limit・日時・NUL・列挙値・int4/bigint/float4 の範囲・`timestamptz` の下限など。
// 読みの口の日時の条件には下限の検査を掛けない（Postgres は下限へ寄せて比べる）。
//
// 揃えていないもの:
// - `purgeExpiredEvents` の `limit: -1`（Postgres は例外にならない）。
// - `listBySourceObservation` に uuid の形でない `observationId` を渡したときの NUL 検査。
// - `jsonb` 列の欄（`payload`・`attributes`・`provenance`）の孤立サロゲート（Postgres は拒み、fixture は保持する）。
// - 索引の行の上限を超える識別子、JSON で往復しない値。
//
// `memory_events` を1か所で見るには、`InMemoryEventStore` に `memoryStore.events` を渡す。既定の形
// （`new InMemoryEventStore(memoryStore)`）では `InMemoryMemoryStore` が書くイベントが `eventStore.list` に出ない。
// `InMemoryRelationStore` も同じで、`memoryStore.relations` を渡す:
//
//   const memoryStore = new InMemoryMemoryStore();
//   const eventStore = new InMemoryEventStore(memoryStore, memoryStore.events);
//   const outboxStore = new InMemoryOutboxStore(memoryStore.outboxJobs);
//   const relationStore = new InMemoryRelationStore(memoryStore, memoryStore.relations);

export { InMemoryMemoryStore } from "./__fixtures__/in-memory-memory-store.js";
export { InMemoryRelationStore } from "./__fixtures__/in-memory-relation-store.js";
export { InMemoryVectorStore } from "./__fixtures__/in-memory-vector-store.js";
export { InMemoryLexicalStore } from "./__fixtures__/in-memory-lexical-store.js";
export { InMemoryEventStore } from "./__fixtures__/in-memory-event-store.js";
export { InMemoryOutboxStore } from "./__fixtures__/in-memory-outbox-store.js";
export { InMemoryTenantSettingsStore } from "./__fixtures__/in-memory-tenant-settings-store.js";

export type { StoredRelation } from "./__fixtures__/in-memory-memory-store.js";

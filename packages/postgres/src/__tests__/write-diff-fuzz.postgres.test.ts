import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { createRuntime } from "@mnemora/core";
import type { Memory, Observation } from "@mnemora/core";
import {
  InMemoryEventStore,
  InMemoryLexicalStore,
  InMemoryMemoryStore,
  InMemoryOutboxStore,
  InMemoryTenantSettingsStore,
  InMemoryVectorStore,
} from "@mnemora/testkit/fixtures";
import {
  breakReinforce,
  diffWriteSeeds,
  fakeWriteFuzzBackend,
  WRITE_FUZZ_CTX,
  type WriteFuzzBackend,
  type WriteRunOutcome,
} from "../../../core/src/__tests__/write-diff-fuzz-harness.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { PostgresLexicalStore } from "../lexical-store.js";
import { PostgresEventStore } from "../event-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import {
  rowToMemory,
  rowToMemoryEvent,
  rowToObservation,
  rowToOutboxJob,
  type MemoryEventRow,
  type MemoryRow,
  type ObservationRow,
  type OutboxJobRow,
} from "../mapping.js";
import {
  closeTestClient,
  getTestClient,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
} from "./test-db.js";

/**
 * 書き込み側の差分ファズ（`packages/core/src/__tests__/write-diff-fuzz-harness.ts`。何を比べて
 * 何を比べないかは、そこの doc コメントに在る——ここには写さない）を、本物の Postgres +
 * pgvector と core の Fake、Postgres と `@mnemora/testkit/fixtures` の `InMemory*` の2組で回し、
 * 1手ごとに戻り値と状態を突き合わせる。
 *
 * - 状態は `SELECT *` を `mapping.ts` の `rowTo*` で core の型へ戻して読む（Fake と同じ型で
 *   比べるため）。
 * - **陽性対照**: Fake / InMemory の側の `reinforce` を「何も書かない」に壊すと、食い違いが
 *   報告されること（2組それぞれに置く）。
 *   検査器が黙って何も比べなくなる回帰を捕まえる。
 *
 * `WRITE_FUZZ_PG_SEEDS`・`WRITE_FUZZ_LEN`・`WRITE_FUZZ_PG_FIRST_SEED` で本数・長さ・起点を変えられる。
 * Postgres の側は seed ごとに1回だけ流し、その結果を Fake・testkit・陽性対照の4本で使い回す。
 */

const SEEDS = Number(process.env.WRITE_FUZZ_PG_SEEDS ?? 20);
const LEN = Number(process.env.WRITE_FUZZ_LEN ?? 60);
const POSITIVE_CONTROL_SEEDS = 5;
const FIRST_SEED = Number(process.env.WRITE_FUZZ_PG_FIRST_SEED ?? 1);
// 時計は実時刻より先から始める。1回の実行の中では両方の backend で同じ値を使う。
const T0 = Date.now() + 86_400_000;
// Postgres の側の実行結果は、seed・`T0`・`LEN` が同じなら同じなので、4本の it で使い回す
// （Postgres を seed ごとに1回しか流さない）。
const postgresRuns = new Map<number, WriteRunOutcome>();

const postgresBackend: WriteFuzzBackend = {
  name: "postgres",
  async setup() {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const tenant = WRITE_FUZZ_CTX.tenantId;
    return {
      stores: {
        memoryStore: new PostgresMemoryStore(db),
        outboxStore: new PostgresOutboxStore(db),
        vectorStore: new PostgresVectorStore(db),
        lexicalStore: new PostgresLexicalStore(db),
        eventStore: new PostgresEventStore(db),
        tenantSettingsStore: new PostgresTenantSettingsStore(db),
      },
      space: TEST_EMBEDDING_SPACE,
      createRuntime,
      read: async () => ({
        memories: (
          await db.execute(sql`SELECT * FROM memories WHERE tenant_id = ${tenant}`)
        ).rows.map((r) => rowToMemory(r as unknown as MemoryRow)),
        observations: (
          await db.execute(sql`SELECT * FROM observations WHERE tenant_id = ${tenant}`)
        ).rows.map((r) => rowToObservation(r as unknown as ObservationRow)),
        outbox: (await db.execute(sql`SELECT * FROM outbox WHERE tenant_id = ${tenant}`)).rows.map(
          (r) => rowToOutboxJob(r as unknown as OutboxJobRow),
        ),
        events: (
          await db.execute(sql`SELECT * FROM memory_events WHERE tenant_id = ${tenant}`)
        ).rows.map((r) => rowToMemoryEvent(r as unknown as MemoryEventRow)),
      }),
    };
  },
};

const fakeBackend = fakeWriteFuzzBackend("fake", TEST_EMBEDDING_SPACE);

/**
 * `@mnemora/testkit/fixtures` の `InMemory*`。利用者が Postgres の代わりに使う、出荷される
 * fixture なので、Postgres との食い違いを core の Fake とは別に見る。状態は
 * `InMemoryMemoryStore` の内部（`memories`・`observations` の Map）を直接読む——
 * `MemoryStore` には、テナントの記憶を丸ごと列挙する口が無いため。
 */
const testkitBackend: WriteFuzzBackend = {
  name: "testkit",
  async setup() {
    const memoryStore = new InMemoryMemoryStore();
    const internals = memoryStore as unknown as {
      memories: Map<string, Memory>;
      observations: Map<string, Observation>;
    };
    const tenant = WRITE_FUZZ_CTX.tenantId;
    return {
      stores: {
        memoryStore,
        outboxStore: new InMemoryOutboxStore(memoryStore.outboxJobs),
        vectorStore: new InMemoryVectorStore(memoryStore),
        lexicalStore: new InMemoryLexicalStore(memoryStore),
        eventStore: new InMemoryEventStore(memoryStore, memoryStore.events),
        tenantSettingsStore: new InMemoryTenantSettingsStore(),
      },
      space: TEST_EMBEDDING_SPACE,
      createRuntime,
      read: async () => ({
        memories: [...internals.memories.values()].filter((m) => m.tenantId === tenant),
        observations: [...internals.observations.values()].filter((o) => o.tenantId === tenant),
        outbox: memoryStore.outboxJobs.filter((j) => j.tenantId === tenant),
        events: memoryStore.events.filter((e) => e.tenantId === tenant),
      }),
    };
  },
};

describe("書き込み側の差分ファズ（本物の Postgres + pgvector と、core の Fake・testkit の InMemory）", () => {
  afterAll(async () => {
    await closeTestClient();
  });

  it(`${SEEDS} シード × ${LEN} 手で、Postgres と Fake の戻り値と状態が1手ごとに一致する`, async () => {
    const report = await diffWriteSeeds(postgresBackend, fakeBackend, {
      seeds: SEEDS,
      len: LEN,
      firstSeed: FIRST_SEED,
      t0: T0,
      cacheA: postgresRuns,
    });
    expect(report).toBe("");
  }, 600_000);

  it("陽性対照: Fake の reinforce を壊すと、食い違いが報告される", async () => {
    const report = await diffWriteSeeds(postgresBackend, fakeBackend, {
      // 食い違いが1つ見えれば足りるので、本数は絞る。
      seeds: POSITIVE_CONTROL_SEEDS,
      len: LEN,
      firstSeed: FIRST_SEED,
      t0: T0,
      cacheA: postgresRuns,
      wrapB: breakReinforce,
    });
    expect(report).not.toBe("");
    expect(report).toMatch(/lastReinforcedAt|"k":"reinforce"|"k":"usage"/);
  }, 600_000);

  it(`${SEEDS} シード × ${LEN} 手で、Postgres と testkit の InMemory の戻り値と状態が1手ごとに一致する`, async () => {
    const report = await diffWriteSeeds(postgresBackend, testkitBackend, {
      seeds: SEEDS,
      len: LEN,
      firstSeed: FIRST_SEED,
      t0: T0,
      cacheA: postgresRuns,
    });
    expect(report).toBe("");
  }, 600_000);

  it("陽性対照: testkit の InMemory の reinforce を壊すと、食い違いが報告される", async () => {
    const report = await diffWriteSeeds(postgresBackend, testkitBackend, {
      // 食い違いが1つ見えれば足りるので、本数は絞る。
      seeds: POSITIVE_CONTROL_SEEDS,
      len: LEN,
      firstSeed: FIRST_SEED,
      t0: T0,
      cacheA: postgresRuns,
      wrapB: breakReinforce,
    });
    expect(report).not.toBe("");
    expect(report).toMatch(/lastReinforcedAt|"k":"reinforce"|"k":"usage"/);
  }, 600_000);
});

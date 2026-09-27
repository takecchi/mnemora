import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { createRuntime } from "@mnemora/core";
import {
  breakReinforce,
  diffWriteSeeds,
  fakeWriteFuzzBackend,
  WRITE_FUZZ_CTX,
  type WriteFuzzBackend,
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
 * pgvector と core の Fake で回し、1手ごとに戻り値と状態を突き合わせる。
 *
 * - 状態は `SELECT *` を `mapping.ts` の `rowTo*` で core の型へ戻して読む（Fake と同じ型で
 *   比べるため）。
 * - **陽性対照**: Fake の側の `reinforce` を「何も書かない」に壊すと、食い違いが報告されること。
 *   検査器が黙って何も比べなくなる回帰を捕まえる。
 *
 * `WRITE_FUZZ_PG_SEEDS`・`WRITE_FUZZ_LEN`・`WRITE_FUZZ_PG_FIRST_SEED` で本数・長さ・起点を変えられる。
 * 【実測】20シード × 60手で 13〜14 秒（手元の PostgreSQL 17、3回とも食い違い0）。
 */

const SEEDS = Number(process.env.WRITE_FUZZ_PG_SEEDS ?? 20);
const LEN = Number(process.env.WRITE_FUZZ_LEN ?? 60);
const POSITIVE_CONTROL_SEEDS = 5;
const FIRST_SEED = Number(process.env.WRITE_FUZZ_PG_FIRST_SEED ?? 1);
// outbox の `available_at` は `now()` で埋まるので、時計はそれより後から始める
// （そうしないと tick が何も claim しない）。1回の実行の中では両方の backend で同じ値を使う。
const T0 = Date.now() + 86_400_000;

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

describe("書き込み側の差分ファズ（本物の Postgres + pgvector と Fake）", () => {
  afterAll(async () => {
    await closeTestClient();
  });

  it(`${SEEDS} シード × ${LEN} 手で、Postgres と Fake の戻り値と状態が1手ごとに一致する`, async () => {
    const report = await diffWriteSeeds(postgresBackend, fakeBackend, {
      seeds: SEEDS,
      len: LEN,
      firstSeed: FIRST_SEED,
      t0: T0,
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
      wrapB: breakReinforce,
    });
    expect(report).not.toBe("");
    expect(report).toMatch(/lastReinforcedAt|"k":"reinforce"|"k":"usage"/);
  }, 600_000);
});

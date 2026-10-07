import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx, MemoryId, NewMemoryEvent } from "@mnemora/core";
import { buildNewMemoryFixture, buildNewObservationFixture } from "@mnemora/testkit";
import { closePostgresClient, createPostgresClient, type PostgresClient } from "../client.js";
import { runMigrations } from "../migrate.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { maybeAnalyzeTableAfterWrite } from "../analyze-threshold.js";
import {
  INITIAL_ANALYZE_THRESHOLD,
  maybeAnalyzeMemoriesAfterWrite,
  peekMemoriesWriteCounterForTesting,
  resetMemoriesWriteCounterForTesting,
} from "../memories-statistics.js";
import { requireDatabaseUrl } from "./test-db.js";
import { dropTempDatabase } from "./temp-database.js";

/**
 * 書き込み時の ANALYZE の自動発火が、閾値・guard・対象の表・数える経路の各側で
 * 約束どおりに動くことを、表の `reltuples`（ANALYZE した瞬間に更新される）と、
 * 書き込み累計の読み口で縛る。`last_analyze` は統計の反映が遅れうるので使わない。
 *
 * 専用の使い捨てデータベースを使う: `memories` の統計を他のファイルの行から隔離するため。
 * 探り用の表は autovacuum を切る。切らないと `reltuples` が autovacuum の ANALYZE で動き、
 * 「撃たなかった」ことを確かめられない。
 */

const TEST_DATABASE = "mnemora_analyze_on_write_recheck_0917_test";
const TENANT = "analyze-on-write-recheck-tenant";
const PROBE_A = "analyze_probe_a";
const PROBE_B = "analyze_probe_b";

function connectionStringFor(database: string): string {
  const url = new URL(requireDatabaseUrl());
  url.pathname = `/${database}`;
  return url.toString();
}

let adminPool: Pool | undefined;
function admin(): Pool {
  adminPool ??= new Pool({ connectionString: requireDatabaseUrl(), max: 1 });
  return adminPool;
}

let client: PostgresClient | undefined;

function pool(): Pool {
  return client!.pool;
}

async function reltuples(table: string): Promise<number> {
  const result = await pool().query(`SELECT reltuples FROM pg_class WHERE oid = $1::regclass`, [
    table,
  ]);
  return Number(result.rows[0].reltuples);
}

async function recreateProbe(table: string, rows: number): Promise<void> {
  await pool().query(`DROP TABLE IF EXISTS ${table}`);
  await pool().query(`CREATE TABLE ${table} (id int) WITH (autovacuum_enabled = false)`);
  await pool().query(`INSERT INTO ${table} SELECT generate_series(1, $1)`, [rows]);
}

async function insertProbeRows(table: string, rows: number): Promise<void> {
  await pool().query(`INSERT INTO ${table} SELECT generate_series(1, $1)`, [rows]);
}

async function insertRawMemories(rows: number, label: string): Promise<void> {
  await pool().query(
    `INSERT INTO memories (
       id, tenant_id, content, content_hash, digest, digest_source,
       provenance_kind, provenance, status, tags, recorded_at,
       strength, half_life_hours, decay_floor_at, embedding_status, created_at, updated_at
     )
     SELECT gen_random_uuid(), $1, $2 || n, $2 || 'hash-' || n, 'digest', 'llm',
            'imported', '{"kind":"imported"}'::jsonb, 'active', '{}'::text[], now(),
            1.0, 720, now() + interval '30 days', 'ready', now(), now()
     FROM generate_series(1, $3) AS n`,
    [TENANT, label, rows],
  );
}

beforeAll(async () => {
  await dropTempDatabase(admin(), TEST_DATABASE);
  await admin().query(`CREATE DATABASE ${TEST_DATABASE}`);
  client = createPostgresClient(connectionStringFor(TEST_DATABASE));
  await runMigrations(client.pool);
  await client.pool.query(`ALTER TABLE memories SET (autovacuum_enabled = false)`);
}, 60_000);

afterAll(async () => {
  if (client) {
    await closePostgresClient(client);
  }
  await dropTempDatabase(admin(), TEST_DATABASE);
  if (adminPool) {
    await adminPool.end();
    adminPool = undefined;
  }
}, 30_000);

beforeEach(() => {
  resetMemoriesWriteCounterForTesting();
});

describe("maybeAnalyzeTableAfterWrite: 閾値・guard・対象の表", () => {
  it("閾値の手前の呼び出しは統計が古くても ANALYZE を撃たず、閾値ちょうどの呼び出しで撃つ", async () => {
    await recreateProbe(PROBE_A, 10);
    expect(await reltuples(PROBE_A)).toBe(-1);
    const counters = new Map<string, number>();

    for (const expectedCount of [1, 2, 3]) {
      const result = await maybeAnalyzeTableAfterWrite(client!.db, PROBE_A, counters, 4);
      expect(result).toEqual({ table: PROBE_A, count: expectedCount, analyzed: false });
      expect(await reltuples(PROBE_A)).toBe(-1);
    }

    const atThreshold = await maybeAnalyzeTableAfterWrite(client!.db, PROBE_A, counters, 4);
    expect(atThreshold).toEqual({ table: PROBE_A, count: 4, analyzed: true });
    expect(await reltuples(PROBE_A)).toBe(10);
  });

  it("等比の閾値の間（倍数でも2の累乗倍でない回）では、統計が古くても撃たない", async () => {
    await recreateProbe(PROBE_A, 10);
    const counters = new Map<string, number>([[PROBE_A, 11]]);

    const result = await maybeAnalyzeTableAfterWrite(client!.db, PROBE_A, counters, 4);

    expect(result).toEqual({ table: PROBE_A, count: 12, analyzed: false });
    expect(await reltuples(PROBE_A)).toBe(-1);
  });

  it("統計の見ている行数が累計と同じなら撃たず、累計のほうが大きければ撃つ", async () => {
    await recreateProbe(PROBE_A, 5);
    await pool().query(`ANALYZE ${PROBE_A}`);
    expect(await reltuples(PROBE_A)).toBe(5);
    await insertProbeRows(PROBE_A, 3);

    const equal = await maybeAnalyzeTableAfterWrite(
      client!.db,
      PROBE_A,
      new Map([[PROBE_A, 4]]),
      5,
    );
    expect(equal).toEqual({ table: PROBE_A, count: 5, analyzed: false });
    expect(await reltuples(PROBE_A)).toBe(5);

    const behind = await maybeAnalyzeTableAfterWrite(
      client!.db,
      PROBE_A,
      new Map([[PROBE_A, 5]]),
      6,
    );
    expect(behind).toEqual({ table: PROBE_A, count: 6, analyzed: true });
    expect(await reltuples(PROBE_A)).toBe(8);
  });

  it("撃つのは渡された表だけで、ほかの表の統計には触れない", async () => {
    await recreateProbe(PROBE_A, 10);
    await recreateProbe(PROBE_B, 7);
    const counters = new Map<string, number>([[PROBE_A, 3]]);

    const result = await maybeAnalyzeTableAfterWrite(client!.db, PROBE_A, counters, 4);

    expect(result.analyzed).toBe(true);
    expect(await reltuples(PROBE_A)).toBe(10);
    expect(await reltuples(PROBE_B)).toBe(-1);
  });

  it("累計は表ごとに別々に数え、別の表の書き込みで閾値に届かない", async () => {
    await recreateProbe(PROBE_A, 10);
    await recreateProbe(PROBE_B, 10);
    const counters = new Map<string, number>();

    await maybeAnalyzeTableAfterWrite(client!.db, PROBE_A, counters, 4);
    await maybeAnalyzeTableAfterWrite(client!.db, PROBE_B, counters, 4);
    await maybeAnalyzeTableAfterWrite(client!.db, PROBE_A, counters, 4);
    const last = await maybeAnalyzeTableAfterWrite(client!.db, PROBE_B, counters, 4);

    expect(last).toEqual({ table: PROBE_B, count: 2, analyzed: false });
    expect(counters.get(PROBE_A)).toBe(2);
    expect(counters.get(PROBE_B)).toBe(2);
    expect(await reltuples(PROBE_A)).toBe(-1);
    expect(await reltuples(PROBE_B)).toBe(-1);
  });

  it("ANALYZE の失敗は握り潰さず投げる", async () => {
    const counters = new Map<string, number>([["analyze_probe_does_not_exist", 3]]);

    await expect(
      maybeAnalyzeTableAfterWrite(client!.db, "analyze_probe_does_not_exist", counters, 4),
    ).rejects.toThrow();
  });
});

describe("maybeAnalyzeMemoriesAfterWrite: memories の閾値", () => {
  // 初項は定数を参照せず 1,000 と書く: 定数を参照すると、初項そのものを変える変異を縛れない
  // （採用者向けの文書が 1,000 / 2,000 / 4,000 と約束している値）。
  const DOCUMENTED_FIRST_THRESHOLD = 1000;

  it("初項（1,000 回目）の手前の呼び出しでは撃たず、ちょうどで memories だけを撃つ", async () => {
    await recreateProbe(PROBE_B, 7);
    await insertRawMemories(5, "first-threshold-");
    expect(await reltuples("memories")).toBeLessThan(DOCUMENTED_FIRST_THRESHOLD);

    for (let i = 1; i < DOCUMENTED_FIRST_THRESHOLD; i += 1) {
      const result = await maybeAnalyzeMemoriesAfterWrite(client!.db);
      expect(result.analyzed).toBe(false);
    }
    expect(await reltuples("memories")).toBeLessThan(5);

    const atThreshold = await maybeAnalyzeMemoriesAfterWrite(client!.db);

    expect(atThreshold).toEqual({ count: DOCUMENTED_FIRST_THRESHOLD, analyzed: true });
    expect(await reltuples("memories")).toBe(5);
    expect(await reltuples(PROBE_B)).toBe(-1);
  });

  it("統計が既に累計以上を見ていれば初項で撃たず、累計が倍になった2つ目の閾値で追い越されていれば撃つ", async () => {
    await pool().query(`TRUNCATE memories CASCADE`);
    await insertRawMemories(INITIAL_ANALYZE_THRESHOLD + 200, "second-threshold-");
    await pool().query(`ANALYZE memories`);
    const analyzedRows = await reltuples("memories");
    expect(analyzedRows).toBe(INITIAL_ANALYZE_THRESHOLD + 200);
    await insertRawMemories(50, "second-threshold-extra-");

    for (let i = 1; i <= INITIAL_ANALYZE_THRESHOLD; i += 1) {
      await maybeAnalyzeMemoriesAfterWrite(client!.db);
    }
    expect(peekMemoriesWriteCounterForTesting()).toBe(INITIAL_ANALYZE_THRESHOLD);
    expect(await reltuples("memories")).toBe(analyzedRows);

    for (let i = INITIAL_ANALYZE_THRESHOLD + 1; i < 2 * INITIAL_ANALYZE_THRESHOLD; i += 1) {
      await maybeAnalyzeMemoriesAfterWrite(client!.db);
    }
    expect(await reltuples("memories")).toBe(analyzedRows);

    const second = await maybeAnalyzeMemoriesAfterWrite(client!.db);

    expect(second).toEqual({ count: 2 * INITIAL_ANALYZE_THRESHOLD, analyzed: true });
    expect(await reltuples("memories")).toBe(analyzedRows + 50);
  });
});

describe("PostgresMemoryStore の書き込み経路が memories の書き込み累計を進める条件", () => {
  const ctx: Ctx = { tenantId: TENANT };

  function newStore(): PostgresMemoryStore {
    return new PostgresMemoryStore(client!.db);
  }

  async function idempotentInput(label: string) {
    const observation = await newStore().createObservation(
      ctx,
      buildNewObservationFixture({ tenantId: TENANT }),
    );
    return buildNewMemoryFixture({
      tenantId: TENANT,
      sourceObservationId: observation.id,
      extractorVersion: "analyze-recheck-v1",
      contentHash: `hash-${label}`,
      content: `content ${label}`,
    });
  }

  function supersedeEvent(memoryId: MemoryId): NewMemoryEvent {
    return {
      tenantId: TENANT,
      memoryId,
      kind: "superseded",
      actor: { type: "system" },
      digestSnapshot: "digest",
      sizeBeforeBytes: null,
      meta: { reason: "analyze-recheck" },
    };
  }

  it("createMemory は新しい行を書いたときだけ数え、既存行を返しただけの呼び出しは数えない", async () => {
    const input = await idempotentInput("create-memory");

    await newStore().createMemory(ctx, input);
    expect(peekMemoriesWriteCounterForTesting()).toBe(1);

    await newStore().createMemory(ctx, input);
    expect(peekMemoriesWriteCounterForTesting()).toBe(1);
  });

  it("createMemoryWithOutbox は新しい行を書いたときだけ数え、既存行を返しただけの呼び出しは数えない", async () => {
    const input = await idempotentInput("create-with-outbox");

    const first = await newStore().createMemoryWithOutbox(ctx, input, []);
    expect(first.created).toBe(true);
    expect(peekMemoriesWriteCounterForTesting()).toBe(1);

    const again = await newStore().createMemoryWithOutbox(ctx, input, []);
    expect(again.created).toBe(false);
    expect(peekMemoriesWriteCounterForTesting()).toBe(1);
  });

  it("createMemoryWithOutbox が巻き戻ったときは数えない", async () => {
    const store = newStore();
    const old = await store.createMemory(ctx, buildNewMemoryFixture({ tenantId: TENANT }));
    await store.supersedeWithNewMemories(
      ctx,
      [{ input: buildNewMemoryFixture({ tenantId: TENANT, contentHash: "winner" }), jobKinds: [] }],
      [{ id: old.id, supersededByIndex: 0, event: supersedeEvent(old.id) }],
    );
    resetMemoriesWriteCounterForTesting();

    await expect(
      store.createMemoryWithOutbox(
        ctx,
        buildNewMemoryFixture({ tenantId: TENANT, contentHash: "aborted" }),
        [],
        { abortIfSuperseded: [old.id] },
      ),
    ).rejects.toThrow();

    expect(peekMemoriesWriteCounterForTesting()).toBe(0);
  });

  it("supersedeWithNewMemories は新しい行を書いたときに1回数え、news が空なら数えない", async () => {
    await newStore().supersedeWithNewMemories(
      ctx,
      [{ input: buildNewMemoryFixture({ tenantId: TENANT, contentHash: "sw-new" }), jobKinds: [] }],
      [],
    );
    expect(peekMemoriesWriteCounterForTesting()).toBe(1);

    await newStore().supersedeWithNewMemories(ctx, [], []);
    expect(peekMemoriesWriteCounterForTesting()).toBe(1);
  });

  it("supersedeWithNewMemories は news が既存行を返しただけなら数えない", async () => {
    const input = await idempotentInput("sw-existing");
    await newStore().createMemory(ctx, input);
    resetMemoriesWriteCounterForTesting();

    const result = await newStore().supersedeWithNewMemories(ctx, [{ input, jobKinds: [] }], []);

    expect(result.created.map((entry) => entry.created)).toEqual([false]);
    expect(peekMemoriesWriteCounterForTesting()).toBe(0);
  });

  it.each([
    ["既存→新規の順", true],
    ["新規→既存の順", false],
  ])(
    "supersedeWithNewMemories は news の一部だけが新しい行でも1回数える（%s）",
    async (_label, existingFirst) => {
      const existing = await idempotentInput(`sw-mixed-${existingFirst}`);
      await newStore().createMemory(ctx, existing);
      resetMemoriesWriteCounterForTesting();
      const fresh = buildNewMemoryFixture({
        tenantId: TENANT,
        contentHash: `sw-mixed-fresh-${existingFirst}`,
      });
      const news = existingFirst
        ? [
            { input: existing, jobKinds: [] },
            { input: fresh, jobKinds: [] },
          ]
        : [
            { input: fresh, jobKinds: [] },
            { input: existing, jobKinds: [] },
          ];

      const result = await newStore().supersedeWithNewMemories(ctx, news, []);

      expect(result.created.filter((entry) => entry.created)).toHaveLength(1);
      expect(peekMemoriesWriteCounterForTesting()).toBe(1);
    },
  );

  it("supersedeWithNewMemories が全件の食い違いで巻き戻ったときは数えない", async () => {
    const store = newStore();
    const old = await store.createMemory(ctx, buildNewMemoryFixture({ tenantId: TENANT }));
    resetMemoriesWriteCounterForTesting();

    await expect(
      store.supersedeWithNewMemories(
        ctx,
        [
          {
            input: buildNewMemoryFixture({ tenantId: TENANT, contentHash: "sw-abort" }),
            jobKinds: [],
          },
        ],
        [
          {
            id: old.id,
            supersededByIndex: 0,
            expectedStatus: "archived",
            event: supersedeEvent(old.id),
          },
        ],
        { abortIfAllConflicted: true },
      ),
    ).rejects.toThrow();

    expect(peekMemoriesWriteCounterForTesting()).toBe(0);
  });
});

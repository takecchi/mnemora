import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import {
  ConsolidationLLMResultSchema,
  ExtractionResultSchema,
  ReflectionLLMResultSchema,
  createRuntime,
  eraseTenant,
} from "@mnemora/core";
import { embeddingSpaceTableName } from "../embedding-space-table.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { PostgresEventStore } from "../event-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import {
  closeTestClient,
  getTestClient,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
} from "./test-db.js";

const S = "SECRET-ERASE-TENANT";
const vec = (text: string): number[] => {
  const h = createHash("sha256").update(text).digest();
  return [h[0]! / 255 + 0.01, h[1]! / 255, h[2]! / 255];
};

afterAll(async () => {
  await closeTestClient();
});

function buildRuntime(db: Awaited<ReturnType<typeof getTestClient>>["db"]) {
  let n = 0;
  return createRuntime({
    memoryStore: new PostgresMemoryStore(db),
    vectorStore: new PostgresVectorStore(db),
    eventStore: new PostgresEventStore(db),
    outboxStore: new PostgresOutboxStore(db),
    tenantSettingsStore: new PostgresTenantSettingsStore(db),
    llmProvider: {
      complete: async () => ({ content: "unused" }),
      completeStructured: async (_ctx: Ctx, req: { schema: unknown }) => {
        n += 1;
        if (req.schema === ExtractionResultSchema) {
          return ExtractionResultSchema.parse({
            memories: [
              {
                content: `${S} 本文 ${n}`,
                digest: `${S} 要旨 ${n}`,
                provenanceKind: "stated",
                tags: [`${S}-tag`],
              },
            ],
          }) as never;
        }
        if (req.schema === ConsolidationLLMResultSchema) {
          return ConsolidationLLMResultSchema.parse({ content: `${S} 統合 ${n}` }) as never;
        }
        if (req.schema === ReflectionLLMResultSchema) {
          return ReflectionLLMResultSchema.parse({
            outcome: "reflected",
            content: `${S} 内省 ${n}`,
          }) as never;
        }
        throw new Error("unexpected schema");
      },
    } as never,
    embeddingProvider: {
      space: TEST_EMBEDDING_SPACE,
      embed: async (_ctx: Ctx, texts: string[]) => texts.map(vec),
    } as never,
    hashContent: (content: string) => createHash("sha256").update(content).digest("hex"),
    clock: { now: () => new Date(Date.now() + 60_000) },
    config: { autoQueueConsolidateReflectOnExtract: true },
  } as never);
}

async function seedTenant(
  runtime: ReturnType<typeof buildRuntime>,
  tenantSettingsStore: PostgresTenantSettingsStore,
  tenantId: string,
): Promise<void> {
  const ctx: Ctx = { tenantId, subjectId: `${S}-subject` };
  for (let i = 0; i < 6; i++) {
    await runtime.observe(ctx, {
      kind: "utterance",
      text: `${S} 発話 ${i}`,
      speaker: `${S}-speaker`,
      externalId: `${S}-ext-${tenantId}-${i}`,
      attributes: { owner: `${S}-owner` },
      ...(i % 2 === 1 ? { extract: "deferred" } : {}),
    } as never);
  }
  for (let round = 0; round < 30; round++) {
    const r = await runtime.tick({ tenantId }, {
      kinds: ["extract", "embed", "consolidate", "reflect"],
      leaseMs: 60_000,
      limit: 10,
    } as never);
    if (r.processed === 0) break;
  }
  // decayClock を 'wall' から進めておかないと、`activityCounting` を渡しても `advanceActivityClock` は常に false のままで、
  // `tenant_activity` に行ができない（消す前に0行だった、という偽陰性を避ける）。
  await tenantSettingsStore.setDecayClock(ctx, "either" as never);
  const recalled = await runtime.recall(ctx, {
    text: `${S} の問い`,
    limit: 3,
    activityCounting: "tenant",
  } as never);
  await runtime.observe(ctx, {
    kind: "memory_usage",
    recallId: recalled.recallId,
    usedMemoryIds: recalled.memories.slice(0, 1).map((m) => m.memoryId),
  } as never);
  // `tenant_settings` の行は、observe/tick/recall だけでは作られない。
  await tenantSettingsStore.setEventRetention(ctx, { kind: "unlimited" } as never);
}

async function countAll(
  pool: Awaited<ReturnType<typeof getTestClient>>["pool"],
  tenantId: string,
): Promise<Record<string, number>> {
  const tables = [
    "memories",
    "observations",
    embeddingSpaceTableName(TEST_EMBEDDING_SPACE),
    "labels",
    "memory_labels",
    "recalls",
    "recall_usages",
    "outbox",
    "memory_events",
    "tenant_settings",
    "tenant_activity",
  ];
  const out: Record<string, number> = {};
  for (const t of tables) {
    const r = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${t} WHERE tenant_id = $1`,
      [tenantId],
    );
    out[t] = r.rows[0]!.n;
  }
  return out;
}

/** 最小の Memory を1件作る。 */
async function createBareMemory(
  memoryStore: PostgresMemoryStore,
  tenantId: string,
  contentHash: string,
) {
  return memoryStore.createMemory(
    { tenantId },
    {
      tenantId,
      subjectId: null,
      sourceObservationId: null,
      extractorVersion: null,
      content: "本文",
      contentHash,
      digest: "digest",
      digestSource: "llm",
      provenance: { kind: "imported", batchId: "fixture" },
      tags: [],
      occurredAt: null,
      recordedAt: new Date("2026-01-01T00:00:00.000Z"),
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours: 720,
      decayFloorAt: new Date("2026-06-01T00:00:00.000Z"),
      embeddingStatus: "pending",
    },
  );
}

/** テナント内に superseded の組と contested の組（どちらも同じテナントの行を指す）を、生 SQL で作る。 */
async function seedSelfReferencePairs(
  pool: Awaited<ReturnType<typeof getTestClient>>["pool"],
  memoryStore: PostgresMemoryStore,
  tenantId: string,
) {
  const supersededNew = await createBareMemory(memoryStore, tenantId, `${tenantId}-sn`);
  const supersededOld = await createBareMemory(memoryStore, tenantId, `${tenantId}-so`);
  const contestedFirst = await createBareMemory(memoryStore, tenantId, `${tenantId}-c1`);
  const contestedSecond = await createBareMemory(memoryStore, tenantId, `${tenantId}-c2`);
  await pool.query(`UPDATE memories SET superseded_by_id = $1 WHERE id = $2`, [
    supersededNew.id,
    supersededOld.id,
  ]);
  await pool.query(`UPDATE memories SET contested_with_id = $1 WHERE id = $2`, [
    contestedSecond.id,
    contestedFirst.id,
  ]);
  await pool.query(`UPDATE memories SET contested_with_id = $1 WHERE id = $2`, [
    contestedFirst.id,
    contestedSecond.id,
  ]);
  return { supersededNew, supersededOld, contestedFirst, contestedSecond };
}

/** テナントの `memories` の `superseded_by_id`・`contested_with_id` を、生 SQL で id 順に読む。 */
async function readSelfReferenceColumns(
  pool: Awaited<ReturnType<typeof getTestClient>>["pool"],
  tenantId: string,
) {
  const r = await pool.query<{
    id: string;
    superseded_by_id: string | null;
    contested_with_id: string | null;
  }>(
    `SELECT id, superseded_by_id, contested_with_id FROM memories WHERE tenant_id = $1 ORDER BY id`,
    [tenantId],
  );
  return r.rows;
}

describe("eraseTenant（Issue #1207 / ADR 0383、本物の Postgres）", () => {
  it("自己参照の NULL 化は対象テナントの行だけに及ぶ（他テナントの superseded_by_id・contested_with_id は消去の前後で変わらない）", async () => {
    await resetTestDatabase();
    const { db, pool } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const deps = {
      memoryStore,
      vectorStore: new PostgresVectorStore(db),
      outboxStore: new PostgresOutboxStore(db),
      tenantSettingsStore: new PostgresTenantSettingsStore(db),
    };
    const T = "erase-self-ref-target";
    const OTHER = "erase-self-ref-other";
    await seedSelfReferencePairs(pool, memoryStore, T);
    await seedSelfReferencePairs(pool, memoryStore, OTHER);

    const otherBefore = await readSelfReferenceColumns(pool, OTHER);
    expect(otherBefore.filter((r) => r.superseded_by_id !== null)).toHaveLength(1);
    expect(otherBefore.filter((r) => r.contested_with_id !== null)).toHaveLength(2);

    const outcome = await eraseTenant({ tenantId: T }, deps, {
      confirmTenantId: T,
      limit: 100_000,
    });
    expect(outcome.kind).toBe("executed");
    expect(await readSelfReferenceColumns(pool, T)).toEqual([]);
    expect(await readSelfReferenceColumns(pool, OTHER)).toEqual(otherBefore);
  }, 60_000);

  it("dryRun: true は自己参照（superseded_by_id・contested_with_id）を書き換えない", async () => {
    await resetTestDatabase();
    const { db, pool } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const deps = {
      memoryStore,
      vectorStore: new PostgresVectorStore(db),
      outboxStore: new PostgresOutboxStore(db),
      tenantSettingsStore: new PostgresTenantSettingsStore(db),
    };
    const T = "erase-self-ref-dry-run";
    await seedSelfReferencePairs(pool, memoryStore, T);
    const before = await readSelfReferenceColumns(pool, T);
    expect(before.filter((r) => r.superseded_by_id !== null)).toHaveLength(1);
    expect(before.filter((r) => r.contested_with_id !== null)).toHaveLength(2);

    const outcome = await eraseTenant({ tenantId: T }, deps, {
      confirmTenantId: T,
      limit: 100_000,
      dryRun: true,
    });
    expect(outcome.kind).toBe("executed");
    expect(await readSelfReferenceColumns(pool, T)).toEqual(before);
  }, 60_000);

  it("他テナント同士の参照（A が B を参照）は、無関係なテナント C の eraseTenant を止めない", async () => {
    await resetTestDatabase();
    const { db, pool } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const deps = {
      memoryStore,
      vectorStore: new PostgresVectorStore(db),
      outboxStore: new PostgresOutboxStore(db),
      tenantSettingsStore: new PostgresTenantSettingsStore(db),
    };
    const A = "erase-foreign-ref-a";
    const B = "erase-foreign-ref-b";
    const C = "erase-foreign-ref-c";
    const inA = await createBareMemory(memoryStore, A, "foreign-ref-a");
    const inB = await createBareMemory(memoryStore, B, "foreign-ref-b");
    const inC = await createBareMemory(memoryStore, C, "foreign-ref-c");
    // 生 SQL: この状態は mnemora の書き込み経路では作れない。
    await pool.query(`UPDATE memories SET superseded_by_id = $1 WHERE id = $2`, [inB.id, inA.id]);

    const outcome = await eraseTenant({ tenantId: C }, deps, {
      confirmTenantId: C,
      limit: 100_000,
    });
    expect(outcome.kind).toBe("executed");
    expect(await memoryStore.get({ tenantId: C }, inC.id)).toBeNull();
    expect((await memoryStore.get({ tenantId: A }, inA.id))?.supersededById).toBe(inB.id);
    expect(await memoryStore.get({ tenantId: B }, inB.id)).not.toBeNull();

    const blocked = await eraseTenant({ tenantId: B }, deps, {
      confirmTenantId: B,
      limit: 100_000,
    });
    expect(blocked).toEqual({ kind: "blocked_by_foreign_reference", count: 1 });
  }, 60_000);

  it("実データで全表が消え、別テナントは変わらない", async () => {
    await resetTestDatabase();
    const { db, pool } = await getTestClient();
    const runtime = buildRuntime(db);
    const tenantSettingsStoreForSeed = new PostgresTenantSettingsStore(db);

    const T = "erase-tenant-full";
    const OTHER = "erase-tenant-keep";
    await seedTenant(runtime, tenantSettingsStoreForSeed, T);
    await seedTenant(runtime, tenantSettingsStoreForSeed, OTHER);

    const before = await countAll(pool, T);
    // 最初から0件だったものを「消えた」と取り違えないよう、先にデータが入っていることを確かめる。
    expect(before.memories).toBeGreaterThan(0);
    expect(before.observations).toBeGreaterThan(0);
    expect(before[embeddingSpaceTableName(TEST_EMBEDDING_SPACE)]).toBeGreaterThan(0);
    expect(before.recalls).toBeGreaterThan(0);
    expect(before.outbox).toBeGreaterThan(0);
    expect(before.memory_events).toBeGreaterThan(0);
    expect(before.tenant_settings).toBeGreaterThan(0);
    expect(before.tenant_activity).toBeGreaterThan(0);

    const otherBefore = await countAll(pool, OTHER);
    expect(otherBefore.memories).toBeGreaterThan(0);

    const deps = {
      memoryStore: new PostgresMemoryStore(db),
      vectorStore: new PostgresVectorStore(db),
      outboxStore: new PostgresOutboxStore(db),
      tenantSettingsStore: new PostgresTenantSettingsStore(db),
    };
    const ctxT: Ctx = { tenantId: T };
    let outcome = await eraseTenant(ctxT, deps, { confirmTenantId: T, limit: 100_000 });
    let guard = 0;
    while (outcome.kind === "executed" && outcome.reachedLimit) {
      guard += 1;
      expect(guard).toBeLessThan(20);
      outcome = await eraseTenant(ctxT, deps, { confirmTenantId: T, limit: 100_000 });
    }
    expect(outcome.kind).toBe("executed");

    const after = await countAll(pool, T);
    for (const [table, n] of Object.entries(after)) {
      expect({ table, n }).toEqual({ table, n: 0 });
    }

    const otherAfter = await countAll(pool, OTHER);
    expect(otherAfter).toEqual(otherBefore);
  }, 120_000);

  it("dryRun: true では何も消えないが、消えるはずだった件数を返す", async () => {
    await resetTestDatabase();
    const { db, pool } = await getTestClient();
    const runtime = buildRuntime(db);
    const T = "erase-tenant-dry-run";
    await seedTenant(runtime, new PostgresTenantSettingsStore(db), T);

    const before = await countAll(pool, T);
    const deps = {
      memoryStore: new PostgresMemoryStore(db),
      vectorStore: new PostgresVectorStore(db),
      outboxStore: new PostgresOutboxStore(db),
      tenantSettingsStore: new PostgresTenantSettingsStore(db),
    };
    const outcome = await eraseTenant({ tenantId: T }, deps, {
      confirmTenantId: T,
      limit: 100_000,
      dryRun: true,
    });
    expect(outcome.kind).toBe("executed");
    if (outcome.kind !== "executed") throw new Error("unreachable");
    expect(outcome.dryRun).toBe(true);
    expect(outcome.deleted.memoryStore).toBeGreaterThan(0);
    expect(outcome.deleted.vectorStore).toBeGreaterThan(0);
    expect(outcome.deleted.outboxStore).toBeGreaterThan(0);
    expect(outcome.deleted.tenantSettingsStore).toBeGreaterThan(0);

    const after = await countAll(pool, T);
    expect(after).toEqual(before);
  }, 60_000);

  it("blocked_by_foreign_reference: 他テナントの行が superseded_by_id で参照していると、バッチはロールバックされ行数が変わらない", async () => {
    await resetTestDatabase();
    const { db, pool } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const vectorStore = new PostgresVectorStore(db);
    const outboxStore = new PostgresOutboxStore(db);
    const tenantSettingsStore = new PostgresTenantSettingsStore(db);

    const T = "erase-tenant-blocked";
    const OTHER = "erase-tenant-blocked-other";
    const ctxT: Ctx = { tenantId: T };
    const ctxOther: Ctx = { tenantId: OTHER };

    const mine = await memoryStore.createMemory(ctxT, {
      tenantId: T,
      subjectId: null,
      sourceObservationId: null,
      extractorVersion: null,
      content: "本文",
      contentHash: "hash-blocked-mine",
      digest: "digest",
      digestSource: "llm",
      provenance: { kind: "imported", batchId: "fixture" },
      tags: [],
      occurredAt: null,
      recordedAt: new Date("2026-01-01T00:00:00.000Z"),
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours: 720,
      decayFloorAt: new Date("2026-06-01T00:00:00.000Z"),
      embeddingStatus: "pending",
    });
    const other = await memoryStore.createMemory(ctxOther, {
      tenantId: OTHER,
      subjectId: null,
      sourceObservationId: null,
      extractorVersion: null,
      content: "他テナントの本文",
      contentHash: "hash-blocked-other",
      digest: "digest",
      digestSource: "llm",
      provenance: { kind: "imported", batchId: "fixture" },
      tags: [],
      occurredAt: null,
      recordedAt: new Date("2026-01-01T00:00:00.000Z"),
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours: 720,
      decayFloorAt: new Date("2026-06-01T00:00:00.000Z"),
      embeddingStatus: "pending",
    });

    // ⚠ ここから先は port 直呼びではなく生 SQL を使う。「別テナントの行がこのテナントの行を `superseded_by_id` で参照する」状態は、
    // どの書き込み経路も ctx でテナントを揃えるため作れない。FK 自体はテナントで絞られていないのでスキーマとしては可能で、
    // この歯はスキーマレベルの参照整合性チェックを検査するために、意図的に生 SQL でこの状態を作る。
    await pool.query(`UPDATE memories SET superseded_by_id = $1 WHERE id = $2`, [
      mine.id,
      other.id,
    ]);

    const deps = { memoryStore, vectorStore, outboxStore, tenantSettingsStore };
    const outcome = await eraseTenant(ctxT, deps, { confirmTenantId: T, limit: 100_000 });
    expect(outcome).toEqual({ kind: "blocked_by_foreign_reference", count: 1 });

    expect(await memoryStore.get(ctxT, mine.id)).not.toBeNull();
    const otherReread = await memoryStore.get(ctxOther, other.id);
    expect(otherReread?.supersededById).toBe(mine.id);
  }, 60_000);

  it("blocked_by_foreign_reference: 自己参照以外の経路（埋め込みの表の CASCADE・memory_events）でも止まり、どちらのテナントの行も1行も変わらない", async () => {
    // 他テナントからの参照に当たったら止める。他テナントの行は書き換えず、途中まで消えた状態を残さない。
    // ⚠ 埋め込みの表の `memory_id` は `ON DELETE CASCADE` なので、検査が自己参照しか見ないと、他テナントの埋め込みの行が `memories` の削除に巻き込まれて黙って消える。
    // ⚠ `vectorStore`/`outboxStore` を `memoryStore` より先に呼ぶと、止まった時点でこのテナントの埋め込み・outbox の行が既に消えている。
    await resetTestDatabase();
    const { db, pool } = await getTestClient();
    const runtime = buildRuntime(db);
    const tenantSettingsStore = new PostgresTenantSettingsStore(db);
    const T = "erase-tenant-blocked-paths";
    const OTHER = "erase-tenant-blocked-paths-other";
    await seedTenant(runtime, tenantSettingsStore, T);
    await seedTenant(runtime, tenantSettingsStore, OTHER);

    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM memories WHERE tenant_id = $1 ORDER BY id LIMIT 1",
      [T],
    );
    const mineId = rows[0]!.id;
    const space = embeddingSpaceTableName(TEST_EMBEDDING_SPACE);
    await pool.query(
      `INSERT INTO ${space} (tenant_id, memory_id, embedding, model)
       SELECT $1, $2, embedding, model FROM ${space} WHERE tenant_id = $3 LIMIT 1`,
      [OTHER, mineId, T],
    );
    await pool.query(
      `INSERT INTO memory_events (id, tenant_id, memory_id, kind, at, actor, meta)
       VALUES (gen_random_uuid(), $1, $2, 'updated', now(), '{"type":"system"}'::jsonb, '{}'::jsonb)`,
      [OTHER, mineId],
    );

    const beforeT = await countAll(pool, T);
    const beforeOther = await countAll(pool, OTHER);
    expect(beforeT[space]).toBeGreaterThan(0);
    expect(beforeT.outbox).toBeGreaterThan(0);

    const deps = {
      memoryStore: new PostgresMemoryStore(db),
      vectorStore: new PostgresVectorStore(db),
      outboxStore: new PostgresOutboxStore(db),
      tenantSettingsStore,
    };
    const outcome = await eraseTenant({ tenantId: T }, deps, {
      confirmTenantId: T,
      limit: 100_000,
    });
    expect(outcome).toEqual({ kind: "blocked_by_foreign_reference", count: 2 });

    expect(await countAll(pool, T)).toEqual(beforeT);
    expect(await countAll(pool, OTHER)).toEqual(beforeOther);
  }, 120_000);

  it("limit で途中で止まった回は、設定・outbox・埋め込みを消さない（呼び直せば最後まで消える）", async () => {
    await resetTestDatabase();
    const { db, pool } = await getTestClient();
    const runtime = buildRuntime(db);
    const T = "erase-tenant-stops-at-limit";
    const OTHER = "erase-tenant-stops-at-limit-keep";
    await seedTenant(runtime, new PostgresTenantSettingsStore(db), T);
    await seedTenant(runtime, new PostgresTenantSettingsStore(db), OTHER);

    const embeddingTable = embeddingSpaceTableName(TEST_EMBEDDING_SPACE);
    const before = await countAll(pool, T);
    const otherBefore = await countAll(pool, OTHER);
    const LIMIT = 10;
    expect(before.memories!).toBeGreaterThan(0);
    expect(before.memories! + before.memory_events! + before.recalls!).toBeGreaterThan(LIMIT);
    expect(before.tenant_settings).toBeGreaterThan(0);
    expect(before.outbox).toBeGreaterThan(0);
    expect(before[embeddingTable]).toBeGreaterThan(0);

    const deps = {
      memoryStore: new PostgresMemoryStore(db),
      vectorStore: new PostgresVectorStore(db),
      outboxStore: new PostgresOutboxStore(db),
      tenantSettingsStore: new PostgresTenantSettingsStore(db),
    };
    const ctxT: Ctx = { tenantId: T };

    const first = await eraseTenant(ctxT, deps, { confirmTenantId: T, limit: LIMIT });
    expect(first.kind).toBe("executed");
    if (first.kind !== "executed") throw new Error("unreachable");
    expect(first.reachedLimit).toBe(true);
    const afterFirst = await countAll(pool, T);
    expect(afterFirst.memories! + afterFirst.memory_events! + afterFirst.recalls!).toBeGreaterThan(
      0,
    );
    expect(afterFirst.tenant_settings).toBe(before.tenant_settings);
    expect(afterFirst.outbox).toBe(before.outbox);
    expect(before[embeddingTable]! - afterFirst[embeddingTable]!).toBeLessThanOrEqual(
      before.memories! - afterFirst.memories!,
    );

    expect(first.deleted.vectorStore).toBe(0);
    expect(first.deleted.outboxStore).toBe(0);
    expect(first.deleted.tenantSettingsStore).toBe(0);

    let outcome = first;
    let guard = 0;
    while (outcome.reachedLimit) {
      guard += 1;
      expect(guard).toBeLessThan(50);
      const mid = await countAll(pool, T);
      expect(mid.tenant_settings).toBe(before.tenant_settings);
      const next = await eraseTenant(ctxT, deps, { confirmTenantId: T, limit: LIMIT });
      expect(next.kind).toBe("executed");
      if (next.kind !== "executed") throw new Error("unreachable");
      outcome = next;
    }
    expect(guard).toBeGreaterThan(0);
    expect(outcome.reachedLimit).toBe(false);

    const after = await countAll(pool, T);
    for (const [table, n] of Object.entries(after)) {
      expect({ table, n }).toEqual({ table, n: 0 });
    }
    expect(await countAll(pool, OTHER)).toEqual(otherBefore);
  }, 120_000);

  it("dryRun: true でも、memoryStore が limit で止まったら後ろの port の deleted は 0（本番の1回目と同じ形）", async () => {
    await resetTestDatabase();
    const { db, pool } = await getTestClient();
    const runtime = buildRuntime(db);
    const T = "erase-tenant-stops-at-limit-dry-run";
    await seedTenant(runtime, new PostgresTenantSettingsStore(db), T);
    const before = await countAll(pool, T);

    const outcome = await eraseTenant(
      { tenantId: T },
      {
        memoryStore: new PostgresMemoryStore(db),
        vectorStore: new PostgresVectorStore(db),
        outboxStore: new PostgresOutboxStore(db),
        tenantSettingsStore: new PostgresTenantSettingsStore(db),
      },
      { confirmTenantId: T, limit: 10, dryRun: true },
    );
    expect(outcome.kind).toBe("executed");
    if (outcome.kind !== "executed") throw new Error("unreachable");
    expect(outcome.dryRun).toBe(true);
    expect(outcome.reachedLimit).toBe(true);
    expect(outcome.deleted.memoryStore).toBe(10);
    expect(outcome.deleted.vectorStore).toBe(0);
    expect(outcome.deleted.outboxStore).toBe(0);
    expect(outcome.deleted.tenantSettingsStore).toBe(0);
    expect(await countAll(pool, T)).toEqual(before);
  }, 60_000);
});

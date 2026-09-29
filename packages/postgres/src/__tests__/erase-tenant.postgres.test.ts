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

/**
 * Issue #1207 / [ADR 0383](../../../../docs/decisions/0383-erase-tenant.md):
 * `eraseTenant`（`packages/core/src/erase-tenant.ts`）を `@mnemora/postgres` の
 * 4 store に対して実行する歯。`tenant-erasure-residue.postgres.test.ts`
 * （forget→purge→保持期間の掃除、今の振る舞いの記録）とは別物——こちらは
 * テナントを**跡形なく**消す新しい操作そのものを検査する。
 */

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
  // decayClock を 'wall' から進めておかないと、`activityCounting` を渡しても
  // `advanceActivityClock` は常に false のまま（`recall-runtime.ts` 参照）——
  // `tenant_activity.activity_seq` を確実に進める（ADR 0165・ADR 0353）ため、
  // `tenant_activity` も `eraseTenant` が消す表の1つなので、消す前に0行だった、
  // という偽陰性を避ける。
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
  // `tenant_settings` に行を作る——observe/tick/recall だけでは行が作られないため
  // （`getDefaultHalfLifeHours` 等は行が無ければ既定値へ倒れる。`tenant-erasure-residue
  // .postgres.test.ts` も同じ理由で明示的に書き込んでいる）。
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

describe("eraseTenant（Issue #1207 / ADR 0383、本物の Postgres）", () => {
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
    // 少なくともいくつかの表には実際にデータが入っていることを確認してからでないと、
    // この歯は「最初から0件だった」を「消えた」と取り違えかねない。
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
    // 1回で消し切れなければ、reachedLimit が false になるまで呼び直す（何度呼んでも安全）。
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

    // このテナントの記憶を1件作る。
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
    // 別テナントの記憶を1件作る。
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

    // ⚠ ここから先は port 直呼びではなく生 SQL を使う——「別テナントの行がこのテナントの
    // 行を superseded_by_id で参照する」状態は、mnemora のどの書き込み経路
    // （`supersedeWithNewMemories` 等）も ctx でテナントを揃えるため作れない。FK 自体は
    // テナントで絞られていない（`memories.superseded_by_id uuid NULL REFERENCES
    // memories(id)`）ので、スキーマとしては可能——この歯はスキーマレベルの
    // 参照整合性チェックを検査するためのものであり、意図的に生 SQL でこの状態を作る。
    await pool.query(`UPDATE memories SET superseded_by_id = $1 WHERE id = $2`, [
      mine.id,
      other.id,
    ]);

    const deps = { memoryStore, vectorStore, outboxStore, tenantSettingsStore };
    const outcome = await eraseTenant(ctxT, deps, { confirmTenantId: T, limit: 100_000 });
    expect(outcome).toEqual({ kind: "blocked_by_foreign_reference", count: 1 });

    // 何も消えていない——mine 自身も、other も、outbox/vectorStore の行（あれば）も無傷。
    expect(await memoryStore.get(ctxT, mine.id)).not.toBeNull();
    const otherReread = await memoryStore.get(ctxOther, other.id);
    expect(otherReread?.supersededById).toBe(mine.id);
  }, 60_000);
});

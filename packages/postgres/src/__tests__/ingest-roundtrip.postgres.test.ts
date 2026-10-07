import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Ctx, EmbeddingProvider } from "@mnemora/core";
import { createRuntime } from "@mnemora/core";
import { DeterministicEmbeddingProvider, DeterministicLLMProvider } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { PostgresEventStore } from "../event-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import { sha256Hex } from "../content-hash.js";
import { embeddingSpaceTableName } from "../embedding-space-table.js";
import {
  closeTestClient,
  getTestClient,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
} from "./test-db.js";

/** ここで使う `LLMProvider` / `EmbeddingProvider` は testkit の決定的な擬似実装なので、検査しているのは runtime → MemoryStore → VectorStore → outbox という配線であり、抽出結果そのものの品質ではない。 */
function buildRuntime() {
  return getTestClient().then(({ db }) => {
    return createRuntime({
      memoryStore: new PostgresMemoryStore(db),
      outboxStore: new PostgresOutboxStore(db),
      vectorStore: new PostgresVectorStore(db),
      eventStore: new PostgresEventStore(db),
      tenantSettingsStore: new PostgresTenantSettingsStore(db),
      llmProvider: new DeterministicLLMProvider(),
      embeddingProvider: new DeterministicEmbeddingProvider(TEST_EMBEDDING_SPACE),
      hashContent: sha256Hex,
    });
  });
}

describe("observe → recall 前段の往復（roadmap.md 段階3、本物の Postgres）", () => {
  it("observe(sync) → observations 行 → memories 行 → tick(embed) → memory_embeddings 行 → embeddingStatus='ready'", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const runtime = await buildRuntime();
    const ctx: Ctx = { tenantId: "tenant-roundtrip" };

    const result = await runtime.observe(ctx, {
      kind: "utterance",
      text: "DB往復検証用の発話です",
      speaker: "tester",
    });

    expect(result.extraction).toBe("ok");
    expect(result.memoryIds).toHaveLength(1);

    const observationRows = await db.execute(sql`
      SELECT * FROM observations WHERE id = ${result.observationId}
    `);
    expect(observationRows.rows).toHaveLength(1);

    const memoryId = result.memoryIds[0]!;
    const memoryRows = await db.execute(sql`
      SELECT * FROM memories WHERE id = ${memoryId}
    `);
    expect(memoryRows.rows).toHaveLength(1);
    const memoryRow = memoryRows.rows[0] as unknown as {
      digest: string;
      content: string;
      embedding_status: string;
      source_observation_id: string;
    };
    expect(memoryRow.digest.length).toBeGreaterThan(0);
    expect(memoryRow.content).toBe("DB往復検証用の発話です");
    expect(memoryRow.embedding_status).toBe("pending");
    expect(memoryRow.source_observation_id).toBe(result.observationId);

    const outboxRows = await db.execute(sql`
      SELECT * FROM outbox WHERE tenant_id = ${ctx.tenantId} AND kind = 'embed' AND completed_at IS NULL
    `);
    expect(outboxRows.rows).toHaveLength(1);

    // このテストはリースの境界を検査しないので、十分に長く固定した値を使う。
    const tickResult = await runtime.tick(ctx, { kinds: ["embed"], leaseMs: 60_000 });
    expect(tickResult).toEqual({
      processed: 1,
      failed: 0,
      unsupported: [],
      leaseConflicts: [],
    });

    const memoryStore = new PostgresMemoryStore(db);
    const updatedMemory = await memoryStore.get(ctx, memoryId);
    expect(updatedMemory?.embeddingStatus).toBe("ready");

    const table = embeddingSpaceTableName(TEST_EMBEDDING_SPACE);
    const embeddingRows = await db.execute(sql`
      SELECT * FROM ${sql.identifier(table)}
      WHERE tenant_id = ${ctx.tenantId} AND memory_id = ${memoryId}
    `);
    expect(embeddingRows.rows).toHaveLength(1);
  });

  it("同じ externalId の Observation を二重に observe() しても Memory が重複して作られない（本物の Postgres）", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const runtime = await buildRuntime();
    const ctx: Ctx = { tenantId: "tenant-roundtrip-idem" };

    await runtime.observe(ctx, {
      kind: "utterance",
      text: "冪等性チェック用の発話",
      externalId: "ext-roundtrip-1",
    });
    const second = await runtime.observe(ctx, {
      kind: "utterance",
      text: "冪等性チェック用の発話（無視されるべき）",
      externalId: "ext-roundtrip-1",
    });
    expect(second.extraction).toBe("skipped");

    const memoryCount = await db.execute(sql`
      SELECT count(*)::int AS count FROM memories WHERE tenant_id = ${ctx.tenantId}
    `);
    expect((memoryCount.rows[0] as unknown as { count: number }).count).toBe(1);

    const observationCount = await db.execute(sql`
      SELECT count(*)::int AS count FROM observations WHERE tenant_id = ${ctx.tenantId}
    `);
    expect((observationCount.rows[0] as unknown as { count: number }).count).toBe(1);
  });

  it("memory_usage の使用報告は抽出器を通らず、reinforce が実 DB に反映される", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const runtime = await buildRuntime();
    const ctx: Ctx = { tenantId: "tenant-roundtrip-usage" };

    const observeResult = await runtime.observe(ctx, { kind: "utterance", text: "使用報告の対象" });
    const memoryId = observeResult.memoryIds[0]!;

    const memoryStore = new PostgresMemoryStore(db);
    const before = await memoryStore.get(ctx, memoryId);
    expect(before?.lastReinforcedAt).toBeNull();

    // `recall_usages.recall_id` は `recalls(id)` への外部キーで、`returned_memories` は NOT NULL・DEFAULT 無し。
    // ここは外部キーの相手が要るだけで内訳の中身は問わないので、「内訳ありの新規行」の最小形を渡す。
    const recallRow = await db.execute(sql`
      INSERT INTO recalls (id, tenant_id, query, usage, index_band, returned_memories)
      VALUES (
        gen_random_uuid(), ${ctx.tenantId}, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
        '{"breakdownCaptured":true,"memories":[]}'::jsonb
      )
      RETURNING id
    `);
    const recallId = (recallRow.rows[0] as unknown as { id: string }).id;

    await runtime.observe(ctx, {
      kind: "memory_usage",
      recallId,
      usedMemoryIds: [memoryId],
    });

    const after = await memoryStore.get(ctx, memoryId);
    expect(after?.lastReinforcedAt).not.toBeNull();
  });

  it("同じ externalId の memory_usage を2回 observe() しても observations の usage 行は1件のまま（本物の Postgres）", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const runtime = await buildRuntime();
    const ctx: Ctx = { tenantId: "tenant-roundtrip-usage-ext-id" };

    const observeResult = await runtime.observe(ctx, {
      kind: "utterance",
      text: "externalId 冪等性チェック用の使用報告の対象",
    });
    const memoryId = observeResult.memoryIds[0]!;

    const recallRow = await db.execute(sql`
      INSERT INTO recalls (id, tenant_id, query, usage, index_band, returned_memories)
      VALUES (
        gen_random_uuid(), ${ctx.tenantId}, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
        '{"breakdownCaptured":true,"memories":[]}'::jsonb
      )
      RETURNING id
    `);
    const recallId = (recallRow.rows[0] as unknown as { id: string }).id;

    const first = await runtime.observe(ctx, {
      kind: "memory_usage",
      externalId: "ext-usage-roundtrip-1",
      recallId,
      usedMemoryIds: [memoryId],
    });
    const second = await runtime.observe(ctx, {
      kind: "memory_usage",
      externalId: "ext-usage-roundtrip-1",
      recallId,
      usedMemoryIds: [memoryId],
    });

    expect(second.observationId).toBe(first.observationId);
    expect(second.memoryIds).toEqual([]);
    expect(second.extraction).toBe("skipped");

    const usageObservationCount = await db.execute(sql`
      SELECT count(*)::int AS count FROM observations
      WHERE tenant_id = ${ctx.tenantId} AND kind = 'usage'
    `);
    expect((usageObservationCount.rows[0] as unknown as { count: number }).count).toBe(1);
  });
});

class OverLimitEmbeddingProvider implements EmbeddingProvider {
  readonly space = TEST_EMBEDDING_SPACE;
  async embed(_ctx: Ctx, texts: string[]): Promise<number[][]> {
    const tooLong = texts.find((text) => text.length > 100);
    if (tooLong !== undefined) {
      throw new Error("simulated input_too_long: input exceeds provider limit");
    }
    return texts.map(() => [0, 0, 0]);
  }
}

describe("embeddingInput opt-in フック（Issue #753、本物の Postgres）", () => {
  it("上限超過で failed になった Memory は、embeddingInput フックを渡した runtime で reembed + tick すると ready になる。memories.content は全文のまま", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const ctx: Ctx = { tenantId: "tenant-embed-input-hook" };
    const hugeContent = "x".repeat(500);
    const provider = new OverLimitEmbeddingProvider();

    const runtime = createRuntime({
      memoryStore: new PostgresMemoryStore(db),
      outboxStore: new PostgresOutboxStore(db),
      vectorStore: new PostgresVectorStore(db),
      eventStore: new PostgresEventStore(db),
      tenantSettingsStore: new PostgresTenantSettingsStore(db),
      llmProvider: new DeterministicLLMProvider(),
      embeddingProvider: provider,
      hashContent: sha256Hex,
    });

    const observeResult = await runtime.observe(ctx, { kind: "utterance", text: hugeContent });
    expect(observeResult.extraction).toBe("ok");
    const memoryId = observeResult.memoryIds[0]!;

    const failedTick = await runtime.tick(ctx, { kinds: ["embed"], leaseMs: 60_000 });
    expect(failedTick).toEqual({ processed: 0, failed: 1, unsupported: [], leaseConflicts: [] });

    const memoryStore = new PostgresMemoryStore(db);
    const afterFailureStatus = (await memoryStore.get(ctx, memoryId))?.embeddingStatus;
    expect(afterFailureStatus).toBe("failed");

    const healingRuntime = createRuntime({
      memoryStore: new PostgresMemoryStore(db),
      outboxStore: new PostgresOutboxStore(db),
      vectorStore: new PostgresVectorStore(db),
      eventStore: new PostgresEventStore(db),
      tenantSettingsStore: new PostgresTenantSettingsStore(db),
      llmProvider: new DeterministicLLMProvider(),
      embeddingProvider: provider,
      hashContent: sha256Hex,
      embeddingInput: (memory) => memory.content.slice(0, 50),
      clock: { now: () => new Date(Date.now() + 1_000) },
    });

    const reembedResult = await healingRuntime.reembed(ctx, { statuses: ["failed"], limit: 10 });
    expect(reembedResult).toEqual({ requeued: 1, memoryIds: [memoryId] });

    const healingTick = await healingRuntime.tick(ctx, { kinds: ["embed"], leaseMs: 60_000 });
    expect(healingTick).toEqual({ processed: 1, failed: 0, unsupported: [], leaseConflicts: [] });

    const healed = await memoryStore.get(ctx, memoryId);
    expect(healed?.embeddingStatus).toBe("ready");
    expect(healed?.content).toBe(hugeContent);

    const table = embeddingSpaceTableName(TEST_EMBEDDING_SPACE);
    const embeddingRows = await db.execute(sql`
      SELECT * FROM ${sql.identifier(table)}
      WHERE tenant_id = ${ctx.tenantId} AND memory_id = ${memoryId}
    `);
    expect(embeddingRows.rows).toHaveLength(1);
  });
});

afterAll(async () => {
  await closeTestClient();
});

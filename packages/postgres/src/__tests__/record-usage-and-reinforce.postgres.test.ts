import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Ctx } from "@mnemora/core";
import { createRuntime } from "@mnemora/core";
import { DeterministicEmbeddingProvider, DeterministicLLMProvider } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { PostgresEventStore } from "../event-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import { sha256Hex } from "../content-hash.js";
import {
  closeTestClient,
  getTestClient,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
} from "./test-db.js";

/**
 * Issue #961: `observe({kind:'memory_usage'})` は `recall_usages` への INSERT と強化
 * （`memories.last_reinforced_at`/`decay_floor_at` の UPDATE）を別々にコミットしていた。
 * 強化の前で落ちると、同じ `externalId` の再送は `recordUsage` が
 * `insertedMemoryIds: []` を返すため強化を二度と呼ばず、強化は恒久に失われていた
 * （docs/memory-model.md §11 行4「`observe()` と同一トランザクション」・ADR 0009
 * 「再送で完了させられる」と食い違う）。
 *
 * `PostgresMemoryStore.recordUsageAndReinforce` は両方を1トランザクションで撃つ。
 * 強化の UPDATE をトリガーで拒否させ、(1) 1回目の失敗で `recall_usages` に行が
 * 残らないこと、(2) トリガーを外した後の同じ `externalId` の再送で強化が完了することを測る。
 */
afterAll(async () => {
  const { db } = await getTestClient();
  await db.execute(sql`DROP TRIGGER IF EXISTS usage_reinforce_probe ON memories`);
  await db.execute(sql`DROP FUNCTION IF EXISTS usage_reinforce_probe_fn()`);
  await closeTestClient();
});

describe("使用報告の記録と強化は1トランザクション（Issue #961、本物の Postgres）", () => {
  it("強化が DB に拒否されたら recall_usages も残らず、同じ externalId の再送で強化が完了する", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const runtime = createRuntime({
      memoryStore: new PostgresMemoryStore(db),
      outboxStore: new PostgresOutboxStore(db),
      vectorStore: new PostgresVectorStore(db),
      eventStore: new PostgresEventStore(db),
      tenantSettingsStore: new PostgresTenantSettingsStore(db),
      llmProvider: new DeterministicLLMProvider(),
      embeddingProvider: new DeterministicEmbeddingProvider(TEST_EMBEDDING_SPACE),
      hashContent: sha256Hex,
    });
    const ctx: Ctx = { tenantId: "tenant-usage-atomic" };
    const observed = await runtime.observe(ctx, {
      kind: "utterance",
      text: "カバはとても重い",
      speaker: "u",
    });
    const memoryId = observed.memoryIds[0]!;
    await runtime.tick(ctx, { leaseMs: 60_000 });
    const recalled = await runtime.recall(ctx, { text: "カバはとても重い" });
    expect(recalled.memories.map((m) => m.memoryId)).toContain(memoryId);

    await db.execute(
      sql.raw(`CREATE OR REPLACE FUNCTION usage_reinforce_probe_fn() RETURNS trigger AS $$
        BEGIN
          IF NEW.last_reinforced_at IS DISTINCT FROM OLD.last_reinforced_at THEN
            RAISE EXCEPTION 'probe: reinforce rejected';
          END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`),
    );
    await db.execute(
      sql`CREATE TRIGGER usage_reinforce_probe BEFORE UPDATE ON memories FOR EACH ROW EXECUTE FUNCTION usage_reinforce_probe_fn()`,
    );
    const input = {
      kind: "memory_usage" as const,
      recallId: recalled.recallId,
      usedMemoryIds: [memoryId],
      externalId: "usage-atomic-1",
    };
    await expect(runtime.observe(ctx, input)).rejects.toThrow();
    await db.execute(sql`DROP TRIGGER usage_reinforce_probe ON memories`);

    const usagesAfterFailure = await db.execute(
      sql`SELECT count(*)::int AS n FROM recall_usages WHERE memory_id = ${memoryId}`,
    );
    expect((usagesAfterFailure.rows[0] as { n: number }).n).toBe(0);

    const resent = await runtime.observe(ctx, input);
    expect(resent.memoryIds).toEqual([memoryId]);
    const memory = await db.execute(
      sql`SELECT last_reinforced_at FROM memories WHERE id = ${memoryId}`,
    );
    expect((memory.rows[0] as { last_reinforced_at: unknown }).last_reinforced_at).not.toBeNull();
    const usages = await db.execute(
      sql`SELECT count(*)::int AS n FROM recall_usages WHERE memory_id = ${memoryId}`,
    );
    expect((usages.rows[0] as { n: number }).n).toBe(1);
  });
});

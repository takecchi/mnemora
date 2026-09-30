import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Ctx, MemoryId } from "@mnemora/core";
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
 * id・クエリの件数が Postgres のバインドパラメータの上限（65535）を超える呼び出しを縛る（ADR 0443）。
 *
 * 以前は `reinforceMany` が1行あたり5個のパラメータを `VALUES` に並べ（13107 件目で上限を超え）、
 * `searchMany` が1クエリあたり2個を `VALUES` に並べていた（32767 件目の前後で上限を超える）。
 * 上限を超えると、drizzle の `Failed query: ... params: <全部>` を message に持つ例外になり、
 * message が何 MB にもなった。崖の手前と奥の両方で、同じように動くこと。
 */
const ctx: Ctx = { tenantId: "bind-limit-cliff" };
const MESSAGE_MAX_CHARS = 2_000;

let memoryStore: PostgresMemoryStore;
let vectorStore: PostgresVectorStore;
let db: Awaited<ReturnType<typeof getTestClient>>["db"];

/** 記憶を SQL で N 件まとめて作り、id を返す（1件ずつ作ると遅いため）。 */
async function seedMemories(n: number): Promise<MemoryId[]> {
  const result = await db.execute(sql`
    INSERT INTO memories (tenant_id, content, content_hash, digest, provenance_kind, provenance,
                          half_life_hours, decay_floor_at, recorded_at)
    SELECT ${ctx.tenantId}, 'c' || g, 'h' || g, 'd' || g, 'imported', '{"kind":"imported"}'::jsonb,
           168, now() + interval '1 day', now() - interval '1 hour'
    FROM generate_series(1, ${n}::int) AS g
    RETURNING id
  `);
  return result.rows.map((r) => (r as { id: string }).id as MemoryId);
}

beforeAll(async () => {
  await resetTestDatabase();
  ({ db } = await getTestClient());
  memoryStore = new PostgresMemoryStore(db);
  vectorStore = new PostgresVectorStore(db);
});

afterAll(async () => {
  await closeTestClient();
});

describe("reinforceMany — 件数の崖（ADR 0443）", () => {
  let ids: MemoryId[];
  beforeAll(async () => {
    ids = await seedMemories(30_000);
  }, 120_000);

  // 13106 × 5 + 3 = 65533 は上限の手前、13107 × 5 + 3 = 65538 は奥。
  for (const n of [13_106, 13_107, 30_000]) {
    it(`${n} 件: 例外にならず、全件を強化して、入力と同じ順で返す`, async () => {
      const slice = ids.slice(0, n);
      const at = new Date("2030-01-01T00:00:00.000Z");
      const result = await memoryStore.reinforceMany(ctx, slice, at);
      expect(result).toHaveLength(n);
      expect(result.map((m) => m.id)).toEqual(slice);
      expect(result.every((m) => m.lastReinforcedAt?.getTime() === at.getTime())).toBe(true);
    }, 120_000);
  }

  it("存在しない id が混ざる大きな呼び出し: 例外の message は巨大にならない", async () => {
    const error = await memoryStore
      .reinforceMany(
        ctx,
        [...ids.slice(0, 20_000), "00000000-0000-4000-8000-000000000000"],
        new Date(),
      )
      .then(
        () => null,
        (e: unknown) => e as Error,
      );
    expect(error).not.toBeNull();
    expect(error!.message).toContain("memory not found");
    expect(error!.message.length).toBeLessThan(MESSAGE_MAX_CHARS);
  }, 120_000);
});

describe("observe({ kind: 'memory_usage' }) — 件数の崖（ADR 0443）", () => {
  for (const n of [13_106, 13_107]) {
    it(`${n} 件の使用報告: 例外にならず、全件を記録して強化する`, async () => {
      await resetTestDatabase();
      const runtime = createRuntime({
        memoryStore,
        outboxStore: new PostgresOutboxStore(db),
        vectorStore,
        eventStore: new PostgresEventStore(db),
        tenantSettingsStore: new PostgresTenantSettingsStore(db),
        llmProvider: new DeterministicLLMProvider(),
        embeddingProvider: new DeterministicEmbeddingProvider(TEST_EMBEDDING_SPACE),
        hashContent: sha256Hex,
      });
      const observed = await runtime.observe(ctx, {
        kind: "utterance",
        text: "カバはとても重い",
        speaker: "u",
      });
      await runtime.tick(ctx, { leaseMs: 60_000 });
      const recalled = await runtime.recall(ctx, { text: "カバはとても重い" });
      expect(recalled.memories.map((m) => m.memoryId)).toContain(observed.memoryIds[0]);
      const ids = await seedMemories(n);

      const result = await runtime.observe(ctx, {
        kind: "memory_usage",
        recallId: recalled.recallId,
        usedMemoryIds: ids,
      });
      expect(result.memoryIds).toHaveLength(n);
      const reinforced = await db.execute(
        sql`SELECT count(*)::int AS n FROM memories WHERE tenant_id = ${ctx.tenantId} AND last_reinforced_at IS NOT NULL AND content LIKE 'c%'`,
      );
      expect((reinforced.rows[0] as { n: number }).n).toBe(n);
    }, 120_000);
  }
});

describe("searchMany — 件数の崖（ADR 0443）", () => {
  // 1クエリあたり2個のパラメータ。固定のパラメータ（tenant・limit など）を足して 65535 を超える境目の前後。
  for (const n of [32_000, 32_767, 32_768, 40_000]) {
    it(`${n} 件のクエリ: 例外にならず、全 key を返す`, async () => {
      await resetTestDatabase();
      const queries = Array.from({ length: n }, (_, i) => ({ key: `k${i}`, vector: [1, 0, 0] }));
      const result = await vectorStore.searchMany(ctx, TEST_EMBEDDING_SPACE, queries, {
        limit: 3,
        filter: { tenantId: ctx.tenantId },
      });
      expect(result.size).toBe(n);
      expect([...result.keys()].slice(0, 2)).toEqual(["k0", "k1"]);
    }, 120_000);
  }

  it("チャンクをまたいでも、結果は search() を単独で呼んだときと一致する", async () => {
    await resetTestDatabase();
    const ids = await seedMemories(30);
    for (const [i, id] of ids.entries()) {
      const vec = [Math.cos(i), Math.sin(i), (i % 5) / 5];
      await vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, id, vec);
    }
    const n = 33_000;
    const vectors = Array.from({ length: n }, (_, i) => [Math.cos(i % 97), Math.sin(i % 89), 0.5]);
    const queries = vectors.map((vector, i) => ({ key: `k${i}`, vector }));
    const many = await vectorStore.searchMany(ctx, TEST_EMBEDDING_SPACE, queries, {
      limit: 4,
      filter: { tenantId: ctx.tenantId },
    });
    for (const i of [0, 1, 16_383, 16_384, 16_385, 32_767, 32_768, 32_999]) {
      const single = await vectorStore.search(ctx, TEST_EMBEDDING_SPACE, vectors[i]!, {
        limit: 4,
        filter: { tenantId: ctx.tenantId },
      });
      expect(many.get(`k${i}`)).toEqual(single);
    }
  }, 120_000);
});

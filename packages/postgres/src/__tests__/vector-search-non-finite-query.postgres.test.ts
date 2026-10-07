import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx, EmbeddingProvider } from "@mnemora/core";
import { createRuntime } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
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
 * `PostgresVectorStore.search`/`searchMany` は、クエリベクトルに有限でない成分
 * （`NaN`・`Infinity`・`-Infinity`）があっても例外を投げず、「比較不能」として扱う。
 *
 * core は provider のクエリ埋め込みの有限でない成分を、vectorStore へ渡す前に弾き、`embedding_provider_unavailable` に
 * する。`search`/`searchMany` を直接呼ぶ場合の「比較不能」の扱いは、それとは独立に決まる（上の2つの it）。
 * 利用者が `recall({ vector })` に渡す値は `RecallQuerySchema` の `z.number()` が `NaN`・`Infinity` とも拒むので、
 * この経路には来ない。
 *
 * core の `FakeVectorStore` と testkit の `InMemoryVectorStore` は、有限でない成分を含むクエリの距離を `NaN` として
 * 返し、`recall()` は `score_not_comparable` に数える——Postgres もそれに揃える。
 */

const ctx: Ctx = { tenantId: `non-finite-query-${randomUUID()}` };

async function seedEmbedded() {
  const { db } = await getTestClient();
  const memoryStore = new PostgresMemoryStore(db);
  const vectorStore = new PostgresVectorStore(db);
  const memory = await memoryStore.createMemory(
    ctx,
    buildNewMemoryFixture({
      tenantId: ctx.tenantId,
      contentHash: `non-finite-${randomUUID()}`,
      embeddingStatus: "ready",
      recordedAt: new Date(Date.now() - 3600_000),
    }),
  );
  await vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, memory.id, [1, 0, 0]);
  return { db, memoryStore, vectorStore, memory };
}

const NON_FINITE_QUERIES = [
  ["NaN", [NaN, 0, 0]],
  ["Infinity", [Infinity, 0, 0]],
  ["-Infinity", [0, -Infinity, 0]],
] as const;

const MISMATCHED_DIMENSION_QUERIES = [
  ["短い", [1, 2]],
  ["長い", [1, 2, 3, 4]],
  ["空", []],
] as const;

describe("PostgresVectorStore: 次元の違うクエリは比較不能として扱う（reject しない。Issue #867 の案B）", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it.each(MISMATCHED_DIMENSION_QUERIES)(
    "search（%s）: 候補は落とさず、距離が比較の通らない値になる",
    async (_label, query) => {
      const { vectorStore, memory } = await seedEmbedded();

      const hits = await vectorStore.search(ctx, TEST_EMBEDDING_SPACE, [...query], {
        limit: 10,
        filter: { tenantId: ctx.tenantId },
      });

      expect(hits.map((h) => h.memoryId)).toEqual([memory.id]);
      expect(hits[0]!.distance >= 0).toBe(false);
      expect(hits[0]!.distance <= 0).toBe(false);
    },
  );

  it.each(MISMATCHED_DIMENSION_QUERIES)(
    "searchMany（%s）: 同じく比較不能になり、正常なクエリは影響を受けない",
    async (_label, query) => {
      const { vectorStore, memory } = await seedEmbedded();

      const result = await vectorStore.searchMany(
        ctx,
        TEST_EMBEDDING_SPACE,
        [
          { key: "bad", vector: [...query] },
          { key: "good", vector: [1, 0, 0] },
        ],
        { limit: 10, filter: { tenantId: ctx.tenantId } },
      );

      const bad = result.get("bad")!;
      expect(bad.map((h) => h.memoryId)).toEqual([memory.id]);
      expect(bad[0]!.distance >= 0).toBe(false);
      expect(result.get("good")).toEqual([{ memoryId: memory.id, distance: 0 }]);
    },
  );
});

describe("PostgresVectorStore: 有限でない成分を含むクエリは比較不能として扱う（reject しない）", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it.each(NON_FINITE_QUERIES)(
    "search（%s）: 候補は落とさず、距離が比較の通らない値になる",
    async (_label, query) => {
      const { vectorStore, memory } = await seedEmbedded();

      const hits = await vectorStore.search(ctx, TEST_EMBEDDING_SPACE, [...query], {
        limit: 10,
        filter: { tenantId: ctx.tenantId },
      });

      expect(hits.map((h) => h.memoryId)).toEqual([memory.id]);
      const distance = hits[0]!.distance;
      expect(distance >= 0).toBe(false);
      expect(distance <= 0).toBe(false);
    },
  );

  it.each(NON_FINITE_QUERIES)(
    "searchMany（%s）: 同じく比較不能になり、正常なクエリは影響を受けない",
    async (_label, query) => {
      const { vectorStore, memory } = await seedEmbedded();

      const result = await vectorStore.searchMany(
        ctx,
        TEST_EMBEDDING_SPACE,
        [
          { key: "bad", vector: [...query] },
          { key: "good", vector: [1, 0, 0] },
        ],
        { limit: 10, filter: { tenantId: ctx.tenantId } },
      );

      const bad = result.get("bad")!;
      expect(bad.map((h) => h.memoryId)).toEqual([memory.id]);
      expect(bad[0]!.distance >= 0).toBe(false);
      expect(result.get("good")).toEqual([{ memoryId: memory.id, distance: 0 }]);
    },
  );

  it.each(NON_FINITE_QUERIES)(
    "runtime.recall: 埋め込み provider がクエリに %s を返しても reject せず、embedding_provider_unavailable に数える（2026-09-30、ADR 0393）",
    async (_label, query) => {
      const { db, memoryStore, vectorStore } = await seedEmbedded();
      const embeddingProvider: EmbeddingProvider = {
        space: TEST_EMBEDDING_SPACE,
        embed: async (_ctx, texts) => texts.map(() => [...query]),
      };
      const runtime = createRuntime({
        memoryStore,
        outboxStore: new PostgresOutboxStore(db),
        vectorStore,
        eventStore: new PostgresEventStore(db),
        tenantSettingsStore: new PostgresTenantSettingsStore(db),
        llmProvider: {
          complete: async () => {
            throw new Error("not used");
          },
          completeStructured: async () => {
            throw new Error("not used");
          },
        },
        embeddingProvider,
        hashContent: (content: string) => `sha256(${content})`,
      });

      const result = await runtime.recall(ctx, { text: "何かのクエリ", association: null });

      expect(result.memories).toEqual([]);
      // core が provider の問い合わせベクトルの有限性を、vectorStore へ渡す前に確かめる。
      expect(result.omitted).toContainEqual({
        kind: "stage_skipped",
        stage: "candidate_generation",
        reason: "embedding_provider_unavailable",
        cause: { kind: "non_finite" },
      });
      expect(result.omitted.find((o) => o.kind === "score_not_comparable")).toBeUndefined();
    },
  );
});

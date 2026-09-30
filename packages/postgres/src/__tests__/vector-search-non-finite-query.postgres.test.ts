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
 * 以前は、`toVectorLiteral` がそのまま `[NaN,0,0]` を作り、pgvector が
 * 「NaN not allowed in vector」／「infinite value not allowed in vector」で拒んで、
 * 未捕捉の `DrizzleQueryError` になっていた。`runtime.recall()` 自体が reject される。
 * 経路は、埋め込み provider がクエリ埋め込みに有限でない成分を返したときだった（当時 provider の
 * 出力は core では検証しなかった）。**2026-09-30（ADR 0393）から、この経路は core が vectorStore へ渡す前に
 * 弾き、`embedding_provider_unavailable` になる**。`search`/`searchMany` を直接呼ぶ場合の
 * 「比較不能」の扱いは変わらない（上の2つの it）。利用者が `recall({ vector })` に渡す値は `RecallQuerySchema`
 * の `z.number()` が `NaN`・`Infinity` とも拒むので、この経路には来ない（実測）。
 *
 * Issue #867 の案B（次元の不一致は比較不能として扱い、`space.dimensions` 長の全 0 ベクトルに
 * 差し替える）と同じ扱いにした。core の `FakeVectorStore` と testkit の `InMemoryVectorStore` は、
 * 有限でない成分を含むクエリの距離を以前から `NaN` として返しており、`recall()` は
 * `score_not_comparable` に数える——Postgres をそれに揃える。
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
      // 2026-09-30（ADR 0393）: core が provider の問い合わせベクトルの有限性を、vectorStore へ渡す前に
      // 確かめる。以前はここが score_not_comparable だった（toComparableQuery が全 0 に差し替えていた）。
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

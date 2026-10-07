import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, MemoryStore, VectorStore } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { InMemoryMemoryStore, InMemoryVectorStore } from "@mnemora/testkit/fixtures";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import {
  closeTestClient,
  getTestClient,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
} from "./test-db.js";

/**
 * ベクトルを float4 で比べる——pgvector は成分を float4 で持ち、testkit の fixture も保存するベクトルとクエリを
 * `Math.fround` で丸める。そのため、何が「距離の同点」になるかが2実装で同じになる。
 *
 * A と B は float64 では A のほうがクエリに近いが、float4 に丸めると同じベクトルになる。B のほうが新しい。
 * どちらの実装でも距離が同点になり、tie-break（`recorded_at` の新しい順）で B が先に来る。
 */

const NOW = new Date("2026-09-28T00:00:00.000Z");
const ctx: Ctx = { tenantId: "vector-search-float4-tie" };
const QUERY = [1, 0, 0];
const ROWS: Array<[label: string, vector: number[], hoursAgo: number]> = [
  ["A", [1, 0.1, 0], 2],
  ["B", [1, 0.1 + 1e-9, 0], 1],
  ["C", [1, 0.3, 0], 3],
];

interface Kit {
  memoryStore: MemoryStore;
  vectorStore: VectorStore;
}

const KITS: Array<[string, () => Promise<Kit>, { order: string[]; first: string }]> = [
  [
    "testkit の InMemory",
    async () => {
      const memoryStore = new InMemoryMemoryStore();
      return { memoryStore, vectorStore: new InMemoryVectorStore(memoryStore) };
    },
    { order: ["B", "A", "C"], first: "B" },
  ],
  [
    "Postgres",
    async () => {
      await resetTestDatabase();
      const { db } = await getTestClient();
      return { memoryStore: new PostgresMemoryStore(db), vectorStore: new PostgresVectorStore(db) };
    },
    { order: ["B", "A", "C"], first: "B" },
  ],
];

afterAll(async () => {
  await closeTestClient();
});

describe("VectorStore.search: float4 の桁より小さい距離の差は、2実装とも同点になる", () => {
  for (const [name, makeKit, expected] of KITS) {
    it(`${name}: 並びは ${expected.order.join(" → ")}、limit 1 なら ${expected.first}`, async () => {
      const kit = await makeKit();
      const labelOf = new Map<string, string>();
      for (const [label, vector, hoursAgo] of ROWS) {
        const memory = await kit.memoryStore.createMemory(
          ctx,
          buildNewMemoryFixture({
            tenantId: ctx.tenantId,
            contentHash: label,
            content: label,
            embeddingStatus: "ready",
            recordedAt: new Date(NOW.getTime() - hoursAgo * 3_600_000),
            decayFloorAt: new Date("2031-01-01T00:00:00.000Z"),
          }),
        );
        await kit.vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, memory.id, vector);
        labelOf.set(memory.id, label);
      }
      const search = (limit: number) =>
        kit.vectorStore.search(ctx, TEST_EMBEDDING_SPACE, QUERY, {
          limit,
          filter: { tenantId: ctx.tenantId },
        });
      const all = await search(3);
      expect(all.map((h) => labelOf.get(h.memoryId))).toEqual(expected.order);
      const [a, b] = [
        all.find((h) => labelOf.get(h.memoryId) === "A")!,
        all.find((h) => labelOf.get(h.memoryId) === "B")!,
      ];
      expect(a.distance).toBe(b.distance);
      expect((await search(1)).map((h) => labelOf.get(h.memoryId))).toEqual([expected.first]);
    });
  }
});

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
 * ベクトルの保存の精度（pgvector は float4、testkit の fixture は丸めない float64）で、何が「距離の同点」になるかが
 * 2実装で違う——今の振る舞いを縛る（Issue #1268。`VectorStore.search` の doc の 2026-09-28 追記）。
 * 振る舞いは変えていない。
 *
 * A と B は float64 では A のほうがクエリに近いが、float4 に丸めると同じベクトルになる。B のほうが新しい。
 * Postgres では距離が同点になって tie-break（`recorded_at` の新しい順）で B が先、fixture では距離の近い A が先。
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
    { order: ["A", "B", "C"], first: "A" },
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

describe("VectorStore.search: float4 の桁より小さい距離の差（今の振る舞い）", () => {
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
      if (name === "Postgres") {
        expect(a.distance).toBe(b.distance);
      } else {
        expect(a.distance).toBeLessThan(b.distance);
      }
      expect((await search(1)).map((h) => labelOf.get(h.memoryId))).toEqual([expected.first]);
    });
  }
});

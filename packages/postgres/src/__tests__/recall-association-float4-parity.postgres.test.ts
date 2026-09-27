import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, MemoryStore, Runtime, VectorStore } from "@mnemora/core";
import { createRuntime } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import {
  InMemoryEventStore,
  InMemoryMemoryStore,
  InMemoryOutboxStore,
  InMemoryTenantSettingsStore,
  InMemoryVectorStore,
} from "@mnemora/testkit/fixtures";
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
 * 段3.5（連想枠）の最終の並びが、アンカーとの類似度が float4 で同点になる組でも2実装で揃うことを縛る
 * （Issue #1268、PR #1273 の後）。
 *
 * 連想枠の順位は「アンカーとの類似度 × `score.total`」で、候補の `total` はクエリとの類似度を含まず記憶の欄だけから
 * 決まる（recall.md §9.2）。X と Y は、倍精度では X のほうがアンカー M に近いが、float4 に丸めると同じベクトルになる。
 * Y は 1ms だけ新しく（半減期を大きくして、減衰の差を類似度の差より十分小さくしてある）、`occurredAt` は揃えてある。
 * - 2実装とも類似度は同点になり、`total` のわずかな差で Y → X の順になる。
 * - PR #1273 の前は、fixture だけが倍精度の類似度で X → Y にしていた（実測）。
 * X と Y はクエリとほぼ直交させ、段2では閾値の下に落として、連想枠からだけ返るようにしてある。
 */

const NOW = new Date("2026-09-28T00:00:00.000Z");
const T0 = NOW.getTime() - 3_600_000;
const ctx: Ctx = { tenantId: "recall-association-float4-parity" };
const ROWS: Array<[label: string, vector: number[], recordedAtMs: number]> = [
  ["M", [0.6, 0.8, 0], T0 - 10],
  ["X", [0, 1, 0.1], T0],
  ["Y", [0, 1, 0.1 + 1e-9], T0 + 1],
];

const shared = {
  llmProvider: {
    complete: async () => ({ content: "unused" }),
    completeStructured: async () => {
      throw new Error("not used");
    },
  },
  embeddingProvider: {
    space: TEST_EMBEDDING_SPACE,
    embed: async (_ctx: Ctx, texts: string[]) => texts.map(() => [1, 0, 0]),
  },
  hashContent: (content: string) => createHash("sha256").update(content).digest("hex"),
  clock: { now: () => NOW },
};

interface Kit {
  runtime: Runtime;
  memoryStore: MemoryStore;
  vectorStore: VectorStore;
}

const KITS: Array<[string, () => Promise<Kit>]> = [
  [
    "testkit の InMemory",
    async () => {
      const memoryStore = new InMemoryMemoryStore();
      const vectorStore = new InMemoryVectorStore(memoryStore);
      return {
        memoryStore,
        vectorStore,
        runtime: createRuntime({
          ...shared,
          memoryStore,
          vectorStore,
          eventStore: new InMemoryEventStore(memoryStore, memoryStore.events),
          outboxStore: new InMemoryOutboxStore(memoryStore.outboxJobs),
          tenantSettingsStore: new InMemoryTenantSettingsStore(memoryStore.activitySeq),
        }),
      };
    },
  ],
  [
    "Postgres",
    async () => {
      await resetTestDatabase();
      const { db } = await getTestClient();
      const memoryStore = new PostgresMemoryStore(db);
      const vectorStore = new PostgresVectorStore(db);
      return {
        memoryStore,
        vectorStore,
        runtime: createRuntime({
          ...shared,
          memoryStore,
          vectorStore,
          eventStore: new PostgresEventStore(db),
          outboxStore: new PostgresOutboxStore(db),
          tenantSettingsStore: new PostgresTenantSettingsStore(db),
        }),
      };
    },
  ],
];

afterAll(async () => {
  await closeTestClient();
});

describe("段3.5（連想枠）: アンカーとの類似度が float4 で同点になる組の並びが2実装で揃う", () => {
  for (const [name, makeKit] of KITS) {
    it(`${name}: M（段2）→ Y → X（連想枠）`, async () => {
      const kit = await makeKit();
      const labelOf = new Map<string, string>();
      for (const [label, vector, recordedAtMs] of ROWS) {
        const memory = await kit.memoryStore.createMemory(
          ctx,
          buildNewMemoryFixture({
            tenantId: ctx.tenantId,
            contentHash: label,
            content: label,
            digest: label,
            embeddingStatus: "ready",
            recordedAt: new Date(recordedAtMs),
            occurredAt: new Date(T0),
            decayFloorAt: new Date("2031-01-01T00:00:00.000Z"),
            halfLifeHours: 1e6,
          }),
        );
        await kit.vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, memory.id, vector);
        labelOf.set(memory.id, label);
      }

      const result = await kit.runtime.recall(ctx, { vector: [1, 0, 0], limit: 3 });

      expect(result.memories.map((m) => [labelOf.get(m.memoryId), m.retrievedVia])).toEqual([
        ["M", "ann"],
        ["Y", "association"],
        ["X", "association"],
      ]);
    });
  }
});

import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemory } from "../memory.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * `stated`・`inferred` の Memory は、元の Observation（列の `sourceObservationId`）が要る
 * （`MemoryStore.createMemory` の TSDoc。Postgres は DB の CHECK、testkit の fixture も拒む）。core の Fake も、書く前に拒む。
 * 受け付けると、Postgres では書けない Memory を前提にした試験が、Fake の上で緑になる。
 */

const ctx: Ctx = { tenantId: "tenant-1" };

const newMemory = (over: Partial<NewMemory>): NewMemory =>
  ({
    tenantId: ctx.tenantId,
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: "本文",
    contentHash: "h",
    digest: "digest",
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: [],
    occurredAt: null,
    recordedAt: new Date("2026-01-01T00:00:00.000Z"),
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 720,
    decayFloorAt: new Date("2027-01-01T00:00:00.000Z"),
    embeddingStatus: "pending",
    ...over,
  }) as NewMemory;

const STATED = { kind: "stated", sourceObservationId: "x", at: "2026-01-01T00:00:00Z" };
const INFERRED = {
  kind: "inferred",
  model: "m",
  promptVersion: "p",
  basis: { memoryIds: [], observationIds: [] },
  confidence: 0.5,
};

describe("FakeMemoryStore: stated・inferred で sourceObservationId が null の Memory は書けない", () => {
  it.each([
    ["stated", STATED],
    ["inferred", INFERRED],
  ])(
    "%s は、createMemory も createMemoryWithOutbox も、何も書かずに断る",
    async (kind, provenance) => {
      const stores = createFakeRuntimeStores();
      const input = newMemory({ provenance: provenance as never });
      const backing = (
        stores.memoryStore as unknown as {
          backing: { memories: Map<string, unknown>; outboxJobs: unknown[] };
        }
      ).backing;
      const message = new RegExp(`provenance\\.kind "${kind}" requires sourceObservationId`);
      await expect(stores.memoryStore.createMemory(ctx, input)).rejects.toThrow(message);
      await expect(
        stores.memoryStore.createMemoryWithOutbox(ctx, input, ["embed"]),
      ).rejects.toThrow(message);
      expect(backing.memories.size).toBe(0);
      expect(backing.outboxJobs).toHaveLength(0);
    },
  );

  it("undefined でも断る（省略は null と同じ）", async () => {
    const stores = createFakeRuntimeStores();
    const input = newMemory({
      provenance: STATED as never,
      sourceObservationId: undefined as never,
    });
    await expect(stores.memoryStore.createMemory(ctx, input)).rejects.toThrow(
      /requires sourceObservationId/,
    );
  });

  it.each([
    ["imported", { kind: "imported", batchId: "b" }],
    ["reflected", { kind: "reflected" }],
  ])("%s は sourceObservationId が null でも書ける（対照）", async (_kind, provenance) => {
    const stores = createFakeRuntimeStores();
    const memory = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ provenance: provenance as never }),
    );
    expect(memory.sourceObservationId).toBeNull();
  });

  it("実在する Observation を指す stated は書ける（対照）", async () => {
    const stores = createFakeRuntimeStores();
    const observation = await stores.memoryStore.createObservation(ctx, {
      tenantId: ctx.tenantId,
      kind: "utterance",
      payload: { text: "t" },
    });
    const memory = await stores.memoryStore.createMemory(
      ctx,
      newMemory({
        sourceObservationId: observation.id,
        provenance: { ...STATED, sourceObservationId: observation.id } as never,
      }),
    );
    expect(memory.sourceObservationId).toBe(observation.id);
  });
});

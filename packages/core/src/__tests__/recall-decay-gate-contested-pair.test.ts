import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { Memory, NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

const NOW = new Date("2026-06-01T00:00:00.000Z");
const ctx: Ctx = { tenantId: "tenant-1" };
const ONE_YEAR_MS = 1_000 * 60 * 60 * 24 * 365;

function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  const recordedAt = NOW;
  const halfLifeHours = 24 * 365 * 10;
  return {
    tenantId: "tenant-1",
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: "本文",
    contentHash: `hash-${Math.random()}`,
    digest: "digest",
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: [],
    occurredAt: null,
    recordedAt,
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours,
    decayFloorAt: defaultDecayStrategy.floorAt({
      recordedAt,
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours,
    }),
    embeddingStatus: "ready",
    ...overrides,
  };
}

function build(opts: { adapterIgnoresDecayPushDown: boolean }) {
  const stores = createFakeRuntimeStores();
  if (opts.adapterIgnoresDecayPushDown) {
    const search = stores.vectorStore.search.bind(stores.vectorStore);
    stores.vectorStore.search = (c, space, query, o) => {
      const {
        decayFloorAtAfter: _at,
        decayFloorSeqAfter: _seq,
        decayFloorAnyAxis: _any,
        ...filter
      } = o.filter;
      return search(c, space, query, { ...o, filter });
    };
  }
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    lexicalStore: stores.lexicalStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: {
      complete: async () => {
        throw new Error("not used");
      },
      completeStructured: async () => {
        throw new Error("not used");
      },
    },
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => NOW },
  });
  return { runtime, stores };
}

async function createContestedPair(
  stores: ReturnType<typeof createFakeRuntimeStores>,
  runtime: ReturnType<typeof build>["runtime"],
  decayFloorAt: Date,
): Promise<[Memory, Memory]> {
  const make = async (digest: string) => {
    const memory = await stores.memoryStore.createMemory(ctx, newMemory({ digest, decayFloorAt }));
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, memory.id, [1, 0]);
    return memory;
  };
  const a = await make("A");
  const b = await make("B");
  expect((await runtime.markContested(ctx, a.id, b.id)).outcome.kind).toBe("contested");
  return [a, b];
}

describe("recall() — 忘却ゲートは contested の記憶にも掛かる", () => {
  for (const adapterIgnoresDecayPushDown of [false, true]) {
    const via = adapterIgnoresDecayPushDown
      ? "段1の adapter が押し下げを無視しても"
      : "段1の押し下げが効いていても";
    it(`${via}、減衰しきった contested の対は既定では返らず、decayed が2件と数えられる`, async () => {
      const { runtime, stores } = build({ adapterIgnoresDecayPushDown });
      const [a, b] = await createContestedPair(stores, runtime, new Date(NOW.getTime() - 1_000));

      const result = await runtime.recall(ctx, { vector: [1, 0], limit: 10, association: null });

      const returned = result.memories.map((m) => m.memoryId);
      expect(returned).not.toContain(a.id);
      expect(returned).not.toContain(b.id);
      expect(result.omitted).toContainEqual({
        kind: "filtered",
        condition: "decayed",
        scopeRelation: "within_scope",
        count: 2,
        countKind: "exact",
      });
    });
  }

  it("includeFullyDecayed: true なら、減衰しきった contested の対が対のまま返る", async () => {
    const { runtime, stores } = build({ adapterIgnoresDecayPushDown: true });
    const [a, b] = await createContestedPair(stores, runtime, new Date(NOW.getTime() - 1_000));

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      association: null,
      includeFullyDecayed: true,
    });

    expect(result.memories.map((m) => m.memoryId).sort()).toEqual([a.id, b.id].sort());
    expect(result.omitted.some((o) => o.kind === "filtered" && o.condition === "decayed")).toBe(
      false,
    );
  });

  it("減衰していない contested の対は、ゲートに落とされず対のまま返る（対照）", async () => {
    const { runtime, stores } = build({ adapterIgnoresDecayPushDown: true });
    const [a, b] = await createContestedPair(
      stores,
      runtime,
      new Date(NOW.getTime() + ONE_YEAR_MS),
    );

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 10, association: null });

    expect(result.memories.map((m) => m.memoryId).sort()).toEqual([a.id, b.id].sort());
  });
});

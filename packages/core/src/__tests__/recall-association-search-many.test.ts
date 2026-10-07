import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { Memory, NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores, withSearchMany } from "./runtime-fakes.js";

const T0 = new Date("2026-06-01T00:00:00.000Z");
const ctx: Ctx = { tenantId: "tenant-1" };

function newMemory(digest: string): NewMemory {
  return {
    tenantId: "tenant-1",
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: digest,
    contentHash: `hash-${digest}`,
    digest,
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: [],
    occurredAt: null,
    recordedAt: T0,
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 24 * 365 * 10,
    decayFloorAt: defaultDecayStrategy.floorAt({
      recordedAt: T0,
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours: 24 * 365 * 10,
    }),
    embeddingStatus: "ready",
  };
}

async function scenario(bundled: boolean) {
  const stores = createFakeRuntimeStores();
  const wrapped = withSearchMany(stores.vectorStore);
  // 無い経路: 同じ記録用ラッパーから searchMany だけを外す（search() の回数は wrapped に積まれる）。
  const vectorStore = bundled ? wrapped : { ...wrapped, searchMany: undefined };
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore,
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
    clock: { now: () => T0 },
  });
  const put = async (digest: string, vector: number[]): Promise<Memory> => {
    const memory = await stores.memoryStore.createMemory(ctx, newMemory(digest));
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, memory.id, vector);
    return memory;
  };
  const anchorY = await put("アンカーY", [0.8, 0.6, 0]);
  const anchorZ = await put("アンカーZ", [0.8, 0, 0.6]);
  const nearY = await put("Yの近傍", [0, 1, 0]);
  const nearZ = await put("Zの近傍", [0, 0, 1]);
  const result = await runtime.recall(ctx, {
    vector: [1, 0, 0],
    limit: 2,
    association: { maxCount: 5, anchorCount: 2 },
  });
  return { result, wrapped, anchorY, anchorZ, nearY, nearZ };
}

describe("recall() 段3.5 — VectorStore.searchMany? の有無で結果が変わらない（往復数だけが変わる）", () => {
  it("束ねる経路と search に戻る経路で、recall() の memories が一致し、連想枠に近傍が入る", async () => {
    const bundled = await scenario(true);
    const fallback = await scenario(false);

    const view = (r: typeof bundled) =>
      r.result.memories.map((m) => ({
        digest: m.digest,
        retrievedVia: m.retrievedVia,
        via:
          m.associationOf === undefined
            ? null
            : r.result.memories.find((x) => x.memoryId === m.associationOf)?.digest,
      }));
    expect(view(bundled)).toEqual(view(fallback));
    const digests = view(bundled).map((v) => v.digest);
    expect(digests).toContain("Yの近傍");
    expect(digests).toContain("Zの近傍");
    expect(view(bundled).filter((v) => v.retrievedVia === "association")).toHaveLength(2);
  });

  it("束ねる経路は、アンカーの memoryId を key に1回だけ searchMany を呼び、search() の回数がアンカー数だけ減る", async () => {
    const bundled = await scenario(true);
    const fallbackStores = await scenario(false);
    expect(fallbackStores.wrapped.searchManyCalls).toHaveLength(0);

    expect(bundled.wrapped.searchManyCalls).toHaveLength(1);
    const call = bundled.wrapped.searchManyCalls[0]!;
    expect([...call.keys].sort()).toEqual([bundled.anchorY.id, bundled.anchorZ.id].sort());
    expect(fallbackStores.wrapped.searchCalls - bundled.wrapped.searchCalls).toBe(2);
  });
});

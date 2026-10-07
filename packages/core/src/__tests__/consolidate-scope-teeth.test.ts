import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { MemoryId } from "../ids.js";
import type { LLMProvider, StructuredRequest } from "../interfaces/llm-provider.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

const ctx: Ctx = { tenantId: "tenant-1" };
const NOW = new Date("2026-06-01T00:00:00.000Z");

function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  const recordedAt = overrides.recordedAt ?? NOW;
  const strength = overrides.strength ?? 1;
  const halfLifeHours = overrides.halfLifeHours ?? 24 * 365 * 10;
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
    strength,
    halfLifeHours,
    decayFloorAt: defaultDecayStrategy.floorAt({
      recordedAt,
      lastReinforcedAt: null,
      strength,
      halfLifeHours,
    }),
    embeddingStatus: "pending",
    ...overrides,
  };
}

const consolidatingLlm: LLMProvider = {
  complete: async () => {
    throw new Error("not used");
  },
  completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> =>
    req.schema.parse({ content: "統合後" }) as T,
};

/** 実時計（`tick()` の claim が `availableAt <= now` を要るため。`consolidate.test.ts` と同じ理由）。 */
function buildRuntime(opts: { realClock?: boolean } = {}) {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: consolidatingLlm,
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
    ...(opts.realClock === true ? {} : { clock: { now: () => NOW } }),
  });
  return { runtime, stores };
}

async function createEmbedded(
  stores: ReturnType<typeof createFakeRuntimeStores>,
  vector: number[],
  overrides: Partial<NewMemory>,
) {
  const memory = await stores.memoryStore.createMemory(
    ctx,
    newMemory({ embeddingStatus: "ready", ...overrides }),
  );
  await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, memory.id, vector);
  return memory;
}

describe("runtime.consolidate({ seedMemoryId }) — 近傍は呼び手の ctx の scope で集める（ADR 0317 決定2）", () => {
  async function setup() {
    const { runtime, stores } = buildRuntime();
    const seed = await createEmbedded(stores, [4, 0], {
      content: "seed content",
      digest: "seed",
      subjectId: "subject-a",
    });
    const neighbor = await createEmbedded(stores, [8, 0], {
      content: "other neighbor",
      digest: "n-b",
      subjectId: "subject-b",
    });
    return { runtime, seed, neighbor };
  }

  const eligibleIds = (result: { sources: { memoryId: MemoryId; kind: string }[] }) =>
    result.sources.filter((s) => s.kind === "eligible").map((s) => s.memoryId);

  it("ctx.subjectId を付けなければ、別 subject の近傍もテナント全体から eligible に入る", async () => {
    const { runtime, seed, neighbor } = await setup();
    const result = await runtime.consolidate(ctx, {
      target: { seedMemoryId: seed.id },
      dryRun: true,
    });
    expect(eligibleIds(result)).toEqual([seed.id, neighbor.id]);
  });

  it("ctx.subjectId を種と同じ subject にすれば、別 subject の近傍は入らない", async () => {
    const { runtime, seed, neighbor } = await setup();
    const result = await runtime.consolidate(
      { ...ctx, subjectId: "subject-a" },
      { target: { seedMemoryId: seed.id }, dryRun: true },
    );
    expect(result.outcome).toBe("nothing_to_consolidate");
    expect(result.sources.map((s) => s.memoryId)).not.toContain(neighbor.id);
  });

  it("ctx.subjectId を種と別の subject にすれば、探索はその subject の scope で行われる（種の subject へは絞られない）", async () => {
    const { runtime, seed, neighbor } = await setup();
    const result = await runtime.consolidate(
      { ...ctx, subjectId: "subject-b" },
      { target: { seedMemoryId: seed.id }, dryRun: true },
    );
    expect(eligibleIds(result)).toEqual([seed.id, neighbor.id]);
  });
});

describe("runtime.tick — consolidate ジョブ: 種の subjectId が null なら、tick に渡した ctx のまま探索する（ADR 0317 決定1）", () => {
  it("種が null・tick の ctx.subjectId が subject-b・近傍が subject-b と subject-a の2件 → subject-b の近傍だけが統合され、subject-a は active のまま", async () => {
    const { runtime, stores } = buildRuntime({ realClock: true });
    const { memory: seed } = await stores.memoryStore.createMemoryWithOutbox(
      ctx,
      newMemory({
        content: "seed content",
        digest: "seed",
        subjectId: null,
        embeddingStatus: "ready",
      }),
      ["consolidate"],
    );
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, seed.id, [4, 0]);
    const inScope = await createEmbedded(stores, [8, 0], {
      content: "subject-b neighbor",
      digest: "n-b",
      subjectId: "subject-b",
    });
    const outOfScope = await createEmbedded(stores, [8, 0], {
      content: "subject-a neighbor",
      digest: "n-a",
      subjectId: "subject-a",
    });

    const tickResult = await runtime.tick(
      { ...ctx, subjectId: "subject-b" },
      { kinds: ["consolidate"], leaseMs: 60_000 },
    );
    expect(tickResult).toEqual({ processed: 1, failed: 0, unsupported: [], leaseConflicts: [] });

    const seedAfter = await stores.memoryStore.get(ctx, seed.id);
    expect(seedAfter?.status).toBe("superseded");
    const consolidated = await stores.memoryStore.get(ctx, seedAfter!.supersededById!);
    const sources = (consolidated!.provenance as { sources: MemoryId[] }).sources;
    expect(sources).toEqual(expect.arrayContaining([seed.id, inScope.id]));
    expect(sources).not.toContain(outOfScope.id);
    expect((await stores.memoryStore.get(ctx, outOfScope.id))?.status).toBe("active");
  });

  it("種が見つからない consolidate ジョブでも、tick は投げず processed 1・failed 0 で終わる", async () => {
    const { runtime, stores } = buildRuntime({ realClock: true });
    const { memory: seed } = await stores.memoryStore.createMemoryWithOutbox(
      ctx,
      newMemory({ content: "seed content", digest: "seed", subjectId: "subject-a" }),
      ["consolidate"],
    );
    const backing = (
      stores.memoryStore as unknown as { backing: { memories: Map<string, unknown> } }
    ).backing;
    expect(backing.memories.delete(seed.id)).toBe(true);

    const tickResult = await runtime.tick(ctx, { kinds: ["consolidate"], leaseMs: 60_000 });
    expect(tickResult).toEqual({ processed: 1, failed: 0, unsupported: [], leaseConflicts: [] });
  });
});

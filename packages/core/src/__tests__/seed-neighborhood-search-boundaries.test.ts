import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { MemoryId } from "../ids.js";
import type { LLMProvider, StructuredRequest } from "../interfaces/llm-provider.js";
import { computeAffinity } from "../strategies/consolidate.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { NewMemory } from "../memory.js";
import { DEFAULT_RECALL_LIMIT } from "../recall.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

const ctx: Ctx = { tenantId: "tenant-1" };
const NOW = new Date("2026-06-01T00:00:00.000Z");

function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  const halfLifeHours = 24 * 365 * 10;
  return {
    tenantId: ctx.tenantId,
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
    recordedAt: NOW,
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours,
    decayFloorAt: defaultDecayStrategy.floorAt({
      recordedAt: NOW,
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours,
    }),
    embeddingStatus: "ready",
    ...overrides,
  };
}

const llm: LLMProvider = {
  complete: async () => {
    throw new Error("not used");
  },
  completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> => {
    for (const value of [
      { outcome: "reflected", content: "内省の本文" },
      { content: "統合後の本文" },
    ]) {
      const parsed = req.schema.safeParse(value);
      if (parsed.success) return parsed.data as T;
    }
    throw new Error("unexpected schema");
  },
};

function makeKit(opts: { realClock?: boolean } = {}) {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    ...stores,
    llmProvider: llm,
    hashContent: (content: string) => `sha256(${content})`,
    ...(opts.realClock === true ? {} : { clock: { now: () => NOW } }),
  });
  return { stores, runtime };
}

type Kit = ReturnType<typeof makeKit>;

/** FakeEmbeddingProvider は text から [文字数, "a" の数] を作る。種の digest "seed" は [4, 0]。 */
async function addEmbedded(
  { stores }: Kit,
  vector: [number, number],
  overrides: Partial<NewMemory>,
) {
  const memory = await stores.memoryStore.createMemory(ctx, newMemory(overrides));
  await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, memory.id, vector);
  return memory;
}

type Operation = "consolidate" | "reflect";

/** dryRun で、その呼び出しが材料として拾った記憶の id（呼ばれた順）を返す。 */
async function gatheredIds(
  { runtime }: Kit,
  operation: Operation,
  callerCtx: Ctx,
  target: { seedMemoryId: MemoryId; minAffinity?: number },
): Promise<MemoryId[]> {
  if (operation === "consolidate") {
    const result = await runtime.consolidate(callerCtx, { target, dryRun: true });
    return result.sources.filter((s) => s.kind === "eligible").map((s) => s.memoryId);
  }
  const result = await runtime.reflect(callerCtx, { target, dryRun: true });
  return result.basis.filter((b) => b.kind === "eligible").map((b) => b.memoryId);
}

describe("{ seedMemoryId } の近傍は、種の content ではなく digest を検索語にして集める", () => {
  it.each(["consolidate", "reflect"] as const)("%s", async (operation) => {
    const kit = makeKit();
    // content "aaaa" は [4, 4]、digest "seed" は [4, 0]。
    const seed = await addEmbedded(kit, [4, 0], { content: "aaaa", digest: "seed" });
    const nearDigest = await addEmbedded(kit, [8, 0], { content: "近傍 d", digest: "nd" });
    await addEmbedded(kit, [8, 8], { content: "近傍 c", digest: "nc" });

    const ids = await gatheredIds(kit, operation, ctx, {
      seedMemoryId: seed.id,
      minAffinity: 0.9,
    });

    expect(ids).toEqual([seed.id, nearDigest.id]);
  });
});

describe("{ seedMemoryId } の近傍に、連想枠（association）で返った記憶は入れない", () => {
  it.each(["consolidate", "reflect"] as const)("%s", async (operation) => {
    const kit = makeKit();
    const seed = await addEmbedded(kit, [4, 0], { content: "seed content", digest: "seed" });
    // 種に近い順に並ぶよう、向きを少しずつずらす。recall() の limit（既定 10）を超えた分は連想枠で返る。
    const neighborCount = DEFAULT_RECALL_LIMIT + 2;
    for (let i = 0; i < neighborCount; i++) {
      await addEmbedded(kit, [8, i * 0.1], { content: `近傍 ${i}`, digest: `n${i}` });
    }

    const ids = await gatheredIds(kit, operation, ctx, { seedMemoryId: seed.id, minAffinity: 0.5 });

    expect(ids).toHaveLength(DEFAULT_RECALL_LIMIT);
    expect(ids[0]).toBe(seed.id);
  });
});

describe("{ seedMemoryId } の minAffinity の既定は、consolidate が 0.8・reflect が 0.4", () => {
  async function setupMiddleNeighbor() {
    const kit = makeKit();
    const seed = await addEmbedded(kit, [4, 0], { content: "seed content", digest: "seed" });
    // [4, 4] と [4, 0] の cosine は約 0.707。0.4 以上 0.8 未満。
    const middle = await addEmbedded(kit, [4, 4], { content: "中くらいの近傍", digest: "mid" });
    return { kit, seed, middle };
  }

  it("reflect は 0.4 以上 0.8 未満の近傍も土台に入れる", async () => {
    const { kit, seed, middle } = await setupMiddleNeighbor();
    expect(await gatheredIds(kit, "reflect", ctx, { seedMemoryId: seed.id })).toEqual([
      seed.id,
      middle.id,
    ]);
  });

  it("consolidate は 0.4 以上 0.8 未満の近傍を統合元に入れない", async () => {
    const { kit, seed, middle } = await setupMiddleNeighbor();
    const result = await kit.runtime.consolidate(ctx, {
      target: { seedMemoryId: seed.id },
      dryRun: true,
    });
    expect(result.outcome).toBe("nothing_to_consolidate");
    expect(result.sources.map((s) => s.memoryId)).not.toContain(middle.id);
  });
});

describe("reflect({ seedMemoryId }) を直接呼ぶと、近傍は呼び手の ctx の scope で集める", () => {
  async function setup() {
    const kit = makeKit();
    const seed = await addEmbedded(kit, [4, 0], {
      content: "seed content",
      digest: "seed",
      subjectId: "subject-a",
    });
    const neighbor = await addEmbedded(kit, [8, 0], {
      content: "other neighbor",
      digest: "nb",
      subjectId: "subject-b",
    });
    return { kit, seed, neighbor };
  }

  it("ctx.subjectId を付けなければ、別 subject の近傍もテナント全体から土台に入る", async () => {
    const { kit, seed, neighbor } = await setup();
    expect(await gatheredIds(kit, "reflect", ctx, { seedMemoryId: seed.id })).toEqual([
      seed.id,
      neighbor.id,
    ]);
  });

  it("ctx.subjectId を種と同じ subject にすれば、別 subject の近傍は入らない", async () => {
    const { kit, seed } = await setup();
    expect(
      await gatheredIds(
        kit,
        "reflect",
        { ...ctx, subjectId: "subject-a" },
        {
          seedMemoryId: seed.id,
        },
      ),
    ).toEqual([seed.id]);
  });

  it("ctx.subjectId を種と別の subject にすれば、探索はその subject の scope で行われる", async () => {
    const { kit, seed, neighbor } = await setup();
    expect(
      await gatheredIds(
        kit,
        "reflect",
        { ...ctx, subjectId: "subject-b" },
        {
          seedMemoryId: seed.id,
        },
      ),
    ).toEqual([seed.id, neighbor.id]);
  });
});

describe("tick の consolidate ジョブは、渡された ctx オブジェクトを書き換えない", () => {
  it("種の subjectId を呼び手の ctx に残さない", async () => {
    const kit = makeKit({ realClock: true });
    const { memory: seed } = await kit.stores.memoryStore.createMemoryWithOutbox(
      ctx,
      newMemory({ content: "seed content", digest: "seed", subjectId: "subject-a" }),
      ["consolidate"],
    );
    await kit.stores.vectorStore.upsert(ctx, kit.stores.embeddingProvider.space, seed.id, [4, 0]);

    const callerCtx: Ctx = { tenantId: ctx.tenantId };
    const tickResult = await kit.runtime.tick(callerCtx, {
      kinds: ["consolidate"],
      leaseMs: 60_000,
    });

    expect(tickResult).toEqual({ processed: 1, failed: 0, unsupported: [], leaseConflicts: [] });
    expect(callerCtx).toEqual({ tenantId: ctx.tenantId });
  });
});

describe("computeAffinity は similarity が NaN のとき、無いものとして扱う", () => {
  const rest = { decay: 1, tagMatch: 1, freshness: 1, strength: 1, total: 1 };

  it("lexicalMatch があればそれを返す", () => {
    expect(computeAffinity({ similarity: Number.NaN, lexicalMatch: 0.6, ...rest })).toBe(0.6);
  });

  it("lexicalMatch も無ければ、どんな有限の minAffinity にも届かない", () => {
    expect(computeAffinity({ similarity: Number.NaN, ...rest })).toBe(-Infinity);
  });
});

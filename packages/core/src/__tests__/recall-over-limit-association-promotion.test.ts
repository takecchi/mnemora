import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { Memory, NewMemory } from "../memory.js";
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

function buildRuntime() {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
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

async function createEmbeddedMemory(
  stores: ReturnType<typeof createFakeRuntimeStores>,
  vector: number[],
  overrides: Partial<NewMemory> = {},
): Promise<Memory> {
  const memory = await stores.memoryStore.createMemory(
    ctx,
    newMemory({ embeddingStatus: "ready", ...overrides }),
  );
  await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, memory.id, vector);
  return memory;
}

describe("recall() — over_limit(stage:'rescore') に数えられた候補が段3.5（連想）経由で finalMemories に昇格したときの排他性（Issue #925）", () => {
  it("(a) over_limit の唯一の候補が連想で拾い直されたときは over_limit(stage:'rescore') の Omission 自体が消える（Issue #925 の再現構成そのまま）", async () => {
    const { runtime, stores } = buildRuntime();

    const a = await createEmbeddedMemory(stores, [1, 0], { digest: "A" });
    const b = await createEmbeddedMemory(stores, [1, 0.001], { digest: "B" });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 1,
      overFetchFactor: 10,
    });

    expect(result.memories.length).toBe(2);
    const returnedA = result.memories.find((m) => m.memoryId === a.id);
    expect(returnedA).toBeDefined();
    expect(returnedA?.retrievedVia).toBe("ann");
    const returnedB = result.memories.find((m) => m.memoryId === b.id);
    expect(returnedB).toBeDefined();
    expect(returnedB?.retrievedVia).toBe("association");
    expect(returnedB?.associationOf).toBe(a.id);

    const overLimit = result.omitted.find((o) => o.kind === "over_limit" && o.stage === "rescore");
    expect(overLimit).toBeUndefined();
  });

  it("(b) over_limit に2件居て1件だけが連想で拾い直されたときは、count が1だけ減り Omission は残る", async () => {
    const { runtime, stores } = buildRuntime();

    const owner = await createEmbeddedMemory(stores, [1, 0, 0], { digest: "owner" });
    const mid = await createEmbeddedMemory(stores, [0.99, 0.1411, 0], { digest: "mid" });
    // far: 連想の minSimilarity に届かず、誰にも拾い直されない（陰性対照）。
    const far = await createEmbeddedMemory(stores, [0.3, 0.9539, 0], { digest: "far" });

    const result = await runtime.recall(ctx, {
      vector: [1, 0, 0],
      limit: 1,
      overFetchFactor: 10,
    });

    const returnedOwner = result.memories.find((m) => m.memoryId === owner.id);
    expect(returnedOwner).toBeDefined();
    const returnedMid = result.memories.find((m) => m.memoryId === mid.id);
    expect(returnedMid).toBeDefined();
    expect(returnedMid?.retrievedVia).toBe("association");
    expect(returnedMid?.associationOf).toBe(owner.id);
    const returnedFar = result.memories.find((m) => m.memoryId === far.id);
    expect(returnedFar).toBeUndefined();

    const overLimit = result.omitted.find((o) => o.kind === "over_limit" && o.stage === "rescore");
    expect(overLimit).toBeDefined();
    if (overLimit?.kind === "over_limit") {
      expect(overLimit.count).toBe(1);
    }
  });

  it("(c) over_limit に居なかった連想候補が返っても、無関係な over_limit(stage:'rescore') の count は減らない（過剰実装を捕まえる歯）", async () => {
    const { runtime, stores } = buildRuntime();

    const owner = await createEmbeddedMemory(stores, [0.5, 0.8660254, 0, 0], { digest: "owner" });
    // bystander: owner への類似度が低く連想に拾い直されない。この count はテストを通じて 1 のままでなければならない。
    const bystander = await createEmbeddedMemory(stores, [0.3, 0, 0.9539, 0], {
      digest: "bystander",
    });
    // associated: クエリへの類似度が閾値未満（below_threshold 側）で、over_limit に一度も居ないまま連想に拾われる。
    const associated = await createEmbeddedMemory(stores, [0.05, 0.9987, 0, 0], {
      digest: "associated",
    });

    const result = await runtime.recall(ctx, {
      vector: [1, 0, 0, 0],
      limit: 1,
      overFetchFactor: 10,
    });

    const returnedOwner = result.memories.find((m) => m.memoryId === owner.id);
    expect(returnedOwner).toBeDefined();
    const returnedAssociated = result.memories.find((m) => m.memoryId === associated.id);
    expect(returnedAssociated).toBeDefined();
    expect(returnedAssociated?.retrievedVia).toBe("association");
    expect(returnedAssociated?.associationOf).toBe(owner.id);
    const returnedBystander = result.memories.find((m) => m.memoryId === bystander.id);
    expect(returnedBystander).toBeUndefined();

    expect(result.omitted.some((o) => o.kind === "below_threshold")).toBe(false);

    const overLimit = result.omitted.find((o) => o.kind === "over_limit" && o.stage === "rescore");
    expect(overLimit).toBeDefined();
    if (overLimit?.kind === "over_limit") {
      expect(overLimit.count).toBe(1);
    }
  });
});

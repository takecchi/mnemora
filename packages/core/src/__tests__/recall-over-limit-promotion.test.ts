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

describe("recall() — over_limit(stage:'rescore') に数えられた候補が段3で finalMemories に昇格したときの排他性（Issue #823、ADR 0203「これが覆るとしたら」3番）", () => {
  it("companion が over_limit の唯一の候補で、丸ごと同伴取得に昇格したときは over_limit(stage:'rescore') の Omission 自体が消える", async () => {
    const { runtime, stores } = buildRuntime();

    const companion = await createEmbeddedMemory(stores, [1, 0.001], {
      status: "contested",
      digest: "companion",
    });
    const owner = await createEmbeddedMemory(stores, [1, 0], {
      status: "contested",
      contestedWithId: companion.id,
      digest: "owner",
    });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 1,
      overFetchFactor: 10,
      // association: null: 検査したいのは段2の over_limit と段3だけで、連想が同じ候補を拾い直すと混ざる。
      association: null,
    });

    const returnedCompanion = result.memories.find((m) => m.memoryId === companion.id);
    expect(returnedCompanion).toBeDefined();
    expect(returnedCompanion?.retrievedVia).toBe("mandatory_companion");
    const returnedOwner = result.memories.find((m) => m.memoryId === owner.id);
    expect(returnedOwner).toBeDefined();
    expect(result.memories.length).toBe(2); // owner + companion

    const overLimit = result.omitted.find((o) => o.kind === "over_limit" && o.stage === "rescore");
    expect(overLimit).toBeUndefined();
  });

  it("over_limit に2件居て1件だけが同伴取得で昇格したときは、count が1だけ減り Omission は残る", async () => {
    const { runtime, stores } = buildRuntime();

    const companion = await createEmbeddedMemory(stores, [0.99, 0.1411], {
      status: "contested",
      digest: "companion",
    });
    // `contestedWithId` は owner 側からだけ辿られる（ADR 0136）。
    const owner = await createEmbeddedMemory(stores, [1, 0], {
      status: "contested",
      contestedWithId: companion.id,
      digest: "owner",
    });
    // bystander は contested でもなく、誰にも同伴として拾われない（陰性対照）。
    const bystander = await createEmbeddedMemory(stores, [0.9, 0.436], {
      digest: "bystander",
    });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 1,
      overFetchFactor: 10,
      // association: null: 検査したいのは段2の over_limit と段3だけで、連想が同じ候補を拾い直すと混ざる。
      association: null,
    });

    const returnedOwner = result.memories.find((m) => m.memoryId === owner.id);
    expect(returnedOwner).toBeDefined();
    const returnedCompanion = result.memories.find((m) => m.memoryId === companion.id);
    expect(returnedCompanion).toBeDefined();
    expect(returnedCompanion?.retrievedVia).toBe("mandatory_companion");
    const returnedBystander = result.memories.find((m) => m.memoryId === bystander.id);
    expect(returnedBystander).toBeUndefined();

    const overLimit = result.omitted.find((o) => o.kind === "over_limit" && o.stage === "rescore");
    expect(overLimit).toBeDefined();
    if (overLimit?.kind === "over_limit") {
      expect(overLimit.count).toBe(1);
    }
  });

  it("同伴が over_limit ではなく below_threshold から昇格したときは、無関係な over_limit(stage:'rescore') の count は減らない（過剰実装を捕まえる歯）", async () => {
    const { runtime, stores } = buildRuntime();

    // companion は below_threshold に落ちるが、段3の必須同伴取得は閾値を見ずに `getMany` で取り直すので昇格する。
    const companion = await createEmbeddedMemory(stores, [0, 1], {
      status: "contested",
      digest: "companion",
    });
    const owner = await createEmbeddedMemory(stores, [1, 0], {
      status: "contested",
      contestedWithId: companion.id,
      digest: "owner",
    });
    // bystander は誰の同伴でもなく、この count は 1 のまま変わってはいけない。
    const bystander = await createEmbeddedMemory(stores, [0.99, 0.1411], {
      digest: "bystander",
    });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 1,
      overFetchFactor: 10,
      // association: null: 検査したいのは段2の over_limit と段3だけで、連想が同じ候補を拾い直すと混ざる。
      association: null,
    });

    const returnedOwner = result.memories.find((m) => m.memoryId === owner.id);
    expect(returnedOwner).toBeDefined();
    const returnedCompanion = result.memories.find((m) => m.memoryId === companion.id);
    expect(returnedCompanion).toBeDefined();
    expect(returnedCompanion?.retrievedVia).toBe("mandatory_companion");
    expect(result.omitted.some((o) => o.kind === "below_threshold")).toBe(false);

    // 「段3で返した同伴の数」を無条件に差し引く過剰実装だと、ここが誤って 0 になる。
    const returnedBystander = result.memories.find((m) => m.memoryId === bystander.id);
    expect(returnedBystander).toBeUndefined();
    const overLimit = result.omitted.find((o) => o.kind === "over_limit" && o.stage === "rescore");
    expect(overLimit).toBeDefined();
    if (overLimit?.kind === "over_limit") {
      expect(overLimit.count).toBe(1);
    }
  });
});

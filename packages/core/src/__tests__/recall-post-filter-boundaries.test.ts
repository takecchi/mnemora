import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { VectorStore } from "../interfaces/vector-store.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { Memory, NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";
import type { FakeVectorStore } from "./runtime-fakes.js";

const NOW = new Date("2026-06-01T00:00:00.000Z");
const ctx: Ctx = { tenantId: "tenant-1" };

function buildRuntime(opts: { vectorStoreOverride?: (fvs: FakeVectorStore) => VectorStore } = {}) {
  const stores = createFakeRuntimeStores();
  const vectorStore = opts.vectorStoreOverride
    ? opts.vectorStoreOverride(stores.vectorStore)
    : stores.vectorStore;
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
    clock: { now: () => NOW },
  });
  return { runtime, stores };
}

/** `search()` に渡る filter から、ゲートの欄（忘却・validAt）を剥がす。adapter が押し下げている限り後置フィルタの境界は外から見えないので、後置フィルタだけを通すために使う。 */
function stripGates(fvs: FakeVectorStore): VectorStore {
  const originalSearch = fvs.search.bind(fvs);
  fvs.search = async (c, space, query, opts) =>
    originalSearch(c, space, query, {
      ...opts,
      filter: {
        ...opts.filter,
        decayFloorAtAfter: undefined,
        decayFloorSeqAfter: undefined,
        decayFloorAnyAxis: undefined,
        validAt: undefined,
      },
    });
  return fvs;
}

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
    decayFloorAt:
      overrides.decayFloorAt ??
      defaultDecayStrategy.floorAt({ recordedAt, lastReinforcedAt: null, strength, halfLifeHours }),
    embeddingStatus: "pending",
    ...overrides,
  };
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

describe("recall() — 段1の後置フィルタの境界（ゲートを押し下げない adapter でも約束どおり）", () => {
  it("decayFloorAt がちょうど「いま」の記憶は返らず、1ミリ秒後なら返る", async () => {
    const { runtime, stores } = buildRuntime({ vectorStoreOverride: stripGates });
    const atNow = await createEmbeddedMemory(stores, [1, 0], { decayFloorAt: NOW });
    const justAfter = await createEmbeddedMemory(stores, [1, 0], {
      decayFloorAt: new Date(NOW.getTime() + 1),
    });

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 10, association: null });

    const ids = result.memories.map((m) => m.memoryId);
    expect(ids).not.toContain(atNow.id);
    expect(ids).toContain(justAfter.id);
  });

  it("validUntil がちょうど validAt の記憶は返らず、1ミリ秒後なら返る", async () => {
    const { runtime, stores } = buildRuntime({ vectorStoreOverride: stripGates });
    const endsAt = await createEmbeddedMemory(stores, [1, 0], { validUntil: NOW });
    const endsJustAfter = await createEmbeddedMemory(stores, [1, 0], {
      validUntil: new Date(NOW.getTime() + 1),
    });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      validAt: NOW,
      association: null,
    });

    const ids = result.memories.map((m) => m.memoryId);
    expect(ids).not.toContain(endsAt.id);
    expect(ids).toContain(endsJustAfter.id);
  });
});

describe("recall() — below_threshold の nearMisses は上位5件", () => {
  it("閾値未満が7件あれば count は7、nearMisses はちょうど5件", async () => {
    const { runtime, stores } = buildRuntime();
    for (let i = 0; i < 7; i += 1) {
      await createEmbeddedMemory(stores, [0, 1]);
    }

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      scoreThreshold: 0.5,
      association: null,
    });

    const below = result.omitted.find((o) => o.kind === "below_threshold");
    expect(below).toMatchObject({ kind: "below_threshold", count: 7 });
    expect(below && "nearMisses" in below ? below.nearMisses : undefined).toHaveLength(5);
  });
});

describe("recall() — 連想枠（段3.5）の境界と除外集合", () => {
  it("アンカーとの類似度がちょうど minSimilarity の候補は連想枠に入る", async () => {
    const { runtime, stores } = buildRuntime();
    const anchor = await createEmbeddedMemory(stores, [1, 0], { digest: "anchor" });
    const neighbor = await createEmbeddedMemory(stores, [1, 0], { digest: "neighbor" });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 1,
      association: { maxCount: 5, anchorCount: 1, minSimilarity: 1 },
    });

    const returnedIds = result.memories.map((m) => m.memoryId);
    const [anchorReturned] = returnedIds;
    const other = anchorReturned === anchor.id ? neighbor : anchor;
    expect(result.memories).toContainEqual(
      expect.objectContaining({ memoryId: other.id, retrievedVia: "association" }),
    );
  });

  it("段3で同伴として返る記憶は、連想枠がもう一度拾わない（memories の id は重複しない）", async () => {
    const { runtime, stores } = buildRuntime();
    const companion = await createEmbeddedMemory(stores, [0.8, 0.6], {
      digest: "companion",
      status: "contested",
    });
    const owner = await createEmbeddedMemory(stores, [1, 0], {
      digest: "owner",
      status: "contested",
      contestedWithId: companion.id,
    });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 1,
      association: { maxCount: 5, anchorCount: 1, minSimilarity: 0 },
    });

    const ids = result.memories.map((m) => m.memoryId);
    expect(ids).toContain(owner.id);
    expect(ids.filter((id) => id === companion.id)).toHaveLength(1);
    expect(new Set(ids).size).toBe(ids.length);
    // 連想枠が同伴を拾い直すと、連想側の単位の組み立てがそれを落として
    // `unit_assembly_dropped` に数える——返した記憶を「落ちた」と数えることになる
    // （ADR 0203 の排他性）。除外集合が効いていれば、この Omission は積まれない。
    expect(result.omitted.filter((o) => o.kind === "unit_assembly_dropped")).toEqual([]);
  });
});

describe("recall() — usage.budgetExceeded の境界", () => {
  it("返した digest の文字数がちょうど maxMemoryChars なら budgetExceeded は立たない", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0], { digest: "abc" });
    await createEmbeddedMemory(stores, [1, 0], { digest: "de" });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      budget: { maxMemoryChars: 5 },
      association: null,
    });

    expect(result.memories).toHaveLength(2);
    expect(result.usage.budgetExceeded ?? false).toBe(false);
  });
});

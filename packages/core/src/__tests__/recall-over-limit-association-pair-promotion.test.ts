import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { Memory, NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/** 2人目の入り方は2通り: 連想の枠が両方を選ぶ／1人目の対向を取り直す（2人目は連想の近傍に入らない）。単位の最初の1人だけを「戻った」と数える実装は、2人目を `over_limit` と `memories` の両方に名乗らせる。 */

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

describe("recall() — 連想が返した争われている記憶の対でも、over_limit(stage:'rescore') に数えた候補は2人とも取り下げられる", () => {
  it("(a) 連想の枠が対の両方を選んだとき", async () => {
    const { runtime, stores } = buildRuntime();

    const anchor = await createEmbeddedMemory(stores, [1, 0, 0], { digest: "anchor" });
    const y = await createEmbeddedMemory(stores, [0.98, 0.199, 0], {
      status: "contested",
      digest: "y",
    });
    const x = await createEmbeddedMemory(stores, [0.99, 0.141, 0], {
      status: "contested",
      contestedWithId: y.id,
      digest: "x",
    });

    const result = await runtime.recall(ctx, { vector: [1, 0, 0], limit: 1, overFetchFactor: 10 });

    const ids = result.memories.map((m) => m.memoryId);
    expect(ids).toContain(anchor.id);
    expect(ids).toContain(x.id);
    expect(ids).toContain(y.id);
    expect(result.memories.find((m) => m.memoryId === x.id)?.retrievedVia).toBe("association");
    expect(result.memories.find((m) => m.memoryId === y.id)?.retrievedVia).toBe("association");
    expect(
      result.omitted.find((o) => o.kind === "over_limit" && o.stage === "rescore"),
    ).toBeUndefined();
  });

  it("(b) 連想の枠が1人を選び、その対向を取り直したとき（対向は連想の近傍に入らない）", async () => {
    const { runtime, stores } = buildRuntime();

    const anchor = await createEmbeddedMemory(stores, [1, 0, 0], { digest: "anchor" });
    // counterpart: クエリへの類似度は閾値を超える（over_limit に数えられる）が、anchor への類似度は
    // 0.3 と低く、連想の minSimilarity（既定 0.5）に届かない。x の対向として取り直される。
    const counterpart = await createEmbeddedMemory(stores, [0.3, 0.9539, 0], {
      status: "contested",
      digest: "counterpart",
    });
    const x = await createEmbeddedMemory(stores, [0.99, 0.141, 0], {
      status: "contested",
      contestedWithId: counterpart.id,
      digest: "x",
    });

    const result = await runtime.recall(ctx, { vector: [1, 0, 0], limit: 1, overFetchFactor: 10 });

    const ids = result.memories.map((m) => m.memoryId);
    expect(ids).toContain(anchor.id);
    expect(ids).toContain(x.id);
    expect(ids).toContain(counterpart.id);
    expect(
      result.omitted.find((o) => o.kind === "over_limit" && o.stage === "rescore"),
    ).toBeUndefined();
  });
});

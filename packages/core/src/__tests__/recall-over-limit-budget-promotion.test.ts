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

describe("recall() — 段3/段3.5で戻った over_limit(stage:'rescore') の候補が段4の予算で改めて落ちたときの排他性（Issue #940）", () => {
  it("(a) 段3（必須の同伴取得）で戻った候補が段4の予算で落ちると、over_limit(rescore) は消え budget_dropped だけに数えられる", async () => {
    const { runtime, stores } = buildRuntime();

    const cand1 = await createEmbeddedMemory(stores, [1, 0], { digest: "C" });
    // `contestedWithId` は owner 側からだけ辿られる（ADR 0136）ので、companion 自身には設定しない。
    const companion = await createEmbeddedMemory(stores, [0.99, 0.1411], {
      status: "contested",
      digest: "COMPANION",
    });
    const owner = await createEmbeddedMemory(stores, [0.999, 0.0447], {
      status: "contested",
      contestedWithId: companion.id,
      digest: "OWNER",
    });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 2,
      overFetchFactor: 10,
      // 段3.5（連想、既定 on）を明示的に切る——本テストが検査したいのは段3と段4だけ。
      association: null,
      // 予算は cand1 の digest しか収まらない: owner+companion の単位は分割できない（docs/recall.md §8）ので丸ごと落ちる。
      budget: { maxMemoryChars: cand1.digest.length },
    });

    expect(result.memories.map((m) => m.memoryId)).toEqual([cand1.id]);
    expect(result.memories.some((m) => m.memoryId === owner.id)).toBe(false);
    expect(result.memories.some((m) => m.memoryId === companion.id)).toBe(false);

    const overLimit = result.omitted.find((o) => o.kind === "over_limit" && o.stage === "rescore");
    expect(overLimit).toBeUndefined();

    const budgetDropped = result.omitted.find((o) => o.kind === "budget_dropped");
    expect(budgetDropped).toBeDefined();
    if (budgetDropped?.kind === "budget_dropped") {
      expect(budgetDropped.count).toBe(2);
    }
  });

  it("(b) 段3.5（連想）で戻った候補が段4の予算で落ちると、over_limit(rescore) は消え budget_dropped だけに数えられる", async () => {
    const { runtime, stores } = buildRuntime();

    const cand1 = await createEmbeddedMemory(stores, [1, 0, 0], { digest: "C" });
    const owner = await createEmbeddedMemory(stores, [0.999, 0.0447, 0], { digest: "OWNER" });
    const b = await createEmbeddedMemory(stores, [0.99, 0.1411, 0], { digest: "B" });

    const result = await runtime.recall(ctx, {
      vector: [1, 0, 0],
      limit: 2,
      overFetchFactor: 10,
      // 連想枠は budget の内側で末尾に連結されるので真っ先に落ちる。
      budget: { maxMemoryChars: cand1.digest.length + owner.digest.length },
    });

    expect(result.memories.map((m) => m.memoryId).sort()).toEqual([cand1.id, owner.id].sort());
    expect(result.memories.some((m) => m.memoryId === b.id)).toBe(false);

    const overLimit = result.omitted.find((o) => o.kind === "over_limit" && o.stage === "rescore");
    expect(overLimit).toBeUndefined();

    const budgetDropped = result.omitted.find((o) => o.kind === "budget_dropped");
    expect(budgetDropped).toBeDefined();
    if (budgetDropped?.kind === "budget_dropped") {
      expect(budgetDropped.count).toBe(1);
    }
  });

  it("(c) 同伴取得/連想を経由していない over_limit のバイスタンダーが居るときは、その分の over_limit(rescore) が残る（過剰実装を捕まえる歯）", async () => {
    const { runtime, stores } = buildRuntime();

    const cand1 = await createEmbeddedMemory(stores, [1, 0], { digest: "C" });
    const companion = await createEmbeddedMemory(stores, [0.99, 0.1411], {
      status: "contested",
      digest: "COMPANION",
    });
    const owner = await createEmbeddedMemory(stores, [0.999, 0.0447], {
      status: "contested",
      contestedWithId: companion.id,
      digest: "OWNER",
    });
    // bystander は誰の同伴でも連想候補でもない（陰性対照）。
    const bystander = await createEmbeddedMemory(stores, [0.9, 0.436], {
      digest: "BYSTANDER",
    });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 2,
      overFetchFactor: 10,
      association: null,
      budget: { maxMemoryChars: cand1.digest.length },
    });

    expect(result.memories.map((m) => m.memoryId)).toEqual([cand1.id]);
    expect(result.memories.some((m) => m.memoryId === owner.id)).toBe(false);
    const returnedBystander = result.memories.find((m) => m.memoryId === bystander.id);
    expect(returnedBystander).toBeUndefined();

    // bystander は同伴取得にも連想にも触れていない: over_limit 全件を差し引く過剰実装だと、ここが誤って 0 になる。
    const overLimit = result.omitted.find((o) => o.kind === "over_limit" && o.stage === "rescore");
    expect(overLimit).toBeDefined();
    if (overLimit?.kind === "over_limit") {
      expect(overLimit.count).toBe(1);
    }

    const budgetDropped = result.omitted.find((o) => o.kind === "budget_dropped");
    expect(budgetDropped).toBeDefined();
    if (budgetDropped?.kind === "budget_dropped") {
      expect(budgetDropped.count).toBe(2);
    }
  });
});

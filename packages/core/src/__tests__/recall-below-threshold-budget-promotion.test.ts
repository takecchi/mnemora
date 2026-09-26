import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { Memory, NewMemory } from "../memory.js";
import type { RecallResult } from "../recall.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * Issue #950: 段2で `below_threshold` に数えられた候補が、段3（必須の同伴取得）または
 * 段3.5（連想）で候補集合に戻り、段4の予算で改めて落ちると、`below_threshold` と
 * `budget_dropped` の両方に数えられていた。
 *
 * ADR 0203 追記3（Issue #940）・追記4（Issue #949）の原則「1件の Memory は `omitted` の中で、
 * 最後にそれを落とした段で1回だけ数える」を `below_threshold` にも当てる——戻った候補は
 * `budget_dropped` 側に残し、`below_threshold` の `count` と `nearMisses` からは取り下げる。
 * 取り下げの作法（`count` を減らし、`nearMisses` から外し、0件なら Omission ごと外す）は
 * ADR 0203 決定5 と同じである。
 */

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

function belowThresholdOf(result: RecallResult) {
  return result.omitted.find((o) => o.kind === "below_threshold");
}
function budgetDroppedCount(result: RecallResult): number | undefined {
  const o = result.omitted.find((x) => x.kind === "budget_dropped");
  return o?.kind === "budget_dropped" ? o.count : undefined;
}

describe("recall() — 段3/段3.5で戻った below_threshold の候補が段4の予算で改めて落ちたときの排他性（Issue #950）", () => {
  it("(a) 段3（必須の同伴取得）で戻った候補が段4の予算で落ちると、below_threshold から外れ budget_dropped だけに数えられる", async () => {
    const { runtime, stores } = buildRuntime();

    const cand1 = await createEmbeddedMemory(stores, [1, 0], { digest: "C" });
    // クエリとの類似度 ≈0.05 ⟹ total が既定の scoreThreshold(0.1) を割り、段2で below_threshold。
    const companion = await createEmbeddedMemory(stores, [0.05, 0.9987], {
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
      association: null,
      budget: { maxMemoryChars: cand1.digest.length },
    });

    expect(result.memories.map((m) => m.memoryId)).toEqual([cand1.id]);
    const below = belowThresholdOf(result);
    if (below?.kind === "below_threshold") {
      expect(below.nearMisses?.some((n) => n.memoryId === companion.id)).toBe(false);
    }
    expect(below).toBeUndefined();
    expect(budgetDroppedCount(result)).toBe(2);
    expect(owner.id).toBeDefined();
  });

  it("(b) 段3.5（連想）で戻った候補が段4の予算で落ちると、below_threshold から外れ budget_dropped だけに数えられる", async () => {
    const { runtime, stores } = buildRuntime();

    const cand1 = await createEmbeddedMemory(stores, [1, 0, 0], { digest: "C" });
    // アンカーになる記憶（クエリとの類似度 0.6 で段2を通る）。
    const anchor = await createEmbeddedMemory(stores, [0.6, 0, 0.8], { digest: "ANCHOR" });
    // クエリとの類似度 ≈0.05 で段2は below_threshold。アンカーとの類似度 ≈0.83 で連想に拾われる。
    const b = await createEmbeddedMemory(stores, [0.05, 0, 0.9987], { digest: "BBBBBB" });

    const result = await runtime.recall(ctx, {
      vector: [1, 0, 0],
      limit: 2,
      overFetchFactor: 10,
      budget: { maxMemoryChars: cand1.digest.length + anchor.digest.length },
    });

    expect(result.memories.map((m) => m.memoryId).sort()).toEqual([cand1.id, anchor.id].sort());
    expect(result.memories.some((m) => m.memoryId === b.id)).toBe(false);
    expect(belowThresholdOf(result)).toBeUndefined();
    expect(budgetDroppedCount(result)).toBe(1);
  });

  it("(c) どの経路でも戻っていない below_threshold の候補は、そのまま below_threshold に残る（過剰実装を捕まえる歯）", async () => {
    const { runtime, stores } = buildRuntime();

    const cand1 = await createEmbeddedMemory(stores, [1, 0, 0], { digest: "C" });
    const anchor = await createEmbeddedMemory(stores, [0.6, 0, 0.8], { digest: "ANCHOR" });
    const b = await createEmbeddedMemory(stores, [0.05, 0, 0.9987], { digest: "BBBBBB" });
    // クエリとも、アンカーとも遠い（アンカーとの類似度 ≈0.03 < 0.5）。連想にも拾われない。
    const bystander = await createEmbeddedMemory(stores, [0.05, 0.9987, 0], {
      digest: "BYSTANDER",
    });

    const result = await runtime.recall(ctx, {
      vector: [1, 0, 0],
      limit: 2,
      overFetchFactor: 10,
      budget: { maxMemoryChars: cand1.digest.length + anchor.digest.length },
    });

    expect(result.memories.some((m) => m.memoryId === b.id)).toBe(false);
    expect(result.memories.some((m) => m.memoryId === bystander.id)).toBe(false);
    const below = belowThresholdOf(result);
    expect(below).toBeDefined();
    if (below?.kind === "below_threshold") {
      expect(below.count).toBe(1);
      expect(below.nearMisses?.map((n) => n.memoryId)).toEqual([bystander.id]);
    }
    expect(budgetDroppedCount(result)).toBe(1);
  });
});

import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { Memory, NewMemory } from "../memory.js";
import type { RecallResult } from "../recall.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * Issue #984: 段2で `below_threshold` に数えられた候補が、段3.5（連想）の候補プールに
 * 入ったが席（`maxCount`）に着けなかった場合、同じ1件が `below_threshold`（`nearMisses` にも
 * 載る）と `over_limit(stage:"association")` の両方に数えられていた。
 *
 * ADR 0203 追記4（Issue #949）が `over_limit(stage:"rescore")` について決めた処置を
 * `below_threshold` にも当てる——この経路の「最後の段」は段3.5 なので、
 * `over_limit(stage:"association")` 側に1回だけ残し、`below_threshold` の `count` と
 * `nearMisses` からは取り下げる（作法は ADR 0203「決めたこと」5 と同じ）。
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

function overLimitAssociationCount(result: RecallResult): number | undefined {
  const o = result.omitted.find((x) => x.kind === "over_limit" && x.stage === "association");
  return o?.kind === "over_limit" ? o.count : undefined;
}

describe("recall() — 段3.5 の候補プールで席に着けなかった below_threshold の候補の排他性（Issue #984）", () => {
  it("(a) 席を競り負けた below_threshold の候補は、below_threshold から外れ over_limit(association) だけに数えられる", async () => {
    const { runtime, stores } = buildRuntime();

    const cand1 = await createEmbeddedMemory(stores, [1, 0, 0], { digest: "C" });
    // アンカー（クエリとの類似度 0.6 で段2を通る）。
    const anchor = await createEmbeddedMemory(stores, [0.6, 0, 0.8], { digest: "ANCHOR" });
    // どちらもクエリとの類似度が低く段2で below_threshold。アンカーには近く、連想の土俵に上がる。
    const b1 = await createEmbeddedMemory(stores, [0.05, 0, 0.9987], { digest: "B1" });
    const b2 = await createEmbeddedMemory(stores, [0.04, 0.05, 0.9975], { digest: "B2" });

    const result = await runtime.recall(ctx, {
      vector: [1, 0, 0],
      limit: 2,
      overFetchFactor: 10,
      association: { maxCount: 1 },
    });

    const ids = result.memories.map((m) => m.memoryId);
    expect(ids.sort()).toEqual([cand1.id, anchor.id, b1.id].sort());
    expect(ids).not.toContain(b2.id);
    expect(belowThresholdOf(result)).toBeUndefined();
    expect(overLimitAssociationCount(result)).toBe(1);
  });

  it("(b) 連想の土俵に上がっていない below_threshold の候補は、そのまま below_threshold に残る（過剰実装を捕まえる歯）", async () => {
    const { runtime, stores } = buildRuntime();

    await createEmbeddedMemory(stores, [1, 0, 0], { digest: "C" });
    await createEmbeddedMemory(stores, [0.6, 0, 0.8], { digest: "ANCHOR" });
    await createEmbeddedMemory(stores, [0.05, 0, 0.9987], { digest: "B1" });
    await createEmbeddedMemory(stores, [0.04, 0.05, 0.9975], { digest: "B2" });
    // クエリともアンカーとも遠い（アンカーとの類似度 ≈0.03 < 0.5）。連想の土俵に上がらない。
    const bystander = await createEmbeddedMemory(stores, [0.05, 0.9987, 0], {
      digest: "BYSTANDER",
    });

    const result = await runtime.recall(ctx, {
      vector: [1, 0, 0],
      limit: 2,
      overFetchFactor: 10,
      association: { maxCount: 1 },
    });

    const below = belowThresholdOf(result);
    expect(below).toBeDefined();
    if (below?.kind === "below_threshold") {
      expect(below.count).toBe(1);
      expect(below.nearMisses?.map((n) => n.memoryId)).toEqual([bystander.id]);
    }
    expect(overLimitAssociationCount(result)).toBe(1);
  });
});

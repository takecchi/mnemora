import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { Memory, NewMemory } from "../memory.js";
import type { RecallResult } from "../recall.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * Issue #1026: 段2で `over_limit(stage:"rescore")`（または `below_threshold`）に数えた contested の
 * 候補を段3.5（連想枠）が席に着け、その後の必須の同伴取得（Issue #959）で対向が取れずに Unit ごと
 * 落ちると、同じ記憶が段2の札と `unit_assembly_dropped` の両方に数えられていた。
 * ADR 0203「決めたこと」1 と追記3〜8 の「最後に落とした段で1回だけ数える」を当て、段3.5 の
 * 組み立てで落ちた分は段2の札から差し引く。
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

function omittedCount(result: RecallResult, kind: string, stage?: string): number | undefined {
  const o = result.omitted.find(
    (x) => x.kind === kind && (stage === undefined || ("stage" in x && x.stage === stage)),
  );
  return o && "count" in o ? o.count : undefined;
}

describe("recall() — 段3.5 で席に着いた後に対向が取れず落ちた候補の排他性（Issue #1026）", () => {
  it("(a) over_limit(rescore) の候補が段3.5 の組み立てで落ちると、unit_assembly_dropped にだけ数える", async () => {
    const { runtime, stores } = buildRuntime();
    const x = await createEmbeddedMemory(stores, [0.8, 0.6, 0], { digest: "X" });
    // A はクエリとの類似度 0.6 で段2を通るが limit=1 の外（over_limit(rescore)）。X には近い。
    const a = await createEmbeddedMemory(stores, [0.6, 0.8, 0], { digest: "A" });
    const b = await createEmbeddedMemory(stores, [0, 0, 1], { digest: "B" });
    expect((await runtime.markContested(ctx, a.id, b.id)).outcome.kind).toBe("contested");
    await runtime.forget(ctx, { memoryId: b.id });

    const result = await runtime.recall(ctx, {
      vector: [1, 0, 0],
      limit: 1,
      association: { maxCount: 1 },
    });

    expect(result.memories.map((m) => m.memoryId)).toEqual([x.id]);
    expect(omittedCount(result, "unit_assembly_dropped")).toBe(1);
    expect(omittedCount(result, "over_limit", "rescore")).toBeUndefined();
  });

  it("(b) below_threshold の候補が段3.5 の組み立てで落ちると、unit_assembly_dropped にだけ数える", async () => {
    const { runtime, stores } = buildRuntime();
    const x = await createEmbeddedMemory(stores, [0.8, 0.6, 0], { digest: "X" });
    // A はクエリとの類似度 0.05 で below_threshold。X との類似度は約 0.64 で連想に拾われる。
    const a = await createEmbeddedMemory(stores, [0.05, 0.9987, 0], { digest: "A" });
    const b = await createEmbeddedMemory(stores, [0, 0, 1], { digest: "B" });
    expect((await runtime.markContested(ctx, a.id, b.id)).outcome.kind).toBe("contested");
    await runtime.forget(ctx, { memoryId: b.id });

    const result = await runtime.recall(ctx, {
      vector: [1, 0, 0],
      limit: 1,
      association: { maxCount: 1 },
    });

    expect(result.memories.map((m) => m.memoryId)).toEqual([x.id]);
    expect(omittedCount(result, "unit_assembly_dropped")).toBe(1);
    expect(omittedCount(result, "below_threshold")).toBeUndefined();
  });

  it("(c) 連想枠に拾われなかった over_limit(rescore) の候補は残る（過剰実装を捕まえる歯）", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [0.8, 0.6, 0], { digest: "X" });
    const a = await createEmbeddedMemory(stores, [0.6, 0.8, 0], { digest: "A" });
    const b = await createEmbeddedMemory(stores, [0, 0, 1], { digest: "B" });
    expect((await runtime.markContested(ctx, a.id, b.id)).outcome.kind).toBe("contested");
    await runtime.forget(ctx, { memoryId: b.id });
    // C はクエリとの類似度 0.7 で over_limit(rescore)。X との類似度は約 0.13 で連想に拾われない。
    await createEmbeddedMemory(stores, [0.7, -0.71, 0], { digest: "C" });

    const result = await runtime.recall(ctx, {
      vector: [1, 0, 0],
      limit: 1,
      association: { maxCount: 1 },
    });

    expect(omittedCount(result, "unit_assembly_dropped")).toBe(1);
    expect(omittedCount(result, "over_limit", "rescore")).toBe(1);
  });
});

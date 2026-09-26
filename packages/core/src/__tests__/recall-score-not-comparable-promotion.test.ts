import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { Memory, NewMemory } from "../memory.js";
import type { RecallResult } from "../recall.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * 段2で `score_not_comparable`（total が NaN。ゼロベクトルの埋め込みなど、ADR 0040/0044）に
 * 数えられた候補が、段3（必須の同伴取得）や段3.5（連想）で候補集合に戻ると、同じ記憶が
 * `memories`（または段4の `budget_dropped`）と `score_not_comparable` の両方に数えられていた。
 *
 * ADR 0203「決めたこと」1（`omitted` は返さなかった記憶の集合）と、追記3〜6 の「1件の Memory は
 * `omitted` の中で、最後にそれを落とした段で1回だけ数える」を `score_not_comparable` にも当てる。
 * 段2の内部状態（`partition.notComparable`）は memoryId を持つので、below_threshold と同じ形で
 * 突き合わせられる。
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

function sncCount(result: RecallResult): number | undefined {
  const o = result.omitted.find((x) => x.kind === "score_not_comparable");
  return o?.kind === "score_not_comparable" ? o.count : undefined;
}
function budgetDroppedCount(result: RecallResult): number | undefined {
  const o = result.omitted.find((x) => x.kind === "budget_dropped");
  return o?.kind === "budget_dropped" ? o.count : undefined;
}

describe("recall() — 段2で score_not_comparable に数えた候補が後の段で戻ったときの排他性", () => {
  it("(a) 段3の必須同伴取得で返ったゼロベクトルの記憶は、score_not_comparable に数えない", async () => {
    const { runtime, stores } = buildRuntime();
    const a = await createEmbeddedMemory(stores, [1, 0], { digest: "A" });
    const b = await createEmbeddedMemory(stores, [0, 0], { digest: "B" });
    expect((await runtime.markContested(ctx, a.id, b.id)).outcome.kind).toBe("contested");

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 5, association: null });

    const byId = new Map(result.memories.map((m) => [m.memoryId, m]));
    expect(byId.get(b.id)?.retrievedVia).toBe("mandatory_companion");
    expect(sncCount(result)).toBeUndefined();
  });

  it("(b) 段3で戻ったゼロベクトルの記憶が段4の予算で落ちると、budget_dropped にだけ数える", async () => {
    const { runtime, stores } = buildRuntime();
    const c = await createEmbeddedMemory(stores, [1, 0], { digest: "C" });
    const a = await createEmbeddedMemory(stores, [0.95, 0.31], { digest: "AAAA" });
    const b = await createEmbeddedMemory(stores, [0, 0], { digest: "BBBB" });
    expect((await runtime.markContested(ctx, a.id, b.id)).outcome.kind).toBe("contested");

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 5,
      association: null,
      budget: { maxMemoryChars: c.digest.length },
    });

    expect(result.memories.map((m) => m.memoryId)).toEqual([c.id]);
    expect(budgetDroppedCount(result)).toBe(2);
    expect(sncCount(result)).toBeUndefined();
  });

  it("(c) どの経路でも戻っていないゼロベクトルの記憶は、score_not_comparable に残る（過剰実装を捕まえる歯）", async () => {
    const { runtime, stores } = buildRuntime();
    const a = await createEmbeddedMemory(stores, [1, 0], { digest: "A" });
    const b = await createEmbeddedMemory(stores, [0, 0], { digest: "B" });
    expect((await runtime.markContested(ctx, a.id, b.id)).outcome.kind).toBe("contested");
    await createEmbeddedMemory(stores, [0, 0], { digest: "D" });

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 5, association: null });

    expect(sncCount(result)).toBe(1);
  });
});

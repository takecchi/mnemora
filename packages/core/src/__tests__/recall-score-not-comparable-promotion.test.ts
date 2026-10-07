import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { Memory, NewMemory } from "../memory.js";
import type { RecallResult } from "../recall.js";
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

function buildRuntimeWithRelations() {
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
    relationStore: stores.relationStore,
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

  it("(d) 段3.5 の連想で戻った比較不能の記憶が段4の予算で落ちると、budget_dropped にだけ数える", async () => {
    const { runtime, stores } = buildRuntime();
    const a = await createEmbeddedMemory(stores, [1, 0], { digest: "AAAA" });
    // halfLifeHours: 0 で total が NaN になる（段2で score_not_comparable）。ベクトルは A と同じなので、
    // 連想（既定 on）が A のアンカーから拾い直す。
    await createEmbeddedMemory(stores, [1, 0], { digest: "XXXX", halfLifeHours: 0 });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 5,
      scoreThreshold: 0,
      includeFullyDecayed: true,
      budget: { maxMemoryChars: a.digest.length },
    });

    expect(result.memories.map((m) => m.memoryId)).toEqual([a.id]);
    expect(budgetDroppedCount(result)).toBe(1);
    expect(sncCount(result)).toBeUndefined();
  });

  it("(e) 段3.5 の組み立てで対向が取れず落ちた比較不能の記憶は、unit_assembly_dropped にだけ数える", async () => {
    const { runtime, stores } = buildRuntime();
    const x = await createEmbeddedMemory(stores, [1, 0, 0], { digest: "X" });
    const b = await createEmbeddedMemory(stores, [0, 0, 1], { digest: "B" });
    // halfLifeHours: 0 は出力の契約（`markContested` の戻り値の検査）を通らないので、contested の
    // 組は store へ直に書く。
    await createEmbeddedMemory(stores, [0.8, 0.6, 0], {
      digest: "A",
      halfLifeHours: 0,
      status: "contested",
      contestedWithId: b.id,
    });
    await runtime.forget(ctx, { memoryId: b.id });

    const result = await runtime.recall(ctx, {
      vector: [1, 0, 0],
      limit: 1,
      scoreThreshold: 0,
      includeFullyDecayed: true,
    });

    expect(result.memories.map((m) => m.memoryId)).toEqual([x.id]);
    const dropped = result.omitted.find((o) => o.kind === "unit_assembly_dropped");
    expect(dropped?.kind === "unit_assembly_dropped" ? dropped.count : undefined).toBe(1);
    expect(sncCount(result)).toBeUndefined();
  });

  it("(f) 多者間の群の上限（relationMaxCount）で切られた比較不能の記憶は、over_limit(relation) にだけ数える", async () => {
    const { runtime, stores } = buildRuntimeWithRelations();
    const owner = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ digest: "owner", validFrom: new Date(Date.UTC(2020, 0, 1)), validUntil: null }),
    );
    const z = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ digest: "Z", validFrom: new Date(Date.UTC(2020, 0, 2)), validUntil: null }),
    );
    const m1 = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ digest: "M1", validFrom: new Date(Date.UTC(2020, 0, 3)), validUntil: null }),
    );
    await runtime.markContestedGroup!(ctx, [owner.id, z.id, m1.id]);
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, owner.id, [1, 0]);
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, z.id, [0, 0]);

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 5, relationMaxCount: 1 });

    expect(result.memories.map((m) => m.memoryId).sort()).toEqual([owner.id, m1.id].sort());
    expect(result.omitted).toContainEqual({
      kind: "over_limit",
      stage: "relation",
      count: 1,
      countKind: "exact",
    });
    expect(sncCount(result)).toBeUndefined();
  });

  it("(g) 比較不能の記憶が2件同時に戻ったときは、戻った件数ぶん差し引き、戻っていない1件だけが残る", async () => {
    const { runtime, stores } = buildRuntimeWithRelations();
    const owner = await createEmbeddedMemory(stores, [1, 0], { digest: "owner" });
    const z1 = await createEmbeddedMemory(stores, [0, 0], { digest: "Z1" });
    const z2 = await createEmbeddedMemory(stores, [0, 0], { digest: "Z2" });
    await runtime.markContestedGroup!(ctx, [owner.id, z1.id, z2.id]);
    // d は群に居ないゼロベクトルで、どこからも戻らない。
    await createEmbeddedMemory(stores, [0, 0], { digest: "D" });

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 5, association: null });

    expect(result.memories.map((m) => m.memoryId).sort()).toEqual([owner.id, z1.id, z2.id].sort());
    expect(sncCount(result)).toBe(1);
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

  it("(h) 差し引いたあとの score_not_comparable は、件数だけが減り countKind は exact のまま残る", async () => {
    const { runtime, stores } = buildRuntime();
    const a = await createEmbeddedMemory(stores, [1, 0], { digest: "A" });
    const b = await createEmbeddedMemory(stores, [0, 0], { digest: "B" });
    expect((await runtime.markContested(ctx, a.id, b.id)).outcome.kind).toBe("contested");
    await createEmbeddedMemory(stores, [0, 0], { digest: "D" });

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 5, association: null });

    expect(result.omitted).toContainEqual({
      kind: "score_not_comparable",
      count: 1,
      countKind: "exact",
    });
  });

  it("(i) 段3.5 で席に着けなかった比較不能の記憶は、over_limit(association) にだけ数える", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0], { digest: "AAAA" });
    await createEmbeddedMemory(stores, [1, 0], { digest: "XXXX" });
    // N は halfLifeHours: 0 で total が NaN（段2で score_not_comparable）。比較不能は席順で最後尾に
    // 送られるので、maxCount: 1 では X が席を取り、N が席に着けない。
    await createEmbeddedMemory(stores, [1, 0], { digest: "NNNN", halfLifeHours: 0 });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 1,
      scoreThreshold: 0,
      includeFullyDecayed: true,
      association: { maxCount: 1 },
    });

    expect(result.omitted).toContainEqual({
      kind: "over_limit",
      stage: "association",
      count: 1,
      countKind: "exact",
    });
    expect(sncCount(result)).toBeUndefined();
  });
});

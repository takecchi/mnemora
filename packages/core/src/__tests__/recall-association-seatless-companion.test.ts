import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { Memory, NewMemory } from "../memory.js";
import type { RecallResult } from "../recall.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * Issue #1020: 段3.5（連想枠）で席（`maxCount`）を競り負けて `over_limit(stage:"association")` に
 * 数えた候補が、同じ段3.5 の必須の同伴取得（Issue #959）で対向として取られると、
 * `memories`（または段4の `budget_dropped`）と `over_limit(stage:"association")` の両方に
 * 数えられていた。ADR 0203「決めたこと」1 と追記3〜6 の「最後に落とした段で1回だけ数える」を当て、
 * 段3.5 の Unit に入った分は `over_limit(stage:"association")` から差し引く。
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

function overLimitAssociationCount(result: RecallResult): number | undefined {
  const o = result.omitted.find((x) => x.kind === "over_limit" && x.stage === "association");
  return o?.kind === "over_limit" ? o.count : undefined;
}

function budgetDroppedCount(result: RecallResult): number | undefined {
  const o = result.omitted.find((x) => x.kind === "budget_dropped");
  return o?.kind === "budget_dropped" ? o.count : undefined;
}

describe("recall() — 段3.5 で席に着けなかった候補が同伴として返ったときの排他性（Issue #1020）", () => {
  async function setup() {
    const { runtime, stores } = buildRuntime();
    // X だけが limit=1 の内側に入り、連想のアンカーになる。
    const x = await createEmbeddedMemory(stores, [0.8, 0.6, 0], { digest: "X" });
    // A・B は X の近くにある contested の組。A が席に着き、B は席を競り負ける。
    const a = await createEmbeddedMemory(stores, [0.6, 0.8, 0], { digest: "AAAA" });
    const b = await createEmbeddedMemory(stores, [0.55, 0.835, 0], { digest: "BBBB" });
    expect((await runtime.markContested(ctx, a.id, b.id)).outcome.kind).toBe("contested");
    return { runtime, stores, x, a, b };
  }

  it("(a) 席を競り負けた候補が同伴として返ると、over_limit(association) に数えない", async () => {
    const { runtime, x, a, b } = await setup();
    const result = await runtime.recall(ctx, {
      vector: [1, 0, 0],
      limit: 1,
      association: { maxCount: 1 },
    });
    const byId = new Map(result.memories.map((m) => [m.memoryId, m]));
    expect(byId.has(x.id)).toBe(true);
    expect(byId.get(a.id)?.retrievedVia).toBe("association");
    expect(byId.get(b.id)?.retrievedVia).toBe("mandatory_companion");
    expect(overLimitAssociationCount(result)).toBeUndefined();
  });

  it("(b) 同伴として取られた後に予算で落ちると、budget_dropped にだけ数える", async () => {
    const { runtime, x } = await setup();
    const result = await runtime.recall(ctx, {
      vector: [1, 0, 0],
      limit: 1,
      association: { maxCount: 1 },
      budget: { maxMemoryChars: x.digest.length },
    });
    expect(result.memories.map((m) => m.memoryId)).toEqual([x.id]);
    expect(budgetDroppedCount(result)).toBe(2);
    expect(overLimitAssociationCount(result)).toBeUndefined();
  });

  it("(c) 同伴として取られていない、席を競り負けただけの候補は over_limit(association) に残る（過剰実装を捕まえる歯）", async () => {
    const { runtime, stores } = await setup();
    await createEmbeddedMemory(stores, [0.5, 0.866, 0], { digest: "C" });
    const result = await runtime.recall(ctx, {
      vector: [1, 0, 0],
      limit: 1,
      association: { maxCount: 1 },
    });
    expect(overLimitAssociationCount(result)).toBe(1);
  });
});

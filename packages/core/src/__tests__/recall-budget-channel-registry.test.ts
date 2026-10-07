import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { Memory, NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * `BUDGET_CHANNEL_REGISTRY` はこのテストファイル自身が持つ（`packages/core` 本体には置かない: 本体の変更ではなく検査側の意見のため）。
 * `@mnemora/testkit` には依存しない（`runtime-fakes.ts` 冒頭と同じ理由）。
 */

type BudgetSide = "inside_budget" | "outside_budget";

const BUDGET_CHANNEL_REGISTRY: Record<string, BudgetSide> = {
  full: "inside_budget",
  digest: "inside_budget",
  index: "outside_budget",
  association: "inside_budget",
};

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

function assertKnownChannels(byTier: Record<string, unknown>): void {
  for (const key of Object.keys(byTier)) {
    expect(
      key in BUDGET_CHANNEL_REGISTRY,
      `usage.byTier に登録表が知らないキー "${key}" が現れた。` +
        "新しいチャンネルを足したなら、BUDGET_CHANNEL_REGISTRY に " +
        "'inside_budget'/'outside_budget' のどちらかとして追加すること " +
        "（Issue #306, recall-budget-channel-registry.test.ts）。",
    ).toBe(true);
  }
}

describe("recall() — usage.byTier のチャンネル登録表（Issue #306 受け入れ条件2）", () => {
  it("byTier に登録表が知らないキーが現れない（association 無し）", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0], { digest: "本文A" });

    const result = await runtime.recall(ctx, { vector: [1, 0] });

    assertKnownChannels(result.usage.byTier);
  });

  it("byTier に登録表が知らないキーが現れない（association 込み）", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [0.70710678, 0.70710678], { digest: "アンカー" });
    await createEmbeddedMemory(stores, [0, 1], { digest: "連想本文" });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      association: { maxCount: 5, anchorCount: 1 },
    });

    assertKnownChannels(result.usage.byTier);
    // 前提: このテストが実際に association チャンネルを駆動できていること
    // （駆動できていなければ、上の assertKnownChannels は association キーを
    // 一度も見ないまま素通りする無意味な緑になる）。
    expect(result.usage.byTier.association).toBeGreaterThan(0);
  });

  it("inside_budget と宣言した digest チャンネルは、きつい予算で実際に落ちる", async () => {
    const { runtime, stores } = buildRuntime();
    expect(BUDGET_CHANNEL_REGISTRY.digest).toBe("inside_budget");

    await createEmbeddedMemory(stores, [1, 0], { digest: "AAAAA" }); // 5 chars
    await createEmbeddedMemory(stores, [0.99, 0.1411], { digest: "BBBBB" }); // 5 chars

    const withoutBudget = await runtime.recall(ctx, { vector: [1, 0] });
    const withBudget = await runtime.recall(ctx, {
      vector: [1, 0],
      budget: { maxMemoryChars: 5 },
    });

    expect(withoutBudget.usage.byTier.digest).toBe(10);
    expect(withBudget.usage.byTier.digest).toBeLessThan(withoutBudget.usage.byTier.digest);
    expect(withBudget.omitted).toContainEqual({
      kind: "budget_dropped",
      count: 1,
      countKind: "exact",
    });
  });

  it("inside_budget と宣言した association チャンネルは、きつい予算で実際に落ちる", async () => {
    const { runtime, stores } = buildRuntime();
    expect(BUDGET_CHANNEL_REGISTRY.association).toBe("inside_budget");

    const anchor = await createEmbeddedMemory(stores, [0.70710678, 0.70710678], {
      digest: "AAAAA", // 5 chars
    });
    const associated = await createEmbeddedMemory(stores, [0, 1], {
      digest: "BBBBB", // 5 chars
    });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      association: { maxCount: 5, anchorCount: 1 },
      budget: { maxMemoryChars: 5 }, // アンカー分だけは入るが、連想分は入らない
    });

    const memoryIds = result.memories.map((m) => m.memoryId);
    expect(memoryIds).toContain(anchor.id);
    expect(memoryIds).not.toContain(associated.id);
    expect(result.omitted).toContainEqual({
      kind: "budget_dropped",
      count: 1,
      countKind: "exact",
    });
  });

  it("引き受けた負債: inside_budget と宣言した full チャンネルは、常に0で駆動する経路が無い", () => {
    // full は現在の実装では usage.byTier.full が常に 0（recall-runtime.ts のプレースホルダ）
    // であり、「きつい予算で実際に落ちる」ことを検査できる入力を作れない。この歯は
    // その事実そのものを記録する（検査していないことを、検査していないと書く）。
    expect(BUDGET_CHANNEL_REGISTRY.full).toBe("inside_budget");
  });

  /**
   * `index` の「予算の対象外」は「何も変わらない」という意味ではない: 段4で落ちた候補は目次帯（digest 帯）側に回るので、
   * budget を締めると digest 帯はむしろ増えうる。変わらないのは、段4より手前で確定する scope（`totalInScope`/`groups`）である。
   */
  it("outside_budget と宣言した index の第3階（groups/totalInScope）は、きつい予算でも変わらない（docs/recall.md §5・§6）", async () => {
    const { runtime, stores } = buildRuntime();
    expect(BUDGET_CHANNEL_REGISTRY.index).toBe("outside_budget");

    for (let i = 0; i < 5; i += 1) {
      await createEmbeddedMemory(stores, [1, 0], { digest: `候補${i}` });
    }

    const withoutBudget = await runtime.recall(ctx, { vector: [1, 0], limit: 10 });
    const withBudget = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      budget: { maxMemoryChars: 1 }, // ほぼ全件を memories から押し出すほど厳しい
    });

    // 前提: budget が実際に何かを押し出していること（押し出していなければ、以下の
    // 「それでも変わらない」は budget が何もしていない無意味な緑になる）。
    expect(withBudget.omitted.some((o) => o.kind === "budget_dropped")).toBe(true);
    expect(withBudget.memories.length).toBeLessThan(withoutBudget.memories.length);

    expect(withBudget.index.totalInScope).toBe(withoutBudget.index.totalInScope);
    expect(withBudget.index.groups).toEqual(withoutBudget.index.groups);
  });
});

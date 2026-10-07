import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { MemoryId } from "../ids.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import type { NewMemory } from "../memory.js";
import { createRuntime, groupSupersededCandidatesByOperation } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * 09/17 にマージされた #464（`Runtime.restoreSuperseded`）・#524（その `dryRun`）の
 * 確かめ直し（Issue #1812、まとまり G1）で、既存の試験の外に残っていた約束の歯。
 *
 * - 省略したときの `actor` は `{ type: "system" }`（`RestoreSupersededOptions.actor` の doc）。
 *   既存の試験は名前に「省略時は system」と書くが、`actor` を渡した場合しか確かめていない。
 * - `outcomes` の順序は、store が返した `restored` の順をそのまま引き継ぐ
 *   （`RestoreSupersededResult.outcomes` の doc）。束ねた強化の経路でも、1件ずつへ戻った経路でも。
 * - `dryRun: true` は「一切の書き込み（`memories` の `UPDATE`・`memory_events` への `INSERT`・
 *   `reinforce`）を行わない」（`RestoreSupersededOptions.dryRun` の doc）。
 *   `reinforce` を呼ばないことと、置き換えた側・候補のどの欄も動かないことを見る。
 * - `groupSupersededCandidatesByOperation` は `supersededReason` を自由文としてそのまま運ぶ。
 *   空文字は `null` と別の値であり、同じグループにしない。
 */

const ctx: Ctx = { tenantId: "tenant-1" };
const NOW = new Date("2026-06-01T00:00:00.000Z");

const llm: LLMProvider = {
  complete: async () => ({ content: "unused" }),
  completeStructured: async (_ctx, req) => req.schema.parse({ content: "統合した本文" }),
};

let counter = 0;
function newMemory(): NewMemory {
  counter += 1;
  return {
    tenantId: ctx.tenantId,
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: `本文${counter}`,
    contentHash: `restore-superseded-recheck-0917-${counter}`,
    digest: `要旨${counter}`,
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: [],
    occurredAt: null,
    recordedAt: NOW,
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 720,
    decayFloorAt: new Date("2027-01-01T00:00:00.000Z"),
    embeddingStatus: "pending",
  };
}

async function setUpGroup(size: number) {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: llm,
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => NOW },
  });
  const ids: MemoryId[] = [];
  for (let i = 0; i < size; i += 1) {
    ids.push((await stores.memoryStore.createMemory(ctx, newMemory())).id);
  }
  const consolidated = await runtime.consolidate(ctx, { target: { memoryIds: ids } });
  return { stores, runtime, ids, supersededById: consolidated.consolidatedMemoryId! };
}

describe("restoreSuperseded（09/17 確かめ直し G1）— actor の既定", () => {
  it("opts.actor を省くと、積む unsuperseded イベントの actor は { type: 'system' }", async () => {
    const { stores, runtime, ids, supersededById } = await setUpGroup(2);

    await runtime.restoreSuperseded(ctx, { supersededById });

    const events = stores.eventStore.events.filter((e) => e.kind === "unsuperseded");
    expect(events.map((e) => e.memoryId).sort()).toEqual([...ids].sort());
    for (const event of events) {
      expect(event.actor).toEqual({ type: "system" });
    }
  });
});

describe("restoreSuperseded（09/17 確かめ直し G1）— outcomes の順序は store の restored のまま", () => {
  it("束ねた強化が成功する経路: store が返した順の逆でも、outcomes はその順のまま", async () => {
    const { stores, runtime, supersededById } = await setUpGroup(4);
    const original = stores.memoryStore.restoreSupersededBy!.bind(stores.memoryStore);
    let storeOrder: MemoryId[] = [];
    stores.memoryStore.restoreSupersededBy = async (c, id, event, filter) => {
      const result = await original(c, id, event, filter);
      const restored = [...result.restored].reverse();
      storeOrder = restored.map((m) => m.id);
      return { restored };
    };

    const result = await runtime.restoreSuperseded(ctx, { supersededById });

    expect(storeOrder).toHaveLength(4);
    expect(result.outcomes.map((o) => o.memoryId)).toEqual(storeOrder);
  });

  it("束ねた強化が失敗して1件ずつへ戻る経路でも、outcomes は store が返した順のまま", async () => {
    const { stores, runtime, supersededById } = await setUpGroup(4);
    const original = stores.memoryStore.restoreSupersededBy!.bind(stores.memoryStore);
    let storeOrder: MemoryId[] = [];
    stores.memoryStore.restoreSupersededBy = async (c, id, event, filter) => {
      const result = await original(c, id, event, filter);
      const restored = [...result.restored].reverse();
      storeOrder = restored.map((m) => m.id);
      return { restored };
    };
    stores.memoryStore.reinforceMany = async () => {
      throw new Error("simulated reinforceMany failure");
    };

    const result = await runtime.restoreSuperseded(ctx, { supersededById });

    expect(storeOrder).toHaveLength(4);
    expect(result.outcomes.map((o) => o.memoryId)).toEqual(storeOrder);
  });
});

describe("restoreSuperseded（09/17 確かめ直し G1）— dryRun は reinforce も含めて何も書かない", () => {
  it("dryRun: true は reinforce・reinforceMany を1回も呼ばず、置き換えた側・候補のどの欄も動かない", async () => {
    const { stores, runtime, ids, supersededById } = await setUpGroup(3);
    const watched = [supersededById, ...ids];
    const snapshot = async () =>
      JSON.stringify(await Promise.all(watched.map((id) => stores.memoryStore.get(ctx, id))));
    const before = await snapshot();
    const eventsBefore = stores.eventStore.events.length;

    let reinforceCalls = 0;
    const originalReinforce = stores.memoryStore.reinforce.bind(stores.memoryStore);
    stores.memoryStore.reinforce = async (...args) => {
      reinforceCalls += 1;
      return originalReinforce(...args);
    };
    const originalMany = stores.memoryStore.reinforceMany.bind(stores.memoryStore);
    stores.memoryStore.reinforceMany = async (...args) => {
      reinforceCalls += 1;
      return originalMany(...args);
    };

    const preview = await runtime.restoreSuperseded(ctx, { supersededById }, { dryRun: true });

    expect(preview.outcomes).toHaveLength(3);
    expect(reinforceCalls).toBe(0);
    expect(await snapshot()).toBe(before);
    expect(stores.eventStore.events).toHaveLength(eventsBefore);
  });
});

describe("groupSupersededCandidatesByOperation（09/17 確かめ直し G1）— 空文字の reason", () => {
  it("空文字の reason は自由文としてそのまま運び、null と同じグループにしない", () => {
    const groups = groupSupersededCandidatesByOperation([
      { memoryId: "mem-1" as MemoryId, supersededReason: "" },
      { memoryId: "mem-2" as MemoryId, supersededReason: null },
      { memoryId: "mem-3" as MemoryId, supersededReason: "" },
    ]);

    expect(groups).toEqual([
      { supersededReason: "", memoryIds: ["mem-1", "mem-3"], boundaryConfidence: "unknown" },
      { supersededReason: null, memoryIds: ["mem-2"], boundaryConfidence: "unknown" },
    ]);
  });
});

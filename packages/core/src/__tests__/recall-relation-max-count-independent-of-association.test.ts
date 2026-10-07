import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { MemoryId } from "../ids.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import type { NewMemory } from "../memory.js";
import type { RecallQuery } from "../recall.js";
import { createRuntime } from "../runtime.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/** `relationMaxCount` を省略したとき群ごとの上限は既定の10で、`association.maxCount` には従わない。`association` を渡さない recall だけでは、省略時の既定を差し替えても赤にならない。逆向き（`relationMaxCount` を指定しても連想枠の件数が変わらない）は縛っていない。 */
const ctx: Ctx = { tenantId: "tenant-relation-vs-association" };
const NOW = new Date("2026-06-01T00:00:00.000Z");

function newMemory(i: number): NewMemory {
  const halfLifeHours = 24 * 365 * 10;
  return {
    tenantId: ctx.tenantId,
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: "本文",
    contentHash: `hash-${Math.random()}`,
    digest: `m${String(i).padStart(3, "0")}`,
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: [],
    occurredAt: null,
    recordedAt: NOW,
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours,
    decayFloorAt: defaultDecayStrategy.floorAt({
      recordedAt: NOW,
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours,
    }),
    embeddingStatus: "pending",
    validFrom: new Date(Date.UTC(2020, 0, 1 + i)),
    validUntil: null,
  };
}

const notUsedLlm: LLMProvider = {
  complete: async () => {
    throw new Error("not used");
  },
  completeStructured: async () => {
    throw new Error("not used");
  },
};

/** owner + 14 件の同伴の候補（合わせて15件）の群を作り、`extra` で recall する。 */
async function recallGroup15(extra: Partial<RecallQuery>) {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: notUsedLlm,
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => NOW },
    relationStore: stores.relationStore,
  });
  const ids: MemoryId[] = [];
  for (let i = 0; i < 15; i++) {
    ids.push((await stores.memoryStore.createMemory(ctx, newMemory(i))).id);
  }
  await runtime.markContestedGroup!(ctx, ids);
  await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, ids[0]!, [1, 0]);
  const result = await runtime.recall(ctx, { vector: [1, 0], ...extra });
  return {
    companions: result.memories.filter((m) => m.retrievedVia === "mandatory_companion"),
    relationOverLimit: result.omitted.filter(
      (o) => o.kind === "over_limit" && o.stage === "relation",
    ),
  };
}

describe("relationMaxCount を省略したときの群の上限は、association.maxCount に従わない（#1470 M11）", () => {
  it.each([[3], [30]])(
    "association: { maxCount: %i } を渡しても、同伴は既定の10件で、over_limit(relation) は4（exact）",
    async (maxCount) => {
      const { companions, relationOverLimit } = await recallGroup15({ association: { maxCount } });
      expect(companions).toHaveLength(10);
      expect(relationOverLimit).toEqual([
        { kind: "over_limit", stage: "relation", count: 4, countKind: "exact" },
      ]);
    },
  );

  it("対照: association を渡さなくても同じ（10件・4）", async () => {
    const { companions, relationOverLimit } = await recallGroup15({});
    expect(companions).toHaveLength(10);
    expect(relationOverLimit).toEqual([
      { kind: "over_limit", stage: "relation", count: 4, countKind: "exact" },
    ]);
  });

  it("relationMaxCount を指定すれば、association.maxCount が違っても指定した値で切る", async () => {
    const { companions, relationOverLimit } = await recallGroup15({
      association: { maxCount: 30 },
      relationMaxCount: 3,
    });
    expect(companions).toHaveLength(3);
    expect(relationOverLimit).toEqual([
      { kind: "over_limit", stage: "relation", count: 11, countKind: "exact" },
    ]);
  });
});

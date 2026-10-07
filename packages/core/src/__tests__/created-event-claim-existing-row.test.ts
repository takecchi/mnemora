import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider, StructuredRequest } from "../interfaces/llm-provider.js";
import type { MemoryStore } from "../interfaces/memory-store.js";
import type { NewMemory } from "../memory.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/** `created-event-claim.test.ts` の「名乗らない adapter」は `supersedeWithNewMemories` が常に `created: true` を返す `FakeMemoryStore` で、`created: false` を返す場面を作っていなかったので、ここで足す。 */

const ctx: Ctx = { tenantId: "created-event-claim-existing-row" };
const NOW = new Date("2026-06-01T00:00:00.000Z");

function newMemory(content: string): NewMemory {
  const halfLifeHours = 24 * 365 * 10;
  return {
    tenantId: ctx.tenantId,
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content,
    contentHash: `hash-${content}`,
    digest: "digest",
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
  };
}

const llm: LLMProvider = {
  complete: async () => {
    throw new Error("not used");
  },
  completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> => {
    for (const value of [{ content: "統合後の本文" }]) {
      const parsed = req.schema.safeParse(value);
      if (parsed.success) return parsed.data as T;
    }
    throw new Error("unexpected schema");
  },
};

/**
 * 名乗らない adapter（`createdEventsWritten` を返さない）で、`supersedeWithNewMemories` が
 * 「既に在った行に当たった」（`created: false`）を返す形にする。`created` を積む責務は runtime に残る。
 */
function makeKit(createdFlag: boolean) {
  const stores = createFakeRuntimeStores();
  const store: MemoryStore = stores.memoryStore;
  const original = store.supersedeWithNewMemories!.bind(store);
  store.supersedeWithNewMemories = async (c, news, supersede, opts) => {
    const result = await original(c, news, supersede, opts);
    return {
      ...result,
      created: result.created.map((entry) => ({ ...entry, created: createdFlag })),
    };
  };
  const runtime = createRuntime({
    ...stores,
    llmProvider: llm,
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => NOW },
  });
  const createdFor = (memoryId: string) =>
    stores.eventStore.events.filter((e) => e.memoryId === memoryId && e.kind === "created");
  return { stores, runtime, createdFor };
}

describe("名乗らない adapter × created: false（既存行に当たった）の行には、created を積まない（ADR 0416 決定1・2、Issue #1734）", () => {
  describe("consolidate", () => {
    async function run(createdFlag: boolean) {
      const kit = makeKit(createdFlag);
      const a = await kit.stores.memoryStore.createMemory(ctx, newMemory("A"));
      const b = await kit.stores.memoryStore.createMemory(ctx, newMemory("B"));
      const result = await kit.runtime.consolidate(ctx, { target: { memoryIds: [a.id, b.id] } });
      return { ...kit, result };
    }

    it("陽性対照: created: true なら、runtime が別の文で created を1件積む", async () => {
      const { result, createdFor } = await run(true);
      expect(createdFor(result.consolidatedMemoryId!)).toHaveLength(1);
    });

    it("created: false なら、created は積まれない", async () => {
      const { result, createdFor } = await run(false);
      expect(result.consolidatedMemoryId).toBeDefined();
      expect(createdFor(result.consolidatedMemoryId!)).toHaveLength(0);
    });
  });
});

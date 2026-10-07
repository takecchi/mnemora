import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider, StructuredRequest } from "../interfaces/llm-provider.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

const TENANT = "tenant-1";
const tenantCtx: Ctx = { tenantId: TENANT };
const T = 10;
const NOW = new Date("2026-06-01T00:00:00.000Z");

const recallBase = {
  tenantId: TENANT,
  query: { text: "fixture" },
  budget: null,
  omitted: [],
  usage: {
    chars: 0,
    estimatedTokens: 0,
    counter: "heuristic" as const,
    byTier: { full: 0, digest: 0, index: 0 },
    indexChars: 0,
  },
  indexBand: { groups: [], totalInScope: 0, countKind: "exact" as const },
  explain: { stages: [] },
  returnedMemories: [],
};

function llmReturning(content: string): LLMProvider {
  return {
    complete: async () => {
      throw new Error("not used");
    },
    completeStructured: async <U>(_ctx: Ctx, req: StructuredRequest<U>): Promise<U> =>
      req.schema.parse({ memories: [{ content, provenanceKind: "stated" }] }) as U,
  };
}

/** T=10。`withRows` の subject には、その回数ぶんの subject 別カウンタの行を作る。 */
async function setup(withRows: Record<string, number>) {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: llmReturning("事実"),
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => NOW },
  });
  await stores.tenantSettingsStore.setDecayClock(tenantCtx, "activity");
  for (let i = 0; i < T; i += 1) {
    await stores.memoryStore.createRecall(tenantCtx, {
      ...recallBase,
      subjectId: null,
      advanceActivityClock: true,
    });
  }
  for (const [subjectId, n] of Object.entries({ anchor: 3, ...withRows })) {
    for (let i = 0; i < n; i += 1) {
      await stores.memoryStore.createRecall(tenantCtx, {
        ...recallBase,
        subjectId,
        advanceActivityClock: { scope: "subject", subjectId },
      });
    }
  }
  return { runtime, stores };
}

async function originOf(key: string, withRows: Record<string, number>) {
  const { runtime, stores } = await setup(withRows);
  const ctx: Ctx = { tenantId: TENANT, subjectId: key };
  const result = await runtime.observe(ctx, { kind: "utterance", text: "発話" });
  return stores.memoryStore.get(ctx, result.memoryIds[0]!);
}

const KEYS = ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"];

describe("活動時計の書き込みの起点: Object.prototype のキー名の subjectId", () => {
  it("陽性対照: plain は 行なしなら T、行があれば T + S_x", async () => {
    expect((await originOf("plain", {}))?.decayBaseSeq).toBe(T);
    expect((await originOf("plain", { plain: 4 }))?.decayBaseSeq).toBe(T + 4);
  });

  it.each(KEYS)("⭐ '%s'（行なし）の起点は T（数のまま）", async (key) => {
    const memory = await originOf(key, {});
    expect(memory?.decayBaseSeq).toBe(T);
    expect(Number.isFinite(memory?.decayFloorSeq)).toBe(true);
  });

  it.each(KEYS)("⭐ '%s'（行あり S=4）の起点は T + 4", async (key) => {
    const memory = await originOf(key, { [key]: 4 });
    expect(memory?.decayBaseSeq).toBe(T + 4);
  });
});

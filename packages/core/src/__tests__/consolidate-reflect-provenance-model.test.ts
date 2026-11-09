import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider, StructuredRequest } from "../interfaces/llm-provider.js";
import type { NewMemory } from "../memory.js";
import { ProvenanceSchema } from "../provenance.js";
import { createRuntime } from "../runtime.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

// consolidate・reflect が作る記憶の provenance に、設定したモデル（model）と応答を実際に返したモデル（respondedModel）が
// 残ること。respondedModel は確かめたときだけ（ADR 0701 と同じ契約。ADR 0705）。

const ctx: Ctx = { tenantId: "consolidate-reflect-provenance-model" };
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
    digest: content,
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

/** consolidate にも reflect にも答える provider。`respondedModel` を渡すと任意の口も実装する。 */
function provider(respondedModel?: string): LLMProvider {
  const respond = <T>(req: StructuredRequest<T>): T => {
    const reflected = req.schema.safeParse({ outcome: "reflected", content: "気づき" });
    return reflected.success ? reflected.data : req.schema.parse({ content: "統合した本文" });
  };
  return {
    complete: async () => ({ content: "unused" }),
    completeStructured: async (_c, req) => respond(req),
    ...(respondedModel !== undefined
      ? {
          completeStructuredWithMeta: async (_c, req) => ({
            value: respond(req),
            respondedModel,
          }),
        }
      : {}),
  } as LLMProvider;
}

async function run(op: "consolidate" | "reflect", llmProvider: LLMProvider) {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    ...stores,
    llmProvider,
    hashContent: (c: string) => `h:${c}`,
    config: { llmModelId: "configured-model" },
    clock: { now: () => NOW },
  });
  const a = await stores.memoryStore.createMemory(ctx, newMemory("A"));
  const b = await stores.memoryStore.createMemory(ctx, newMemory("B"));
  const target = { memoryIds: [a.id, b.id] };
  const createdId =
    op === "consolidate"
      ? (await runtime.consolidate(ctx, { target })).consolidatedMemoryId
      : (await runtime.reflect(ctx, { target })).reflectedMemoryId;
  return (await stores.memoryStore.get(ctx, createdId!))!.provenance;
}

describe.each(["consolidate", "reflect"] as const)(
  "%s が作る記憶の provenance のモデル（ADR 0705）",
  (op) => {
    const kind = op === "consolidate" ? "consolidated" : "reflected";

    it("model は設定値、respondedModel は応答の値", async () => {
      const provenance = await run(op, provider("responded-model-2026-01-01"));

      expect(provenance).toMatchObject({
        kind,
        model: "configured-model",
        respondedModel: "responded-model-2026-01-01",
      });
      expect(ProvenanceSchema.safeParse(provenance).success).toBe(true);
    });

    it("任意の口を実装しない provider では、respondedModel を残さない（確かめていない）", async () => {
      const provenance = await run(op, provider());

      expect(provenance).toMatchObject({ kind, model: "configured-model" });
      expect("respondedModel" in provenance).toBe(false);
    });

    it("応答のモデル名が空文字なら、respondedModel を残さない", async () => {
      const provenance = await run(op, provider(""));

      expect("respondedModel" in provenance).toBe(false);
    });
  },
);

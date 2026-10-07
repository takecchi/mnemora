import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider, StructuredRequest } from "../interfaces/llm-provider.js";
import { ExtractionResultSchema } from "../extraction.js";
import type { NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

const ctx: Ctx = { tenantId: "tenant-745-gating" };

function llm(): LLMProvider {
  return {
    complete: async () => {
      throw new Error("not used");
    },
    completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> => {
      if ((req.schema as unknown) === ExtractionResultSchema) {
        return req.schema.parse({
          memories: [{ content: "好きな食べ物はラーメン", provenanceKind: "stated" }],
        });
      }
      return req.schema.parse({ claims: [{ subject: "user", predicate: "favorite_food" }] });
    },
  };
}

function build() {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: llm(),
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
  });
  return { runtime, stores };
}

function spy(obj: object, key: string): { calls: () => number } {
  const target = obj as Record<string, unknown>;
  const original = target[key] as ((...args: unknown[]) => unknown) | undefined;
  if (original === undefined) throw new Error(`${key} が無い`);
  let count = 0;
  target[key] = (...args: unknown[]) => {
    count += 1;
    return original.apply(obj, args);
  };
  return { calls: () => count };
}

describe("claim key の検出は detectContested: true のときだけ走る", () => {
  it.each([
    ["enabled: true だけ", { enabled: true }],
    ["enabled: true, detectContested: false", { enabled: true, detectContested: false }],
  ] as const)(
    "claimKey: { %s } では find* が0回で、contestedDetection も返らない",
    async (_name, claimKey) => {
      const { runtime, stores } = build();
      const active = spy(stores.memoryStore, "findActiveByClaimKey");
      const contested = spy(stores.memoryStore, "findContestedByClaimKey");

      const result = await runtime.observe(ctx, {
        kind: "utterance",
        text: "好きな食べ物はラーメン",
        claimKey,
      });

      expect(result.memoryIds).toHaveLength(1);
      expect("contestedDetection" in result).toBe(false);
      expect(active.calls()).toBe(0);
      expect(contested.calls()).toBe(0);
    },
  );

  it("陽性対照: detectContested: true なら find* が呼ばれ、contestedDetection が返る", async () => {
    const { runtime, stores } = build();
    const active = spy(stores.memoryStore, "findActiveByClaimKey");

    const result = await runtime.observe(ctx, {
      kind: "utterance",
      text: "好きな食べ物はラーメン",
      claimKey: { enabled: true, detectContested: true },
    });

    expect(active.calls()).toBe(1);
    expect(result.contestedDetection).toHaveLength(1);
  });
});

describe("観測を持たない記憶は、どの観測の兄弟にもならない（ADR 0377 手順2.6）", () => {
  it("sourceObservationId が null の active な記憶と同じ鍵・重なる期間なら、後から observe した記憶と contested になる", async () => {
    const { runtime, stores } = build();
    const recordedAt = new Date();
    const existingInput: NewMemory = {
      tenantId: ctx.tenantId,
      subjectId: null,
      sourceObservationId: null,
      extractorVersion: null,
      content: "好きな食べ物は寿司",
      contentHash: "hash-no-observation",
      digest: "寿司",
      digestSource: "llm",
      provenance: { kind: "imported", batchId: "fixture" },
      tags: [],
      occurredAt: null,
      recordedAt,
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours: 24 * 365 * 10,
      decayFloorAt: defaultDecayStrategy.floorAt({
        recordedAt,
        lastReinforcedAt: null,
        strength: 1,
        halfLifeHours: 24 * 365 * 10,
      }),
      embeddingStatus: "pending",
      claimKey: { subject: "user", predicate: "favorite_food" },
    };
    const existing = await stores.memoryStore.createMemory(ctx, existingInput);

    const result = await runtime.observe(ctx, {
      kind: "utterance",
      text: "好きな食べ物はラーメン",
      claimKey: { enabled: true, detectContested: true },
    });

    expect(result.contestedDetection).toEqual([
      expect.objectContaining({
        matchCount: 1,
        result: expect.objectContaining({ kind: "contested", withMemoryId: existing.id }),
      }),
    ]);
  });
});

import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider, StructuredRequest } from "../interfaces/llm-provider.js";
import type { MemoryStore } from "../interfaces/memory-store.js";
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

describe("冪等に既存の行へ解決した候補では、検出は走らない（ADR 0324）", () => {
  // 1回目の observe が「好きな食べ物はラーメン」を置き、2回目の observe の抽出が同じ本文の候補を2件返す。
  // 2件目は1件目と同じ行に解決する（`created: false`）ので、検出は1件目の1回だけ走る。
  function duplicateCandidatesLlm(): LLMProvider {
    const responses: unknown[] = [
      { memories: [{ content: "好きな食べ物はラーメン", provenanceKind: "stated" }] },
      { claims: [{ subject: "user", predicate: "favorite_food" }] },
      {
        memories: [
          { content: "好きな食べ物は寿司", provenanceKind: "stated" },
          { content: "好きな食べ物は寿司", provenanceKind: "stated" },
        ],
      },
      {
        claims: [
          { subject: "user", predicate: "favorite_food" },
          { subject: "user", predicate: "favorite_food" },
        ],
      },
    ];
    let index = 0;
    return {
      complete: async () => {
        throw new Error("not used");
      },
      completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> =>
        req.schema.parse(responses[index++]) as T,
    };
  }

  function buildWith(withBatchWrite: boolean) {
    const stores = createFakeRuntimeStores();
    if (withBatchWrite) {
      const original = stores.memoryStore.createMemoryWithOutbox.bind(stores.memoryStore);
      (stores.memoryStore as MemoryStore).createMemoriesWithOutboxAndEvents = async (
        c,
        news,
        buildEvent,
        opts,
      ) => {
        const written = [];
        for (const [index, { input, jobKinds }] of news.entries()) {
          const one = await original(c, input, jobKinds, opts);
          if (one.created) {
            await stores.eventStore.append(c, buildEvent(one.memory, []));
          }
          written.push({ index, ...one });
        }
        return { written, dropped: [] };
      };
    }
    const runtime = createRuntime({
      memoryStore: stores.memoryStore,
      outboxStore: stores.outboxStore,
      vectorStore: stores.vectorStore,
      eventStore: stores.eventStore,
      tenantSettingsStore: stores.tenantSettingsStore,
      llmProvider: duplicateCandidatesLlm(),
      embeddingProvider: stores.embeddingProvider,
      hashContent: (content: string) => `sha256(${content})`,
    });
    return { runtime, stores };
  }

  it.each([
    ["createMemoriesWithOutboxAndEvents を持たない store", false],
    ["createMemoriesWithOutboxAndEvents を持つ store", true],
  ] as const)(
    "%s: 同じ本文の2件目は検出せず、contestedDetection は1件だけ",
    async (_name, withBatchWrite) => {
      const { runtime, stores } = buildWith(withBatchWrite);
      const claimKey = { enabled: true, detectContested: true } as const;
      const first = await runtime.observe(ctx, { kind: "utterance", text: "ラーメン", claimKey });
      const active = spy(stores.memoryStore, "findActiveByClaimKey");

      const second = await runtime.observe(ctx, { kind: "utterance", text: "寿司", claimKey });

      expect(second.memoryIds).toHaveLength(2);
      expect(second.memoryIds[1]).toBe(second.memoryIds[0]);
      expect(active.calls()).toBe(1);
      expect(second.contestedDetection).toEqual([
        expect.objectContaining({
          memoryId: second.memoryIds[0],
          result: expect.objectContaining({ kind: "contested", withMemoryId: first.memoryIds[0] }),
        }),
      ]);
    },
  );
});

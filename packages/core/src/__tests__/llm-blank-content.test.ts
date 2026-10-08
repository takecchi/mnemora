import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import { extractCandidates } from "../extraction.js";
import type { LLMProvider, StructuredRequest } from "../interfaces/llm-provider.js";
import type { NewMemory } from "../memory.js";
import type { Observation } from "../observation.js";
import { createRuntime } from "../runtime.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

const ctx: Ctx = { tenantId: "tenant-1" };
const NOW = new Date("2026-06-01T00:00:00.000Z");
/** 半角空白・全角空白（U+3000）・改行・タブ。`trim()` で空になる。 */
const BLANK = " 　\n\t";

function llmReturning(value: unknown): LLMProvider {
  return {
    complete: async () => {
      throw new Error("not used");
    },
    completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> =>
      req.schema.parse(value),
  };
}

const observation: Observation = {
  id: "obs-1",
  tenantId: "tenant-1",
  subjectId: null,
  kind: "utterance",
  payload: { text: "来週の月曜に歯医者の予約がある" },
  occurredAt: null,
  recordedAt: NOW,
  externalId: null,
} as Observation;

/**
 * `""` はスキーマ（`min(1)`）が拒む比較の基準。空白だけの本文が、それと同じ結果になることを
 * 同じ表で比べる。
 */
const EMPTY_AND_BLANKS: Array<[string, string]> = [
  ['`""`（スキーマが拒む基準）', ""],
  ["半角空白", " "],
  ["全角空白（U+3000）", "　"],
  ["改行とタブ", "\n\t"],
  ["混ぜたもの", BLANK],
];

describe("extractCandidates — 空白だけの本文", () => {
  it.each(EMPTY_AND_BLANKS)("%s の本文の候補は、全文フォールバックへ倒れる", async (_, content) => {
    const result = await extractCandidates(
      llmReturning({ memories: [{ content, provenanceKind: "stated" }] }),
      ctx,
      observation,
    );
    expect(result.usedWholeObservationFallback).toBe(true);
    expect(result.failure).not.toBeNull();
    expect(result.candidates.map((c) => c.content)).toEqual(["来週の月曜に歯医者の予約がある"]);
  });

  it.each(EMPTY_AND_BLANKS.filter(([, content]) => content === "" || content === "　"))(
    "%s の本文が1件でも混ざれば、全体が倒れる",
    async (_, content) => {
      const result = await extractCandidates(
        llmReturning({
          memories: [
            { content: "歯医者の予約は月曜", provenanceKind: "stated" },
            { content, provenanceKind: "stated" },
          ],
        }),
        ctx,
        observation,
      );
      expect(result.usedWholeObservationFallback).toBe(true);
      expect(result.candidates.map((c) => c.content)).toEqual(["来週の月曜に歯医者の予約がある"]);
    },
  );

  it.each([
    ["先頭", ["　", "歯医者の予約は月曜", "受付は9時から"]],
    ["真ん中", ["歯医者の予約は月曜", "　", "受付は9時から"]],
    ["末尾", ["歯医者の予約は月曜", "受付は9時から", "　"]],
  ])("空白だけの本文が%sにあっても、全体が倒れる", async (_, contents) => {
    const result = await extractCandidates(
      llmReturning({
        memories: contents.map((content) => ({ content, provenanceKind: "stated" })),
      }),
      ctx,
      observation,
    );
    expect(result.usedWholeObservationFallback).toBe(true);
    expect(result.candidates.map((c) => c.content)).toEqual(["来週の月曜に歯医者の予約がある"]);
  });

  it("前後に空白があっても中身のある本文は、そのまま受ける（trim しない）", async () => {
    const result = await extractCandidates(
      llmReturning({ memories: [{ content: " 歯医者の予約は月曜 ", provenanceKind: "stated" }] }),
      ctx,
      observation,
    );
    expect(result.usedWholeObservationFallback).toBe(false);
    expect(result.candidates.map((c) => c.content)).toEqual([" 歯医者の予約は月曜 "]);
  });
});

function newMemory(content: string): NewMemory {
  const halfLifeHours = 24 * 365 * 10;
  return {
    tenantId: "tenant-1",
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

function buildRuntime(llmProvider: LLMProvider) {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider,
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => NOW },
  });
  return { runtime, stores };
}

describe("consolidate / reflect — 空白だけの本文", () => {
  it("consolidate: llm_failed で、1件も superseded にならない", async () => {
    const { runtime, stores } = buildRuntime(llmReturning({ content: BLANK }));
    const a = await stores.memoryStore.createMemory(ctx, newMemory("A"));
    const b = await stores.memoryStore.createMemory(ctx, newMemory("B"));
    const eventCountBefore = stores.eventStore.events.length;

    const result = await runtime.consolidate(ctx, { target: { memoryIds: [a.id, b.id] } });

    expect(result.outcome).toBe("llm_failed");
    expect(result.llmCalls).toBe(1);
    expect(result.llmFailure?.kind).toBeNull();
    expect(result.consolidatedMemoryId).toBeNull();
    expect(result.sources).toEqual([
      { memoryId: a.id, kind: "not_attempted" },
      { memoryId: b.id, kind: "not_attempted" },
    ]);
    expect(stores.eventStore.events.length).toBe(eventCountBefore);
    expect((await stores.memoryStore.get(ctx, a.id))?.status).toBe("active");
  });

  it("consolidate: 前後に空白があっても中身のある本文は、拒まず、そのまま書く（trim しない）", async () => {
    const padded = "  束ねた本文\n";
    const { runtime, stores } = buildRuntime(llmReturning({ content: padded }));
    const a = await stores.memoryStore.createMemory(ctx, newMemory("A"));
    const b = await stores.memoryStore.createMemory(ctx, newMemory("B"));

    const result = await runtime.consolidate(ctx, { target: { memoryIds: [a.id, b.id] } });

    expect(result.outcome).toBe("consolidated");
    expect(result.llmFailure).toBeNull();
    const created = await stores.memoryStore.get(ctx, result.consolidatedMemoryId!);
    expect(created?.content).toBe(padded);
  });

  it("reflect: 前後に空白があっても中身のある本文は、拒まず、そのまま書く（trim しない）", async () => {
    const padded = "  気づき\n";
    const { runtime, stores } = buildRuntime(
      llmReturning({ outcome: "reflected", content: padded }),
    );
    const a = await stores.memoryStore.createMemory(ctx, newMemory("A"));
    const b = await stores.memoryStore.createMemory(ctx, newMemory("B"));

    const result = await runtime.reflect(ctx, { target: { memoryIds: [a.id, b.id] } });

    expect(result.outcome).toBe("reflected");
    expect(result.llmFailure).toBeNull();
    const created = await stores.memoryStore.get(ctx, result.reflectedMemoryId!);
    expect(created?.content).toBe(padded);
  });

  it("reflect: llm_failed で、1件も書かない", async () => {
    const { runtime, stores } = buildRuntime(
      llmReturning({ outcome: "reflected", content: BLANK }),
    );
    const a = await stores.memoryStore.createMemory(ctx, newMemory("A"));
    const b = await stores.memoryStore.createMemory(ctx, newMemory("B"));
    const eventCountBefore = stores.eventStore.events.length;

    const result = await runtime.reflect(ctx, { target: { memoryIds: [a.id, b.id] } });

    expect(result.outcome).toBe("llm_failed");
    expect(result.llmCalls).toBe(1);
    expect(result.llmFailure?.kind).toBeNull();
    expect(result.reflectedMemoryId).toBeNull();
    expect(stores.eventStore.events.length).toBe(eventCountBefore);
  });
});

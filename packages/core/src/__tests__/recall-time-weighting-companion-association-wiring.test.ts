import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import type { NewMemory } from "../memory.js";
import { RecallQuerySchema } from "../recall.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * `RecallQuery.timeWeighting` を、段2以外の3経路（同伴の2経路・連想枠）へ渡す配線と、
 * `RecallQuerySchema` の値の縛りの歯（Issue #690、ADR 0300 決定「`mandatory_companion`・
 * 段3.5 連想枠の順位キーに同じ値を渡す」。Issue #1775 の #697 のすり抜け 7〜10）。
 *
 * `recall-time-weighting-policy.test.ts` は主経路しか通さず、同伴を持つ記憶・連想枠に
 * `timeWeighting` を渡す歯が無かった。同伴・連想枠の `score.freshness` を直接見る
 * （`occurredAt` の無い古い記憶は、`"legacy"` では 1 未満、`"eventAwareFreshness"` では 1）。
 *
 * `@mnemora/testkit` には依存しない。DB を要さない。
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-06-01T00:00:00.000Z");
const ctx: Ctx = { tenantId: "tenant-tw-wiring" };
const OLD = new Date(NOW.getTime() - 400 * DAY_MS);

const notUsedLlm: LLMProvider = {
  complete: async () => {
    throw new Error("not used");
  },
  completeStructured: async () => {
    throw new Error("not used");
  },
};

function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  const recordedAt = overrides.recordedAt ?? NOW;
  const strength = 1;
  const halfLifeHours = 720;
  return {
    tenantId: ctx.tenantId,
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
    // 忘却ゲートに掛からないよう、床は遠い未来に置く。
    decayFloorAt: new Date(NOW.getTime() + 1_000 * DAY_MS),
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
    llmProvider: notUsedLlm,
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => NOW },
    relationStore: stores.relationStore,
  });
  return { runtime, stores };
}

describe("recall() — timeWeighting は同伴取得の2経路にも渡る（ADR 0300）", () => {
  it("2者間の対（contestedWithId 経路）: 同伴の freshness が、eventAwareFreshness なら 1・legacy なら 1 未満", async () => {
    const { runtime, stores } = buildRuntime();
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "A" }));
    const b = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ digest: "B", recordedAt: OLD, occurredAt: null }),
    );
    await runtime.markContested(ctx, a.id, b.id);
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, a.id, [1, 0]);

    const legacy = await runtime.recall(ctx, { vector: [1, 0] });
    const aware = await runtime.recall(ctx, {
      vector: [1, 0],
      timeWeighting: "eventAwareFreshness",
    });

    const legacyB = legacy.memories.find((m) => m.memoryId === b.id);
    const awareB = aware.memories.find((m) => m.memoryId === b.id);
    expect(legacyB?.retrievedVia).toBe("mandatory_companion");
    expect(awareB?.retrievedVia).toBe("mandatory_companion");
    expect(legacyB?.score.freshness).toBeLessThan(1);
    expect(awareB?.score.freshness).toBe(1);
  });

  it("多者間の contested 群（relationStore 経路）: 同伴の freshness が、eventAwareFreshness なら 1・legacy なら 1 未満", async () => {
    const { runtime, stores } = buildRuntime();
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "A" }));
    const b = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ digest: "B", recordedAt: OLD, occurredAt: null }),
    );
    const c = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ digest: "C", recordedAt: OLD, occurredAt: null }),
    );
    await runtime.markContestedGroup!(ctx, [a.id, b.id, c.id]);
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, a.id, [1, 0]);

    const legacy = await runtime.recall(ctx, { vector: [1, 0] });
    const aware = await runtime.recall(ctx, {
      vector: [1, 0],
      timeWeighting: "eventAwareFreshness",
    });

    for (const id of [b.id, c.id]) {
      const legacyEntry = legacy.memories.find((m) => m.memoryId === id);
      const awareEntry = aware.memories.find((m) => m.memoryId === id);
      expect(legacyEntry?.retrievedVia).toBe("mandatory_companion");
      expect(awareEntry?.retrievedVia).toBe("mandatory_companion");
      expect(legacyEntry?.score.freshness).toBeLessThan(1);
      expect(awareEntry?.score.freshness).toBe(1);
    }
  });
});

describe("recall() — timeWeighting は連想枠（段3.5）の順位キーにも渡る（ADR 0300）", () => {
  it("occurredAt の無い古い連想候補の freshness が、eventAwareFreshness なら 1・legacy なら 1 未満", async () => {
    const { runtime, stores } = buildRuntime();
    const anchor = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ digest: "アンカー", embeddingStatus: "ready" }),
    );
    await stores.vectorStore.upsert(
      ctx,
      stores.embeddingProvider.space,
      anchor.id,
      [0.70710678, 0.70710678],
    );
    const associated = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ digest: "連想", recordedAt: OLD, occurredAt: null, embeddingStatus: "ready" }),
    );
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, associated.id, [0, 1]);

    const base = { vector: [1, 0], association: { maxCount: 5, anchorCount: 1 } };
    const legacy = await runtime.recall(ctx, base);
    const aware = await runtime.recall(ctx, { ...base, timeWeighting: "eventAwareFreshness" });

    const legacyEntry = legacy.memories.find((m) => m.memoryId === associated.id);
    const awareEntry = aware.memories.find((m) => m.memoryId === associated.id);
    expect(awareEntry?.retrievedVia).toBe("association");
    expect(awareEntry?.score.freshness).toBe(1);
    // legacy では freshness が小さく、連想枠の順位キーが足りず席に入らないか、入っても 1 未満。
    if (legacyEntry !== undefined) {
      expect(legacyEntry.score.freshness).toBeLessThan(1);
    }
  });
});

describe("RecallQuerySchema.timeWeighting — 値は 'legacy' | 'eventAwareFreshness' だけ", () => {
  it.each(["bogus", "", 1])("%j は検証で拒まれる", (value) => {
    expect(RecallQuerySchema.safeParse({ vector: [1, 0], timeWeighting: value }).success).toBe(
      false,
    );
  });

  it.each(["legacy", "eventAwareFreshness"])("%j は通る", (value) => {
    expect(RecallQuerySchema.safeParse({ vector: [1, 0], timeWeighting: value }).success).toBe(
      true,
    );
  });
});

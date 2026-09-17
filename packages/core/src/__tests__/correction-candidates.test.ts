import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type {
  LLMProvider,
  LLMResponse,
  PromptSpec,
  StructuredRequest,
} from "../interfaces/llm-provider.js";
import type { EmbeddingProvider } from "../interfaces/embedding-provider.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { NewMemory } from "../memory.js";
import { DEFAULT_CORRECTION_CANDIDATE_LIMIT } from "../correction-candidates.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * `runtime.findCorrectionCandidates`（Issue #369 (C)「訂正の口」、[ADR 0232](../../../docs/decisions/0232-correction-candidates-returned-not-chosen.md)）の歯。
 *
 * 設計の要点（`runtime.ts` の `Runtime.findCorrectionCandidates` の doc コメント参照）:
 * - 書き込みを1件もしない（`markContested`/`resolveContested` の前に立つ）。
 * - LLM を1回も呼ばない——相手探しは既存の `recall()`（ANN + 既存のスコア）だけ。
 * - 新しい閾値を置かない——`recall()` の既定（`scoreThreshold`）をそのまま通す。
 * - `recallRank` は `excludeMemoryIds` で除外した後も詰め直さない。
 * - `tick()`/`observe()` からは呼ばれない（`markContested` と同じ立場——本ファイルは
 *   `findCorrectionCandidates` を明示的に呼ぶことしかしない）。
 *
 * `@mnemora/testkit` には依存しない（`consolidate.test.ts`/`mark-contested.test.ts` と
 * 同じ理由——`runtime-fakes.ts` 冒頭のコメント参照）。
 */

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

/** 呼ばれたら例外を投げつつ、呼び出し回数を数える LLM の偽物（歯5用）。 */
function countingLlm(): LLMProvider & { calls: number } {
  const provider = {
    calls: 0,
    async complete(_ctx: Ctx, _req: PromptSpec): Promise<LLMResponse> {
      provider.calls += 1;
      throw new Error("not used");
    },
    async completeStructured<T>(_ctx: Ctx, _req: StructuredRequest<T>): Promise<T> {
      provider.calls += 1;
      throw new Error("not used");
    },
  };
  return provider;
}

/**
 * `recall()` が実際に ANN 段まで進んだかどうかを、埋め込みの呼び出し回数で数えるための
 * 薄いラッパー（歯7用）。`recall()` は text クエリにつき `embeddingProvider.embed` を
 * 必ず1回呼ぶ（`recall-runtime.ts` の該当箇所）——`RangeError` で早期に落ちた呼び出しは
 * この回数を1つも増やさないはずである。
 */
function countingEmbeddingProvider(inner: EmbeddingProvider): EmbeddingProvider & {
  calls: number;
} {
  const wrapper = {
    calls: 0,
    get space() {
      return inner.space;
    },
    async embed(c: Ctx, texts: string[]): Promise<number[][]> {
      wrapper.calls += 1;
      return inner.embed(c, texts);
    },
  };
  return wrapper;
}

function buildRuntime(llmProvider?: LLMProvider) {
  const stores = createFakeRuntimeStores();
  const embeddingSpy = countingEmbeddingProvider(stores.embeddingProvider);
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: llmProvider ?? countingLlm(),
    embeddingProvider: embeddingSpy,
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => NOW },
  });
  return { runtime, stores, embeddingSpy };
}

/**
 * `FakeEmbeddingProvider` は文字列長・'a' の数から決定的にベクトルを作る
 * （`runtime-fakes.ts` 参照）。`"seed"` → `[4, 0]`——`consolidate.test.ts` の
 * `{ seedMemoryId }` の歯と同じ約束事を流用する。
 */
const QUERY_TEXT = "seed";

async function createCandidate(
  stores: ReturnType<typeof createFakeRuntimeStores>,
  vector: number[],
  overrides: Partial<NewMemory> = {},
) {
  const memory = await stores.memoryStore.createMemory(
    ctx,
    newMemory({ embeddingStatus: "ready", ...overrides }),
  );
  await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, memory.id, vector);
  return memory;
}

describe("runtime.findCorrectionCandidates — 候補が返る", () => {
  it("相手になる記憶が在るとき、candidates[0] がそれで、recallRank===1、outcome==='candidates'", async () => {
    const { runtime, stores } = buildRuntime();
    const target = await createCandidate(stores, [8, 0], { digest: "対象の記憶" });

    const result = await runtime.findCorrectionCandidates(ctx, { text: QUERY_TEXT });

    expect(result.outcome).toBe("candidates");
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.memoryId).toBe(target.id);
    expect(result.candidates[0]?.digest).toBe("対象の記憶");
    expect(result.candidates[0]?.recallRank).toBe(1);
    expect(result.candidates[0]?.retrievedVia).toBe("ann");
    expect(result.candidates[0]?.score).toBeDefined();
    expect(result.recalledCount).toBe(1);
    expect(result.excludedCount).toBe(0);
  });
});

describe("runtime.findCorrectionCandidates — excludeMemoryIds が効く", () => {
  it("除外した id は candidates に無く、excludedCount が増え、残った候補の recallRank は詰め直さない", async () => {
    const { runtime, stores } = buildRuntime();
    // [8, 0] は query [4, 0] と同じ向き ⟹ 類似度1.0（1位）。
    const first = await createCandidate(stores, [8, 0], { digest: "1位" });
    // [8, 4] は [4, 0] からズレる ⟹ 類似度は1位より低いが、閾値(0.1)は超える（2位）。
    const second = await createCandidate(stores, [8, 4], { digest: "2位" });

    const result = await runtime.findCorrectionCandidates(ctx, {
      text: QUERY_TEXT,
      excludeMemoryIds: [first.id],
    });

    expect(result.recalledCount).toBe(2);
    expect(result.excludedCount).toBe(1);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates.map((c) => c.memoryId)).not.toContain(first.id);
    expect(result.candidates[0]?.memoryId).toBe(second.id);
    // ⭐ 詰め直さない: 1位を除外しても、残った候補の recallRank は「2」のまま。
    expect(result.candidates[0]?.recallRank).toBe(2);
  });
});

describe("runtime.findCorrectionCandidates — limit を守る", () => {
  it("既定では3件以下に切られる", async () => {
    const { runtime, stores } = buildRuntime();
    // query [4, 0] から徐々に離れていく4つの候補（どれも閾値は超える）。
    await createCandidate(stores, [8, 0], { digest: "c1" });
    await createCandidate(stores, [8, 1], { digest: "c2" });
    await createCandidate(stores, [8, 2], { digest: "c3" });
    await createCandidate(stores, [8, 4], { digest: "c4" });

    const result = await runtime.findCorrectionCandidates(ctx, { text: QUERY_TEXT });

    expect(result.recalledCount).toBe(4);
    expect(result.candidates).toHaveLength(DEFAULT_CORRECTION_CANDIDATE_LIMIT);
    expect(result.candidates.length).toBeLessThanOrEqual(3);
  });

  it("明示した limit も守る", async () => {
    const { runtime, stores } = buildRuntime();
    await createCandidate(stores, [8, 0], { digest: "c1" });
    await createCandidate(stores, [8, 1], { digest: "c2" });
    await createCandidate(stores, [8, 2], { digest: "c3" });

    const result = await runtime.findCorrectionCandidates(ctx, { text: QUERY_TEXT, limit: 1 });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.digest).toBe("c1");
  });
});

describe("runtime.findCorrectionCandidates — 書き込みを1件もしない", () => {
  it("呼ぶ前後で全 Memory の status が変わらず、memory_events が1件も増えない", async () => {
    const { runtime, stores } = buildRuntime();
    const target = await createCandidate(stores, [8, 0], { digest: "対象の記憶" });
    const eventsBefore = stores.eventStore.events.length;
    const statusBefore = (await stores.memoryStore.get(ctx, target.id))?.status;

    await runtime.findCorrectionCandidates(ctx, { text: QUERY_TEXT });

    const eventsAfter = stores.eventStore.events.length;
    const statusAfter = (await stores.memoryStore.get(ctx, target.id))?.status;
    expect(eventsAfter).toBe(eventsBefore);
    expect(statusAfter).toBe(statusBefore);
    expect(statusAfter).toBe("active");
  });
});

describe("runtime.findCorrectionCandidates — LLM を1回も呼ばない", () => {
  it("LLMProvider をスパイに差し替えても、呼び出し回数が変わらない", async () => {
    const llm = countingLlm();
    const { runtime, stores } = buildRuntime(llm);
    await createCandidate(stores, [8, 0], { digest: "対象の記憶" });
    const callsBefore = llm.calls;

    await runtime.findCorrectionCandidates(ctx, { text: QUERY_TEXT });

    expect(llm.calls).toBe(callsBefore);
    expect(llm.calls).toBe(0);
  });
});

describe("runtime.findCorrectionCandidates — 候補0件", () => {
  it("記憶が1件も無いとき outcome==='no_candidates' かつ candidates が空", async () => {
    const { runtime } = buildRuntime();

    const result = await runtime.findCorrectionCandidates(ctx, { text: QUERY_TEXT });

    expect(result.outcome).toBe("no_candidates");
    expect(result.candidates).toEqual([]);
    expect(result.recalledCount).toBe(0);
    expect(result.excludedCount).toBe(0);
  });

  it("全部除外したとき outcome==='no_candidates' かつ candidates が空", async () => {
    const { runtime, stores } = buildRuntime();
    const only = await createCandidate(stores, [8, 0], { digest: "唯一の候補" });

    const result = await runtime.findCorrectionCandidates(ctx, {
      text: QUERY_TEXT,
      excludeMemoryIds: [only.id],
    });

    expect(result.outcome).toBe("no_candidates");
    expect(result.candidates).toEqual([]);
    expect(result.recalledCount).toBe(1);
    expect(result.excludedCount).toBe(1);
  });
});

describe("runtime.findCorrectionCandidates — limit の定義域", () => {
  it.each([0, -1, 1.5])(
    "limit=%s は RangeError を投げ、recall も呼ばれていない（embed 呼び出し回数が増えない）",
    async (limit) => {
      const { runtime, stores, embeddingSpy } = buildRuntime();
      await createCandidate(stores, [8, 0], { digest: "対象の記憶" });
      const callsBefore = embeddingSpy.calls;

      await expect(
        runtime.findCorrectionCandidates(ctx, { text: QUERY_TEXT, limit }),
      ).rejects.toThrow(RangeError);

      expect(embeddingSpy.calls).toBe(callsBefore);
    },
  );
});

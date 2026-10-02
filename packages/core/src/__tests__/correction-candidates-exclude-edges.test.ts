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
import type { MemoryId } from "../ids.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/** `excludeMemoryIds` の端（穴探し56巡目）。 */

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

describe("runtime.findCorrectionCandidates — excludeMemoryIds の端", () => {
  it("大文字で渡した id も除外される（postgres は UUID を小文字で返す）", async () => {
    const { runtime, stores } = buildRuntime();
    const near = await createCandidate(stores, [8, 0], { digest: "近い" });
    await createCandidate(stores, [8.5, 0], { digest: "遠い" });

    const result = await runtime.findCorrectionCandidates(ctx, {
      text: QUERY_TEXT,
      excludeMemoryIds: [near.id.toUpperCase() as typeof near.id],
    });

    expect(result.excludedCount).toBe(1);
    expect(result.candidates.map((c) => c.memoryId)).not.toContain(near.id);
  });

  it.each([5, {}] as const)(
    "反復できない excludeMemoryIds（%j）は recall を呼ぶ前に TypeError で落ちる（recall の記録を書かない）",
    async (bad) => {
      const { runtime, stores, embeddingSpy } = buildRuntime();
      await createCandidate(stores, [8, 0], { digest: "対象" });
      const before = embeddingSpy.calls;

      await expect(
        runtime.findCorrectionCandidates(ctx, {
          text: QUERY_TEXT,
          excludeMemoryIds: bad as unknown as readonly MemoryId[],
        }),
      ).rejects.toThrow(TypeError);

      expect(embeddingSpy.calls).toBe(before);
    },
  );
});

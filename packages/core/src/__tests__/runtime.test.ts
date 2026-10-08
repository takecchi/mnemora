import { describe, expect, it, vi } from "vitest";
import { DEFAULT_KNOWN_PREDICATES_FROM_STORE_LIMIT } from "../claim-key.js";
import type { Ctx } from "../ctx.js";
import type { EmbeddingProvider } from "../interfaces/embedding-provider.js";
import type { LLMProvider, StructuredRequest } from "../interfaces/llm-provider.js";
import { OutboxLeaseConflictError } from "../interfaces/outbox-store.js";
import {
  CLAIM_KEY_WITH_DEFERRED_EXTRACT_ERROR_PREFIX,
  SUBJECT_CANDIDATES_WITH_DEFERRED_EXTRACT_ERROR_PREFIX,
} from "../observation.js";
import {
  TICK_SUPPORTED_JOB_KINDS,
  UNSUPPORTED_KIND_ERROR_PREFIX,
  createRuntime,
} from "../runtime.js";
import type { ReextractSkip } from "../strategies/reextract.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";
import { withSourceObservation } from "./observed-memory.js";
import type { FakeMemoryStore } from "./runtime-fakes.js";

/** `MemoryStore.createRecall`（recall 段6の書き込み口そのもの）で実在の recallId を用意する。`recordUsage` は `recall_usages.recall_id → recalls(id)` の外部キー相当を要求するため、実体の無い固定文字列は使えない。 */
async function createRecallFixture(stores: { memoryStore: FakeMemoryStore }, ctx: Ctx) {
  return stores.memoryStore.createRecall(ctx, {
    tenantId: ctx.tenantId,
    subjectId: null,
    query: { text: "fixture" },
    budget: null,
    omitted: [],
    usage: {
      chars: 0,
      estimatedTokens: 0,
      counter: "heuristic",
      byTier: { full: 0, digest: 0, index: 0 },
      indexChars: 0,
    },
    indexBand: { groups: [], totalInScope: 0, countKind: "exact" },
    explain: { stages: [] },
    returnedMemories: [],
  });
}

const ctx: Ctx = { tenantId: "tenant-1" };
// リースの境界そのものは検査しないので、十分に長く固定した値を使う。
const TEST_LEASE_MS = 60_000;

function llmReturning(
  memories: {
    content: string;
    digest?: string;
    provenanceKind: "stated" | "inferred";
    confidence?: number;
    subjectId?: string | null;
  }[],
): LLMProvider {
  return {
    complete: async () => {
      throw new Error("not used");
    },
    completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> =>
      req.schema.parse({ memories }) as T,
  };
}

function throwingLlm(): LLMProvider {
  return {
    complete: async () => {
      throw new Error("not used");
    },
    completeStructured: async () => {
      throw new Error("simulated LLM outage");
    },
  };
}

/**
 * `llmReturning` と同じ抽出結果を返しつつ、`reflect()` の `ReflectionLLMResultSchema` で呼ばれたときは「一般化するものは無い」（`outcome: "nothing"`）を返す。
 *
 * `reflect()` は eligible が1件でも LLM を呼ぶ。素の `llmReturning` は `req.schema.parse({ memories })` を無条件で呼ぶので、
 * `ReflectionLLMResultSchema` では parse が失敗し、`reflect()` の catch 節がそれを `outcome: "llm_failed"` に変えてしまう。
 * `req.schema.safeParse` で先に extraction 形を試し、失敗したら reflect の「辞退」形を返すことで、この節の歯を
 * 「job が正しく processed になる」ことだけを測る形に保つ。
 */
function llmReturningOrDecliningReflection(
  memories: Parameters<typeof llmReturning>[0],
): LLMProvider {
  return {
    complete: async () => {
      throw new Error("not used");
    },
    completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> => {
      const asExtraction = req.schema.safeParse({ memories });
      if (asExtraction.success) {
        return asExtraction.data;
      }
      return req.schema.parse({ outcome: "nothing" }) as T;
    },
  };
}

/**
 * `completeStructured` 呼び出しの回数と順序を検査したいテスト用の fake。`responses[0]` が1回目の呼び出し（常に `extractCandidates` 由来）、
 * `responses[1]` が2回目（opt-in が有効なら `deriveClaimKeys` 由来）に対応する。`runExtraction` が常に「抽出 → (opt-inのときだけ)claim key」の順で
 * 呼ぶことを前提にした単純化。設定した回数を超えて呼ばれたら例外を投げる（未設定の応答を勝手に補わない）。
 */
function sequencedLlm(responses: unknown[]): LLMProvider & { calls: StructuredRequest<unknown>[] } {
  const calls: StructuredRequest<unknown>[] = [];
  return {
    calls,
    complete: async () => {
      throw new Error("not used");
    },
    completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> => {
      const index = calls.length;
      calls.push(req as StructuredRequest<unknown>);
      if (index >= responses.length) {
        throw new Error(`sequencedLlm: no response configured for call #${index + 1}`);
      }
      return req.schema.parse(responses[index]) as T;
    },
  };
}

function buildRuntime(
  llmProvider: LLMProvider,
  overrides: Partial<Parameters<typeof createRuntime>[0]> = {},
) {
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
    ...overrides,
  });
  return { runtime, stores };
}

describe("runtime.observe — extract: 'sync'（既定, D2）", () => {
  it("utterance を観測すると、その場で抽出されて Memory が作られる", async () => {
    const { runtime, stores } = buildRuntime(
      llmReturning([{ content: "東京出張がある", digest: "東京出張", provenanceKind: "stated" }]),
    );
    const result = await runtime.observe(ctx, { kind: "utterance", text: "明日東京に出張します" });

    expect(result.extraction).toBe("ok");
    expect(result.memoryIds).toHaveLength(1);
    const memory = await stores.memoryStore.get(ctx, result.memoryIds[0]!);
    expect(memory?.digest).toBe("東京出張");
    expect(memory?.digestSource).toBe("llm");
    expect(memory?.sourceObservationId).toBe(result.observationId);
  });

  it("digest 生成に失敗した候補は digestSource: 'fallback' で content は必ず保持される", async () => {
    const { runtime, stores } = buildRuntime(
      llmReturning([{ content: "長い本文がここに入ります", provenanceKind: "stated" }]),
    );
    const result = await runtime.observe(ctx, { kind: "utterance", text: "テスト発話" });
    const memory = await stores.memoryStore.get(ctx, result.memoryIds[0]!);
    expect(memory?.digestSource).toBe("fallback");
    expect(memory?.content).toBe("長い本文がここに入ります");
  });

  it("LLM 呼び出し自体が失敗しても observe() 全体は失敗せず、全文を保持した Memory が1件残る", async () => {
    const { runtime, stores } = buildRuntime(throwingLlm());
    const result = await runtime.observe(ctx, {
      kind: "utterance",
      text: "障害時でも残したい発話",
    });
    expect(result.extraction).toBe("llm_failed_whole_observation");
    expect(result.memoryIds).toHaveLength(1);
    const memory = await stores.memoryStore.get(ctx, result.memoryIds[0]!);
    expect(memory?.content).toBe("障害時でも残したい発話");
    expect(memory?.provenance.kind).toBe("stated");
  });

  it("LLM が失敗して全文フォールバックへ倒れたことが、監査ログの meta.reason に残る", async () => {
    const { runtime, stores } = buildRuntime(throwingLlm());
    const result = await runtime.observe(ctx, { kind: "utterance", text: "障害時の発話" });

    const events = await stores.eventStore.list(ctx, { memoryId: result.memoryIds[0]! });
    const created = events.find((event) => event.kind === "created");
    expect(created).toBeDefined();
    expect((created!.meta as { reason?: string }).reason).toBe(
      "extraction_failed_whole_observation_fallback",
    );
  });

  it("正常に抽出できたときの監査ログは reason: 'extracted' のままである（上の歯と対になる）", async () => {
    const { runtime, stores } = buildRuntime(
      llmReturning([{ content: "本文Y", digest: "要旨Y", provenanceKind: "stated" }]),
    );
    const result = await runtime.observe(ctx, { kind: "utterance", text: "本文Y" });

    const events = await stores.eventStore.list(ctx, { memoryId: result.memoryIds[0]! });
    const created = events.find((event) => event.kind === "created");
    expect((created!.meta as { reason?: string }).reason).toBe("extracted");
  });

  it("LLM 失敗の kind が監査ログの meta.failureKind に残る", async () => {
    const provider: LLMProvider = {
      complete: async () => {
        throw new Error("not used");
      },
      completeStructured: async () => {
        const error = new Error("the model refused") as Error & { kind: string };
        error.kind = "refusal";
        throw error;
      },
    };
    const { runtime, stores } = buildRuntime(provider);
    const result = await runtime.observe(ctx, { kind: "utterance", text: "拒否される発話" });

    const events = await stores.eventStore.list(ctx, { memoryId: result.memoryIds[0]! });
    const created = events.find((event) => event.kind === "created");
    expect((created!.meta as { failureKind?: string | null }).failureKind).toBe("refusal");
  });

  it("kind を名乗らない失敗（素の Error）は meta.failureKind が null になる（『分からない』を勝手な種類に読み替えない）", async () => {
    const { runtime, stores } = buildRuntime(throwingLlm());
    const result = await runtime.observe(ctx, { kind: "utterance", text: "種類不明の失敗" });

    const events = await stores.eventStore.list(ctx, { memoryId: result.memoryIds[0]! });
    const created = events.find((event) => event.kind === "created");
    expect((created!.meta as { failureKind?: string | null }).failureKind).toBeNull();
  });

  it("成功経路の監査ログ meta には failureKind キー自体が無い", async () => {
    const { runtime, stores } = buildRuntime(
      llmReturning([{ content: "本文Z", digest: "要旨Z", provenanceKind: "stated" }]),
    );
    const result = await runtime.observe(ctx, { kind: "utterance", text: "本文Z" });

    const events = await stores.eventStore.list(ctx, { memoryId: result.memoryIds[0]! });
    const created = events.find((event) => event.kind === "created");
    expect("failureKind" in (created!.meta as Record<string, unknown>)).toBe(false);
  });

  it("createMemory の contentHash は注入された hashContent で計算される（core は計算しない, D16）", async () => {
    const { runtime, stores } = buildRuntime(
      llmReturning([{ content: "本文X", digest: "要旨X", provenanceKind: "stated" }]),
    );
    const result = await runtime.observe(ctx, { kind: "utterance", text: "本文X" });
    const memory = await stores.memoryStore.get(ctx, result.memoryIds[0]!);
    expect(memory?.contentHash).toBe("sha256(本文X)");
  });

  it("Memory 作成時に 'created' イベントが監査ログへ記録される", async () => {
    const { runtime, stores } = buildRuntime(
      llmReturning([{ content: "本文", digest: "要旨", provenanceKind: "stated" }]),
    );
    const result = await runtime.observe(ctx, { kind: "utterance", text: "本文" });
    const events = await stores.eventStore.list(ctx, { memoryId: result.memoryIds[0]! });
    expect(events.some((e) => e.kind === "created")).toBe(true);
  });

  it("LLM が0件の候補を返したら Memory は作られない（ゴミ記憶を増やさない）", async () => {
    const { runtime } = buildRuntime(llmReturning([]));
    const result = await runtime.observe(ctx, {
      kind: "utterance",
      text: "特に記憶するまでもない雑談",
    });
    expect(result.extraction).toBe("ok");
    expect(result.memoryIds).toEqual([]);
  });

  it("extract 済みの extract ジョブは outbox 上で completed になる（黙って溜め込まない）", async () => {
    const { runtime, stores } = buildRuntime(
      llmReturning([{ content: "本文", digest: "要旨", provenanceKind: "stated" }]),
    );
    await runtime.observe(ctx, { kind: "utterance", text: "本文" });
    const pending = await stores.outboxStore.claimBatch(ctx, {
      kinds: ["extract"],
      limit: 10,
      now: new Date(),
      claimedBy: "test",
      leaseMs: TEST_LEASE_MS,
    });
    expect(pending).toEqual([]);
  });

  it("embed ジョブは sync 抽出でも常に outbox 経由（未処理のまま残る）", async () => {
    const { runtime, stores } = buildRuntime(
      llmReturning([{ content: "本文", digest: "要旨", provenanceKind: "stated" }]),
    );
    await runtime.observe(ctx, { kind: "utterance", text: "本文" });
    const pending = await stores.outboxStore.claimBatch(ctx, {
      kinds: ["embed"],
      limit: 10,
      now: new Date(),
      claimedBy: "test",
      leaseMs: TEST_LEASE_MS,
    });
    expect(pending).toHaveLength(1);
  });
});

/**
 * 偽の `LLMProvider`（`completeStructured` が throw する）を `createRuntime` へ本物の経路で注入し、`runtime.observe()` を実際に呼ぶ。
 * `ObserveResult` を手で組み立てて `extractionFailure` を入れて assert する「皮で注入するだけの歯」にはしない。
 */
describe("runtime.observe — provider の kind が ObserveResult まで運ばれる（ADR 0072 追記）", () => {
  function throwingLlmWithKind(kind: string, message: string): LLMProvider {
    return {
      complete: async () => {
        throw new Error("not used");
      },
      completeStructured: async () => {
        // `@mnemora/openai` / `@mnemora/anthropic` が投げる、`kind` を持つエラーの模倣。
        // core は provider のクラスを知らない（instanceof は使えない）ので、
        // ここでは値として `kind` を持つだけの素の Error を投げる（duck typing の対象）。
        const error = new Error(message) as Error & { kind: string };
        error.kind = kind;
        throw error;
      },
    };
  }

  it("provider が kind: 'refusal' 付きで投げても observe() は throw せず、ExtractionOutcome は 'llm_failed_whole_observation' のまま、extractionFailure.kind に 'refusal' が読める", async () => {
    const { runtime, stores } = buildRuntime(
      throwingLlmWithKind("refusal", "the model refused to answer"),
    );

    const result = await runtime.observe(ctx, {
      kind: "utterance",
      text: "本物の経路を通す発話",
    });

    expect(result.extraction).toBe("llm_failed_whole_observation");
    expect(result.extractionFailure).toEqual({
      kind: "refusal",
      message: "the model refused to answer",
    });

    expect(result.memoryIds).toHaveLength(1);
    const memory = await stores.memoryStore.get(ctx, result.memoryIds[0]!);
    expect(memory?.content).toBe("本物の経路を通す発話");
    expect(memory?.provenance.kind).toBe("stated");
  });

  it("成功経路では extractionFailure は必ず null（『間違った有る』の逆側）", async () => {
    const { runtime } = buildRuntime(
      llmReturning([{ content: "本文", digest: "要旨", provenanceKind: "stated" }]),
    );
    const result = await runtime.observe(ctx, { kind: "utterance", text: "本文" });
    expect(result.extraction).toBe("ok");
    expect(result.extractionFailure).toBeNull();
  });

  it("kind を名乗らない失敗（素の Error）は extractionFailure.kind が null になる", async () => {
    const { runtime } = buildRuntime(throwingLlm());
    const result = await runtime.observe(ctx, { kind: "utterance", text: "種類不明の失敗" });
    expect(result.extraction).toBe("llm_failed_whole_observation");
    expect(result.extractionFailure?.kind).toBeNull();
    expect(result.extractionFailure?.message).toBe("simulated LLM outage");
  });

  it("memory_usage（extraction: 'skipped'）でも extractionFailure は null", async () => {
    const { runtime, stores } = buildRuntime(llmReturning([]));
    const memory = await stores.memoryStore.createMemory(ctx, {
      tenantId: "tenant-1",
      subjectId: null,
      sourceObservationId: null,
      extractorVersion: null,
      content: "本文",
      contentHash: "hash-extraction-failure-null",
      digest: "要旨",
      digestSource: "llm",
      provenance: { kind: "imported", batchId: "batch-1" },
      tags: [],
      occurredAt: null,
      recordedAt: new Date("2026-01-01T00:00:00.000Z"),
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours: 720,
      decayFloorAt: new Date("2026-06-01T00:00:00.000Z"),
      embeddingStatus: "pending",
    });
    const recallId = await createRecallFixture(stores, ctx);
    const result = await runtime.observe(ctx, {
      kind: "memory_usage",
      recallId,
      usedMemoryIds: [memory.id],
    });
    expect(result.extraction).toBe("skipped");
    expect(result.extractionFailure).toBeNull();
  });

  it("冪等な再送（extraction: 'skipped'）でも extractionFailure は null", async () => {
    const { runtime } = buildRuntime(
      llmReturning([{ content: "本文", digest: "要旨", provenanceKind: "stated" }]),
    );
    await runtime.observe(ctx, { kind: "utterance", text: "本文", externalId: "ext-failure-null" });
    const second = await runtime.observe(ctx, {
      kind: "utterance",
      text: "本文",
      externalId: "ext-failure-null",
    });
    expect(second.extraction).toBe("skipped");
    expect(second.extractionFailure).toBeNull();
  });

  it("deferred（extraction: 'skipped'）でも extractionFailure は null", async () => {
    const { runtime } = buildRuntime(llmReturning([]));
    const result = await runtime.observe(ctx, {
      kind: "utterance",
      text: "本文",
      extract: "deferred",
    });
    expect(result.extraction).toBe("skipped");
    expect(result.extractionFailure).toBeNull();
  });
});

describe("runtime.observe — extract: 'deferred'", () => {
  it("deferred では抽出されず、extract ジョブが outbox に残る", async () => {
    const { runtime, stores } = buildRuntime(
      llmReturning([{ content: "本文", digest: "要旨", provenanceKind: "stated" }]),
    );
    const result = await runtime.observe(ctx, {
      kind: "utterance",
      text: "本文",
      extract: "deferred",
    });
    expect(result.extraction).toBe("skipped");
    expect(result.memoryIds).toEqual([]);

    const pending = await stores.outboxStore.claimBatch(ctx, {
      kinds: ["extract"],
      limit: 10,
      now: new Date(),
      claimedBy: "test",
      leaseMs: TEST_LEASE_MS,
    });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.payload.observationId).toBe(result.observationId);
  });

  it("runtime.tick で deferred の extract ジョブを消化すると Memory が作られる", async () => {
    const { runtime, stores } = buildRuntime(
      llmReturning([{ content: "本文", digest: "要旨", provenanceKind: "stated" }]),
    );
    const result = await runtime.observe(ctx, {
      kind: "utterance",
      text: "本文",
      extract: "deferred",
    });
    expect(result.memoryIds).toEqual([]);

    const tickResult = await runtime.tick(ctx, { kinds: ["extract"], leaseMs: TEST_LEASE_MS });
    expect(tickResult).toEqual({ processed: 1, failed: 0, unsupported: [], leaseConflicts: [] });

    const aggregate = await stores.memoryStore.aggregateScope(ctx, {});
    expect(aggregate.totalInScope).toBe(1);
  });
});

describe("runtime.observe — 冪等性（roadmap.md 段階3の完了条件）", () => {
  it("同じ externalId の Observation を二重に送っても Memory が重複して作られない", async () => {
    const { runtime, stores } = buildRuntime(
      llmReturning([{ content: "本文", digest: "要旨", provenanceKind: "stated" }]),
    );
    const first = await runtime.observe(ctx, {
      kind: "utterance",
      text: "本文",
      externalId: "ext-1",
    });
    const second = await runtime.observe(ctx, {
      kind: "utterance",
      text: "本文（無視されるべき別内容）",
      externalId: "ext-1",
    });

    expect(second.observationId).toBe(first.observationId);
    expect(second.extraction).toBe("skipped");
    expect(second.memoryIds).toEqual([]);

    const aggregate = await stores.memoryStore.aggregateScope(ctx, {});
    expect(aggregate.totalInScope).toBe(1);
  });

  it("冪等な再送では新しい outbox ジョブを積まない", async () => {
    const { runtime, stores } = buildRuntime(
      llmReturning([{ content: "本文", digest: "要旨", provenanceKind: "stated" }]),
    );
    await runtime.observe(ctx, { kind: "utterance", text: "本文", externalId: "ext-2" });
    await runtime.observe(ctx, { kind: "utterance", text: "本文", externalId: "ext-2" });

    const pending = await stores.outboxStore.claimBatch(ctx, {
      kinds: ["embed"],
      limit: 10,
      now: new Date(),
      claimedBy: "test",
      leaseMs: TEST_LEASE_MS,
    });
    expect(pending).toHaveLength(1);
  });
});

describe("runtime.observe — memory_usage（ADR 0009）", () => {
  it("使用報告は抽出器を通らず、recall_usages への挿入と reinforce だけを行う", async () => {
    const { runtime, stores } = buildRuntime(llmReturning([]));
    const memory = await stores.memoryStore.createMemory(ctx, {
      tenantId: "tenant-1",
      subjectId: null,
      sourceObservationId: null,
      extractorVersion: null,
      content: "本文",
      contentHash: "hash",
      digest: "要旨",
      digestSource: "llm",
      provenance: { kind: "imported", batchId: "batch-1" },
      tags: [],
      occurredAt: null,
      recordedAt: new Date("2026-01-01T00:00:00.000Z"),
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours: 720,
      decayFloorAt: new Date("2026-06-01T00:00:00.000Z"),
      embeddingStatus: "pending",
    });

    const recallId = await createRecallFixture(stores, ctx);
    const result = await runtime.observe(ctx, {
      kind: "memory_usage",
      recallId,
      usedMemoryIds: [memory.id],
    });

    expect(result.extraction).toBe("skipped");
    expect(result.memoryIds).toEqual([memory.id]);
    const reinforced = await stores.memoryStore.get(ctx, memory.id);
    expect(reinforced?.lastReinforcedAt).not.toBeNull();
  });

  it("同じ (recallId, memoryId) の再送では reinforce が二重に走らない（insertedMemoryIds が空）", async () => {
    const { runtime, stores } = buildRuntime(llmReturning([]));
    const memory = await stores.memoryStore.createMemory(ctx, {
      tenantId: "tenant-1",
      subjectId: null,
      sourceObservationId: null,
      extractorVersion: null,
      content: "本文",
      contentHash: "hash",
      digest: "要旨",
      digestSource: "llm",
      provenance: { kind: "imported", batchId: "batch-1" },
      tags: [],
      occurredAt: null,
      recordedAt: new Date("2026-01-01T00:00:00.000Z"),
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours: 720,
      decayFloorAt: new Date("2026-06-01T00:00:00.000Z"),
      embeddingStatus: "pending",
    });

    const recallId = await createRecallFixture(stores, ctx);
    await runtime.observe(ctx, {
      kind: "memory_usage",
      recallId,
      usedMemoryIds: [memory.id],
    });
    const second = await runtime.observe(ctx, {
      kind: "memory_usage",
      recallId,
      usedMemoryIds: [memory.id],
    });
    expect(second.memoryIds).toEqual([]);
  });

  /**
   * `FakeMemoryStore` は `reinforceMany` を実装している（既定では「口が在る」側の経路を通る）ので、「口が無い」側は
   * `undefined` を代入して prototype を隠す作法で個別に検査する。
   */
  it("MemoryStore.reinforceMany が在るときはそれを1回だけ呼び、reinforce を1件ずつは呼ばない", async () => {
    const { runtime, stores } = buildRuntime(llmReturning([]));
    const memories = await Promise.all(
      [0, 1, 2].map((i) =>
        stores.memoryStore.createMemory(ctx, {
          tenantId: "tenant-1",
          subjectId: null,
          sourceObservationId: null,
          extractorVersion: null,
          content: "本文",
          contentHash: `hash-${i}`,
          digest: "要旨",
          digestSource: "llm",
          provenance: { kind: "imported", batchId: "batch-1" },
          tags: [],
          occurredAt: null,
          recordedAt: new Date("2026-01-01T00:00:00.000Z"),
          lastReinforcedAt: null,
          strength: 1,
          halfLifeHours: 720,
          decayFloorAt: new Date("2026-06-01T00:00:00.000Z"),
          embeddingStatus: "pending",
        }),
      ),
    );

    // `recordUsageAndReinforce`（任意）が在ると記録と強化を1つの口で撃ち、下の2段の経路（`reinforceMany` / 1件ずつの `reinforce`）を通らない。
    // この歯が見るのは2段の経路の分岐なので、その口を持たない adapter を模す。
    (stores.memoryStore as { recordUsageAndReinforce?: unknown }).recordUsageAndReinforce =
      undefined;
    const recallId = await createRecallFixture(stores, ctx);
    // `reinforce` 自体は spy しない: `FakeMemoryStore.reinforceMany` は `reinforce` を呼び回す素直な実装なので、`reinforceMany` が実際に
    // 呼ばれても内部で `reinforce` が複数回呼ばれる。検査したいのは fake の内部実装ではなく、`runtime.ts` が
    // 「口が在るときは `reinforceMany` を1回呼ぶ」という分岐を選んだことだけである。
    const reinforceManySpy = vi.spyOn(stores.memoryStore, "reinforceMany");

    const result = await runtime.observe(ctx, {
      kind: "memory_usage",
      recallId,
      usedMemoryIds: memories.map((m) => m.id),
    });

    expect(result.memoryIds).toEqual(memories.map((m) => m.id));
    expect(reinforceManySpy).toHaveBeenCalledTimes(1);
    expect(reinforceManySpy.mock.calls[0]?.[1]).toEqual(memories.map((m) => m.id));
    for (const memory of memories) {
      const reinforced = await stores.memoryStore.get(ctx, memory.id);
      expect(reinforced?.lastReinforcedAt).not.toBeNull();
    }
  });

  it("MemoryStore.reinforceMany が無いときは従来どおり reinforce を1件ずつ呼ぶ（挙動は変えない）", async () => {
    const { runtime, stores } = buildRuntime(llmReturning([]));
    const memories = await Promise.all(
      [0, 1, 2].map((i) =>
        stores.memoryStore.createMemory(ctx, {
          tenantId: "tenant-1",
          subjectId: null,
          sourceObservationId: null,
          extractorVersion: null,
          content: "本文",
          contentHash: `hash-fallback-${i}`,
          digest: "要旨",
          digestSource: "llm",
          provenance: { kind: "imported", batchId: "batch-1" },
          tags: [],
          occurredAt: null,
          recordedAt: new Date("2026-01-01T00:00:00.000Z"),
          lastReinforcedAt: null,
          strength: 1,
          halfLifeHours: 720,
          decayFloorAt: new Date("2026-06-01T00:00:00.000Z"),
          embeddingStatus: "pending",
        }),
      ),
    );

    // 口を持たない adapter を模す（`delete` では消えない。クラスのメソッドは prototype に在る）。
    (stores.memoryStore as { recordUsageAndReinforce?: unknown }).recordUsageAndReinforce =
      undefined;
    (stores.memoryStore as { reinforceMany?: unknown }).reinforceMany = undefined;
    const reinforceSpy = vi.spyOn(stores.memoryStore, "reinforce");

    const recallId = await createRecallFixture(stores, ctx);
    const result = await runtime.observe(ctx, {
      kind: "memory_usage",
      recallId,
      usedMemoryIds: memories.map((m) => m.id),
    });

    expect(result.memoryIds).toEqual(memories.map((m) => m.id));
    expect(reinforceSpy).toHaveBeenCalledTimes(memories.length);
    for (const memory of memories) {
      const reinforced = await stores.memoryStore.get(ctx, memory.id);
      expect(reinforced?.lastReinforcedAt).not.toBeNull();
    }
  });

  it("insertedMemoryIds が空なら reinforceMany を呼ばない（従来のループも0回だったのと同じ）", async () => {
    const { runtime, stores } = buildRuntime(llmReturning([]));
    const memory = await stores.memoryStore.createMemory(ctx, {
      tenantId: "tenant-1",
      subjectId: null,
      sourceObservationId: null,
      extractorVersion: null,
      content: "本文",
      contentHash: "hash-empty",
      digest: "要旨",
      digestSource: "llm",
      provenance: { kind: "imported", batchId: "batch-1" },
      tags: [],
      occurredAt: null,
      recordedAt: new Date("2026-01-01T00:00:00.000Z"),
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours: 720,
      decayFloorAt: new Date("2026-06-01T00:00:00.000Z"),
      embeddingStatus: "pending",
    });
    const recallId = await createRecallFixture(stores, ctx);
    await runtime.observe(ctx, { kind: "memory_usage", recallId, usedMemoryIds: [memory.id] });

    const reinforceManySpy = vi.spyOn(stores.memoryStore, "reinforceMany");
    const result = await runtime.observe(ctx, {
      kind: "memory_usage",
      recallId,
      usedMemoryIds: [memory.id],
    });

    expect(result.memoryIds).toEqual([]);
    expect(reinforceManySpy).not.toHaveBeenCalled();
  });

  it("2段の経路（recordUsageAndReinforce が無い adapter）でも、insertedMemoryIds が空なら reinforceMany を呼ばない", async () => {
    // 上の歯は `recordUsageAndReinforce` の経路を通り、2段の経路の「空なら呼ばない」分岐には届かない。
    // 口を持たない adapter を模して、その分岐を見る。
    const { runtime, stores } = buildRuntime(llmReturning([]));
    const memory = await stores.memoryStore.createMemory(ctx, {
      tenantId: "tenant-1",
      subjectId: null,
      sourceObservationId: null,
      extractorVersion: null,
      content: "本文",
      contentHash: "hash-empty-two-step",
      digest: "要旨",
      digestSource: "llm",
      provenance: { kind: "imported", batchId: "batch-1" },
      tags: [],
      occurredAt: null,
      recordedAt: new Date("2026-01-01T00:00:00.000Z"),
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours: 720,
      decayFloorAt: new Date("2026-06-01T00:00:00.000Z"),
      embeddingStatus: "pending",
    });
    (stores.memoryStore as { recordUsageAndReinforce?: unknown }).recordUsageAndReinforce =
      undefined;
    const recallId = await createRecallFixture(stores, ctx);
    await runtime.observe(ctx, { kind: "memory_usage", recallId, usedMemoryIds: [memory.id] });

    const reinforceManySpy = vi.spyOn(stores.memoryStore, "reinforceMany");
    const reinforceSpy = vi.spyOn(stores.memoryStore, "reinforce");
    const result = await runtime.observe(ctx, {
      kind: "memory_usage",
      recallId,
      usedMemoryIds: [memory.id],
    });

    expect(result.memoryIds).toEqual([]);
    expect(reinforceManySpy).not.toHaveBeenCalled();
    expect(reinforceSpy).not.toHaveBeenCalled();
  });
});

describe("runtime.observe — memory_usage の externalId 冪等性（Issue #870）", () => {
  function observationsBacking(stores: { memoryStore: FakeMemoryStore }) {
    // Fake の裏の Map を直接数える（`FakeMemoryStore` に列挙の口が無いため）。
    return (
      stores.memoryStore as unknown as {
        backing: { observations: Map<string, { kind: string; tenantId: string }> };
      }
    ).backing.observations;
  }

  async function createUsageMemory(stores: { memoryStore: FakeMemoryStore }) {
    return stores.memoryStore.createMemory(ctx, {
      tenantId: "tenant-1",
      subjectId: null,
      sourceObservationId: null,
      extractorVersion: null,
      content: "本文",
      contentHash: `hash-${Math.random()}`,
      digest: "要旨",
      digestSource: "llm",
      provenance: { kind: "imported", batchId: "batch-1" },
      tags: [],
      occurredAt: null,
      recordedAt: new Date("2026-01-01T00:00:00.000Z"),
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours: 720,
      decayFloorAt: new Date("2026-06-01T00:00:00.000Z"),
      embeddingStatus: "pending",
    });
  }

  it("同じ externalId で memory_usage を2回送ると observationId が同じで、observations の usage 行は1件のまま", async () => {
    const { runtime, stores } = buildRuntime(llmReturning([]));
    const memory = await createUsageMemory(stores);
    const recallId = await createRecallFixture(stores, ctx);

    const first = await runtime.observe(ctx, {
      kind: "memory_usage",
      externalId: "usage-ext-1",
      recallId,
      usedMemoryIds: [memory.id],
    });
    const second = await runtime.observe(ctx, {
      kind: "memory_usage",
      externalId: "usage-ext-1",
      recallId,
      usedMemoryIds: [memory.id],
    });

    expect(second.observationId).toBe(first.observationId);
    expect(second.memoryIds).toEqual([]);
    expect(second.extraction).toBe("skipped");

    const usageRows = [...observationsBacking(stores).values()].filter(
      (o) => o.tenantId === "tenant-1" && o.kind === "usage",
    );
    expect(usageRows).toHaveLength(1);
  });

  it("externalId を渡さない2回は observationId が別のまま（今の振る舞いの固定）", async () => {
    const { runtime, stores } = buildRuntime(llmReturning([]));
    const memory = await createUsageMemory(stores);
    const recallId = await createRecallFixture(stores, ctx);

    const first = await runtime.observe(ctx, {
      kind: "memory_usage",
      recallId,
      usedMemoryIds: [memory.id],
    });
    const second = await runtime.observe(ctx, {
      kind: "memory_usage",
      recallId,
      usedMemoryIds: [memory.id],
    });

    expect(second.observationId).not.toBe(first.observationId);
  });

  it("初回が recordUsage 前に落ちた想定（observation だけ在る）から再送すると、使用が記録・強化される", async () => {
    const { runtime, stores } = buildRuntime(llmReturning([]));
    const memory = await createUsageMemory(stores);
    const recallId = await createRecallFixture(stores, ctx);

    // 初回呼び出しが createObservation の直後・recordUsage の手前で落ちた状況を模す
    // ——observation だけを直接作る（handleMemoryUsage を経由しない）。
    const crashedObservation = await stores.memoryStore.createObservation(ctx, {
      tenantId: "tenant-1",
      subjectId: null,
      externalId: "usage-ext-retry",
      kind: "usage",
      payload: { recallId, usedMemoryIds: [memory.id] },
      occurredAt: null,
      recordedAt: new Date(),
    });

    const retry = await runtime.observe(ctx, {
      kind: "memory_usage",
      externalId: "usage-ext-retry",
      recallId,
      usedMemoryIds: [memory.id],
    });

    expect(retry.observationId).toBe(crashedObservation.id);
    expect(retry.memoryIds).toEqual([memory.id]);
    const reinforced = await stores.memoryStore.get(ctx, memory.id);
    expect(reinforced?.lastReinforcedAt).not.toBeNull();
  });

  it("別 kind と externalId が衝突したら recordUsage を呼ばず、他 kind の再送と同じ形で返す", async () => {
    const { runtime, stores } = buildRuntime(llmReturning([]));
    const memory = await createUsageMemory(stores);
    const recallId = await createRecallFixture(stores, ctx);

    const utteranceObservation = await stores.memoryStore.createObservation(ctx, {
      tenantId: "tenant-1",
      subjectId: null,
      externalId: "usage-ext-conflict",
      kind: "utterance",
      payload: { text: "別 kind の観測" },
      occurredAt: null,
      recordedAt: new Date(),
    });

    const result = await runtime.observe(ctx, {
      kind: "memory_usage",
      externalId: "usage-ext-conflict",
      recallId,
      usedMemoryIds: [memory.id],
    });

    expect(result.observationId).toBe(utteranceObservation.id);
    expect(result.memoryIds).toEqual([]);
    expect(result.extraction).toBe("skipped");
    const notReinforced = await stores.memoryStore.get(ctx, memory.id);
    expect(notReinforced?.lastReinforcedAt).toBeNull();
  });
});

describe("runtime.tick — embed ジョブ（embeddingStatus の遷移）", () => {
  it("embed ジョブを処理すると embeddingStatus が 'ready' になり、vector が upsert される", async () => {
    const { runtime, stores } = buildRuntime(
      llmReturning([{ content: "本文", digest: "要旨", provenanceKind: "stated" }]),
    );
    const observeResult = await runtime.observe(ctx, { kind: "utterance", text: "本文" });
    const memoryId = observeResult.memoryIds[0]!;

    const tickResult = await runtime.tick(ctx, { kinds: ["embed"], leaseMs: TEST_LEASE_MS });
    expect(tickResult).toEqual({ processed: 1, failed: 0, unsupported: [], leaseConflicts: [] });

    const memory = await stores.memoryStore.get(ctx, memoryId);
    expect(memory?.embeddingStatus).toBe("ready");
    expect(stores.vectorStore.entries.size).toBe(1);
  });

  it("embedding provider が失敗すると embeddingStatus が 'failed' になり、tick は failed をカウントする", async () => {
    const { runtime, stores } = buildRuntime(
      llmReturning([{ content: "本文", digest: "要旨", provenanceKind: "stated" }]),
    );
    const observeResult = await runtime.observe(ctx, { kind: "utterance", text: "本文" });
    const memoryId = observeResult.memoryIds[0]!;

    stores.embeddingProvider.shouldFail = true;
    const tickResult = await runtime.tick(ctx, { kinds: ["embed"], leaseMs: TEST_LEASE_MS });
    expect(tickResult).toEqual({ processed: 0, failed: 1, unsupported: [], leaseConflicts: [] });

    const memory = await stores.memoryStore.get(ctx, memoryId);
    expect(memory?.embeddingStatus).toBe("failed");
  });

  /**
   * `observe({ kind: 'document' })` の `content` に上限は無い。LLM 抽出が失敗すると全文が1件の候補になり、`EmbeddingProvider` の契約どおりに reject する provider を使ったとき、
   * content は黙って切り詰められず、embeddingStatus は 'failed' になり、tick はそれを failed として数える。
   */
  it("LLM抽出が失敗して全文フォールバックになった Memory を、上限超過で reject する embeddingProvider に渡すと、content は全文のまま embeddingStatus が 'failed' になり、tick はそれを failed として数える（Issue #449）", async () => {
    const hugeContent = "x".repeat(500);
    const overLimitEmbeddingProvider: EmbeddingProvider = {
      space: { provider: "fake-over-limit", model: "fake-over-limit-model", dimensions: 2 },
      embed: async (_ctx, texts) => {
        const tooLong = texts.find((text) => text.length > 100);
        if (tooLong !== undefined) {
          throw new Error("simulated input_too_long: input exceeds provider limit");
        }
        return texts.map(() => [0, 0]);
      },
    };
    const { runtime, stores } = buildRuntime(throwingLlm(), {
      embeddingProvider: overLimitEmbeddingProvider,
    });

    const observeResult = await runtime.observe(ctx, { kind: "document", content: hugeContent });
    expect(observeResult.extraction).toBe("llm_failed_whole_observation");
    const memoryId = observeResult.memoryIds[0]!;

    const beforeTick = await stores.memoryStore.get(ctx, memoryId);
    expect(beforeTick?.content).toBe(hugeContent);

    const tickResult = await runtime.tick(ctx, { kinds: ["embed"], leaseMs: TEST_LEASE_MS });

    expect(tickResult).toEqual({ processed: 0, failed: 1, unsupported: [], leaseConflicts: [] });

    const afterTick = await stores.memoryStore.get(ctx, memoryId);
    expect(afterTick?.content).toBe(hugeContent);
    expect(afterTick?.embeddingStatus).toBe("failed");
  });
});

describe("runtime.reembed（ADR 0079: provider が直った後に、索引へ戻す）", () => {
  /**
   * provider が落ちている間に `observe()` → `tick()` が失敗（`embeddingStatus` は `failed`・outbox 行は `failed_at`＝終端）→ provider が直る →
   * `tick()` をもう一度呼んでも何も起きない（`fail` は終端で、`claimBatch` は `failed_at IS NULL` を要求する）→ `reembed()` → 次の `tick()` で `ready`。
   * 「直った後の `tick()` が何も起こさない」段を落とすと、この歯は「そもそも直っていた」を検査したことになる。
   */
  it("provider が落ちている間に入った Memory は、tick を繰り返しても索引へ戻らない。reembed してから tick すると ready になる", async () => {
    const { runtime, stores } = buildRuntime(
      llmReturning([{ content: "本文", digest: "要旨", provenanceKind: "stated" }]),
    );
    stores.embeddingProvider.shouldFail = true;
    const observeResult = await runtime.observe(ctx, { kind: "utterance", text: "本文" });
    const memoryId = observeResult.memoryIds[0]!;

    const failedTick = await runtime.tick(ctx, { kinds: ["embed"], leaseMs: TEST_LEASE_MS });
    const afterFailure = (await stores.memoryStore.get(ctx, memoryId))?.embeddingStatus;

    stores.embeddingProvider.shouldFail = false;

    const uselessTick = await runtime.tick(ctx, { kinds: ["embed"], leaseMs: TEST_LEASE_MS });
    const stillFailed = (await stores.memoryStore.get(ctx, memoryId))?.embeddingStatus;

    const reembedResult = await runtime.reembed(ctx, { statuses: ["failed"], limit: 10 });
    // ⚠ `reembed` は積み直すだけで、埋め込みそのものは行わない——**この時点ではまだ
    // ベクトルは入っていない。**次の `tick()` が入れる。
    const vectorsRightAfterReembed = stores.vectorStore.entries.size;

    const healingTick = await runtime.tick(ctx, { kinds: ["embed"], leaseMs: TEST_LEASE_MS });
    const healed = (await stores.memoryStore.get(ctx, memoryId))?.embeddingStatus;

    expect({
      failedTick,
      afterFailure,
      uselessTick,
      stillFailed,
      reembedResult,
      vectorsRightAfterReembed,
      healingTick,
      healed,
      vectorsAfterHealingTick: stores.vectorStore.entries.size,
    }).toEqual({
      failedTick: { processed: 0, failed: 1, unsupported: [], leaseConflicts: [] },
      afterFailure: "failed",
      uselessTick: { processed: 0, failed: 0, unsupported: [], leaseConflicts: [] },
      stillFailed: "failed",
      reembedResult: { requeued: 1, memoryIds: [memoryId] },
      vectorsRightAfterReembed: 0,
      healingTick: { processed: 1, failed: 0, unsupported: [], leaseConflicts: [] },
      healed: "ready",
      vectorsAfterHealingTick: 1,
    });
  });

  it("reembed は対象が0件でも例外を投げず、tick も何も拾わない", async () => {
    const { runtime } = buildRuntime(llmReturning([]));

    const result = await runtime.reembed(ctx, { statuses: ["failed", "pending"], limit: 10 });
    const tickResult = await runtime.tick(ctx, { kinds: ["embed"], leaseMs: TEST_LEASE_MS });

    expect({ result, tickResult }).toEqual({
      result: { requeued: 0, memoryIds: [] },
      tickResult: { processed: 0, failed: 0, unsupported: [], leaseConflicts: [] },
    });
  });
});

/**
 * `RuntimeDeps.embeddingInput`（任意の opt-in フック）は、`processEmbedJob` が `embed()` へ送る文字列を差し替える（`Memory.content` 自体は変えない）。
 * 1本目はフックを注入した runtime で `reembed()` → `tick()` すると `ready` になる陽性対照。
 * 2本目はフックを渡さない runtime では、`reembed()` → `tick()` を繰り返しても `failed` のまま。
 */
describe("runtime.tick — processEmbedJob の embeddingInput opt-in フック（Issue #753）", () => {
  function overLimitEmbeddingProvider(): EmbeddingProvider {
    return {
      space: { provider: "fake-over-limit", model: "fake-over-limit-model", dimensions: 2 },
      embed: async (_ctx, texts) => {
        const tooLong = texts.find((text) => text.length > 100);
        if (tooLong !== undefined) {
          throw new Error("simulated input_too_long: input exceeds provider limit");
        }
        return texts.map(() => [0, 0]);
      },
    };
  }

  it("embeddingInput フックを渡した runtime で reembed + tick すると、failed だった Memory は ready になる。content は全文のまま変わらない", async () => {
    const hugeContent = "x".repeat(500);
    const provider = overLimitEmbeddingProvider();
    const { runtime, stores } = buildRuntime(throwingLlm(), { embeddingProvider: provider });

    const observeResult = await runtime.observe(ctx, { kind: "document", content: hugeContent });
    const memoryId = observeResult.memoryIds[0]!;

    const failedTick = await runtime.tick(ctx, { kinds: ["embed"], leaseMs: TEST_LEASE_MS });
    const afterFailureStatus = (await stores.memoryStore.get(ctx, memoryId))?.embeddingStatus;

    // 運用側が opt-in フックを足した runtime を、同じ store（同じ永続状態）に対して新たに立てる。runtime 自身は状態を持たず、状態は deps 側の store が持つ。
    const healingRuntime = createRuntime({
      memoryStore: stores.memoryStore,
      outboxStore: stores.outboxStore,
      vectorStore: stores.vectorStore,
      eventStore: stores.eventStore,
      tenantSettingsStore: stores.tenantSettingsStore,
      llmProvider: throwingLlm(),
      embeddingProvider: provider,
      hashContent: (content: string) => `sha256(${content})`,
      embeddingInput: (memory) => memory.content.slice(0, 50),
    });

    const reembedResult = await healingRuntime.reembed(ctx, { statuses: ["failed"], limit: 10 });
    const healingTick = await healingRuntime.tick(ctx, {
      kinds: ["embed"],
      leaseMs: TEST_LEASE_MS,
    });
    const healed = await stores.memoryStore.get(ctx, memoryId);

    expect({
      failedTick,
      afterFailureStatus,
      reembedResult,
      healingTick,
      healedStatus: healed?.embeddingStatus,
      healedContent: healed?.content,
    }).toEqual({
      failedTick: { processed: 0, failed: 1, unsupported: [], leaseConflicts: [] },
      afterFailureStatus: "failed",
      reembedResult: { requeued: 1, memoryIds: [memoryId] },
      healingTick: { processed: 1, failed: 0, unsupported: [], leaseConflicts: [] },
      healedStatus: "ready",
      healedContent: hugeContent,
    });
  });

  it("embeddingInput を渡さない runtime では、reembed + tick を繰り返しても同じ content をまた送ってしまい failed のまま（既定不変）", async () => {
    const hugeContent = "x".repeat(500);
    const provider = overLimitEmbeddingProvider();
    const { runtime, stores } = buildRuntime(throwingLlm(), { embeddingProvider: provider });

    const observeResult = await runtime.observe(ctx, { kind: "document", content: hugeContent });
    const memoryId = observeResult.memoryIds[0]!;

    await runtime.tick(ctx, { kinds: ["embed"], leaseMs: TEST_LEASE_MS });
    const reembedResult = await runtime.reembed(ctx, { statuses: ["failed"], limit: 10 });
    const secondTick = await runtime.tick(ctx, { kinds: ["embed"], leaseMs: TEST_LEASE_MS });
    const stillFailed = await stores.memoryStore.get(ctx, memoryId);

    expect({
      reembedResult,
      secondTick,
      stillFailedStatus: stillFailed?.embeddingStatus,
      stillFailedContent: stillFailed?.content,
    }).toEqual({
      reembedResult: { requeued: 1, memoryIds: [memoryId] },
      secondTick: { processed: 0, failed: 1, unsupported: [], leaseConflicts: [] },
      stillFailedStatus: "failed",
      stillFailedContent: hugeContent,
    });
  });
});

/**
 * `Runtime.getRecall` は `MemoryStore.getRecall` への素通しなので、`viaRuntime` と `stores.memoryStore.getRecall` を直接呼んだ結果が一致することを見る。
 * 値の中身（score/retrievedVia の形）の検査は `recall-runtime.ts` の歯の役目であり、ここでは行わない。
 */
describe("runtime.getRecall（Issue #312、ADR 0161: MemoryStore.getRecall への素通し）", () => {
  it("createRecall で書いた行を、memoryStore.getRecall と同じ内容で読み戻す", async () => {
    const { runtime, stores } = buildRuntime(llmReturning([]));
    const recallId = await createRecallFixture(stores, ctx);

    const viaRuntime = await runtime.getRecall(ctx, recallId);
    const viaStore = await stores.memoryStore.getRecall(ctx, recallId);

    expect(viaRuntime).not.toBeNull();
    expect(viaRuntime).toEqual(viaStore);
  });

  it("存在しない recallId には null を返す（例外にしない）", async () => {
    const { runtime } = buildRuntime(llmReturning([]));

    const result = await runtime.getRecall(ctx, "does-not-exist");

    expect(result).toBeNull();
  });

  it("別テナントの recallId には null を返す（tenant scoping）", async () => {
    const { runtime, stores } = buildRuntime(llmReturning([]));
    const recallId = await createRecallFixture(stores, ctx);
    const otherCtx: Ctx = { tenantId: "tenant-2" };

    const result = await runtime.getRecall(otherCtx, recallId);

    expect(result).toBeNull();
  });
});

/**
 * `MemoryStore.archiveDecayed` は任意メソッドで、`FakeMemoryStore` は実装しているので、既定では「口が在る」側（`supported: true`）の経路を通る。
 * 「口が無い」側（`supported: false`）は、`undefined` を代入して prototype を隠す作法で個別に検査する。
 */
async function createDecayedMemory(
  stores: ReturnType<typeof buildRuntime>["stores"],
  contentHash: string,
  decayFloorAt: Date,
  status: "active" | "contested" | "superseded" | "forgotten" | "archived" = "active",
) {
  return stores.memoryStore.createMemory(ctx, {
    tenantId: ctx.tenantId,
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: "本文",
    contentHash,
    digest: `要旨-${contentHash}`,
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "batch-1" },
    status,
    tags: [],
    occurredAt: null,
    recordedAt: new Date("2026-01-01T00:00:00.000Z"),
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 720,
    decayFloorAt,
    embeddingStatus: "pending",
  });
}

describe("runtime.sweepArchive（ADR 0114: 減衰しきった Memory の掃引）", () => {
  const NOW = new Date("2026-06-01T00:00:00.000Z");

  it("口が在る adapter では supported: true を名乗り、active かつ decayFloorAt <= now の Memory だけを archived にする", async () => {
    const { runtime, stores } = buildRuntime(llmReturning([]));
    const decayed = await createDecayedMemory(
      stores,
      "sweep-archive-decayed",
      new Date(NOW.getTime() - 1_000),
    );
    const notYet = await createDecayedMemory(
      stores,
      "sweep-archive-not-yet",
      new Date(NOW.getTime() + 1_000),
    );
    const contested = await createDecayedMemory(
      stores,
      "sweep-archive-contested",
      new Date(NOW.getTime() - 1_000),
      "contested",
    );

    const result = await runtime.sweepArchive(ctx, { now: NOW, limit: 10 });

    const decayedAfter = await stores.memoryStore.get(ctx, decayed.id);
    const notYetAfter = await stores.memoryStore.get(ctx, notYet.id);
    const contestedAfter = await stores.memoryStore.get(ctx, contested.id);

    expect({
      supported: result.supported,
      archivedIds: result.archived.map((a) => a.memoryId),
      reachedLimit: result.reachedLimit,
      decayedStatus: decayedAfter?.status,
      notYetStatus: notYetAfter?.status,
      contestedStatus: contestedAfter?.status,
    }).toEqual({
      supported: true,
      archivedIds: [decayed.id],
      reachedLimit: false,
      decayedStatus: "archived",
      notYetStatus: "active",
      contestedStatus: "contested",
    });
  });

  it("口が無い adapter では supported: false を名乗り、archived は常に空・reachedLimit は常に false（黙って0件を返さない、ADR 0082 と同じ哲学）", async () => {
    const { runtime, stores } = buildRuntime(llmReturning([]));
    await createDecayedMemory(stores, "sweep-archive-unsupported", new Date(NOW.getTime() - 1_000));

    // 口を持たない adapter を模す（`delete` では消えない。クラスのメソッドは prototype に在る）。
    (stores.memoryStore as { archiveDecayed?: unknown }).archiveDecayed = undefined;

    const result = await runtime.sweepArchive(ctx, { now: NOW, limit: 10 });

    expect(result).toEqual({ supported: false, archived: [], reachedLimit: false });
  });

  it("この掃引は tick() からは自動で走らない", async () => {
    const { runtime, stores } = buildRuntime(llmReturning([]));
    const decayed = await createDecayedMemory(
      stores,
      "sweep-archive-not-automatic",
      new Date(NOW.getTime() - 1_000),
    );

    await runtime.tick(ctx, { kinds: ["embed"], leaseMs: TEST_LEASE_MS });

    const after = await stores.memoryStore.get(ctx, decayed.id);
    expect(after?.status).toBe("active");
  });

  it("対象が0件でも例外を投げない", async () => {
    const { runtime } = buildRuntime(llmReturning([]));

    const result = await runtime.sweepArchive(ctx, { now: NOW, limit: 10 });

    expect(result).toEqual({ supported: true, archived: [], reachedLimit: false });
  });
});

/**
 * ここで検査しているのは「`Runtime.sweepArchive` が `MemoryStore.archiveDecayed` へどんな `opts` を渡すか」であって、
 * `FakeMemoryStore.archiveDecayed` 自身が `clock`/`nowSeq` に応じて対象を絞り込むかどうかではない（`FakeMemoryStore` は壁時計の `decayFloorAt` だけで絞る素朴な実装）。
 * `vi.spyOn` で `archiveDecayed`/`getActivitySeq` の呼び出しそのものを観測する。
 */
describe("runtime.sweepArchive が opts.clock 省略時に decay_clock へ従う（Issue #364 / ADR 0186）", () => {
  const NOW = new Date("2026-06-01T00:00:00.000Z");

  it("decay_clock='activity' のテナントでは、clock 省略時に store へ clock: 'activity' と数値の nowSeq が渡る", async () => {
    const { runtime, stores } = buildRuntime(llmReturning([]));
    await stores.tenantSettingsStore.setDecayClock(ctx, "activity");
    const archiveDecayedSpy = vi.spyOn(stores.memoryStore, "archiveDecayed");

    await runtime.sweepArchive(ctx, { now: NOW, limit: 10 });

    expect(archiveDecayedSpy).toHaveBeenCalledTimes(1);
    const passedOpts = archiveDecayedSpy.mock.calls[0]?.[1];
    expect(passedOpts?.clock).toBe("activity");
    expect(typeof passedOpts?.nowSeq).toBe("number");
  });

  it("decay_clock 未設定（既定 'wall'）のテナントでは、clock: 'wall' 相当が渡り、tenant_activity（getActivitySeq）を読まない", async () => {
    const { runtime, stores } = buildRuntime(llmReturning([]));
    const archiveDecayedSpy = vi.spyOn(stores.memoryStore, "archiveDecayed");
    const getActivitySeqSpy = vi.spyOn(stores.tenantSettingsStore, "getActivitySeq");

    await runtime.sweepArchive(ctx, { now: NOW, limit: 10 });

    expect(archiveDecayedSpy).toHaveBeenCalledTimes(1);
    const passedOpts = archiveDecayedSpy.mock.calls[0]?.[1];
    expect(passedOpts?.clock).toBe("wall");
    expect(passedOpts?.nowSeq).toBeUndefined();
    expect(getActivitySeqSpy).not.toHaveBeenCalled();
  });

  it("opts.clock を明示で渡したら、decay_clock（'activity'）の値に関わらずそちらが勝つ", async () => {
    const { runtime, stores } = buildRuntime(llmReturning([]));
    await stores.tenantSettingsStore.setDecayClock(ctx, "activity");
    const archiveDecayedSpy = vi.spyOn(stores.memoryStore, "archiveDecayed");

    await runtime.sweepArchive(ctx, { now: NOW, limit: 10, clock: "wall" });

    expect(archiveDecayedSpy).toHaveBeenCalledTimes(1);
    const passedOpts = archiveDecayedSpy.mock.calls[0]?.[1];
    expect(passedOpts?.clock).toBe("wall");
    expect(passedOpts?.nowSeq).toBeUndefined();
  });

  it("decay_clock='either' でも数値の nowSeq が渡る", async () => {
    const { runtime, stores } = buildRuntime(llmReturning([]));
    await stores.tenantSettingsStore.setDecayClock(ctx, "either");
    const archiveDecayedSpy = vi.spyOn(stores.memoryStore, "archiveDecayed");

    await runtime.sweepArchive(ctx, { now: NOW, limit: 10 });

    expect(archiveDecayedSpy).toHaveBeenCalledTimes(1);
    const passedOpts = archiveDecayedSpy.mock.calls[0]?.[1];
    expect(passedOpts?.clock).toBe("either");
    expect(typeof passedOpts?.nowSeq).toBe("number");
  });

  // `opts.clock` を明示しても、`'wall'` 以外で `opts.nowSeq` を省けば tenant_activity は読む。読まないのは `decay_clock`（tenant_settings）のほうだけ。
  it("clock: 'activity' を明示して nowSeq を省くと、decay_clock は読まず、tenant_activity は1回読む", async () => {
    const { runtime, stores } = buildRuntime(llmReturning([]));
    const archiveDecayedSpy = vi.spyOn(stores.memoryStore, "archiveDecayed");
    const getDecayClockSpy = vi.spyOn(stores.tenantSettingsStore, "getDecayClock");
    const getActivitySeqSpy = vi.spyOn(stores.tenantSettingsStore, "getActivitySeq");

    await runtime.sweepArchive(ctx, { now: NOW, limit: 10, clock: "activity" });

    expect(getDecayClockSpy).not.toHaveBeenCalled();
    expect(getActivitySeqSpy).toHaveBeenCalledTimes(1);
    const passedOpts = archiveDecayedSpy.mock.calls[0]?.[1];
    expect(passedOpts?.clock).toBe("activity");
    expect(typeof passedOpts?.nowSeq).toBe("number");
  });

  it("clock と nowSeq の両方を明示すると、tenant_settings も tenant_activity も読まない", async () => {
    const { runtime, stores } = buildRuntime(llmReturning([]));
    const archiveDecayedSpy = vi.spyOn(stores.memoryStore, "archiveDecayed");
    const getDecayClockSpy = vi.spyOn(stores.tenantSettingsStore, "getDecayClock");
    const getActivitySeqSpy = vi.spyOn(stores.tenantSettingsStore, "getActivitySeq");

    await runtime.sweepArchive(ctx, { now: NOW, limit: 10, clock: "either", nowSeq: 7 });

    expect(getDecayClockSpy).not.toHaveBeenCalled();
    expect(getActivitySeqSpy).not.toHaveBeenCalled();
    const passedOpts = archiveDecayedSpy.mock.calls[0]?.[1];
    expect(passedOpts?.clock).toBe("either");
    expect(passedOpts?.nowSeq).toBe(7);
  });
});

/**
 * `failed` という1つの数では足りない: 「embed の provider が落ちて失敗した」と「`tick` がその kind を処理できない」は、
 * どちらも終端の失敗だが呼び出し側が次に取る手が違う（前者は provider を直して `reembed`、後者はそもそも `tick` に頼む相手が違う）。
 * `failed: 1` だけを返すとこの2つが同じ顔になる。
 */
describe("runtime.tick — 対応していない outbox job kind（ADR 0082 / issue #105）", () => {
  /** 利用者が独自に足した kind。`TICK_SUPPORTED_JOB_KINDS` に**永久に**入らない側の代表。 */
  const CUSTOM_KIND = "gurumi-chan:notify-slack";

  async function enqueueJobOfKind(
    stores: ReturnType<typeof buildRuntime>["stores"],
    kind: string,
  ): Promise<string> {
    const { jobs } = await stores.memoryStore.createObservationWithOutbox(
      ctx,
      { tenantId: "tenant-1", subjectId: null, externalId: null, kind: "utterance", payload: {} },
      [kind],
    );
    expect(jobs).toHaveLength(1);
    return jobs[0]!.id;
  }

  it("⭐ 呼び出し側が独自に足した kind を明示的に渡すと、TickResult.unsupported に名指しで出る", async () => {
    const { runtime, stores } = buildRuntime(llmReturning([]));
    const jobId = await enqueueJobOfKind(stores, CUSTOM_KIND);

    const tickResult = await runtime.tick(ctx, { kinds: [CUSTOM_KIND], leaseMs: TEST_LEASE_MS });

    expect(tickResult).toEqual({
      processed: 0,
      failed: 1,
      unsupported: [{ jobId, kind: CUSTOM_KIND }],
      leaseConflicts: [],
    });
  });

  it("⭐ 芯: 「処理を試みて失敗した」と「対応していない kind だった」が、同じ tick の中で別の顔になる", async () => {
    // 同じ1回の tick で2件を拾わせる: embed ジョブ 1件（provider が落ちていて失敗する＝試して失敗した）と、
    // 対応していない kind 1件（試すまでもなく処理できない）。`failed: 2` は両者を足した数で、どちらがどちらか言わない。
    // `unsupported` だけが後者を名指しする。
    const { runtime, stores } = buildRuntime(
      llmReturning([{ content: "本文", digest: "要旨", provenanceKind: "stated" }]),
    );
    await runtime.observe(ctx, { kind: "utterance", text: "本文" });
    const unsupportedJobId = await enqueueJobOfKind(stores, CUSTOM_KIND);
    stores.embeddingProvider.shouldFail = true;

    const tickResult = await runtime.tick(ctx, {
      kinds: ["embed", CUSTOM_KIND],
      leaseMs: TEST_LEASE_MS,
    });

    expect(tickResult).toEqual({
      processed: 0,
      failed: 2,
      unsupported: [{ jobId: unsupportedJobId, kind: CUSTOM_KIND }],
      leaseConflicts: [],
    });
  });

  it("⭐ 黙って lease 切れを待たない: 対応していない kind は終端で落ち、2回目の tick では claim されない", async () => {
    const { runtime, stores } = buildRuntime(llmReturning([]));
    const jobId = await enqueueJobOfKind(stores, CUSTOM_KIND);

    const first = await runtime.tick(ctx, { kinds: [CUSTOM_KIND], leaseMs: TEST_LEASE_MS });
    expect(first.unsupported).toEqual([{ jobId, kind: CUSTOM_KIND }]);

    // outbox 行は終端（failedAt が付く）。`last_error` にも kind が名指しで残る——
    // `TickResult` を捨ててしまった後から DB だけを見た人にも同じ結論が届くように。
    const rowAfterFirst = stores.outboxStore.listJobs(ctx).find((job) => job.id === jobId)!;
    expect(rowAfterFirst.failedAt).not.toBeNull();
    expect(rowAfterFirst.lastError).toBe(`${UNSUPPORTED_KIND_ERROR_PREFIX}${CUSTOM_KIND}`);

    const second = await runtime.tick(ctx, { kinds: [CUSTOM_KIND], leaseMs: TEST_LEASE_MS });
    expect(second).toEqual({ processed: 0, failed: 0, unsupported: [], leaseConflicts: [] });
    expect(stores.outboxStore.listJobs(ctx).find((job) => job.id === jobId)!.attempts).toBe(1);
  });

  /**
   * `kind` は DB の `text` 列から来る任意の文字列で、`OutboxJobKind` は開いたユニオンなので型でも止まらない。
   * ハンドラの索引にプレーンなオブジェクトを使うと、`kind` が `"constructor"` / `"toString"` のときに `Object.prototype` 側の関数が返ってしまい、
   * 「対応している」と誤判定して呼ぶ。
   */
  it.each(["constructor", "toString", "__proto__", "hasOwnProperty"])(
    "⭐ kind が '%s' でも prototype の関数をハンドラと取り違えず、unsupported に出る",
    async (kind) => {
      const { runtime, stores } = buildRuntime(llmReturning([]));
      const jobId = await enqueueJobOfKind(stores, kind);

      const tickResult = await runtime.tick(ctx, { kinds: [kind], leaseMs: TEST_LEASE_MS });

      expect(tickResult).toEqual({
        processed: 0,
        failed: 1,
        unsupported: [{ jobId, kind }],
        leaseConflicts: [],
      });
    },
  );

  it("⭐ 頼まれていない kind は claim すらしない: 既定の kinds では、対応していない kind の行は無傷で残る", async () => {
    // 「対応していないなら焼く」を claim の既定値まで広げると、呼び出し側が頼んでもいない
    // ジョブ（本体がこれから入る kind・利用者が別経路で処理するつもりの kind）を
    // 終端で焼くことになる。既定は `TICK_SUPPORTED_JOB_KINDS` だけを claim する。
    const { runtime, stores } = buildRuntime(llmReturning([]));
    const jobId = await enqueueJobOfKind(stores, CUSTOM_KIND);

    const tickResult = await runtime.tick(ctx, { leaseMs: TEST_LEASE_MS });

    expect(tickResult).toEqual({ processed: 0, failed: 0, unsupported: [], leaseConflicts: [] });
    const row = stores.outboxStore.listJobs(ctx).find((job) => job.id === jobId)!;
    expect({ claimedAt: row.claimedAt, failedAt: row.failedAt, attempts: row.attempts }).toEqual({
      claimedAt: null,
      failedAt: null,
      attempts: 0,
    });
  });

  it("⭐ `TICK_SUPPORTED_JOB_KINDS` は 'consolidate'/'reflect' を含む（時限式の歯が役目を終えた証跡）", () => {
    expect(TICK_SUPPORTED_JOB_KINDS).toContain("consolidate");
    expect(TICK_SUPPORTED_JOB_KINDS).toContain("reflect");
  });

  it.each(["consolidate", "reflect"])(
    "⭐ '%s' ジョブの payload が壊れている（memoryId が無い）と、unsupported ではなく failed で終端に落ちる",
    async (kind) => {
      const { runtime, stores } = buildRuntime(llmReturning([]));
      // `enqueueJobOfKind` は observation 用の outbox 経路を借りて payload を `{ observationId }` にする。
      // `consolidate`/`reflect` が読む `memoryId` を持たない「payload が壊れている」ケースの具体例。
      const jobId = await enqueueJobOfKind(stores, kind);

      const tickResult = await runtime.tick(ctx, { kinds: [kind], leaseMs: TEST_LEASE_MS });

      expect(tickResult).toEqual({
        processed: 0,
        failed: 1,
        unsupported: [],
        leaseConflicts: [],
      });
      const row = stores.outboxStore.listJobs(ctx).find((job) => job.id === jobId)!;
      expect(row.failedAt).not.toBeNull();
      expect(row.lastError).toBe(`runtime.tick: ${kind} job payload missing memoryId`);
    },
  );
});

describe("runtime.tick — consolidate/reflect ジョブを処理する（Issue #204 / ADR 0157）", () => {
  it.each(["consolidate", "reflect"] as const)(
    "⭐ payload `{ memoryId }` が正しければ、'%s' ジョブは unsupported にも failed にもならず処理される",
    async (kind) => {
      // `llmReturningOrDecliningReflection` を使う理由: `reflect` は種1件だけでも LLM を呼ぶので、素の `llmReturning` だと
      // `ReflectionLLMResultSchema` の parse に失敗して `llm_failed`（`tick()` の `failed`）になり、
      // この歯が測りたい「payload が正しい job は処理される」こととは無関係な理由で赤くなる。
      const { runtime, stores } = buildRuntime(llmReturningOrDecliningReflection([]));
      const { jobs } = await stores.memoryStore.createMemoryWithOutbox(
        ctx,
        await withSourceObservation(stores.memoryStore, ctx, {
          tenantId: "tenant-1",
          subjectId: null,
          sourceObservationId: null,
          extractorVersion: null,
          content: "本文",
          contentHash: "hash-1",
          digest: "要旨",
          digestSource: "llm",
          provenance: {
            kind: "stated",
            sourceObservationId: "obs-standalone",
            at: "2026-01-01T00:00:00.000Z",
          },
          tags: [],
          occurredAt: null,
          recordedAt: new Date(),
          strength: 1,
          halfLifeHours: 24,
          decayFloorAt: new Date(),
          embeddingStatus: "pending",
        }),
        [kind],
      );
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.payload).toEqual({ memoryId: jobs[0]!.payload.memoryId });

      const tickResult = await runtime.tick(ctx, { kinds: [kind], leaseMs: TEST_LEASE_MS });

      // `consolidate()` は eligible が1件（種のみ）で `nothing_to_consolidate`（LLM を呼ばずに打ち切る）に終わる。
      // `reflect()` は eligible 1件でも LLM を呼ぶが、`llmReturningOrDecliningReflection` が「一般化するものは無い」で応じるので
      // `nothing_to_reflect` に終わる。どちらも `tick()` の視点では「処理を試みて成功した」ので、ジョブは完了として扱われる。
      expect(tickResult).toEqual({
        processed: 1,
        failed: 0,
        unsupported: [],
        leaseConflicts: [],
      });
    },
  );
});

describe("runtime.observe(extract) が consolidate/reflect の種を積むのは opt-in のときだけ（Issue #204 / ADR 0157）", () => {
  it("🔴 既定（config を渡さない）では、extract は embed 以外のジョブを1件も積まない", async () => {
    const { runtime, stores } = buildRuntime(
      llmReturning([{ content: "本文", digest: "要旨", provenanceKind: "stated" }]),
    );

    await runtime.observe(ctx, { kind: "utterance", text: "本文" });

    // `extract: 'sync'`（既定）は `extract` ジョブを常に積み、同じ呼び出しの中で `complete()` する。
    // ここで測りたいのは `consolidate`/`reflect` が積まれないことだけなので、それ以外の kind は無視する。
    const kinds = stores.outboxStore
      .listJobs(ctx)
      .map((job) => job.kind)
      .filter((kind) => kind === "consolidate" || kind === "reflect");
    expect(kinds).toEqual([]);
  });

  it("⭐ `autoQueueConsolidateReflectOnExtract: true` にすると、同じ memoryId を種にした consolidate/reflect のジョブも積まれ、tick が処理する", async () => {
    const { runtime, stores } = buildRuntime(
      llmReturningOrDecliningReflection([
        { content: "本文", digest: "要旨", provenanceKind: "stated" },
      ]),
      { config: { autoQueueConsolidateReflectOnExtract: true } },
    );

    const observeResult = await runtime.observe(ctx, { kind: "utterance", text: "本文" });
    const memoryId = observeResult.memoryIds[0]!;

    // `extract` ジョブも積まれるが sync 抽出の中で既に `complete()` されているので、ここでは `consolidate`/`embed`/`reflect` の3つだけを見る。
    const jobsBeforeTick = stores.outboxStore.listJobs(ctx).filter((job) => job.kind !== "extract");
    expect(
      jobsBeforeTick
        .map((job) => ({ kind: job.kind, payload: job.payload }))
        .sort((a, b) => a.kind.localeCompare(b.kind)),
    ).toEqual([
      { kind: "consolidate", payload: { memoryId } },
      { kind: "embed", payload: { memoryId } },
      { kind: "reflect", payload: { memoryId } },
    ]);

    // 積まれるだけでなく、tick() が実際に処理する（unsupported にならない）ところまで測る。
    // 「積む」と「処理できる」を別の歯で確かめないと、payload の形が食い違っていても「積んだこと」だけで緑になってしまう。
    const tickResult = await runtime.tick(ctx, { leaseMs: TEST_LEASE_MS });
    expect(tickResult).toEqual({ processed: 3, failed: 0, unsupported: [], leaseConflicts: [] });
  });
});

/**
 * `FakeOutboxStore`（`packages/core` 自身の私的なテストダブル）は `packages/testkit` の適合スイートの対象外である
 * （`core` は `testkit` に依存しない、docs/architecture.md §4）。この節が無いと、`FakeOutboxStore` の CAS 判定は
 * 実装されているのにどの歯からも呼ばれないまま残る。
 */
describe("OutboxStore.complete/fail の CAS（ADR 0142 / Issue #233、FakeOutboxStore）", () => {
  async function enqueueJob(stores: ReturnType<typeof buildRuntime>["stores"]): Promise<string> {
    const { jobs } = await stores.memoryStore.createObservationWithOutbox(
      ctx,
      { tenantId: "tenant-1", subjectId: null, externalId: null, kind: "utterance", payload: {} },
      ["extract"],
    );
    expect(jobs).toHaveLength(1);
    return jobs[0]!.id;
  }

  it("complete は claim 時の attempts と一致すれば成功する", async () => {
    const { stores } = buildRuntime(llmReturning([]));
    const jobId = await enqueueJob(stores);

    const claimed = await stores.outboxStore.claimBatch(ctx, {
      limit: 10,
      now: new Date(),
      claimedBy: "worker-1",
      leaseMs: TEST_LEASE_MS,
    });
    const job = claimed.find((j) => j.id === jobId)!;

    await expect(stores.outboxStore.complete(ctx, jobId, job.attempts)).resolves.not.toThrow();
    expect(
      stores.outboxStore.listJobs(ctx).find((j) => j.id === jobId)!.completedAt,
    ).not.toBeNull();
  });

  it("complete は attempts が一致しないと OutboxLeaseConflictError を投げる", async () => {
    const { stores } = buildRuntime(llmReturning([]));
    const jobId = await enqueueJob(stores);

    const claimed = await stores.outboxStore.claimBatch(ctx, {
      limit: 10,
      now: new Date(),
      claimedBy: "worker-1",
      leaseMs: TEST_LEASE_MS,
    });
    const job = claimed.find((j) => j.id === jobId)!;

    await expect(stores.outboxStore.complete(ctx, jobId, job.attempts - 1)).rejects.toBeInstanceOf(
      OutboxLeaseConflictError,
    );
  });

  it("fail は attempts が一致しないと OutboxLeaseConflictError を投げる", async () => {
    const { stores } = buildRuntime(llmReturning([]));
    const jobId = await enqueueJob(stores);

    const claimed = await stores.outboxStore.claimBatch(ctx, {
      limit: 10,
      now: new Date(),
      claimedBy: "worker-1",
      leaseMs: TEST_LEASE_MS,
    });
    const job = claimed.find((j) => j.id === jobId)!;

    await expect(
      stores.outboxStore.fail(ctx, jobId, "boom", job.attempts - 1),
    ).rejects.toBeInstanceOf(OutboxLeaseConflictError);
  });

  it("⭐ 再現(Issue #233): リース切れ後に別ワーカーが再claim・completeした結果を、遅れたワーカーのfailが上書きできない", async () => {
    const { stores } = buildRuntime(llmReturning([]));
    const jobId = await enqueueJob(stores);
    const leaseMs = 1000;
    const base = new Date();

    const claimA = await stores.outboxStore.claimBatch(ctx, {
      limit: 10,
      now: base,
      claimedBy: "worker-A",
      leaseMs,
    });
    const jobAsClaimedByA = claimA.find((j) => j.id === jobId)!;

    const afterExpiry = new Date(base.getTime() + leaseMs);

    const claimB = await stores.outboxStore.claimBatch(ctx, {
      limit: 10,
      now: afterExpiry,
      claimedBy: "worker-B",
      leaseMs,
    });
    const jobAsClaimedByB = claimB.find((j) => j.id === jobId)!;
    expect(jobAsClaimedByB.attempts).toBeGreaterThan(jobAsClaimedByA.attempts);
    await stores.outboxStore.complete(ctx, jobId, jobAsClaimedByB.attempts);

    await expect(
      stores.outboxStore.fail(ctx, jobId, "worker-A: stale failure", jobAsClaimedByA.attempts),
    ).rejects.toBeInstanceOf(OutboxLeaseConflictError);

    const finalJob = stores.outboxStore.listJobs(ctx).find((j) => j.id === jobId)!;
    expect(finalJob.completedAt).not.toBeNull();
    expect(finalJob.failedAt).toBeNull();
  });

  // complete/fail は互いに排他。先に付いた終端が勝ち、後から来た呼び出しは行を変えず、例外も投げない
  // （`FakeOutboxStore` は適合スイートの対象でないため、ここで別に検査する）。
  it("逐次: complete → fail（同じ attempts）— completedAt は付いたまま、failedAt/lastError は null のまま（Issue #826）", async () => {
    const { stores } = buildRuntime(llmReturning([]));
    const jobId = await enqueueJob(stores);

    const claimed = await stores.outboxStore.claimBatch(ctx, {
      limit: 10,
      now: new Date(),
      claimedBy: "worker-1",
      leaseMs: TEST_LEASE_MS,
    });
    const job = claimed.find((j) => j.id === jobId)!;

    await stores.outboxStore.complete(ctx, jobId, job.attempts);
    await expect(
      stores.outboxStore.fail(ctx, jobId, "should-not-be-recorded", job.attempts),
    ).resolves.not.toThrow();

    const finalJob = stores.outboxStore.listJobs(ctx).find((j) => j.id === jobId)!;
    expect(finalJob.completedAt).not.toBeNull();
    expect(finalJob.failedAt).toBeNull();
    expect(finalJob.lastError).toBeNull();
  });

  it("逐次: fail → complete（同じ attempts）— failedAt/lastError は保たれ、completedAt は付かない（Issue #826）", async () => {
    const { stores } = buildRuntime(llmReturning([]));
    const jobId = await enqueueJob(stores);

    const claimed = await stores.outboxStore.claimBatch(ctx, {
      limit: 10,
      now: new Date(),
      claimedBy: "worker-1",
      leaseMs: TEST_LEASE_MS,
    });
    const job = claimed.find((j) => j.id === jobId)!;

    await stores.outboxStore.fail(ctx, jobId, "boom", job.attempts);
    await expect(stores.outboxStore.complete(ctx, jobId, job.attempts)).resolves.not.toThrow();

    const finalJob = stores.outboxStore.listJobs(ctx).find((j) => j.id === jobId)!;
    expect(finalJob.failedAt).not.toBeNull();
    expect(finalJob.lastError).toBe("boom");
    expect(finalJob.completedAt).toBeNull();
  });
});

/**
 * リース競合は異常ではなく正常な並行の結果（別のワーカーが既にそのジョブを終わらせた）なので、`tick()` は `OutboxLeaseConflictError` を検知しても、
 * その1件を飛ばして残りのジョブの処理を続ける。1件の良性の競合で同じ `tick` 呼び出し内の無関係な他のジョブまで止めない。
 *
 * 決定的な差し込みで再現する: `FakeEmbeddingProvider.beforeEmbedReturn` フックから、処理中のジョブ自身を直接 `claimBatch` で再 claim して、
 * 「処理には成功したが complete しようとした時点でリースを失っていた」を確率的な並行に頼らず毎回同じ形で起こす。
 */
describe("runtime.tick — リース競合は他のジョブの処理を止めない（ADR 0142 決定3）", () => {
  it("⭐ 1件が complete 時にリース競合しても、同じ tick 内の他のジョブは処理される", async () => {
    let fakeNow = new Date(Date.now() + 1000);
    const fakeClock = { now: () => fakeNow };
    const leaseMs = 10;

    const { runtime, stores } = buildRuntime(
      llmReturning([{ content: "本文", digest: "要旨", provenanceKind: "stated" }]),
      { clock: fakeClock },
    );

    // job A(先に available)・job B(後に available)。claimBatch は available_at
    // 昇順で claim するため、観測順どおり A が先・B が後に処理される。
    const observeA = await runtime.observe(ctx, { kind: "utterance", text: "本文A" });
    const observeB = await runtime.observe(ctx, { kind: "utterance", text: "本文B" });
    const memoryIdA = observeA.memoryIds[0]!;
    const memoryIdB = observeB.memoryIds[0]!;

    let hookFired = false;
    stores.embeddingProvider.beforeEmbedReturn = async () => {
      if (hookFired) {
        // 2件目(B)の embed() でも呼ばれる——1件目でだけ発火させる。
        return;
      }
      hookFired = true;
      fakeNow = new Date(fakeNow.getTime() + leaseMs + 1000);
      const hijacked = await stores.outboxStore.claimBatch(ctx, {
        kinds: ["embed"],
        limit: 1,
        now: fakeNow,
        claimedBy: "attacker",
        leaseMs,
      });
      expect(hijacked.map((j) => j.payload.memoryId)).toEqual([memoryIdA]);
    };

    const tickResult = await runtime.tick(ctx, {
      kinds: ["embed"],
      limit: 10,
      leaseMs,
    });

    expect(tickResult.processed).toBe(1);
    expect(tickResult.failed).toBe(0);
    expect(tickResult.unsupported).toEqual([]);
    expect(tickResult.leaseConflicts).toHaveLength(1);
    expect(tickResult.leaseConflicts[0]).toMatchObject({
      kind: "embed",
      attemptedOutcome: "complete",
    });

    // Aの embed 処理自体(handler)は実際には成功していた——outbox の記帳だけが
    // 競合で弾かれた、という区別が付いていることを確認する。
    const memoryA = await stores.memoryStore.get(ctx, memoryIdA);
    expect(memoryA?.embeddingStatus).toBe("ready");
    const memoryB = await stores.memoryStore.get(ctx, memoryIdB);
    expect(memoryB?.embeddingStatus).toBe("ready");
  });
});

describe("runtime.reextract（ADR 0028: 「やり直したら重複が残る」の掃除）", () => {
  /**
   * runtime1（失敗する LLM）で observe() させ、全文フォールバックの Memory を1件作る。
   * runtime2（成功する LLM）は同じ stores を共有する——「provider が復旧した後」を模す。
   */
  function buildReextractScenario(succeedingCandidates: Parameters<typeof llmReturning>[0]) {
    const { runtime: runtime1, stores } = buildRuntime(throwingLlm());
    const runtime2 = createRuntime({
      memoryStore: stores.memoryStore,
      outboxStore: stores.outboxStore,
      vectorStore: stores.vectorStore,
      eventStore: stores.eventStore,
      tenantSettingsStore: stores.tenantSettingsStore,
      llmProvider: llmReturning(succeedingCandidates),
      embeddingProvider: stores.embeddingProvider,
      hashContent: (content: string) => `sha256(${content})`,
    });
    return { runtime1, runtime2, stores };
  }

  it("⭐ reextract を2回走らせても、2回目では Memory が増えない（冪等は『数が増えない』で測る。オーナーの線）", async () => {
    const { runtime1, runtime2, stores } = buildReextractScenario([
      { content: "抽出結果A", digest: "要旨A", provenanceKind: "stated" },
      { content: "抽出結果B", digest: "要旨B", provenanceKind: "stated" },
    ]);
    const observeResult = await runtime1.observe(ctx, {
      kind: "utterance",
      text: "障害時に取り込まれた発話",
    });
    expect(observeResult.extraction).toBe("llm_failed_whole_observation");

    const countFor = async () =>
      (await stores.memoryStore.listBySourceObservation(ctx, observeResult.observationId, "v1"))
        .length;

    expect(await countFor()).toBe(1); // フォールバックの1件のみ

    const first = await runtime2.reextract(ctx, observeResult.observationId);
    expect(first.extraction).toBe("ok");
    const afterFirst = await countFor();
    expect(afterFirst).toBe(3); // フォールバック(superseded) + 新規2件

    const second = await runtime2.reextract(ctx, observeResult.observationId);
    expect(second.extraction).toBe("ok");
    const afterSecond = await countFor();
    // ⚠ 「キーが在る」ではなく「数が増えない」を assert する。
    expect(afterSecond).toBe(afterFirst);
  });

  it("全文フォールバックの Memory が superseded になり、superseded_by_id が新しい Memory を指す", async () => {
    const { runtime1, runtime2, stores } = buildReextractScenario([
      { content: "新しい抽出結果", digest: "要旨", provenanceKind: "stated" },
    ]);
    const observeResult = await runtime1.observe(ctx, { kind: "utterance", text: "発話" });
    const fallbackId = observeResult.memoryIds[0]!;

    const result = await runtime2.reextract(ctx, observeResult.observationId);
    expect(result.supersededMemoryIds).toEqual([fallbackId]);

    const fallbackMemory = await stores.memoryStore.get(ctx, fallbackId);
    expect(fallbackMemory?.status).toBe("superseded");
    expect(fallbackMemory?.supersededById).toBe(result.memoryIds[0]);

    const target = await stores.memoryStore.get(ctx, fallbackMemory!.supersededById!);
    expect(target?.status).toBe("active");
  });

  it("🔴 候補が0件なら、何も supersede しない（0件は正常な抽出結果であり、これを根拠に既存を消さない）", async () => {
    const { runtime1, runtime2, stores } = buildReextractScenario([]);
    const observeResult = await runtime1.observe(ctx, { kind: "utterance", text: "発話" });
    const fallbackId = observeResult.memoryIds[0]!;

    const result = await runtime2.reextract(ctx, observeResult.observationId);
    expect(result.extraction).toBe("ok");
    expect(result.memoryIds).toEqual([]);
    expect(result.supersededMemoryIds).toEqual([]);

    const fallbackMemory = await stores.memoryStore.get(ctx, fallbackId);
    expect(fallbackMemory?.status).toBe("active"); // 触られていない
  });

  it("🔴 forgotten の Memory は supersede されない（利用者が意図して忘れさせたものを機構の都合で上書きしない）", async () => {
    const { runtime1, runtime2, stores } = buildReextractScenario([
      { content: "新しい抽出結果", digest: "要旨", provenanceKind: "stated" },
    ]);
    const observeResult = await runtime1.observe(ctx, { kind: "utterance", text: "発話" });
    const fallbackId = observeResult.memoryIds[0]!;
    await stores.memoryStore.updateStatus(ctx, fallbackId, "forgotten");

    const result = await runtime2.reextract(ctx, observeResult.observationId);
    expect(result.supersededMemoryIds).toEqual([]);

    const stillForgotten = await stores.memoryStore.get(ctx, fallbackId);
    expect(stillForgotten?.status).toBe("forgotten");
    expect(stillForgotten?.supersededById ?? null).toBeNull();
  });

  it("reextract のあと、recall() の omitted に filtered(superseded) が出る（ADR 0027 と繋がる）", async () => {
    const { runtime1, runtime2 } = buildReextractScenario([
      { content: "新しい抽出結果", digest: "要旨", provenanceKind: "stated" },
    ]);
    const observeResult = await runtime1.observe(ctx, { kind: "utterance", text: "発話" });
    await runtime2.reextract(ctx, observeResult.observationId);

    const recallResult = await runtime2.recall(ctx, {});
    expect(recallResult.omitted).toContainEqual(
      expect.objectContaining({ kind: "filtered", condition: "superseded" }),
    );
  });

  it("変わっていない候補は、2回目の reextract でも superseded にならない（content_hash 比較を外すと壊れる歯）", async () => {
    const stores = createFakeRuntimeStores();
    const succeedingLlm = llmReturning([
      { content: "変わらない内容", digest: "要旨", provenanceKind: "stated" },
    ]);
    const runtime = createRuntime({
      memoryStore: stores.memoryStore,
      outboxStore: stores.outboxStore,
      vectorStore: stores.vectorStore,
      eventStore: stores.eventStore,
      tenantSettingsStore: stores.tenantSettingsStore,
      llmProvider: succeedingLlm,
      embeddingProvider: stores.embeddingProvider,
      hashContent: (content: string) => `sha256(${content})`,
    });

    const observeResult = await runtime.observe(ctx, { kind: "utterance", text: "発話" });
    expect(observeResult.extraction).toBe("ok");
    const originalId = observeResult.memoryIds[0]!;

    await runtime.reextract(ctx, observeResult.observationId);
    const result = await runtime.reextract(ctx, observeResult.observationId);

    expect(result.supersededMemoryIds).toEqual([]);
    const original = await stores.memoryStore.get(ctx, originalId);
    expect(original?.status).toBe("active");
    expect(original?.supersededById ?? null).toBeNull();
  });

  describe("skipped（ADR 0029: 既存 Memory を supersede しなかった理由を出す）", () => {
    /** 同じ stores を共有しつつ、llmProvider だけ差し替えた runtime を作る。 */
    function runtimeWithLlm(
      stores: ReturnType<typeof createFakeRuntimeStores>,
      llmProvider: LLMProvider,
    ) {
      return createRuntime({
        memoryStore: stores.memoryStore,
        outboxStore: stores.outboxStore,
        vectorStore: stores.vectorStore,
        eventStore: stores.eventStore,
        tenantSettingsStore: stores.tenantSettingsStore,
        llmProvider,
        embeddingProvider: stores.embeddingProvider,
        hashContent: (content: string) => `sha256(${content})`,
      });
    }

    function skipForId(skipped: ReextractSkip[], id: string) {
      return skipped.find((s) => s.kind !== "not_examined" && s.memoryId === id);
    }

    it("⭐ contested 1件・forgotten 2件が status 付きで非対称に skipped へ出る（隣の値への入れ替え変異を検出する）", async () => {
      const stores = createFakeRuntimeStores();
      const runtime1 = runtimeWithLlm(
        stores,
        llmReturning([
          { content: "候補1", digest: "要旨1", provenanceKind: "stated" },
          { content: "候補2", digest: "要旨2", provenanceKind: "stated" },
          { content: "候補3", digest: "要旨3", provenanceKind: "stated" },
        ]),
      );
      const observeResult = await runtime1.observe(ctx, { kind: "utterance", text: "発話" });
      expect(observeResult.memoryIds).toHaveLength(3);
      const [contestedId, forgotten1Id, forgotten2Id] = observeResult.memoryIds as [
        string,
        string,
        string,
      ];
      await stores.memoryStore.updateStatus(ctx, contestedId, "contested");
      await stores.memoryStore.updateStatus(ctx, forgotten1Id, "forgotten");
      await stores.memoryStore.updateStatus(ctx, forgotten2Id, "forgotten");

      const runtime2 = runtimeWithLlm(
        stores,
        llmReturning([{ content: "新しい抽出結果", digest: "要旨", provenanceKind: "stated" }]),
      );
      const result = await runtime2.reextract(ctx, observeResult.observationId);

      expect(result.skipped).toHaveLength(3);
      expect(result.supersededMemoryIds).toEqual([]); // 3件とも active ではないので supersede 対象外

      const contestedSkip = skipForId(result.skipped, contestedId);
      const forgotten1Skip = skipForId(result.skipped, forgotten1Id);
      const forgotten2Skip = skipForId(result.skipped, forgotten2Id);
      expect(contestedSkip).toEqual({
        kind: "status_not_active",
        memoryId: contestedId,
        status: "contested",
      });
      expect(forgotten1Skip).toEqual({
        kind: "status_not_active",
        memoryId: forgotten1Id,
        status: "forgotten",
      });
      expect(forgotten2Skip).toEqual({
        kind: "status_not_active",
        memoryId: forgotten2Id,
        status: "forgotten",
      });

      // 非対称であることそのものを assert する——同数だと取り違えが検出できない。
      const statuses = result.skipped
        .filter(
          (s): s is Extract<ReextractSkip, { kind: "status_not_active" }> =>
            s.kind === "status_not_active",
        )
        .map((s) => s.status);
      expect(statuses.filter((status) => status === "contested")).toHaveLength(1);
      expect(statuses.filter((status) => status === "forgotten")).toHaveLength(2);
    });

    it("content_hash が一致した既存 Memory は { kind: 'unchanged' } として skipped に出る", async () => {
      const stores = createFakeRuntimeStores();
      const succeedingLlm = llmReturning([
        { content: "変わらない内容", digest: "要旨", provenanceKind: "stated" },
      ]);
      const runtime = runtimeWithLlm(stores, succeedingLlm);

      const observeResult = await runtime.observe(ctx, { kind: "utterance", text: "発話" });
      expect(observeResult.extraction).toBe("ok");
      const originalId = observeResult.memoryIds[0]!;

      const result = await runtime.reextract(ctx, observeResult.observationId);

      expect(result.skipped).toEqual([{ kind: "unchanged", memoryId: originalId }]);
      expect(result.supersededMemoryIds).toEqual([]);
    });

    it("🔴 候補が0件のとき skipped は [{ kind: 'not_examined', reason: 'no_candidates' }]（listBySourceObservation を呼ぶ前の早期 return）", async () => {
      const { runtime1, runtime2 } = buildReextractScenario([]);
      const observeResult = await runtime1.observe(ctx, { kind: "utterance", text: "発話" });

      const result = await runtime2.reextract(ctx, observeResult.observationId);

      expect(result.extraction).toBe("ok");
      expect(result.skipped).toEqual([{ kind: "not_examined", reason: "no_candidates" }]);
    });

    it("🔴 LLM がまた失敗したとき skipped は [{ kind: 'not_examined', reason: 'llm_failed_whole_observation' }]（listBySourceObservation を呼ぶ前の早期 return）", async () => {
      const stores = createFakeRuntimeStores();
      const runtime1 = runtimeWithLlm(stores, throwingLlm());
      const observeResult = await runtime1.observe(ctx, {
        kind: "utterance",
        text: "障害時に取り込まれた発話",
      });
      expect(observeResult.extraction).toBe("llm_failed_whole_observation");

      const runtime2 = runtimeWithLlm(stores, throwingLlm());
      const result = await runtime2.reextract(ctx, observeResult.observationId);

      expect(result.extraction).toBe("llm_failed_whole_observation");
      expect(result.skipped).toEqual([
        { kind: "not_examined", reason: "llm_failed_whole_observation" },
      ]);
      expect(result.extractionFailure).toEqual({
        kind: null,
        message: "simulated LLM outage",
      });
    });

    it("⭐ reextract でも provider の kind が extractionFailure まで運ばれる（observe() との対称性）", async () => {
      const kindThrowingLlm: LLMProvider = {
        complete: async () => {
          throw new Error("not used");
        },
        completeStructured: async () => {
          const error = new Error("truncated response") as Error & { kind: string };
          error.kind = "truncated";
          throw error;
        },
      };
      const stores = createFakeRuntimeStores();
      const runtime1 = runtimeWithLlm(stores, throwingLlm());
      const observeResult = await runtime1.observe(ctx, {
        kind: "utterance",
        text: "障害時に取り込まれた発話",
      });

      const runtime2 = runtimeWithLlm(stores, kindThrowingLlm);
      const result = await runtime2.reextract(ctx, observeResult.observationId);

      expect(result.extraction).toBe("llm_failed_whole_observation");
      expect(result.extractionFailure).toEqual({
        kind: "truncated",
        message: "truncated response",
      });
    });

    it("reextract が候補0件・成功のときは extractionFailure が null（片方だけ有るを作らない）", async () => {
      const { runtime1, runtime2 } = buildReextractScenario([
        { content: "新規", digest: "要旨", provenanceKind: "stated" },
      ]);
      const observeResult = await runtime1.observe(ctx, { kind: "utterance", text: "発話" });
      const result = await runtime2.reextract(ctx, observeResult.observationId);
      expect(result.extraction).toBe("ok");
      expect(result.extractionFailure).toBeNull();

      const zeroCandidatesScenario = buildReextractScenario([]);
      const zeroObserve = await zeroCandidatesScenario.runtime1.observe(ctx, {
        kind: "utterance",
        text: "発話2",
      });
      const zeroResult = await zeroCandidatesScenario.runtime2.reextract(
        ctx,
        zeroObserve.observationId,
      );
      expect(zeroResult.extraction).toBe("ok");
      expect(zeroResult.extractionFailure).toBeNull();
    });

    it("⭐ 「飛ばすものが無かった」・「候補0件」・「LLM失敗」の3つの顔が違う（オーナーの追加要求）", async () => {
      const stores = createFakeRuntimeStores();
      const zeroLlm = llmReturning([]);
      const zeroRuntime = runtimeWithLlm(stores, zeroLlm);

      // 顔1: 「飛ばすものが無かった」。既存 Memory が無い Observation に、候補が有る LLM で reextract する。
      const observeResult1 = await zeroRuntime.observe(ctx, { kind: "utterance", text: "発話1" });
      expect(observeResult1.memoryIds).toEqual([]);
      const succeedingRuntime = runtimeWithLlm(
        stores,
        llmReturning([{ content: "新規", digest: "要旨", provenanceKind: "stated" }]),
      );
      const nothingToSkip = await succeedingRuntime.reextract(ctx, observeResult1.observationId);
      expect(nothingToSkip.skipped).toEqual([]);

      // 顔2: 「候補0件」。listBySourceObservation を呼ぶ前の早期 return。
      const observeResult2 = await zeroRuntime.observe(ctx, { kind: "utterance", text: "発話2" });
      const noCandidates = await zeroRuntime.reextract(ctx, observeResult2.observationId);
      expect(noCandidates.skipped).toEqual([{ kind: "not_examined", reason: "no_candidates" }]);

      // 顔3: 「LLM失敗」。これも listBySourceObservation を呼ぶ前の早期 return。
      const observeResult3 = await zeroRuntime.observe(ctx, { kind: "utterance", text: "発話3" });
      const throwingRuntime = runtimeWithLlm(stores, throwingLlm());
      const llmFailed = await throwingRuntime.reextract(ctx, observeResult3.observationId);
      expect(llmFailed.skipped).toEqual([
        { kind: "not_examined", reason: "llm_failed_whole_observation" },
      ]);

      expect(nothingToSkip.skipped).not.toEqual(noCandidates.skipped);
      expect(noCandidates.skipped).not.toEqual(llmFailed.skipped);
      expect(nothingToSkip.skipped).not.toEqual(llmFailed.skipped);
    });
  });

  describe("compare-and-swap（ADR 0030: 読んでから書くまでの間の TOCTOU を検知する）", () => {
    it("⭐ 対象 M の1件目を書きに来た瞬間に M を forgotten へ変えても、M は forgotten のまま・supersede されず・イベントも積まれない（別の対象 N は普通に supersede される）", async () => {
      const stores = createFakeRuntimeStores();
      const setupRuntime = createRuntime({
        memoryStore: stores.memoryStore,
        outboxStore: stores.outboxStore,
        vectorStore: stores.vectorStore,
        eventStore: stores.eventStore,
        tenantSettingsStore: stores.tenantSettingsStore,
        llmProvider: llmReturning([
          { content: "M候補", digest: "M要旨", provenanceKind: "stated" },
          { content: "N候補", digest: "N要旨", provenanceKind: "stated" },
        ]),
        embeddingProvider: stores.embeddingProvider,
        hashContent: (content: string) => `sha256(${content})`,
      });
      const observeResult = await setupRuntime.observe(ctx, { kind: "utterance", text: "発話" });
      const [mId, nId] = observeResult.memoryIds as [string, string];

      const reextractRuntime = createRuntime({
        memoryStore: stores.memoryStore,
        outboxStore: stores.outboxStore,
        vectorStore: stores.vectorStore,
        eventStore: stores.eventStore,
        tenantSettingsStore: stores.tenantSettingsStore,
        llmProvider: llmReturning([
          { content: "新しい抽出結果", digest: "新要旨", provenanceKind: "stated" },
        ]),
        embeddingProvider: stores.embeddingProvider,
        hashContent: (content: string) => `sha256(${content})`,
      });

      // 決定的な差し込み: M への1件目の書き込みが来た瞬間に、別の誰か（利用者による forget 相当）が M を forgotten に変えたことにする。
      // N には介入しない。フィクスチャを非対称にすることで「件数は合っているが対応が崩れている」実装も捕まえられるようにする。
      // `FakeMemoryStore.get` は写しを返すので、行そのものを引く `liveRowForTest` で取った参照の `status` を書き換えて「割り込み」を再現する。
      const mBeforeIntervention = stores.memoryStore.liveRowForTest(ctx, mId);
      let intervened = false;
      stores.memoryStore.beforeUpdateStatus = (id) => {
        if (!intervened && id === mId) {
          intervened = true;
          mBeforeIntervention!.status = "forgotten";
        }
      };

      const result = await reextractRuntime.reextract(ctx, observeResult.observationId);

      const mAfter = await stores.memoryStore.get(ctx, mId);
      expect(mAfter?.status).toBe("forgotten");
      expect(result.supersededMemoryIds).not.toContain(mId);
      expect(result.skipped).toContainEqual({
        kind: "status_changed_concurrently",
        memoryId: mId,
        observedStatus: "forgotten",
      });
      const mEvents = stores.eventStore.events.filter(
        (e) => e.memoryId === mId && e.kind === "superseded",
      );
      expect(mEvents).toEqual([]); // superseded イベントは一切積まれていない

      expect(result.supersededMemoryIds).toContain(nId);
      const nAfter = await stores.memoryStore.get(ctx, nId);
      expect(nAfter?.status).toBe("superseded");
      const nEvents = stores.eventStore.events.filter(
        (e) => e.memoryId === nId && e.kind === "superseded",
      );
      expect(nEvents).toHaveLength(1);
    });

    it("競合でない例外（updateStatus が想定外のエラーを投げた）はそのまま再送出される", async () => {
      const stores = createFakeRuntimeStores();
      const setupRuntime = createRuntime({
        memoryStore: stores.memoryStore,
        outboxStore: stores.outboxStore,
        vectorStore: stores.vectorStore,
        eventStore: stores.eventStore,
        tenantSettingsStore: stores.tenantSettingsStore,
        llmProvider: llmReturning([{ content: "候補", digest: "要旨", provenanceKind: "stated" }]),
        embeddingProvider: stores.embeddingProvider,
        hashContent: (content: string) => `sha256(${content})`,
      });
      const observeResult = await setupRuntime.observe(ctx, { kind: "utterance", text: "発話" });

      const reextractRuntime = createRuntime({
        memoryStore: stores.memoryStore,
        outboxStore: stores.outboxStore,
        vectorStore: stores.vectorStore,
        eventStore: stores.eventStore,
        tenantSettingsStore: stores.tenantSettingsStore,
        llmProvider: llmReturning([
          { content: "新しい抽出結果", digest: "新要旨", provenanceKind: "stated" },
        ]),
        embeddingProvider: stores.embeddingProvider,
        hashContent: (content: string) => `sha256(${content})`,
      });

      // 競合ではない、ただの障害（例: 接続断）を模す。
      // 差し替える先は、`reextract` が実際に呼ぶ口（`supersedeWithNewMemories`）でなければならない。
      // さもないと差し替えた口が呼ばれず、例外が飛ばないので歯が落ちるか、条件がずれれば緑のまま何も検査しなくなる。
      stores.memoryStore.supersedeWithNewMemories = async () => {
        throw new Error("simulated connection reset");
      };

      await expect(reextractRuntime.reextract(ctx, observeResult.observationId)).rejects.toThrow(
        "simulated connection reset",
      );
    });

    it("supersedeWithNewMemories が投げたとき、今日の2段の経路へフォールバックしない（ADR 0100）", async () => {
      const stores = createFakeRuntimeStores();
      const setupRuntime = createRuntime({
        memoryStore: stores.memoryStore,
        outboxStore: stores.outboxStore,
        vectorStore: stores.vectorStore,
        eventStore: stores.eventStore,
        tenantSettingsStore: stores.tenantSettingsStore,
        llmProvider: llmReturning([{ content: "候補", digest: "要旨", provenanceKind: "stated" }]),
        embeddingProvider: stores.embeddingProvider,
        hashContent: (content: string) => `sha256(${content})`,
      });
      const observeResult = await setupRuntime.observe(ctx, { kind: "utterance", text: "発話" });

      const reextractRuntime = createRuntime({
        memoryStore: stores.memoryStore,
        outboxStore: stores.outboxStore,
        vectorStore: stores.vectorStore,
        eventStore: stores.eventStore,
        tenantSettingsStore: stores.tenantSettingsStore,
        llmProvider: llmReturning([
          { content: "新しい抽出結果", digest: "新要旨", provenanceKind: "stated" },
        ]),
        embeddingProvider: stores.embeddingProvider,
        hashContent: (content: string) => `sha256(${content})`,
      });

      // 口が在って投げたときに今日の経路で撃ち直さない。撃ち直すと「トランザクションを張れなかった」と
      // 「張ったが失敗した」が呼び手から区別できなくなる。
      let usedFallback = false;
      stores.memoryStore.supersedeWithNewMemories = async () => {
        throw new Error("simulated transaction failure");
      };
      const originalUpdateStatusWithEvent = stores.memoryStore.updateStatusWithEvent.bind(
        stores.memoryStore,
      );
      stores.memoryStore.updateStatusWithEvent = async (...args) => {
        usedFallback = true;
        return originalUpdateStatusWithEvent(...args);
      };

      await expect(reextractRuntime.reextract(ctx, observeResult.observationId)).rejects.toThrow(
        "simulated transaction failure",
      );
      expect(usedFallback).toBe(false);
    });

    it("reextract は口が在る adapter で atomicity: 'store_supported' を名乗る（ADR 0100）", async () => {
      const stores = createFakeRuntimeStores();
      const setupRuntime = createRuntime({
        memoryStore: stores.memoryStore,
        outboxStore: stores.outboxStore,
        vectorStore: stores.vectorStore,
        eventStore: stores.eventStore,
        tenantSettingsStore: stores.tenantSettingsStore,
        llmProvider: llmReturning([{ content: "候補", digest: "要旨", provenanceKind: "stated" }]),
        embeddingProvider: stores.embeddingProvider,
        hashContent: (content: string) => `sha256(${content})`,
      });
      const observeResult = await setupRuntime.observe(ctx, { kind: "utterance", text: "発話" });

      const withPort = createRuntime({
        memoryStore: stores.memoryStore,
        outboxStore: stores.outboxStore,
        vectorStore: stores.vectorStore,
        eventStore: stores.eventStore,
        tenantSettingsStore: stores.tenantSettingsStore,
        llmProvider: llmReturning([
          { content: "新しい抽出結果", digest: "新要旨", provenanceKind: "stated" },
        ]),
        embeddingProvider: stores.embeddingProvider,
        hashContent: (content: string) => `sha256(${content})`,
      });
      const supported = await withPort.reextract(ctx, observeResult.observationId);
      expect(supported.atomicity).toBe("store_supported");
      expect(supported.supersededMemoryIds).toHaveLength(1);
    });

    it("reextract は口が無い adapter で atomicity: 'store_unsupported' を名乗り、今日の2段で書く（ADR 0100）", async () => {
      const stores = createFakeRuntimeStores();
      const setupRuntime = createRuntime({
        memoryStore: stores.memoryStore,
        outboxStore: stores.outboxStore,
        vectorStore: stores.vectorStore,
        eventStore: stores.eventStore,
        tenantSettingsStore: stores.tenantSettingsStore,
        llmProvider: llmReturning([{ content: "候補", digest: "要旨", provenanceKind: "stated" }]),
        embeddingProvider: stores.embeddingProvider,
        hashContent: (content: string) => `sha256(${content})`,
      });
      const observeResult = await setupRuntime.observe(ctx, { kind: "utterance", text: "発話" });

      // 口を持たない adapter を模す（第三者の既存 adapter がこの形）。`delete` では消えない（クラスのメソッドは prototype に在る）ので、
      // `undefined` を代入して prototype を隠す。
      (stores.memoryStore as { supersedeWithNewMemories?: unknown }).supersedeWithNewMemories =
        undefined;

      const withoutPort = createRuntime({
        memoryStore: stores.memoryStore,
        outboxStore: stores.outboxStore,
        vectorStore: stores.vectorStore,
        eventStore: stores.eventStore,
        tenantSettingsStore: stores.tenantSettingsStore,
        llmProvider: llmReturning([
          { content: "新しい抽出結果", digest: "新要旨", provenanceKind: "stated" },
        ]),
        embeddingProvider: stores.embeddingProvider,
        hashContent: (content: string) => `sha256(${content})`,
      });
      const unsupported = await withoutPort.reextract(ctx, observeResult.observationId);
      expect(unsupported.atomicity).toBe("store_unsupported");
      expect(unsupported.supersededMemoryIds).toHaveLength(1);
    });
  });
});

describe("observe の冪等な再送は、同時に別の観測が入っても抽出をやり直さない（ADR 0054）", () => {
  /**
   * `handleExtractableObservation` は `createObservationWithOutbox` の `created` だけを見て「抽出をやり直すか」を決める。
   * 擬似実装が `created` を大域の件数差から導いていると、同時に別の観測が作られただけで再送が「新規」に化け、
   * 同じ observation に対して抽出がもう一度走る。ここで測っているのはその値である。
   */
  it("再送は extraction: 'skipped'・memoryIds: [] のままで、LLM は増えない", async () => {
    let llmCalls = 0;
    const countingLlm: LLMProvider = {
      complete: async () => {
        throw new Error("not used");
      },
      completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> => {
        llmCalls += 1;
        return req.schema.parse({
          memories: [{ content: "東京出張がある", digest: "東京出張", provenanceKind: "stated" }],
        }) as T;
      },
    };
    const { runtime } = buildRuntime(countingLlm);

    const seed = await runtime.observe(ctx, {
      kind: "utterance",
      text: "明日東京に出張します",
      externalId: "utt-adr54",
    });
    expect(seed.extraction).toBe("ok");
    const llmCallsAfterSeed = llmCalls;

    const [resend, fresh] = await Promise.all([
      runtime.observe(ctx, {
        kind: "utterance",
        text: "明日東京に出張します",
        externalId: "utt-adr54",
      }),
      runtime.observe(ctx, {
        kind: "utterance",
        text: "来週大阪に行きます",
        externalId: "utt-adr54-other",
      }),
    ]);

    expect({
      resendExtraction: resend.extraction,
      resendMemoryIds: resend.memoryIds,
      resendIsSeedObservation: resend.observationId === seed.observationId,
      freshExtraction: fresh.extraction,
      freshMemoryCount: fresh.memoryIds.length,
      freshIsDistinctObservation: fresh.observationId !== seed.observationId,
      llmCallsAddedByResendAndFresh: llmCalls - llmCallsAfterSeed,
    }).toEqual({
      resendExtraction: "skipped",
      resendMemoryIds: [],
      resendIsSeedObservation: true,
      freshExtraction: "ok",
      freshMemoryCount: 1,
      freshIsDistinctObservation: true,
      llmCallsAddedByResendAndFresh: 1,
    });
  });
});

describe("observe: 抽出候補ごとに subjectId を持てる（Issue #608 項目①）", () => {
  it("同じ observation から出た複数候補が、候補ごとに違う subjectId を持つ", async () => {
    const { runtime, stores } = buildRuntime(
      llmReturning([
        { content: "Aさんは面白いと思った", provenanceKind: "stated", subjectId: "user:a" },
        { content: "Bさんは面白いとは思わなかった", provenanceKind: "stated", subjectId: "user:b" },
        // 明示的な null ＝ 主題なし（observation の subjectId があっても上書きする）。
        { content: "映画をやっている", provenanceKind: "stated", subjectId: null },
        // subjectId 省略 ＝ 未指定。observation の値へ落ちる。
        { content: "念のための第4の候補", provenanceKind: "stated" },
      ]),
      // 一覧を渡さずに候補ごとの主題を受けるのは opt-in（既定は捨てる）。
      { config: { acceptLlmSubjectIdWithoutCandidates: true } },
    );

    const result = await runtime.observe(ctx, {
      kind: "utterance",
      text: "この前映画観に行ってきたけど面白かったよ／僕はあんまり合わなかったかも",
      subjectId: "user:conversation-default",
    });

    expect(result.extraction).toBe("ok");
    expect(result.memoryIds).toHaveLength(4);

    const memories = await Promise.all(
      result.memoryIds.map((id) => stores.memoryStore.get(ctx, id)),
    );
    expect(memories.map((m) => m?.subjectId)).toEqual([
      "user:a",
      "user:b",
      null,
      "user:conversation-default",
    ]);
  });
});

describe("observe: subjectCandidates（Issue #608 項目②(b)）", () => {
  it("一覧内の subjectId は、そのまま Memory の subjectId になる", async () => {
    const { runtime, stores } = buildRuntime(
      llmReturning([{ content: "Aさんの話", provenanceKind: "stated", subjectId: "user:a" }]),
    );
    const result = await runtime.observe(ctx, {
      kind: "utterance",
      text: "Aさんが話した",
      subjectId: "user:conversation-default",
      subjectCandidates: ["user:a", "user:b"],
    });
    expect(result.extraction).toBe("ok");
    const memory = await stores.memoryStore.get(ctx, result.memoryIds[0]!);
    expect(memory?.subjectId).toBe("user:a");
    expect(result.rejectedSubjectIds).toEqual([]);
  });

  it("一覧外の subjectId は弾かれ、observation の subjectId へ戻る。弾いたことが ObserveResult から見える", async () => {
    const { runtime, stores } = buildRuntime(
      llmReturning([
        { content: "一覧に無い主題の話", provenanceKind: "stated", subjectId: "user:ghost" },
      ]),
    );
    const result = await runtime.observe(ctx, {
      kind: "utterance",
      text: "誰かが話した",
      subjectId: "user:conversation-default",
      subjectCandidates: ["user:a", "user:b"],
    });
    expect(result.extraction).toBe("ok");
    const memory = await stores.memoryStore.get(ctx, result.memoryIds[0]!);
    expect(memory?.subjectId).toBe("user:conversation-default");
    expect(result.rejectedSubjectIds).toEqual(["user:ghost"]);
  });

  it("null（主題なし）は一覧外でも弾かれず、observation の subjectId があっても上書きする", async () => {
    const { runtime, stores } = buildRuntime(
      llmReturning([{ content: "主題なしの話", provenanceKind: "stated", subjectId: null }]),
    );
    const result = await runtime.observe(ctx, {
      kind: "utterance",
      text: "誰かが話した",
      subjectId: "user:conversation-default",
      subjectCandidates: ["user:a", "user:b"],
    });
    const memory = await stores.memoryStore.get(ctx, result.memoryIds[0]!);
    expect(memory?.subjectId).toBeNull();
    expect(result.rejectedSubjectIds).toEqual([]);
  });

  it("subjectCandidates を渡さなければ ObserveResult に rejectedSubjectIds が無い（渡した場合とキーの有無で区別する）", async () => {
    const { runtime } = buildRuntime(
      llmReturning([{ content: "任意の主題", provenanceKind: "stated", subjectId: "anything" }]),
    );
    const result = await runtime.observe(ctx, { kind: "utterance", text: "発話" });
    expect("rejectedSubjectIds" in result).toBe(false);
  });

  it("空配列（[]）を渡した場合も『渡していない』と同じ——一覧では検証されず（opt-in なら素通り）、rejectedSubjectIds も無い", async () => {
    const { runtime, stores } = buildRuntime(
      llmReturning([{ content: "任意の主題", provenanceKind: "stated", subjectId: "anything" }]),
      { config: { acceptLlmSubjectIdWithoutCandidates: true } },
    );
    const result = await runtime.observe(ctx, {
      kind: "utterance",
      text: "発話",
      subjectCandidates: [],
    });
    const memory = await stores.memoryStore.get(ctx, result.memoryIds[0]!);
    expect(memory?.subjectId).toBe("anything");
    expect("rejectedSubjectIds" in result).toBe(false);
  });

  it("extract: 'deferred' と subjectCandidates を同時に渡すとエラーになる（検証段、黙って捨てない）", async () => {
    const { runtime } = buildRuntime(llmReturning([]));
    await expect(
      runtime.observe(ctx, {
        kind: "utterance",
        text: "発話",
        extract: "deferred",
        subjectCandidates: ["user:a"],
      }),
    ).rejects.toThrow(SUBJECT_CANDIDATES_WITH_DEFERRED_EXTRACT_ERROR_PREFIX);
  });

  it("extract: 'deferred' と空配列の subjectCandidates は、エラーにならない（空配列＝渡していないと同じ）", async () => {
    const { runtime, stores } = buildRuntime(llmReturning([]));
    const result = await runtime.observe(ctx, {
      kind: "utterance",
      text: "発話",
      extract: "deferred",
      subjectCandidates: [],
    });
    expect(result.extraction).toBe("skipped");
    const observation = await stores.memoryStore.getObservation(ctx, result.observationId);
    expect(observation).not.toBeNull();
  });

  it("deferred と subjectCandidates の組み合わせエラーは、observation を書き込む前に投げる（副作用を残さない）", async () => {
    const { runtime, stores } = buildRuntime(llmReturning([]));
    await expect(
      runtime.observe(ctx, {
        kind: "utterance",
        text: "検証段で落ちるはずの発話",
        extract: "deferred",
        subjectCandidates: ["user:a"],
      }),
    ).rejects.toThrow();
    // `runtime.observe` が投げる前に何かを書いていれば、ここに行が残ってしまう。
    // `FakeMemoryStore` は observation を連番 id で払い出すため、1件も無いことを
    // 「obs-1 が無い」で確かめる（この歯だけがこのテストで observe を呼んでいる）。
    const observation = await stores.memoryStore.getObservation(ctx, "obs-1");
    expect(observation).toBeNull();
  });

  it("event / document でも subjectCandidates が同じように効く", async () => {
    const { runtime: eventRuntime, stores: eventStores } = buildRuntime(
      llmReturning([{ content: "ログインした", provenanceKind: "stated", subjectId: "user:a" }]),
    );
    const eventResult = await eventRuntime.observe(ctx, {
      kind: "event",
      name: "login",
      subjectCandidates: ["user:a"],
    });
    const eventMemory = await eventStores.memoryStore.get(ctx, eventResult.memoryIds[0]!);
    expect(eventMemory?.subjectId).toBe("user:a");

    const { runtime: docRuntime, stores: docStores } = buildRuntime(
      llmReturning([{ content: "文書の要点", provenanceKind: "stated", subjectId: "user:z" }]),
    );
    const docResult = await docRuntime.observe(ctx, {
      kind: "document",
      content: "本文",
      subjectCandidates: ["user:a"],
    });
    const docMemory = await docStores.memoryStore.get(ctx, docResult.memoryIds[0]!);
    expect(docMemory?.subjectId).toBeNull(); // observation.subjectId も無いので null（①の既存の振る舞い）
    expect(docResult.rejectedSubjectIds).toEqual(["user:z"]);
  });

  it("reextract は候補一覧を使わない（保存されていないため）——observe() 時点では弾かれたはずの値が、reextract では素通りする", async () => {
    const { runtime, stores } = buildRuntime(
      llmReturning([{ content: "初回の抽出", provenanceKind: "stated", subjectId: "user:a" }]),
    );
    const observeResult = await runtime.observe(ctx, {
      kind: "utterance",
      text: "発話",
      subjectId: "user:conversation-default",
      subjectCandidates: ["user:a"], // "user:ghost" はこの一覧に無い
    });
    expect(observeResult.extraction).toBe("ok");

    const reextractRuntime = createRuntime({
      memoryStore: stores.memoryStore,
      outboxStore: stores.outboxStore,
      vectorStore: stores.vectorStore,
      eventStore: stores.eventStore,
      tenantSettingsStore: stores.tenantSettingsStore,
      llmProvider: llmReturning([
        { content: "やり直した抽出", provenanceKind: "stated", subjectId: "user:ghost" },
      ]),
      embeddingProvider: stores.embeddingProvider,
      hashContent: (content: string) => `sha256(${content})`,
      // 既定では reextract も LLM の subjectId を捨てる。ここは「一覧で検証しようがない」ことを縛るので opt-in で受ける。
      config: { acceptLlmSubjectIdWithoutCandidates: true },
    });
    const reextractResult = await reextractRuntime.reextract(ctx, observeResult.observationId);
    expect(reextractResult.extraction).toBe("ok");
    const newMemoryId = reextractResult.memoryIds.find(
      (id) => !observeResult.memoryIds.includes(id),
    );
    const newMemory = await stores.memoryStore.get(ctx, newMemoryId!);
    // subjectCandidates は Observation にも DB にも保存されていないため、reextract は
    // これを検証しようがなく、LLM が返した値をそのまま使う——observe() 時点なら
    // 「一覧外」として弾かれていたはずの "user:ghost" が、ここではそのまま通る。
    expect(newMemory?.subjectId).toBe("user:ghost");
    expect("rejectedSubjectIds" in reextractResult).toBe(false);
  });
});

describe("observe: claimKey（Issue #371、(B) 第1段。ADR 0185/0315 決定2の(ii) separate）", () => {
  it("既定（claimKey を渡さない）では、deriveClaimKeys は一度も呼ばれない。呼び出し回数は1のまま", async () => {
    const llm = sequencedLlm([{ memories: [{ content: "発話", provenanceKind: "stated" }] }]);
    const { runtime, stores } = buildRuntime(llm);
    const result = await runtime.observe(ctx, { kind: "utterance", text: "発話" });
    expect(result.extraction).toBe("ok");
    expect(llm.calls.length).toBe(1); // 抽出の1回だけ。claim key の呼び出しは無い。
    const memory = await stores.memoryStore.get(ctx, result.memoryIds[0]!);
    expect(memory?.claimKey ?? null).toBeNull();
    expect("claimKeyFailure" in result).toBe(false);
  });

  it("claimKey: { enabled: false } でも、既定と同じ——呼ばれない・キーも無い", async () => {
    const llm = sequencedLlm([{ memories: [{ content: "発話", provenanceKind: "stated" }] }]);
    const { runtime } = buildRuntime(llm);
    const result = await runtime.observe(ctx, {
      kind: "utterance",
      text: "発話",
      claimKey: { enabled: false },
    });
    expect(llm.calls.length).toBe(1);
    expect("claimKeyFailure" in result).toBe(false);
  });

  it("claimKey: { enabled: true } は、候補群をまとめて1回（バッチ）で問う——候補ごとに独立呼び出しにしない", async () => {
    const llm = sequencedLlm([
      {
        memories: [
          { content: "好きな食べ物はラーメン", provenanceKind: "stated" },
          { content: "好きな色は青", provenanceKind: "stated" },
        ],
      },
      {
        claims: [
          { subject: "user", predicate: "favorite_food" },
          { subject: "user", predicate: "favorite_color" },
        ],
      },
    ]);
    const { runtime, stores } = buildRuntime(llm);
    const result = await runtime.observe(ctx, {
      kind: "utterance",
      text: "好きな食べ物はラーメン、好きな色は青",
      claimKey: { enabled: true },
    });
    expect(result.extraction).toBe("ok");
    expect(llm.calls.length).toBe(2); // 抽出1回 + claim key 1回（候補2件をまとめて）。
    expect(result.memoryIds.length).toBe(2);

    const first = await stores.memoryStore.get(ctx, result.memoryIds[0]!);
    const second = await stores.memoryStore.get(ctx, result.memoryIds[1]!);
    expect(first?.claimKey).toEqual({ subject: "user", predicate: "favorite_food" });
    expect(second?.claimKey).toEqual({ subject: "user", predicate: "favorite_color" });
    expect(result.claimKeyFailure).toBeNull();
  });

  it("既定の抽出プロンプトは opt-in の有無で変わらない——2回目の呼び出しだけが増える", async () => {
    const withoutOptIn = sequencedLlm([{ memories: [] }]);
    const { runtime: runtimeA } = buildRuntime(withoutOptIn);
    await runtimeA.observe(ctx, { kind: "utterance", text: "発話" });
    const firstPromptWithoutOptIn: unknown = withoutOptIn.calls[0]!.prompt;

    const withOptIn = sequencedLlm([{ memories: [] }]);
    const { runtime: runtimeB } = buildRuntime(withOptIn);
    await runtimeB.observe(ctx, {
      kind: "utterance",
      text: "発話",
      claimKey: { enabled: true },
    });
    const firstPromptWithOptIn: unknown = withOptIn.calls[0]!.prompt;

    expect(firstPromptWithOptIn).toEqual(firstPromptWithoutOptIn);
    expect(withoutOptIn.calls.length).toBe(1);
    expect(withOptIn.calls.length).toBe(1);
  });

  it("候補が0件なら、opt-in が有効でも claim key の呼び出しは起きない（+0回）", async () => {
    const llm = sequencedLlm([{ memories: [] }]);
    const { runtime, stores } = buildRuntime(llm);
    const result = await runtime.observe(ctx, {
      kind: "utterance",
      text: "何も記憶に値しない発話",
      claimKey: { enabled: true },
    });
    expect(result.memoryIds).toEqual([]);
    expect(llm.calls.length).toBe(1);
    expect(result.claimKeyFailure).toBeNull();
    void stores;
  });

  it("claim key の呼び出しが失敗しても、Memory の作成は止まらない——claimKey は null のまま、失敗は ObserveResult に残る", async () => {
    const llm = sequencedLlm([{ memories: [{ content: "発話", provenanceKind: "stated" }] }]);
    const { runtime, stores } = buildRuntime(llm);
    const result = await runtime.observe(ctx, {
      kind: "utterance",
      text: "発話",
      claimKey: { enabled: true },
    });
    expect(result.extraction).toBe("ok");
    expect(result.memoryIds.length).toBe(1);
    const memory = await stores.memoryStore.get(ctx, result.memoryIds[0]!);
    expect(memory?.claimKey ?? null).toBeNull();
    expect(result.claimKeyFailure).not.toBeNull();
  });

  it("knownPredicates を渡すと、claim key 呼び出しの system プロンプトへ足される", async () => {
    const llm = sequencedLlm([
      { memories: [{ content: "発話", provenanceKind: "stated" }] },
      { claims: [{ subject: "user", predicate: "favorite_food" }] },
    ]);
    const { runtime } = buildRuntime(llm);
    await runtime.observe(ctx, {
      kind: "utterance",
      text: "発話",
      claimKey: { enabled: true, knownPredicates: ["favorite_food", "favorite_color"] },
    });
    const claimKeyCall = llm.calls[1]!;
    expect(claimKeyCall.prompt.system).toContain("favorite_food");
    expect(claimKeyCall.prompt.system).toContain("favorite_color");
  });

  it("extract: 'deferred' と claimKey を同時に渡すとエラーになる（検証段、黙って捨てない）", async () => {
    const { runtime } = buildRuntime(llmReturning([]));
    await expect(
      runtime.observe(ctx, {
        kind: "utterance",
        text: "発話",
        extract: "deferred",
        claimKey: { enabled: true },
      }),
    ).rejects.toThrow(CLAIM_KEY_WITH_DEFERRED_EXTRACT_ERROR_PREFIX);
  });

  it("deferred と claimKey の組み合わせエラーは、observation を書き込む前に投げる（副作用を残さない）", async () => {
    const { runtime, stores } = buildRuntime(llmReturning([]));
    await expect(
      runtime.observe(ctx, {
        kind: "utterance",
        text: "検証段で落ちるはずの発話",
        extract: "deferred",
        claimKey: { enabled: true },
      }),
    ).rejects.toThrow();
    const observation = await stores.memoryStore.getObservation(ctx, "obs-1");
    expect(observation).toBeNull();
  });

  it("event / document でも claimKey が同じように効く", async () => {
    const eventLlm = sequencedLlm([
      { memories: [{ content: "ログインした", provenanceKind: "stated" }] },
      { claims: [{ subject: "user", predicate: "login" }] },
    ]);
    const { runtime: eventRuntime, stores: eventStores } = buildRuntime(eventLlm);
    const eventResult = await eventRuntime.observe(ctx, {
      kind: "event",
      name: "login",
      claimKey: { enabled: true },
    });
    const eventMemory = await eventStores.memoryStore.get(ctx, eventResult.memoryIds[0]!);
    expect(eventMemory?.claimKey).toEqual({ subject: "user", predicate: "login" });

    const docLlm = sequencedLlm([
      { memories: [{ content: "文書の要点", provenanceKind: "stated" }] },
      { claims: [{ subject: "user", predicate: "document_summary" }] },
    ]);
    const { runtime: docRuntime, stores: docStores } = buildRuntime(docLlm);
    const docResult = await docRuntime.observe(ctx, {
      kind: "document",
      content: "本文",
      claimKey: { enabled: true },
    });
    const docMemory = await docStores.memoryStore.get(ctx, docResult.memoryIds[0]!);
    expect(docMemory?.claimKey).toEqual({ subject: "user", predicate: "document_summary" });
  });

  it("reextract は claimKey を使わない（保存されていないため）——opt-in していても呼び出しは抽出の1回だけ", async () => {
    const observeLlm = sequencedLlm([
      { memories: [{ content: "初回の抽出", provenanceKind: "stated" }] },
      { claims: [{ subject: "user", predicate: "topic" }] },
    ]);
    const { runtime, stores } = buildRuntime(observeLlm);
    const observeResult = await runtime.observe(ctx, {
      kind: "utterance",
      text: "発話",
      claimKey: { enabled: true },
    });
    expect(observeResult.extraction).toBe("ok");

    const reextractLlm = sequencedLlm([
      { memories: [{ content: "やり直した抽出", provenanceKind: "stated" }] },
    ]);
    const reextractRuntime = createRuntime({
      memoryStore: stores.memoryStore,
      outboxStore: stores.outboxStore,
      vectorStore: stores.vectorStore,
      eventStore: stores.eventStore,
      tenantSettingsStore: stores.tenantSettingsStore,
      llmProvider: reextractLlm,
      embeddingProvider: stores.embeddingProvider,
      hashContent: (content: string) => `sha256(${content})`,
    });
    const reextractResult = await reextractRuntime.reextract(ctx, observeResult.observationId);
    expect(reextractResult.extraction).toBe("ok");
    expect(reextractLlm.calls.length).toBe(1);
    const newMemoryId = reextractResult.memoryIds.find(
      (id) => !observeResult.memoryIds.includes(id),
    );
    const newMemory = await stores.memoryStore.get(ctx, newMemoryId!);
    expect(newMemory?.claimKey ?? null).toBeNull();
    expect("claimKeyFailure" in reextractResult).toBe(false);
  });
});

describe("observe: claimKey knownPredicatesFromStore（Issue #691続き、ADR 0326「採らなかった案B」の実装、ADR 0329）", () => {
  /**
   * `stores.memoryStore.listActiveClaimPredicates` の呼び出し回数・引数を捕まえる薄い
   * ラッパー（`spyOnFindActiveByClaimKey` と同じ形——プロトタイプは変更しない）。
   */
  function spyOnListActiveClaimPredicates(memoryStore: FakeMemoryStore): {
    calls: { subjectId: string | null; limit: number }[];
  } {
    const spy: { calls: { subjectId: string | null; limit: number }[] } = { calls: [] };
    const original = memoryStore.listActiveClaimPredicates.bind(memoryStore);
    memoryStore.listActiveClaimPredicates = (async (...args: Parameters<typeof original>) => {
      spy.calls.push(args[1]);
      return original(...args);
    }) as typeof memoryStore.listActiveClaimPredicates;
    return spy;
  }

  it("既定（knownPredicatesFromStore を渡さない）では、listActiveClaimPredicates は一度も呼ばれない", async () => {
    const llm = sequencedLlm([
      { memories: [{ content: "好きな食べ物はラーメン", provenanceKind: "stated" }] },
      { claims: [{ subject: "user", predicate: "favorite_food" }] },
    ]);
    const { runtime, stores } = buildRuntime(llm);
    const spy = spyOnListActiveClaimPredicates(stores.memoryStore);
    await runtime.observe(ctx, {
      kind: "utterance",
      text: "好きな食べ物はラーメン",
      claimKey: { enabled: true },
    });
    expect(spy.calls).toEqual([]);
  });

  it("knownPredicatesFromStore: false は既定と同じ——呼ばれない", async () => {
    const llm = sequencedLlm([
      { memories: [{ content: "好きな食べ物はラーメン", provenanceKind: "stated" }] },
      { claims: [{ subject: "user", predicate: "favorite_food" }] },
    ]);
    const { runtime, stores } = buildRuntime(llm);
    const spy = spyOnListActiveClaimPredicates(stores.memoryStore);
    await runtime.observe(ctx, {
      kind: "utterance",
      text: "好きな食べ物はラーメン",
      claimKey: { enabled: true, knownPredicatesFromStore: false },
    });
    expect(spy.calls).toEqual([]);
  });

  it("候補が0件なら、knownPredicatesFromStore が有効でも listActiveClaimPredicates は呼ばれない（+0回）", async () => {
    const llm = sequencedLlm([{ memories: [] }]);
    const { runtime, stores } = buildRuntime(llm);
    const spy = spyOnListActiveClaimPredicates(stores.memoryStore);
    const result = await runtime.observe(ctx, {
      kind: "utterance",
      text: "何も記憶に値しない発話",
      claimKey: { enabled: true, knownPredicatesFromStore: true },
    });
    expect(result.memoryIds).toEqual([]);
    expect(spy.calls).toEqual([]);
  });

  it("store が listActiveClaimPredicates を実装しない adapter では、knownPredicatesFromStore: true でも静かに効かない——渡した knownPredicates だけが使われる", async () => {
    const llm = sequencedLlm([
      { memories: [{ content: "好きな食べ物はラーメン", provenanceKind: "stated" }] },
      { claims: [{ subject: "user", predicate: "favorite_food" }] },
    ]);
    const { runtime, stores } = buildRuntime(llm);
    // `listActiveClaimPredicates` を持たない adapter を模す。
    // @ts-expect-error テスト用に任意メソッドを取り除く。
    stores.memoryStore.listActiveClaimPredicates = undefined;
    await runtime.observe(ctx, {
      kind: "utterance",
      text: "好きな食べ物はラーメン",
      claimKey: {
        enabled: true,
        knownPredicates: ["existing_hint"],
        knownPredicatesFromStore: true,
      },
    });
    const claimKeyCall = llm.calls[1]!;
    expect(claimKeyCall.prompt.system).toContain("existing_hint");
  });

  it("knownPredicatesFromStore: true で、同じ subjectId の既存 active な claim key predicate が system プロンプトへ足される", async () => {
    const seedLlm = sequencedLlm([
      { memories: [{ content: "好きな食べ物はラーメン", provenanceKind: "stated" }] },
      { claims: [{ subject: "user", predicate: "favorite_food" }] },
    ]);
    const { runtime, stores } = buildRuntime(seedLlm);
    await runtime.observe(ctx, {
      kind: "utterance",
      text: "好きな食べ物はラーメン",
      subjectId: "user-1",
      claimKey: { enabled: true },
    });

    const followUpLlm = sequencedLlm([
      { memories: [{ content: "苦手な食べ物はパクチー", provenanceKind: "stated" }] },
      { claims: [{ subject: "user", predicate: "food_dislike" }] },
    ]);
    const runtime2 = createRuntime({
      memoryStore: stores.memoryStore,
      outboxStore: stores.outboxStore,
      vectorStore: stores.vectorStore,
      eventStore: stores.eventStore,
      tenantSettingsStore: stores.tenantSettingsStore,
      llmProvider: followUpLlm,
      embeddingProvider: stores.embeddingProvider,
      hashContent: (content: string) => `sha256(${content})`,
    });
    await runtime2.observe(ctx, {
      kind: "utterance",
      text: "苦手な食べ物はパクチー",
      subjectId: "user-1",
      claimKey: { enabled: true, knownPredicatesFromStore: true },
    });
    const claimKeyCall = followUpLlm.calls[1]!;
    expect(claimKeyCall.prompt.system).toContain("favorite_food");
  });

  it("subjectId ごとに store を引く——observation.subjectId をそのまま listActiveClaimPredicates へ渡す", async () => {
    const llm = sequencedLlm([
      { memories: [{ content: "好きな食べ物はラーメン", provenanceKind: "stated" }] },
      { claims: [{ subject: "user", predicate: "favorite_food" }] },
    ]);
    const { runtime, stores } = buildRuntime(llm);
    const spy = spyOnListActiveClaimPredicates(stores.memoryStore);
    await runtime.observe(ctx, {
      kind: "utterance",
      text: "好きな食べ物はラーメン",
      subjectId: "user-1",
      claimKey: { enabled: true, knownPredicatesFromStore: true },
    });
    expect(spy.calls).toEqual([
      { subjectId: "user-1", limit: DEFAULT_KNOWN_PREDICATES_FROM_STORE_LIMIT },
    ]);
  });

  it("knownPredicatesFromStore: true（limit を指定しない）なら、既定の上限 20 件を store へ渡す（ADR 0329）", async () => {
    const llm = sequencedLlm([
      { memories: [{ content: "好きな食べ物はラーメン", provenanceKind: "stated" }] },
      { claims: [{ subject: "user", predicate: "favorite_food" }] },
    ]);
    const { runtime, stores } = buildRuntime(llm);
    const spy = spyOnListActiveClaimPredicates(stores.memoryStore);
    await runtime.observe(ctx, {
      kind: "utterance",
      text: "好きな食べ物はラーメン",
      claimKey: { enabled: true, knownPredicatesFromStore: true },
    });
    expect(DEFAULT_KNOWN_PREDICATES_FROM_STORE_LIMIT).toBe(20);
    expect(spy.calls).toEqual([{ subjectId: null, limit: 20 }]);
  });

  it("knownPredicatesFromStore: { limit } を渡すと、その件数を store へ渡す", async () => {
    const llm = sequencedLlm([
      { memories: [{ content: "好きな食べ物はラーメン", provenanceKind: "stated" }] },
      { claims: [{ subject: "user", predicate: "favorite_food" }] },
    ]);
    const { runtime, stores } = buildRuntime(llm);
    const spy = spyOnListActiveClaimPredicates(stores.memoryStore);
    await runtime.observe(ctx, {
      kind: "utterance",
      text: "好きな食べ物はラーメン",
      claimKey: { enabled: true, knownPredicatesFromStore: { limit: 3 } },
    });
    expect(spy.calls).toEqual([{ subjectId: null, limit: 3 }]);
  });

  it("利用者の knownPredicates を先に、store から集めた一覧を後ろに、重複を除いて連結する", async () => {
    const seedLlm = sequencedLlm([
      { memories: [{ content: "好きな食べ物はラーメン", provenanceKind: "stated" }] },
      { claims: [{ subject: "user", predicate: "favorite_food" }] },
      { memories: [{ content: "好きな色は青", provenanceKind: "stated" }] },
      { claims: [{ subject: "user", predicate: "favorite_color" }] },
    ]);
    const { runtime, stores } = buildRuntime(seedLlm);
    await runtime.observe(ctx, {
      kind: "utterance",
      text: "好きな食べ物はラーメン",
      subjectId: "user-1",
      claimKey: { enabled: true },
    });
    await runtime.observe(ctx, {
      kind: "utterance",
      text: "好きな色は青",
      subjectId: "user-1",
      claimKey: { enabled: true },
    });

    const followUpLlm = sequencedLlm([
      { memories: [{ content: "苦手な食べ物はパクチー", provenanceKind: "stated" }] },
      { claims: [{ subject: "user", predicate: "food_dislike" }] },
    ]);
    const runtime2 = createRuntime({
      memoryStore: stores.memoryStore,
      outboxStore: stores.outboxStore,
      vectorStore: stores.vectorStore,
      eventStore: stores.eventStore,
      tenantSettingsStore: stores.tenantSettingsStore,
      llmProvider: followUpLlm,
      embeddingProvider: stores.embeddingProvider,
      hashContent: (content: string) => `sha256(${content})`,
    });
    await runtime2.observe(ctx, {
      kind: "utterance",
      text: "苦手な食べ物はパクチー",
      subjectId: "user-1",
      claimKey: {
        enabled: true,
        knownPredicates: ["user_chosen_hint", "favorite_food"],
        knownPredicatesFromStore: true,
      },
    });
    const claimKeyCall = followUpLlm.calls[1]!;
    const system = claimKeyCall.prompt.system as string;
    expect(system).toContain(
      "既知の predicate 候補一覧: user_chosen_hint, favorite_food, favorite_color。",
    );
  });
});

describe("observe: claimKey knownSubjects は subjectCandidates へ暗黙に転用しない（Issue #372負債6、ADR 0334）", () => {
  /**
   * `knownPredicatesFromStore` と対になる `knownSubjectsFromStore`（store が自己蓄積した claim key subject を語彙ヒントに動的に足す版）は実装していない。
   * store 分は LLM が自由記述で作った曖昧な値（例: `'sibling'`）になりがちで、汎用語彙として横流しすると無関係な話題の主張にまで誤って使い回されるため。
   *
   * この describe が検査するのは、`knownSubjects` を明示しない限り `subjectCandidates` の有無・中身がプロンプトに一切影響しないこと。
   * `claimKey.enabled: true` と `subjectCandidates` を併用している呼び出し側が、新しい opt-in を何も選んでいないのにプロンプト・カセット鍵が動いてはならない。
   */

  it("knownSubjects も subjectCandidates も渡さなければ、system に既知の subject 候補一覧の文言が無い", async () => {
    const llm = sequencedLlm([
      { memories: [{ content: "姉は福岡で働いています。", provenanceKind: "stated" }] },
      { claims: [{ subject: "姉", predicate: "sibling_residence" }] },
    ]);
    const { runtime } = buildRuntime(llm);
    await runtime.observe(ctx, {
      kind: "utterance",
      text: "姉は福岡で働いています。",
      claimKey: { enabled: true },
    });
    const claimKeyCall = llm.calls[1]!;
    expect(claimKeyCall.prompt.system).not.toContain("既知の subject 候補一覧");
  });

  it("claimKeyOptions.knownSubjects を渡すと、その語彙が system へ足される", async () => {
    const llm = sequencedLlm([
      { memories: [{ content: "姉は福岡で働いています。", provenanceKind: "stated" }] },
      { claims: [{ subject: "姉", predicate: "sibling_residence" }] },
    ]);
    const { runtime } = buildRuntime(llm);
    await runtime.observe(ctx, {
      kind: "utterance",
      text: "姉は福岡で働いています。",
      claimKey: { enabled: true, knownSubjects: ["user", "姉"] },
    });
    const claimKeyCall = llm.calls[1]!;
    expect(claimKeyCall.prompt.system).toContain("既知の subject 候補一覧: user, 姉。");
  });

  it("claimKey.knownSubjects: [] は『渡していない』と同じ——claim key 呼び出しの system が省いた場合と toEqual（ClaimKeyOptions.knownSubjects の doc。Issue #1775 の #792）", async () => {
    const run = async (claimKey: { enabled: true; knownSubjects?: string[] }) => {
      const llm = sequencedLlm([
        { memories: [{ content: "姉は福岡で働いています。", provenanceKind: "stated" }] },
        { claims: [{ subject: "姉", predicate: "sibling_residence" }] },
      ]);
      const { runtime } = buildRuntime(llm);
      await runtime.observe(ctx, { kind: "utterance", text: "姉は福岡で働いています。", claimKey });
      return llm.calls[1]!.prompt;
    };
    expect(await run({ enabled: true, knownSubjects: [] })).toEqual(await run({ enabled: true }));
  });

  it("knownPredicates と knownSubjects を併用すると、observe を通した claim key 呼び出しの system に両方が出て、predicate が先（ADR 0334。Issue #1775 の #792）", async () => {
    const llm = sequencedLlm([
      { memories: [{ content: "姉は福岡で働いています。", provenanceKind: "stated" }] },
      { claims: [{ subject: "姉", predicate: "sibling_residence" }] },
    ]);
    const { runtime } = buildRuntime(llm);
    await runtime.observe(ctx, {
      kind: "utterance",
      text: "姉は福岡で働いています。",
      claimKey: { enabled: true, knownPredicates: ["favorite_food"], knownSubjects: ["user"] },
    });
    const system = llm.calls[1]!.prompt.system as string;
    const predicateIndex = system.indexOf("既知の predicate 候補一覧");
    const subjectIndex = system.indexOf("既知の subject 候補一覧");
    expect(predicateIndex).toBeGreaterThanOrEqual(0);
    expect(subjectIndex).toBeGreaterThan(predicateIndex);
  });

  it("regression: enabled: true + subjectCandidates あり + knownSubjects 省略のとき、claim key プロンプトは subjectCandidates を渡さない場合（＝main の既存挙動）と完全に同一——暗黙の転用が復活していないことを固定する", async () => {
    const withCandidatesLlm = sequencedLlm([
      { memories: [{ content: "姉は福岡で働いています。", provenanceKind: "stated" }] },
      { claims: [{ subject: "姉", predicate: "sibling_residence" }] },
    ]);
    const { runtime: withCandidatesRuntime } = buildRuntime(withCandidatesLlm);
    await withCandidatesRuntime.observe(ctx, {
      kind: "utterance",
      text: "姉は福岡で働いています。",
      subjectCandidates: ["user", "姉", "同僚"],
      claimKey: { enabled: true },
    });

    const withoutCandidatesLlm = sequencedLlm([
      { memories: [{ content: "姉は福岡で働いています。", provenanceKind: "stated" }] },
      { claims: [{ subject: "姉", predicate: "sibling_residence" }] },
    ]);
    const { runtime: withoutCandidatesRuntime } = buildRuntime(withoutCandidatesLlm);
    await withoutCandidatesRuntime.observe(ctx, {
      kind: "utterance",
      text: "姉は福岡で働いています。",
      claimKey: { enabled: true },
    });

    const withCandidatesPrompt = withCandidatesLlm.calls[1]!.prompt;
    const withoutCandidatesPrompt = withoutCandidatesLlm.calls[1]!.prompt;
    // `PromptSpec`（system + messages）が完全一致 ⟹ カセット鍵（`llmCassetteKey`）も動かない。
    expect(withCandidatesPrompt).toEqual(withoutCandidatesPrompt);
    expect(withCandidatesPrompt.system).not.toContain("既知の subject 候補一覧");
  });

  it("claimKeyOptions.knownSubjects と subjectCandidates の両方を渡しても、subjectCandidates 側は system に一切現れない", async () => {
    const llm = sequencedLlm([
      { memories: [{ content: "姉は福岡で働いています。", provenanceKind: "stated" }] },
      { claims: [{ subject: "姉", predicate: "sibling_residence" }] },
    ]);
    const { runtime } = buildRuntime(llm);
    await runtime.observe(ctx, {
      kind: "utterance",
      text: "姉は福岡で働いています。",
      subjectCandidates: ["user", "ignored_candidate"],
      claimKey: { enabled: true, knownSubjects: ["user", "姉"] },
    });
    const claimKeyCall = llm.calls[1]!;
    const system = claimKeyCall.prompt.system as string;
    expect(system).toContain("既知の subject 候補一覧: user, 姉。");
    expect(system).not.toContain("ignored_candidate");
  });

  it("候補が0件なら、subjectCandidates を渡していても claim key 派生自体が呼ばれない（+0回、既存の「候補0件」規約のまま）", async () => {
    const llm = sequencedLlm([{ memories: [] }]);
    const { runtime } = buildRuntime(llm);
    const result = await runtime.observe(ctx, {
      kind: "utterance",
      text: "何も記憶に値しない発話",
      subjectCandidates: ["user", "姉"],
      claimKey: { enabled: true },
    });
    expect(result.memoryIds).toEqual([]);
    expect(llm.calls.length).toBe(1);
  });
});

describe("observe: claimKey 検出（Issue #372、(B) 第2段。ADR 0185 決定2・決定4）", () => {
  /**
   * `stores.memoryStore.findActiveByClaimKey` の呼び出し回数を数える薄いラッパーを
   * インスタンスへ被せる（プロトタイプは変更しない——他のテストに影響しない）。
   */
  function spyOnFindActiveByClaimKey(memoryStore: FakeMemoryStore): { calls: number } {
    const counter = { calls: 0 };
    const original = memoryStore.findActiveByClaimKey.bind(memoryStore);
    memoryStore.findActiveByClaimKey = (async (...args: Parameters<typeof original>) => {
      counter.calls += 1;
      return original(...args);
    }) as typeof memoryStore.findActiveByClaimKey;
    return counter;
  }

  it("既定（detectContested を渡さない）では、findActiveByClaimKey は一度も呼ばれず、1件も contested にならない", async () => {
    const llm = sequencedLlm([
      { memories: [{ content: "好きな食べ物はラーメン", provenanceKind: "stated" }] },
      { claims: [{ subject: "user", predicate: "favorite_food" }] },
      { memories: [{ content: "好きな食べ物は寿司", provenanceKind: "stated" }] },
      { claims: [{ subject: "user", predicate: "favorite_food" }] },
    ]);
    const { runtime, stores } = buildRuntime(llm);
    const spy = spyOnFindActiveByClaimKey(stores.memoryStore);

    const first = await runtime.observe(ctx, {
      kind: "utterance",
      text: "好きな食べ物はラーメン",
      claimKey: { enabled: true },
    });
    const second = await runtime.observe(ctx, {
      kind: "utterance",
      text: "好きな食べ物は寿司",
      claimKey: { enabled: true },
    });

    expect(spy.calls).toBe(0);
    expect("contestedDetection" in first).toBe(false);
    expect("contestedDetection" in second).toBe(false);
    const firstMemory = await stores.memoryStore.get(ctx, first.memoryIds[0]!);
    const secondMemory = await stores.memoryStore.get(ctx, second.memoryIds[0]!);
    expect(firstMemory?.status).toBe("active");
    expect(secondMemory?.status).toBe("active");
    expect(firstMemory?.contestedWithId ?? null).toBeNull();
    expect(secondMemory?.contestedWithId ?? null).toBeNull();
    const events = await stores.eventStore.list(ctx, {});
    expect(events.some((e) => (e.meta as { reason?: string }).reason === "contested")).toBe(false);
    expect(
      events.some(
        (e) => (e.meta as { reason?: string }).reason === "claim_key_conflict_unresolved",
      ),
    ).toBe(false);
  });

  it("detectContested: false は既定と同じ——検出は走らない", async () => {
    const llm = sequencedLlm([
      { memories: [{ content: "好きな食べ物はラーメン", provenanceKind: "stated" }] },
      { claims: [{ subject: "user", predicate: "favorite_food" }] },
    ]);
    const { runtime, stores } = buildRuntime(llm);
    const spy = spyOnFindActiveByClaimKey(stores.memoryStore);
    const result = await runtime.observe(ctx, {
      kind: "utterance",
      text: "好きな食べ物はラーメン",
      claimKey: { enabled: true, detectContested: false },
    });
    expect(spy.calls).toBe(0);
    expect("contestedDetection" in result).toBe(false);
  });

  it("同じ鍵・重なる有効期間・違う内容の active がちょうど1件あると、検出が発火して両側とも contested になる", async () => {
    const llm = sequencedLlm([
      { memories: [{ content: "好きな食べ物はラーメン", provenanceKind: "stated" }] },
      { claims: [{ subject: "user", predicate: "favorite_food" }] },
      { memories: [{ content: "好きな食べ物は寿司", provenanceKind: "stated" }] },
      { claims: [{ subject: "user", predicate: "favorite_food" }] },
    ]);
    const { runtime, stores } = buildRuntime(llm);
    const first = await runtime.observe(ctx, {
      kind: "utterance",
      text: "好きな食べ物はラーメン",
      claimKey: { enabled: true, detectContested: true },
    });
    expect(first.contestedDetection).toEqual([
      {
        memoryId: first.memoryIds[0],
        claimKey: { subject: "user", predicate: "favorite_food" },
        matchCount: 0,
        result: { kind: "no_conflict" },
      },
    ]);

    const second = await runtime.observe(ctx, {
      kind: "utterance",
      text: "好きな食べ物は寿司",
      claimKey: { enabled: true, detectContested: true },
    });
    expect(second.contestedDetection).toHaveLength(1);
    const outcome = second.contestedDetection![0]!;
    expect(outcome.matchCount).toBe(1);
    expect(outcome.result.kind).toBe("contested");
    if (outcome.result.kind !== "contested") throw new Error("unreachable");
    expect(outcome.result.withMemoryId).toBe(first.memoryIds[0]);
    expect(outcome.result.markContested.outcome.kind).toBe("contested");

    const firstMemory = await stores.memoryStore.get(ctx, first.memoryIds[0]!);
    const secondMemory = await stores.memoryStore.get(ctx, second.memoryIds[0]!);
    expect(firstMemory?.status).toBe("contested");
    expect(secondMemory?.status).toBe("contested");
    expect(firstMemory?.contestedWithId).toBe(second.memoryIds[0]);
    expect(secondMemory?.contestedWithId).toBe(first.memoryIds[0]);
    expect(firstMemory?.status).not.toBe("superseded");
    expect(secondMemory?.status).not.toBe("superseded");
  });

  it("markContested の根拠（鍵・重なった有効期間・両側の content_hash）が meta.note に構造として載る", async () => {
    const llm = sequencedLlm([
      { memories: [{ content: "好きな食べ物はラーメン", provenanceKind: "stated" }] },
      { claims: [{ subject: "user", predicate: "favorite_food" }] },
      { memories: [{ content: "好きな食べ物は寿司", provenanceKind: "stated" }] },
      { claims: [{ subject: "user", predicate: "favorite_food" }] },
    ]);
    const { runtime, stores } = buildRuntime(llm);
    const first = await runtime.observe(ctx, {
      kind: "utterance",
      text: "好きな食べ物はラーメン",
      claimKey: { enabled: true, detectContested: true },
    });
    const second = await runtime.observe(ctx, {
      kind: "utterance",
      text: "好きな食べ物は寿司",
      claimKey: { enabled: true, detectContested: true },
    });

    const events = await stores.eventStore.list(ctx, { memoryId: second.memoryIds[0]! });
    const contestedEvent = events.find(
      (e) => (e.meta as { reason?: string }).reason === "contested",
    );
    expect(contestedEvent).toBeDefined();
    const note = JSON.parse((contestedEvent!.meta as { note: string }).note) as {
      kind: string;
      claimKey: { subject: string; predicate: string };
      subjectId: string | null;
      first: { id: string; contentHash: string };
      second: { id: string; contentHash: string };
    };
    expect(note.kind).toBe("claim_key_conflict");
    expect(note.claimKey).toEqual({ subject: "user", predicate: "favorite_food" });
    expect([note.first.id, note.second.id].sort()).toEqual(
      [first.memoryIds[0], second.memoryIds[0]].sort(),
    );
  });

  it("content_hash が同じなら矛盾にならない（同じ内容を2回言っても衝突しない）", async () => {
    const llm = sequencedLlm([
      { memories: [{ content: "好きな食べ物はラーメン", provenanceKind: "stated" }] },
      { claims: [{ subject: "user", predicate: "favorite_food" }] },
      { memories: [{ content: "好きな食べ物はラーメン", provenanceKind: "stated" }] },
      { claims: [{ subject: "user", predicate: "favorite_food" }] },
    ]);
    const { runtime, stores } = buildRuntime(llm);
    await runtime.observe(ctx, {
      kind: "utterance",
      text: "好きな食べ物はラーメン",
      claimKey: { enabled: true, detectContested: true },
    });
    const second = await runtime.observe(ctx, {
      kind: "utterance",
      text: "好きな食べ物はラーメン",
      claimKey: { enabled: true, detectContested: true },
    });
    expect(second.contestedDetection).toEqual([
      expect.objectContaining({ matchCount: 0, result: { kind: "no_conflict" } }),
    ]);
    void stores;
  });

  it("有効期間が重ならなければ矛盾にならない（去年の住所と今の住所）", async () => {
    const llm = sequencedLlm([
      { memories: [{ content: "住所は東京", provenanceKind: "stated" }] },
      { claims: [{ subject: "user", predicate: "address" }] },
      { memories: [{ content: "住所は大阪", provenanceKind: "stated" }] },
      { claims: [{ subject: "user", predicate: "address" }] },
    ]);
    const { runtime, stores } = buildRuntime(llm);
    await runtime.observe(ctx, {
      kind: "utterance",
      text: "住所は東京",
      claimKey: { enabled: true, detectContested: true },
      validFrom: new Date("2020-01-01T00:00:00Z"),
      validUntil: new Date("2021-01-01T00:00:00Z"),
    });
    const second = await runtime.observe(ctx, {
      kind: "utterance",
      text: "住所は大阪",
      claimKey: { enabled: true, detectContested: true },
      validFrom: new Date("2022-01-01T00:00:00Z"),
      validUntil: new Date("2023-01-01T00:00:00Z"),
    });
    expect(second.contestedDetection).toEqual([
      expect.objectContaining({ matchCount: 0, result: { kind: "no_conflict" } }),
    ]);
    const secondMemory = await stores.memoryStore.get(ctx, second.memoryIds[0]!);
    expect(secondMemory?.status).toBe("active");
  });

  it("subject_id が違えば矛盾にならない", async () => {
    const llm = sequencedLlm([
      { memories: [{ content: "好きな食べ物はラーメン", provenanceKind: "stated" }] },
      { claims: [{ subject: "user", predicate: "favorite_food" }] },
      { memories: [{ content: "好きな食べ物は寿司", provenanceKind: "stated" }] },
      { claims: [{ subject: "user", predicate: "favorite_food" }] },
    ]);
    const { runtime, stores } = buildRuntime(llm);
    await runtime.observe(ctx, {
      kind: "utterance",
      text: "好きな食べ物はラーメン",
      subjectId: "alice",
      claimKey: { enabled: true, detectContested: true },
    });
    const second = await runtime.observe(ctx, {
      kind: "utterance",
      text: "好きな食べ物は寿司",
      subjectId: "bob",
      claimKey: { enabled: true, detectContested: true },
    });
    expect(second.contestedDetection).toEqual([
      expect.objectContaining({ matchCount: 0, result: { kind: "no_conflict" } }),
    ]);
    void stores;
  });

  it("claim key の subject/predicate が空白だけ（LLM の壊れた出力）だと、無関係な Memory 同士が『空の鍵』で誤って contested にならない", async () => {
    // `deriveClaimKeys` が返す subject/predicate が空白だけ（スキーマの `min(1)` は通るが、`normalizeClaimKeyPart` の trim で空文字列に潰れる）だと、
    // 鍵が取れなかったものとして扱われる。さもないと、内容が無関係な2件が同じ「空の鍵」に潰れて誤って一致する。
    const llm = sequencedLlm([
      { memories: [{ content: "好きな食べ物はラーメン", provenanceKind: "stated" }] },
      { claims: [{ subject: " ", predicate: "  " }] },
      { memories: [{ content: "明日は晴れるらしい", provenanceKind: "stated" }] },
      { claims: [{ subject: "　", predicate: "　" }] }, // 全角スペース——直す前は両方とも
    ]);
    const { runtime, stores } = buildRuntime(llm);
    const first = await runtime.observe(ctx, {
      kind: "utterance",
      text: "好きな食べ物はラーメン",
      claimKey: { enabled: true, detectContested: true },
    });
    const second = await runtime.observe(ctx, {
      kind: "utterance",
      text: "明日は晴れるらしい",
      claimKey: { enabled: true, detectContested: true },
    });
    expect(first.contestedDetection).toEqual([]);
    expect(second.contestedDetection).toEqual([]);
    const firstMemory = await stores.memoryStore.get(ctx, first.memoryIds[0]!);
    const secondMemory = await stores.memoryStore.get(ctx, second.memoryIds[0]!);
    expect(firstMemory?.status).toBe("active");
    expect(secondMemory?.status).toBe("active");
    expect(firstMemory?.claimKey).toBeNull();
    expect(secondMemory?.claimKey).toBeNull();
  });

  it("相手の active が2件以上（3件目以降）のときは markContested を呼ばず、根拠が memory_events に構造として残る", async () => {
    // 1件目・2件目は detectContested を使わずに作る。2件ともペアにならないまま `active` で残り続ける。
    // 3件目で初めて検出を有効にすると、相手の active が2件ある状態に出会う。
    const llm = sequencedLlm([
      { memories: [{ content: "好きな食べ物はラーメン", provenanceKind: "stated" }] },
      { claims: [{ subject: "user", predicate: "favorite_food" }] },
      { memories: [{ content: "好きな食べ物は寿司", provenanceKind: "stated" }] },
      { claims: [{ subject: "user", predicate: "favorite_food" }] },
      { memories: [{ content: "好きな食べ物はカレー", provenanceKind: "stated" }] },
      { claims: [{ subject: "user", predicate: "favorite_food" }] },
    ]);
    const { runtime, stores } = buildRuntime(llm);
    const first = await runtime.observe(ctx, {
      kind: "utterance",
      text: "好きな食べ物はラーメン",
      claimKey: { enabled: true },
    });
    const second = await runtime.observe(ctx, {
      kind: "utterance",
      text: "好きな食べ物は寿司",
      claimKey: { enabled: true },
    });
    expect((await stores.memoryStore.get(ctx, first.memoryIds[0]!))?.status).toBe("active");
    expect((await stores.memoryStore.get(ctx, second.memoryIds[0]!))?.status).toBe("active");

    const third = await runtime.observe(ctx, {
      kind: "utterance",
      text: "好きな食べ物はカレー",
      claimKey: { enabled: true, detectContested: true },
    });
    expect(third.contestedDetection).toHaveLength(1);
    const outcome = third.contestedDetection![0]!;
    expect(outcome.matchCount).toBe(2);
    expect(outcome.result.kind).toBe("unresolved_conflict");
    if (outcome.result.kind !== "unresolved_conflict") throw new Error("unreachable");
    expect([...outcome.result.matchMemoryIds].sort()).toEqual(
      [first.memoryIds[0], second.memoryIds[0]].sort(),
    );

    const thirdMemory = await stores.memoryStore.get(ctx, third.memoryIds[0]!);
    expect(thirdMemory?.status).toBe("active");
    expect(thirdMemory?.contestedWithId ?? null).toBeNull();

    const events = await stores.eventStore.list(ctx, { memoryId: third.memoryIds[0]! });
    const unresolvedEvent = events.find(
      (e) => (e.meta as { reason?: string }).reason === "claim_key_conflict_unresolved",
    );
    expect(unresolvedEvent).toBeDefined();
    const note = JSON.parse((unresolvedEvent!.meta as { note: string }).note) as {
      kind: string;
      matchCount: number;
      matches: { id: string }[];
    };
    expect(note.kind).toBe("claim_key_conflict_unresolved");
    expect(note.matchCount).toBe(2);
    expect(note.matches.map((m) => m.id).sort()).toEqual(
      [first.memoryIds[0], second.memoryIds[0]].sort(),
    );
  });

  it("findActiveByClaimKey を実装しない adapter では、detectContested: true でも例外を投げず静かに何もしない", async () => {
    const llm = sequencedLlm([
      { memories: [{ content: "好きな食べ物はラーメン", provenanceKind: "stated" }] },
      { claims: [{ subject: "user", predicate: "favorite_food" }] },
    ]);
    const { runtime, stores } = buildRuntime(llm);
    // `findActiveByClaimKey` を持たない adapter を模す（インスタンスへ `undefined` を直接代入してプロトタイプの実装を覆う。
    // `delete` はプロトタイプのメソッドには効かない）。
    // @ts-expect-error テスト用に任意メソッドを取り除く。
    stores.memoryStore.findActiveByClaimKey = undefined;
    const result = await runtime.observe(ctx, {
      kind: "utterance",
      text: "好きな食べ物はラーメン",
      claimKey: { enabled: true, detectContested: true },
    });
    expect(result.contestedDetection).toEqual([]);
    const memory = await stores.memoryStore.get(ctx, result.memoryIds[0]!);
    expect(memory?.status).toBe("active");
  });
});

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
import type { FakeMemoryStore } from "./runtime-fakes.js";

/**
 * ADR 0047: `MemoryStore.recordUsage` は `recall_usages.recall_id → recalls(id)` の
 * 外部キー相当を要求するようになった（`FakeMemoryStore` にも適用した）。以前この節の
 * 2つのテストは実体の無い固定文字列 `"recall-1"` を渡していたが、それは「本番経路では
 * 起きえない `recall_usages` 行」を手元でだけ緑にしていた（ADR 0047 の決め手）。
 * `MemoryStore.createRecall`（recall 段6の書き込み口そのもの）で実在の recallId を用意する。
 */
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
// このファイルの歯はリースの境界そのものを検査しない(それは
// outbox-store-conformance.ts の役目)ので、十分に長く固定した値を使う。
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
 * Issue #371: `completeStructured` 呼び出しの**回数**と**順序**を検査したいテスト用の
 * fake。`responses[0]` が1回目の呼び出し（常に `extractCandidates` 由来）、`responses[1]`
 * が2回目（opt-in が有効なら `deriveClaimKeys` 由来）に対応する——`runExtraction` が
 * 常に「抽出 → (opt-inのときだけ)claim key」の順で呼ぶことを前提にした単純化。
 * 設定した回数を超えて呼ばれたら例外を投げる（未設定の応答を勝手に補わない）。
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

  /**
   * ADR 0008 の判定基準を取り込み側に当てる。
   *
   * LLM 呼び出しが失敗して全文フォールバックへ倒れた Memory は、**抽出されたものではない**
   * ——未処理の生テキストである。監査ログがこれを `reason: 'extracted'` として記録すると、
   * 監査ログ自体が事実でないことを主張することになる（「消えたことが見える」ための仕組みが、
   * 「起きなかったことが起きた」と言う）。
   *
   * この歯は、`meta.reason` が抽出の成否を区別し続けることを守る。
   */
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

  /**
   * `meta` は既存の jsonb NOT NULL 列（`memory_events.meta`）へのキー追加のみで、
   * マイグレーションは不要（`packages/postgres/src/schema.ts` 参照）。書き手は
   * `event-store.ts` の `append` と `memory-store.ts` の `updateStatusWithEvent` の2つだけで、
   * どちらも `JSON.stringify(event.meta)` をそのまま書くだけ——キーの集合を検査する
   * トリガー・列 default は無い。
   */
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
 * ⭐ オーナーが名指しで要求した通しの歯（ADR 0072 追記）:
 * provider が `kind` 付きで投げる → `extraction` が飲む → *それでも* `ObserveResult` から
 * `kind` が読める、を1本で通す。
 *
 * ⚠ 偽の `LLMProvider`（`completeStructured` が throw する）を `createRuntime` へ本物の
 * 経路で注入し、`runtime.observe()` を実際に呼ぶ——`ObserveResult` を手で組み立てて
 * `extractionFailure` を入れて assert する「皮で注入するだけの歯」にはしない。
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

    // ADR 0013 の飲み込みが維持されていること: throw せずに resolve する。
    const result = await runtime.observe(ctx, {
      kind: "utterance",
      text: "本物の経路を通す発話",
    });

    expect(result.extraction).toBe("llm_failed_whole_observation");
    expect(result.extractionFailure).toEqual({
      kind: "refusal",
      message: "the model refused to answer",
    });

    // 全文フォールバックの Memory が実際に作られていること（ADR 0013 の安全弁そのもの）。
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

    // 最初の1回の抽出で作られた embed ジョブ(1件)だけが残っているはず。
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
   * Issue #449 / ADR 0305: 3段つながっての歯。
   *
   * 1. `observe({ kind: 'document' })` の `content` に上限は無い（`observation.ts` の
   *    `.min(1)` のみ、`.max()` 無し）。
   * 2. LLM 抽出が失敗すると `fallbackWholeObservationCandidate` が Observation の全文を
   *    そのまま1件の候補にする（`extraction.ts`）。
   * 3. その全文が `processEmbedJob` 経由で `embed(ctx, [memory.content])` へそのまま渡る。
   *
   * **この歯が固定するのは、3段がつながった先で `EmbeddingProvider` の契約
   * （`embedding-provider.ts` の interface doc）どおりに reject する provider を
   * 使ったとき、次の3つがすべて成り立つことである**——
   * (a) Memory.content は全文のまま変わらない（黙って切り詰められない）、
   * (b) embeddingStatus は 'failed' になる、
   * (c) tick はそれを failed として数える（黙って ready にならない）。
   *
   * ⚠ **これは 既定の挙動を1つも変えていない**——`observe`/`extraction`/`processEmbedJob`
   * のどれも本歯のために変更していない。固定しているのは「provider が契約どおりに
   * reject したとき、その先の3段が正しく振る舞うこと」だけである。
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

    // (a) 全文フォールバックの時点で、content は既に全文のまま。
    const beforeTick = await stores.memoryStore.get(ctx, memoryId);
    expect(beforeTick?.content).toBe(hugeContent);

    const tickResult = await runtime.tick(ctx, { kinds: ["embed"], leaseMs: TEST_LEASE_MS });

    // (c) tick は failed として数える。黙って processed 側に入らない。
    expect(tickResult).toEqual({ processed: 0, failed: 1, unsupported: [], leaseConflicts: [] });

    const afterTick = await stores.memoryStore.get(ctx, memoryId);
    // (a) tick の後も content は全文のまま——黙って切り詰められていない。
    expect(afterTick?.content).toBe(hugeContent);
    // (b) embeddingStatus は 'failed'。黙って 'ready' にならない。
    expect(afterTick?.embeddingStatus).toBe("failed");
  });
});

describe("runtime.reembed（ADR 0079: provider が直った後に、索引へ戻す）", () => {
  /**
   * この ADR が塞ごうとしている穴を、端から端まで1本で通す:
   *
   * 1. 埋め込みの provider が落ちている間に `observe()` する
   * 2. `tick()` が失敗し、`embeddingStatus` は `failed`・outbox 行は `failed_at`（終端）
   * 3. **provider が直る**
   * 4. `tick()` をもう一度呼んでも**何も起きない**（`fail` は終端で、`claimBatch` は
   *    `failed_at IS NULL` を要求する。ADR 0032）——ここが穴だった
   * 5. `reembed()` を呼ぶ ⟹ 次の `tick()` で `ready` になり、ベクトルが入る
   *
   * ⚠ **段4を落とすと、この歯は「そもそも直っていた」を検査したことになる。**
   * 段4があることで初めて「`reembed` が効いた」と言える。
   */
  it("provider が落ちている間に入った Memory は、tick を繰り返しても索引へ戻らない。reembed してから tick すると ready になる", async () => {
    const { runtime, stores } = buildRuntime(
      llmReturning([{ content: "本文", digest: "要旨", provenanceKind: "stated" }]),
    );
    stores.embeddingProvider.shouldFail = true;
    const observeResult = await runtime.observe(ctx, { kind: "utterance", text: "本文" });
    const memoryId = observeResult.memoryIds[0]!;

    const failedTick = await runtime.tick(ctx, { kinds: ["embed"], leaseMs: TEST_LEASE_MS });
    // ⚠ 状態はその場で**文字列として**取り出す。`FakeMemoryStore.get` は可変な Memory
    // オブジェクトへの参照をそのまま返すので、オブジェクトのまま持ち回ると後続の
    // `tick` の書き込みで「過去の観測」まで書き換わる（実際にそれで一度赤くなった）。
    const afterFailure = (await stores.memoryStore.get(ctx, memoryId))?.embeddingStatus;

    // provider が直る。
    stores.embeddingProvider.shouldFail = false;

    // ⚠ ここが穴だった: 直った後に tick を呼んでも、失敗した行は二度と claim されない。
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
 * Issue #753（#449 の残り、ADR 0305 決定4の歯の続き）: 上限超過で `failed` になった
 * Memory には、ADR 0079 の `reembed()` だけでは回復手段が無かった——`requeueEmbedJobs`
 * は failed を pending に戻して embed ジョブを積み直すだけで、次の `processEmbedJob` は
 * 同じ `memory.content`（全文のまま）を再び `embed()` へ送るため、また同じ理由で
 * `failed` に戻る。
 *
 * `RuntimeDeps.embeddingInput`（任意の opt-in フック）は、`processEmbedJob` が
 * `embed()` へ送る文字列を差し替えられるようにする——`Memory.content` 自体は変えない。
 *
 * この節の2本は対になっている:
 * - 1本目: フックを注入した runtime で `reembed()` → `tick()` すると `ready` になる
 *   （フックが無いと直せない、を実際に直せることの陽性対照）。
 * - 2本目: フックを渡さない今までどおりの runtime では、`reembed()` → `tick()` を
 *   繰り返しても `failed` のまま（既定の挙動は1ビットも変わっていないことの固定）。
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
    // ⚠ `FakeMemoryStore.get` は可変な Memory オブジェクトへの参照をそのまま返す
    // （上の「runtime.reembed」describe の注意と同じ footgun）。ここで文字列として
    // 値を取り出しておかないと、後続の `healingTick` の書き込みで「過去の観測」の
    // つもりだった `afterFailure` まで "ready" に書き換わる。
    const afterFailureStatus = (await stores.memoryStore.get(ctx, memoryId))?.embeddingStatus;

    // 運用側が opt-in フックを足した runtime を、同じ store（同じ永続状態）に対して
    // 新たに立てる——runtime 自身は状態を持たない関数の集合であり、状態は deps 側の
    // store が持つ。既存の failed 行に対して「後からフックを足した runtime で reembed
    // する」という、実際の復旧オペレーションをそのまま模している。
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
 * Issue #312 / [ADR 0161](../../../docs/decisions/0161-runtime-get-recall.md):
 * `Runtime.getRecall` は `MemoryStore.getRecall` への**素通し**である
 * （`reembed` と同じ形——`runtime.ts` の doc コメント参照）。ここで検査するのは
 * 「素通しであること」そのもの——`viaRuntime` と `stores.memoryStore.getRecall` を
 * 直接呼んだ結果が一致することを見る。値の中身（score/retrievedVia の形）の検査は
 * `recall-runtime.ts` の歯の役目であり、ここでは行わない。
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
 * ADR 0114: `docs/memory-model.md` §11 行8「`decay_floor_at < now()` を検出する
 * 低頻度の掃引…→ `status='archived'` + `archived` イベント」を実行する
 * `Runtime.sweepArchive` の検査。
 *
 * `MemoryStore.archiveDecayed` は任意メソッドである——`FakeMemoryStore` は
 * `InMemoryMemoryStore`（`@mnemora/testkit`）と同じく実装しているので、既定では
 * 「口が在る」側（`supported: true`）の経路を通る。「口が無い」側
 * （`supported: false`）は `supersedeWithNewMemories` の歯（ADR 0100）と同じ作法——
 * `undefined` を代入して prototype を隠す——で個別に検査する。
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

    // 口を持たない adapter を模す（`supersedeWithNewMemories` の歯と同じ作法。
    // `delete` では消えない——クラスのメソッドは prototype に在る）。
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
 * Issue #364 / [ADR 0186](../../../docs/decisions/0186-sweep-archive-follows-decay-clock.md):
 * `sweepArchive` は `opts.clock` を省略されたとき `tenant_settings.decay_clock` へ従う。
 *
 * ここで検査しているのは「`Runtime.sweepArchive` が `MemoryStore.archiveDecayed` へ
 * どんな `opts` を渡すか」であって、`FakeMemoryStore.archiveDecayed` 自身が `clock`/
 * `nowSeq` に応じて対象を絞り込むかどうかではない（`FakeMemoryStore` は壁時計の
 * `decayFloorAt` だけで絞る素朴な実装であり、本 Issue の対象外——ADR 0186 決めたことは
 * 「どの引数を渡すか」であり、store 側の絞り込みは ADR 0165 が別途固定している）。
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
});

/**
 * ADR 0082 / issue #105（外部の採用検討者からの報告）。
 *
 * 報告の芯は2つあった。
 * 1. `OutboxJobKind` に `"consolidate"` が**名指しで**在るので、呼び出し側は
 *    「積めば `tick` が処理してくれる」と読む（実際に読み違えた利用者が居る）。
 * 2. 推測として:「`kinds: ['consolidate']` を渡すと claim はできてしまうが処理する分岐が
 *    無いので、何も起こらないまま lease が切れて、claim され続けるのに進まないのでは」。
 *
 * **2 は現物では起きていなかった**（PR 本文の実測を参照）。この節の歯は、
 * **起きていないことが、これからも起き続けない**ように固定するために置いてある。
 *
 * ⚠ **この節の歯が守っているのは「`failed` という1つの数では足りない」ことである。**
 * 「embed の provider が落ちて失敗した」と「`tick` がその kind を処理できない」は、
 * どちらも終端の失敗だが**呼び出し側が次に取る手が違う**（前者は provider を直して
 * `reembed`、後者はそもそも `tick` に頼む相手が違う）。`failed: 1` だけを返すと
 * この2つが同じ顔になる——ADR 0029 が `ReextractResult.skipped` で塞いだのと同じ族。
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
    // 同じ1回の tick で2件を拾わせる:
    //   - embed ジョブ 1件（provider が落ちていて失敗する ＝ 試して失敗した）
    //   - 対応していない kind 1件（試すまでもなく処理できない）
    // `failed: 2` は両者を足した数であり、**どちらがどちらか言わない**。
    // `unsupported` だけが後者を名指しする。これが無いと呼び出し側は区別できない。
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
    // 報告者が推測した「claim され続けるがいつまでも進まない」が起きないことを測る歯。
    const { runtime, stores } = buildRuntime(llmReturning([]));
    const jobId = await enqueueJobOfKind(stores, CUSTOM_KIND);

    const first = await runtime.tick(ctx, { kinds: [CUSTOM_KIND], leaseMs: TEST_LEASE_MS });
    expect(first.unsupported).toEqual([{ jobId, kind: CUSTOM_KIND }]);

    // outbox 行は終端（failedAt が付く）。`last_error` にも kind が名指しで残る——
    // `TickResult` を捨ててしまった後から DB だけを見た人にも同じ結論が届くように。
    const rowAfterFirst = stores.outboxStore.listJobs(ctx).find((job) => job.id === jobId)!;
    expect(rowAfterFirst.failedAt).not.toBeNull();
    expect(rowAfterFirst.lastError).toBe(`${UNSUPPORTED_KIND_ERROR_PREFIX}${CUSTOM_KIND}`);

    // 2回目は claim されない（`fail` は終端。ADR 0032）。lease が切れて再び拾われる形ではない。
    const second = await runtime.tick(ctx, { kinds: [CUSTOM_KIND], leaseMs: TEST_LEASE_MS });
    expect(second).toEqual({ processed: 0, failed: 0, unsupported: [], leaseConflicts: [] });
    expect(stores.outboxStore.listJobs(ctx).find((job) => job.id === jobId)!.attempts).toBe(1);
  });

  /**
   * 🔴 **報告に無い穴。実装を書いた後に自分で読み返して見つけたので、歯にした。**
   *
   * `kind` は DB の `text` 列から来る**任意の文字列**であり、`OutboxJobKind` は開いた
   * ユニオンなので型でも止まらない。ハンドラの索引にプレーンなオブジェクトを使うと、
   * `kind` が `"constructor"` / `"toString"` のときに `Object.prototype` 側の関数が
   * 返ってしまい、**「対応している」と誤判定して呼ぶ**。そうなると、この節が守っている
   * 「対応していない kind は unsupported に出る」が**この2語に対してだけ黙って破れる**。
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

  /**
   * 🔴 **この歯は時限式だった。ここで役目を終えた（Issue #204 / ADR 0157）。**
   *
   * 元の歯は「`consolidate` / `reflect` はいまは `tick` に分岐が無く `unsupported` に出る」を
   * `it.each(["consolidate", "reflect"])` で測っていた。ADR 0082 決定5 が予告していた
   * とおり——「本体が入ったら赤くなる。それが正しい。**本体を足す側がこの歯を
   * 書き換えるところまでがその作業**である」——`TICK_SUPPORTED_JOB_KINDS` に
   * `"consolidate"`/`"reflect"` を足した今、元のアサーション
   * （`expect(TICK_SUPPORTED_JOB_KINDS).not.toContain(kind)` と
   * `unsupported: [{ jobId, kind }]`）はどちらも成り立たなくなった。
   *
   * **単に削除しない**（ADR 0157 決定3）——代わりに、下の2本を「いまは tick が処理する」
   * ことを測る歯として書き換えた:
   *
   * 1. `TICK_SUPPORTED_JOB_KINDS` が実際に両方を含むこと（元の歯の否定）。
   * 2. payload が壊れている（`memoryId` が無い）ジョブは、**`unsupported` にではなく
   *    `failed` の側**（対応している kind として扱われたが、処理を試みて失敗した）に
   *    出ること——`processConsolidateJob`/`processReflectJob` が
   *    `readSeedMemoryIdFromPayload` で投げ、`tick()` がそれを `fail()` に落とす経路
   *    （ADR 0082 の「無いの分類」を保ったまま、`unsupported` の意味を壊さない）。
   *
   * ⚠ 「well-formed な payload を tick が実際に処理する」歯は、この describe の外
   * （`runtime.tick — consolidate/reflect ジョブを処理する`）に置いた——対象の Memory を
   * 用意する必要があり、この describe の他の歯（未対応 kind・壊れた payload）とは
   * セットアップの形が異なるため。
   *
   * ⚠ この節の他の4つの歯（`CUSTOM_KIND` / prototype 名を使うもの）は時限式では**ない**
   * ——`CUSTOM_KIND` は利用者が足した kind であり、`TICK_SUPPORTED_JOB_KINDS` に入ることは
   * 無い。kind がいくつ増えても、それらは効き続ける（下の歯が実際にそれを壊していないことを
   * 確認済み——この編集は上のブロックだけを書き換えている）。
   */
  it("⭐ `TICK_SUPPORTED_JOB_KINDS` は 'consolidate'/'reflect' を含む（時限式の歯が役目を終えた証跡）", () => {
    expect(TICK_SUPPORTED_JOB_KINDS).toContain("consolidate");
    expect(TICK_SUPPORTED_JOB_KINDS).toContain("reflect");
  });

  it.each(["consolidate", "reflect"])(
    "⭐ '%s' ジョブの payload が壊れている（memoryId が無い）と、unsupported ではなく failed で終端に落ちる",
    async (kind) => {
      const { runtime, stores } = buildRuntime(llmReturning([]));
      // `enqueueJobOfKind` は observation 用の outbox 経路を借りて payload を
      // `{ observationId }` にする——`consolidate`/`reflect` が読む `memoryId` を持たない、
      // 「payload が壊れている」ケースの具体例（ADR 0157 決定「payload が壊れていたときの
      // 倒れ方を決める」）。
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

/**
 * Issue #204 / ADR 0157: `tick()` が `consolidate`/`reflect` の outbox ジョブを実際に処理する
 * ことを、正常系（payload が正しい）で測る。上の describe（対応していない kind の節）は
 * 「壊れた payload」の倒れ方を測っており、ここは「対応している」ことそのものを測る。
 */
describe("runtime.tick — consolidate/reflect ジョブを処理する（Issue #204 / ADR 0157）", () => {
  it.each(["consolidate", "reflect"] as const)(
    "⭐ payload `{ memoryId }` が正しければ、'%s' ジョブは unsupported にも failed にもならず処理される",
    async (kind) => {
      const { runtime, stores } = buildRuntime(llmReturning([]));
      const { jobs } = await stores.memoryStore.createMemoryWithOutbox(
        ctx,
        {
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
        },
        [kind],
      );
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.payload).toEqual({ memoryId: jobs[0]!.payload.memoryId });

      const tickResult = await runtime.tick(ctx, { kinds: [kind], leaseMs: TEST_LEASE_MS });

      // `seedMemoryId` の近傍が無い（テナントにこの1件しかない）ため、`consolidate()`/
      // `reflect()` は内部的には `nothing_to_consolidate`/`no_eligible_basis` 等で終わるが、
      // **`tick()` の視点では「処理を試みて成功した」**——ジョブは完了として扱われる。
      expect(tickResult).toEqual({
        processed: 1,
        failed: 0,
        unsupported: [],
        leaseConflicts: [],
      });
    },
  );
});

/**
 * Issue #204 / ADR 0157 決定4: 🔴 自動駆動は**既定で有効にならない**（北極星の問い2 /
 * docs/roadmap.md §1.1）。この describe は両方向を測る——
 * 「既定では1件も積まれない」と「opt-in すると積まれ、tick が処理する」。
 */
describe("runtime.observe(extract) が consolidate/reflect の種を積むのは opt-in のときだけ（Issue #204 / ADR 0157）", () => {
  it("🔴 既定（config を渡さない）では、extract は embed 以外のジョブを1件も積まない", async () => {
    const { runtime, stores } = buildRuntime(
      llmReturning([{ content: "本文", digest: "要旨", provenanceKind: "stated" }]),
    );

    await runtime.observe(ctx, { kind: "utterance", text: "本文" });

    // `extract: 'sync'`（既定）は監査/冪等性のための `extract` ジョブを常に積み、
    // 同じ呼び出しの中で `complete()` する（`handleExtractableObservation` 参照。
    // ADR 0157 の対象ではない、既存の挙動）——ここで測りたいのは
    // `consolidate`/`reflect` が積まれないことだけなので、それ以外の kind は無視する。
    const kinds = stores.outboxStore
      .listJobs(ctx)
      .map((job) => job.kind)
      .filter((kind) => kind === "consolidate" || kind === "reflect");
    expect(kinds).toEqual([]);
  });

  it("⭐ `autoQueueConsolidateReflectOnExtract: true` にすると、同じ memoryId を種にした consolidate/reflect のジョブも積まれ、tick が処理する", async () => {
    const { runtime, stores } = buildRuntime(
      llmReturning([{ content: "本文", digest: "要旨", provenanceKind: "stated" }]),
      { config: { autoQueueConsolidateReflectOnExtract: true } },
    );

    const observeResult = await runtime.observe(ctx, { kind: "utterance", text: "本文" });
    const memoryId = observeResult.memoryIds[0]!;

    // `extract` ジョブも積まれるが（既存の挙動、上のテストのコメント参照）、sync 抽出の
    // 中で既に `complete()` されているので、ここでは `consolidate`/`embed`/`reflect` の
    // 3つだけを見る（ADR 0157 の対象）。
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

    // 積まれるだけでなく、tick() が実際に処理する（unsupported にならない）ところまで測る
    // ——「積む」と「処理できる」を別の歯で確かめないと、payload の形が食い違っていても
    // 「積んだこと」だけで緑になってしまう。既に complete 済みの `extract` ジョブは
    // `claimBatch` の対象外なので `processed` には含まれない。
    const tickResult = await runtime.tick(ctx, { leaseMs: TEST_LEASE_MS });
    expect(tickResult).toEqual({ processed: 3, failed: 0, unsupported: [], leaseConflicts: [] });
  });
});

/**
 * ADR 0142 / Issue #233: `OutboxStore.complete`/`fail` を CAS にする。
 *
 * `packages/testkit` の `outbox-store-conformance.ts` が `InMemoryOutboxStore`/
 * `PostgresOutboxStore` の両方に対して同じ契約を検査しているが、`FakeOutboxStore`
 * （このファイルが使う `packages/core` 自身の私的なテストダブル）はその適合スイートの
 * 対象外である（`core` は `testkit` に依存しない、docs/architecture.md §4）。
 * ⚠ **この節が無いと、`FakeOutboxStore` の CAS 判定は「実装されているが、どの歯からも
 * 呼ばれない」まま残る**——ADR 0053 が「Mu5a 変異が生存」として残した穴と同じ形
 * （実装だけあって、それを壊す変異を検出する歯が無い）を、ここで自分から開けないための節。
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

    // ワーカーA が claim する。
    const claimA = await stores.outboxStore.claimBatch(ctx, {
      limit: 10,
      now: base,
      claimedBy: "worker-A",
      leaseMs,
    });
    const jobAsClaimedByA = claimA.find((j) => j.id === jobId)!;

    // リースが切れる。
    const afterExpiry = new Date(base.getTime() + leaseMs);

    // ワーカーB が再 claim して complete する。
    const claimB = await stores.outboxStore.claimBatch(ctx, {
      limit: 10,
      now: afterExpiry,
      claimedBy: "worker-B",
      leaseMs,
    });
    const jobAsClaimedByB = claimB.find((j) => j.id === jobId)!;
    expect(jobAsClaimedByB.attempts).toBeGreaterThan(jobAsClaimedByA.attempts);
    await stores.outboxStore.complete(ctx, jobId, jobAsClaimedByB.attempts);

    // ワーカーA が遅れて、自分が claim した時点の(もう古い) attempts で fail を呼ぶ。
    await expect(
      stores.outboxStore.fail(ctx, jobId, "worker-A: stale failure", jobAsClaimedByA.attempts),
    ).rejects.toBeInstanceOf(OutboxLeaseConflictError);

    // Bの complete の結果が、Aの遅れた呼び出しによって上書きされていない
    // ——本 Issue が指摘したバグの直接の否定。
    const finalJob = stores.outboxStore.listJobs(ctx).find((j) => j.id === jobId)!;
    expect(finalJob.completedAt).not.toBeNull();
    expect(finalJob.failedAt).toBeNull();
  });

  // Issue #826: complete/fail は互いに排他。先に付いた終端が勝ち、後から来た呼び出しは
  // 行を変えず、例外も投げない（`packages/testkit` の `InMemoryOutboxStore`・
  // `PostgresOutboxStore` と同じ意味論。`FakeOutboxStore` はどちらの適合スイートの
  // 対象でもないため、ここで別に検査する）。
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
 * ADR 0142 決定3: `tick()` は `OutboxLeaseConflictError` を検知しても、その1件を
 * 飛ばして残りのジョブの処理を続ける（伝播させて `tick()` 全体を止めない）。
 *
 * **リース競合は異常ではなく、正常な並行の結果である**——別のワーカーが既にその
 * ジョブを終わらせたということであり、システムから見ればそのジョブは済んでいる。
 * 1件の良性の競合で、同じ `tick` 呼び出し内の無関係な他のジョブまで処理が止まるのは、
 * 狭い事象を広い停止に変換する形であり、避ける。
 *
 * **決定的な差し込み**（`FakeMemoryStore.beforeUpdateStatus`、ADR 0030 と同じ形）で
 * 再現する: `FakeEmbeddingProvider.beforeEmbedReturn` フックから、処理中のジョブ自身を
 * （テストコードが）直接 `claimBatch` で再 claim することで、「処理には成功したが
 * complete しようとした時点でリースを失っていた」を確率的な並行に頼らず毎回同じ形で
 * 起こす。
 */
describe("runtime.tick — リース競合は他のジョブの処理を止めない（ADR 0142 決定3）", () => {
  it("⭐ 1件が complete 時にリース競合しても、同じ tick 内の他のジョブは処理される", async () => {
    // fakeNow は実時刻より確実に先の、この describe 内で完全に制御する時刻。
    // ジョブの availableAt は FakeBackingStore.enqueueJob が実時刻 `new Date()` で
    // 打つため、fakeNow を実時刻より先に置くことで available_at <= now が
    // 常に成立するようにする(実時刻とfakeNowの同期を取る必要を無くす)。
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
      // fakeNow をリース失効後まで進めてから、job A だけを別ワーカーとして
      // 横取りする(limit:1・available_at 昇順なので A が選ばれる)。
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

    // A は「complete しようとした時点でリースを失っていた」——processed/failed の
    // どちらにも数えず、leaseConflicts に名指しで出る。B は無関係に正常処理される。
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
    // Bは競合と無関係に、いつもどおり処理される。
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
    // ここでは observe() 自体が最初から成功する（フォールバックを経由しない）。
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

    // 同じ候補で reextract を2回走らせる——LLM は毎回同じ内容を返す（決定的）。
    await runtime.reextract(ctx, observeResult.observationId);
    const result = await runtime.reextract(ctx, observeResult.observationId);

    expect(result.supersededMemoryIds).toEqual([]);
    const original = await stores.memoryStore.get(ctx, originalId);
    expect(original?.status).toBe("active");
    expect(original?.supersededById ?? null).toBeNull();
  });

  // ADR 0029: ADR 0028 が「引き受ける負債」に記録した欠落を埋める歯。
  // `ReextractResult.skipped` が「見ていない」「見たが対象外」「見て変わっていなかった」を
  // 別の顔で出すことを確かめる。
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

      // 別内容を返す LLM で reextract する——3件とも今回の content_hash 集合に含まれない。
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

      // 非対称であることそのものを assert する——同数だと入れ替え変異が生き残る。
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

      // 同じ内容を返す LLM で reextract する——content_hash が一致し続ける。
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

      // reextract でも同じく LLM が失敗し続ける。
      const runtime2 = runtimeWithLlm(stores, throwingLlm());
      const result = await runtime2.reextract(ctx, observeResult.observationId);

      expect(result.extraction).toBe("llm_failed_whole_observation");
      expect(result.skipped).toEqual([
        { kind: "not_examined", reason: "llm_failed_whole_observation" },
      ]);
      // ADR 0072 追記: `reextract` の `extractionFailure` も `observe()` と対称に運ばれる
      // ——片方だけ種類が分かる非対称を作らない。
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
      // 候補0件の LLM で observe() する——Memory は1件も作られない。
      const zeroLlm = llmReturning([]);
      const zeroRuntime = runtimeWithLlm(stores, zeroLlm);

      // 顔1: 「飛ばすものが無かった」——既存 Memory が無い Observation に、候補が有る LLM で
      // reextract する。本経路（`classifyReextractTargets`）を通るが、existingBefore が
      // 空なので skipped も空になる。
      const observeResult1 = await zeroRuntime.observe(ctx, { kind: "utterance", text: "発話1" });
      expect(observeResult1.memoryIds).toEqual([]);
      const succeedingRuntime = runtimeWithLlm(
        stores,
        llmReturning([{ content: "新規", digest: "要旨", provenanceKind: "stated" }]),
      );
      const nothingToSkip = await succeedingRuntime.reextract(ctx, observeResult1.observationId);
      expect(nothingToSkip.skipped).toEqual([]);

      // 顔2: 「候補0件」——別の Observation に対し、候補0件の LLM のまま reextract する。
      // listBySourceObservation を呼ぶ前の早期 return。
      const observeResult2 = await zeroRuntime.observe(ctx, { kind: "utterance", text: "発話2" });
      const noCandidates = await zeroRuntime.reextract(ctx, observeResult2.observationId);
      expect(noCandidates.skipped).toEqual([{ kind: "not_examined", reason: "no_candidates" }]);

      // 顔3: 「LLM失敗」——さらに別の Observation に対し、LLM 自体が例外を投げる。
      // これも listBySourceObservation を呼ぶ前の早期 return。
      const observeResult3 = await zeroRuntime.observe(ctx, { kind: "utterance", text: "発話3" });
      const throwingRuntime = runtimeWithLlm(stores, throwingLlm());
      const llmFailed = await throwingRuntime.reextract(ctx, observeResult3.observationId);
      expect(llmFailed.skipped).toEqual([
        { kind: "not_examined", reason: "llm_failed_whole_observation" },
      ]);

      // 3つの顔がそれぞれ違うことを並べて確認する——顔1だけが空配列（見たうえで、飛ばす
      // ものが無かった）で、顔2・顔3は同じ「見ていない」でも reason が違う。
      expect(nothingToSkip.skipped).not.toEqual(noCandidates.skipped);
      expect(noCandidates.skipped).not.toEqual(llmFailed.skipped);
      expect(nothingToSkip.skipped).not.toEqual(llmFailed.skipped);
    });
  });

  // ADR 0030（安全弁3）: 読み（listBySourceObservation）と書き（updateStatus）の間に
  // 割り込む書き込みで安全弁が破れる TOCTOU を、compare-and-swap で塞いだことを検査する。
  describe("compare-and-swap（ADR 0030: 読んでから書くまでの間の TOCTOU を検知する）", () => {
    it("⭐ 対象 M の1件目を書きに来た瞬間に M を forgotten へ変えても、M は forgotten のまま・supersede されず・イベントも積まれない（別の対象 N は普通に supersede される）", async () => {
      const stores = createFakeRuntimeStores();
      // 既存 Memory を2件作る（非対称: M は割り込みで forgotten に変わる、N は変わらない）。
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

      // reextract 用の runtime（別内容を返す LLM——M・N とも今回の content_hash 集合に無い）。
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

      // 決定的な差し込み: toSupersede は existingBefore の順（M, N）でループされる
      // （FakeBackingStore.memories は Map で挿入順を保つ）。M への1件目の書き込みが
      // 来た「まさにその瞬間」に、別の誰か（利用者による forget 相当）が M を
      // forgotten に変えたことにする。N には介入しない——フィクスチャを非対称にする
      // ことで「件数は合っているが対応が崩れている」変異も捕まえられるようにする。
      //
      // `FakeMemoryStore.get` は backing.memories に入っている Memory オブジェクトへの
      // 参照をそのまま返す実装（コピーを作らない）なので、事前に取得した参照の
      // `status` を書き換えるだけで「割り込み」を再現できる。
      const mBeforeIntervention = await stores.memoryStore.get(ctx, mId);
      let intervened = false;
      stores.memoryStore.beforeUpdateStatus = (id) => {
        if (!intervened && id === mId) {
          intervened = true;
          mBeforeIntervention!.status = "forgotten";
        }
      };

      const result = await reextractRuntime.reextract(ctx, observeResult.observationId);

      // M: forgotten のまま・supersede されていない・skipped に status_changed_concurrently。
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

      // N: 同じ呼び出しの中で、普通に supersede されている（非対称であることの確認）。
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
      //
      // ⚠ **この歯が差し替える先は、`reextract` が実際に呼ぶ口でなければならない。**
      // ADR 0031 のときは `updateStatus` → `updateStatusWithEvent` へ向け直した。
      // ADR 0100 で `FakeMemoryStore` が `supersedeWithNewMemories` を実装したため、
      // `reextract` はそちらを呼ぶ——⟹ **差し替える先もそちらへ向け直す。**
      // さもないと「差し替えた口が呼ばれず、例外が飛ばないので歯が落ちる」（今回は赤く
      // なって気付けたが、条件がずれれば**緑のまま何も検査しなくなる**——ADR 0031 決定8 が
      // 名指しした一番危険な壊れ方である）。
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

      // 🔴 ADR 0100 の禁止1: 口が在って**投げた**ときに今日の経路で撃ち直さない。
      // 撃ち直すと「トランザクションを張れなかった」と「張ったが失敗した」が呼び手から
      // 区別できなくなる（Issue #134 が潰すなと明示した破れ）。
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
      // フォールバックしていない＝今日の経路（updateStatusWithEvent）は呼ばれていない。
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

      // 口を持たない adapter を模す——第三者の既存 adapter がこの形である。
      // ⚠ `delete` では消えない（クラスのメソッドは prototype に在り、インスタンスの
      // own property ではない）——`undefined` を代入して prototype を隠す。
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
      // 口が無くても supersede そのものは今日どおり行われる。
      expect(unsupported.supersededMemoryIds).toHaveLength(1);
    });
  });
});

describe("observe の冪等な再送は、同時に別の観測が入っても抽出をやり直さない（ADR 0054）", () => {
  /**
   * `handleExtractableObservation` は `createObservationWithOutbox` の `created` だけを見て
   * 「抽出をやり直すか」を決める。擬似実装が `created` を大域の件数差から導いていると、
   * **同時に別の観測が作られただけで再送が「新規」に化け**、同じ observation に対して
   * 抽出がもう一度走る——LLM がもう一度叩かれ、`extraction` が `"skipped"` ではなく
   * 抽出結果になり、`memoryIds` が空でなくなる。ここで測っているのはその**値**である。
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
      // fresh のぶんの1回だけ。再送は抽出を走らせない。
      llmCallsAddedByResendAndFresh: 1,
    });
  });
});

/**
 * Issue #608 項目①（核心）: `buildNewMemoriesForCandidates`（runtime.ts）は同じ observation を
 * 全候補へ渡す。候補ごとに違う `subjectId` を持てるようになったことで、**1回の observe() から
 * 複数の Memory が出て、それぞれ違う主題を持てる**ことを、runtime 経由（observe()）で縛る。
 * `extraction.test.ts` の `buildNewMemoryFromCandidate` 単体の歯とは別に、
 * `runtime.observe` → `buildNewMemoriesForCandidates` の配線そのものが崩れていないことを見る。
 */
describe("observe: 抽出候補ごとに subjectId を持てる（Issue #608 項目①）", () => {
  it("同じ observation から出た複数候補が、候補ごとに違う subjectId を持つ", async () => {
    const { runtime, stores } = buildRuntime(
      llmReturning([
        { content: "Aさんは面白いと思った", provenanceKind: "stated", subjectId: "user:a" },
        { content: "Bさんは面白いとは思わなかった", provenanceKind: "stated", subjectId: "user:b" },
        // 明示的な null ＝ 主題なし（observation の subjectId があっても上書きする）。
        { content: "映画をやっている", provenanceKind: "stated", subjectId: null },
        // subjectId 省略 ＝ 未指定。従来どおり observation の値へ落ちる。
        { content: "念のための第4の候補", provenanceKind: "stated" },
      ]),
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

/**
 * Issue #608 項目②(b): 呼び出し側が subject の候補一覧を渡し、抽出器に選ばせる口。
 * `buildExtractionPrompt` の文面自体（候補一覧・null の指示が載るか）は
 * `extraction.test.ts` が縛る——ここでは `runtime.observe` を通した配線
 * （ObserveXxxInput.subjectCandidates → Memory.subjectId、一覧外の値の runtime 検証、
 * deferred との組み合わせの検証エラー、reextract がこの欄を使わないこと）を縛る。
 */
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
    // 何も弾かれていないので、rejectedSubjectIds は空配列で「渡した・0件弾いた」を示す。
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
    // ①の「省略」経路と同じ着地点——observation の subjectId へフォールバックする。
    expect(memory?.subjectId).toBe("user:conversation-default");
    // 黙って戻さない: 弾いた値が ObserveResult に残る。
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

  it("空配列（[]）を渡した場合も『渡していない』と同じ——検証されず、rejectedSubjectIds も無い", async () => {
    const { runtime, stores } = buildRuntime(
      llmReturning([{ content: "任意の主題", provenanceKind: "stated", subjectId: "anything" }]),
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
    // deferred なので observation は作られるが、抽出はまだ実行されない。
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

    // reextract 用に、別の LLM 応答（一覧外だったはずの値）を返す runtime を同じ stores で作る。
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
    // `ReextractResult` に `rejectedSubjectIds` は無い（候補一覧を扱わないため、
    // そもそも運ぶものが無い）。
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
    // 「渡していない」ので rejectedSubjectIds と同じ規約でキー自体が無い。
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
    // opt-in を使ったので claimKeyFailure キーは常に有る（成功時は null）。
    expect(result.claimKeyFailure).toBeNull();
  });

  it("既定の抽出プロンプトは opt-in の有無で変わらない——2回目の呼び出しだけが増える", async () => {
    // 1回目（抽出）の req.prompt を捕まえ、opt-in の有無で完全に同一であることを確認する。
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
    // 候補0件なので claim key の呼び出しにも到達しない——どちらも呼び出しは1回だけ。
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
    // 2回目（claim key）の応答を設定しない ⟹ sequencedLlm が例外を投げる。
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
    // reextract は claim key opt-in を渡す口を持たない ⟹ 呼び出しは抽出の1回だけ。
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
    // `listActiveClaimPredicates` を持たない adapter を模す（既存の
    // 「findActiveByClaimKey を実装しない adapter」の歯と同じ手法）。
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
        // 利用者が明示的に選んだ語彙——store 側にも同じ値 "favorite_food" が在るが、
        // 重複せず1回だけ、かつ利用者の指定順が先頭に来ることを見る。
        knownPredicates: ["user_chosen_hint", "favorite_food"],
        knownPredicatesFromStore: true,
      },
    });
    const claimKeyCall = followUpLlm.calls[1]!;
    const system = claimKeyCall.prompt.system as string;
    // 利用者指定分（"user_chosen_hint", "favorite_food"）の後ろに、store 分から
    // 重複を除いた "favorite_color" だけが連結されている——"favorite_food" が
    // 重複して並んでいれば、この厳密な部分文字列は一致しない。
    expect(system).toContain(
      "既知の predicate 候補一覧: user_chosen_hint, favorite_food, favorite_color。",
    );
  });
});

describe("observe: claimKey knownSubjects は subjectCandidates へ暗黙に転用しない（Issue #372負債6、ADR 0334）", () => {
  /**
   * ⚠ ADR 0334「採らなかった案」: `knownPredicatesFromStore` と対になる
   * `knownSubjectsFromStore`（store が自己蓄積した claim key subject を語彙ヒントに
   * 動的に足す版）は実装していない——store 分は LLM が自由記述で作った曖昧な値
   * （例: `'sibling'`）になりがちで、それを汎用語彙として横流しすると無関係な話題の
   * 主張にまで誤って使い回される汚染を実測で確認したため（`claim-key.ts` の
   * `ClaimKeyOptions.knownSubjects` doc コメント、ADR 0334 決定3参照）。
   *
   * ⚠ **当初案は `knownSubjects` 省略時に `subjectCandidates`（Issue #608 項目②(b)）を
   * 既定値として転用していたが、取り下げた**（ADR 0334 追記〔2026-09-26〕）——
   * `claimKey.enabled: true` と `subjectCandidates` を既に併用している呼び出し側が、
   * `knownSubjects` という新しい opt-in を一切選んでいないのに claim key プロンプト・
   * カセット鍵が動いてしまい、「off のときのプロンプトは1バイトも変えない」に反する
   * ため。この describe が検査するのは、`knownSubjects` を明示しない限り
   * `subjectCandidates` の有無・中身がプロンプトに一切影響しないことである。
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

  it("regression: enabled: true + subjectCandidates あり + knownSubjects 省略のとき、claim key プロンプトは subjectCandidates を渡さない場合（＝main の既存挙動）と完全に同一——暗黙の転用が復活していないことを固定する", async () => {
    const withCandidatesLlm = sequencedLlm([
      { memories: [{ content: "姉は福岡で働いています。", provenanceKind: "stated" }] },
      { claims: [{ subject: "姉", predicate: "sibling_residence" }] },
    ]);
    const { runtime: withCandidatesRuntime } = buildRuntime(withCandidatesLlm);
    await withCandidatesRuntime.observe(ctx, {
      kind: "utterance",
      text: "姉は福岡で働いています。",
      // 既存で claimKey.enabled と subjectCandidates を併用している呼び出し側を模す
      // ——knownSubjects は一切渡していない（この opt-in を選んでいない）。
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
    // 1件目の時点では相手がいない ⟹ no_conflict。
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
    // ⛔ superseded へは一切進めない。
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
    // `deriveClaimKeys` が返す subject/predicate が空白だけ（スキーマの `min(1)` は
    // 通るが、`normalizeClaimKeyPart` の trim で空文字列に潰れる）だと、鍵が
    // 取れなかったものとして扱われる（`claim-key.ts` の `deriveClaimKeys` 参照）。
    // 内容がまったく無関係な2件のどちらも壊れた鍵を返した場合、直す前は両方が
    // `{ subject: "", predicate: "" }` という同じ「空の鍵」に潰れて誤って
    // 一致してしまっていた。
    const llm = sequencedLlm([
      { memories: [{ content: "好きな食べ物はラーメン", provenanceKind: "stated" }] },
      { claims: [{ subject: " ", predicate: "  " }] },
      { memories: [{ content: "明日は晴れるらしい", provenanceKind: "stated" }] },
      { claims: [{ subject: "　", predicate: "　" }] }, // 全角スペース——直す前は両方とも
      // { subject: "", predicate: "" } に潰れ、無関係などうしが誤って一致していた。
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
    // 鍵が取れなかった（null）ので、detectClaimKeyContested は検出自体を試みない
    // （`contestedDetection` に対応する要素が現れない）。
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
    // 1件目・2件目は detectContested を使わずに作る——2件ともペアにならないまま
    // `active` で残り続ける（実運用では「後から opt-in を有効にした」「バッチ内の
    // 複数候補が同じ鍵になった」等でも同じ状況になりうる）。3件目で初めて検出を
    // 有効にすると、相手の active が2件（=3件目）ある状態に出会う。
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
    // 検出を使っていないので、1件目・2件目はどちらも active のまま。
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

    // markContested を呼んでいない ⟹ 3件目は active のまま、既存2件の状態も変わらない。
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
    // `findActiveByClaimKey` を持たない adapter を模す（インスタンスへ `undefined` を
    // 直接代入してプロトタイプの実装を覆う。`delete` はプロトタイプのメソッドには
    // 効かないため使わない）。
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

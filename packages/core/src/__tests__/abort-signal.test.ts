import { describe, expect, it, vi } from "vitest";
import type { Ctx } from "../ctx.js";
import { abortReason, runAbortable } from "../abort.js";
import type { AbortOptions } from "../abort.js";
import type { EmbeddingProvider } from "../interfaces/embedding-provider.js";
import type { LLMProvider, StructuredRequest } from "../interfaces/llm-provider.js";
import type { MemoryId } from "../ids.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

const ctx: Ctx = { tenantId: "tenant-abort" };

/** `completeStructured` を呼ぶと永久に pending のままになる `LLMProvider`。`opts.signal` を一切見ない: runtime 自身が abort と競わせることの歯にするため。 */
class HangingLLMProvider implements LLMProvider {
  calls: { req: unknown; opts: AbortOptions | undefined }[] = [];
  private pendingResolve: ((value: unknown) => void) | null = null;
  private pendingReject: ((error: unknown) => void) | null = null;

  complete(): Promise<never> {
    throw new Error("HangingLLMProvider.complete: not used");
  }

  completeStructured<T>(_ctx: Ctx, req: StructuredRequest<T>, opts?: AbortOptions): Promise<T> {
    this.calls.push({ req, opts });
    return new Promise<T>((resolve, reject) => {
      this.pendingResolve = resolve as (value: unknown) => void;
      this.pendingReject = reject as (error: unknown) => void;
    });
  }

  resolveLatest(value: unknown): void {
    this.pendingResolve?.(value);
  }

  rejectLatest(error: unknown): void {
    this.pendingReject?.(error);
  }
}

class HangingEmbeddingProvider implements EmbeddingProvider {
  readonly space = { provider: "hanging", model: "hanging-model", dimensions: 2 };
  calls: { texts: string[]; opts: AbortOptions | undefined }[] = [];
  private pendingResolve: ((value: number[][]) => void) | null = null;
  private pendingReject: ((error: unknown) => void) | null = null;

  embed(_ctx: Ctx, texts: string[], opts?: AbortOptions): Promise<number[][]> {
    this.calls.push({ texts, opts });
    return new Promise<number[][]>((resolve, reject) => {
      this.pendingResolve = resolve;
      this.pendingReject = reject;
    });
  }

  resolveLatest(value: number[][]): void {
    this.pendingResolve?.(value);
  }

  rejectLatest(error: unknown): void {
    this.pendingReject?.(error);
  }
}

/** 1回目の `completeStructured` は `firstResponse` で即座に成功し、2回目（claim key の呼び出し）は pending のままにする `LLMProvider`。 */
class TwoCallLLMProvider implements LLMProvider {
  callCount = 0;
  secondCallOpts: AbortOptions | undefined;
  private secondCallResolve: ((value: unknown) => void) | undefined;

  constructor(private readonly firstResponse: unknown) {}

  complete(): Promise<never> {
    throw new Error("TwoCallLLMProvider.complete: not used");
  }

  completeStructured<T>(_ctx: Ctx, req: StructuredRequest<T>, opts?: AbortOptions): Promise<T> {
    this.callCount += 1;
    if (this.callCount === 1) {
      return Promise.resolve(req.schema.parse(this.firstResponse) as T);
    }
    this.secondCallOpts = opts;
    return new Promise<T>((resolve) => {
      this.secondCallResolve = resolve as (value: unknown) => void;
    });
  }

  resolveSecondCall(value: unknown): void {
    this.secondCallResolve?.(value);
  }
}

function succeedingLlm(): LLMProvider {
  return {
    complete: async () => {
      throw new Error("not used");
    },
    completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> =>
      req.schema.parse({
        memories: [{ content: "本文", digest: "要旨", provenanceKind: "stated" }],
      }) as T,
  };
}

function succeedingEmbeddingProvider(): EmbeddingProvider {
  return {
    space: { provider: "fake", model: "fake-model", dimensions: 2 },
    embed: async (_ctx: Ctx, texts: string[]) => texts.map(() => [1, 2]),
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

/** `completeStructured`/`embed` の呼び出しが登録されるまで待つ。固定回数のマイクロタスクではなく `setTimeout` を複数回挟むのは、provider を呼ぶまでに複数回 `await` を挟む経路があるため。 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("AbortSignal — 呼ぶ前に既に abort 済みの場合（provider を一切呼ばない）", () => {
  it("observe(): 既に abort 済みの signal を渡すと、LLM を呼ばずに reject する", async () => {
    const llm = new HangingLLMProvider();
    const { runtime } = buildRuntime(llm);
    const controller = new AbortController();
    controller.abort();

    await expect(
      runtime.observe(ctx, { kind: "utterance", text: "発話" }, { signal: controller.signal }),
    ).rejects.toBe(controller.signal.reason);
    expect(llm.calls).toHaveLength(0);
  });

  it("recall(): 既に abort 済みの signal を渡すと、embed を呼ばずに reject する", async () => {
    const embeddingProvider = new HangingEmbeddingProvider();
    const { runtime } = buildRuntime(succeedingLlm(), { embeddingProvider });
    const controller = new AbortController();
    controller.abort();

    await expect(
      runtime.recall(ctx, { text: "クエリ" }, { signal: controller.signal }),
    ).rejects.toBe(controller.signal.reason);
    expect(embeddingProvider.calls).toHaveLength(0);
  });

  it("tick(): 既に abort 済みの signal を渡すと、claim 済みのどのジョブも処理せずに reject する", async () => {
    const embeddingProvider = new HangingEmbeddingProvider();
    const { runtime, stores } = buildRuntime(succeedingLlm(), { embeddingProvider });
    await runtime.observe(ctx, { kind: "utterance", text: "発話" });

    const controller = new AbortController();
    controller.abort();
    await expect(
      runtime.tick(ctx, { leaseMs: 60_000, kinds: ["embed"], signal: controller.signal }),
    ).rejects.toBe(controller.signal.reason);

    expect(embeddingProvider.calls).toHaveLength(0);
    const jobs = stores.outboxStore.listJobs(ctx);
    const embedJob = jobs.find((j) => j.kind === "embed")!;
    expect(embedJob.claimedAt).not.toBeNull();
    expect(embedJob.completedAt).toBeNull();
    expect(embedJob.failedAt).toBeNull();
  });

  it("tick(): 既に abort 済みなら、provider を呼ばない種類（対応していない kind）のジョブも fail() で焼かずに残す", async () => {
    const { runtime, stores } = buildRuntime(succeedingLlm());
    const customKind = "gurumi-chan:notify-slack";
    const { jobs } = await stores.memoryStore.createObservationWithOutbox(
      ctx,
      { tenantId: ctx.tenantId, subjectId: null, externalId: null, kind: "utterance", payload: {} },
      [customKind],
    );
    expect(jobs).toHaveLength(1);

    const controller = new AbortController();
    controller.abort();
    await expect(
      runtime.tick(ctx, { leaseMs: 60_000, kinds: [customKind], signal: controller.signal }),
    ).rejects.toBe(controller.signal.reason);

    const row = stores.outboxStore.listJobs(ctx).find((j) => j.id === jobs[0]!.id)!;
    expect(row.claimedAt).not.toBeNull();
    expect(row.failedAt).toBeNull();
    expect(row.completedAt).toBeNull();
  });
});

describe("AbortSignal — observe(): 抽出の LLM 呼び出し中に abort", () => {
  it("observe() が signal.reason で reject し、記憶は0件、extract ジョブは complete されず残る", async () => {
    const llm = new HangingLLMProvider();
    const { runtime, stores } = buildRuntime(llm);
    const controller = new AbortController();

    const promise = runtime.observe(
      ctx,
      { kind: "utterance", text: "発話" },
      { signal: controller.signal },
    );
    await flushMicrotasks();
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]!.opts?.signal).toBe(controller.signal);

    controller.abort();
    await expect(promise).rejects.toBe(controller.signal.reason);

    const jobs = stores.outboxStore.listJobs(ctx);
    expect(jobs).toHaveLength(1);
    const extractJob = jobs[0]!;
    expect(extractJob.kind).toBe("extract");
    expect(extractJob.completedAt).toBeNull();
    expect(extractJob.failedAt).toBeNull();

    const observationId = extractJob.payload.observationId as string;
    const memories = await stores.memoryStore.listBySourceObservation(ctx, observationId, "v1");
    expect(memories).toHaveLength(0);

    llm.resolveLatest({
      memories: [{ content: "遅れて届いた本文", provenanceKind: "stated" }],
    });
    await flushMicrotasks();
    const memoriesAfter = await stores.memoryStore.listBySourceObservation(
      ctx,
      observationId,
      "v1",
    );
    expect(memoriesAfter).toHaveLength(0);
  });

  it("abort 後に LLM が reject しても、observe() は既に reject 済みの値のまま動かない", async () => {
    const llm = new HangingLLMProvider();
    const { runtime } = buildRuntime(llm);
    const controller = new AbortController();

    const promise = runtime.observe(
      ctx,
      { kind: "utterance", text: "発話" },
      { signal: controller.signal },
    );
    await flushMicrotasks();
    controller.abort();
    await expect(promise).rejects.toBe(controller.signal.reason);

    llm.rejectLatest(new Error("LLM がようやく失敗した"));
    await flushMicrotasks();
  });

  it("claimKey.enabled: true のとき、claim key の LLM 呼び出し中の abort でも記憶は0件（claim key は書き込みより前）", async () => {
    const llm = new TwoCallLLMProvider({
      memories: [{ content: "本文", digest: "要旨", provenanceKind: "stated" }],
    });
    const { runtime, stores } = buildRuntime(llm);
    const controller = new AbortController();

    const promise = runtime.observe(
      ctx,
      {
        kind: "utterance",
        text: "発話",
        claimKey: { enabled: true },
      },
      { signal: controller.signal },
    );
    await flushMicrotasks();
    expect(llm.callCount).toBe(2);
    expect(llm.secondCallOpts?.signal).toBe(controller.signal);

    controller.abort();
    await expect(promise).rejects.toBe(controller.signal.reason);

    const jobs = stores.outboxStore.listJobs(ctx);
    const observationId = jobs[0]!.payload.observationId as string;
    const memories = await stores.memoryStore.listBySourceObservation(ctx, observationId, "v1");
    expect(memories).toHaveLength(0);

    llm.resolveSecondCall({ claims: [{ subject: "user", predicate: "p" }] });
    await flushMicrotasks();
  });
});

describe("AbortSignal — reextract(): 抽出の LLM 呼び出し中に abort", () => {
  it("reextract() が reject し、何も書かない", async () => {
    const llm = new HangingLLMProvider();
    const { runtime, stores } = buildRuntime(succeedingLlm());
    const observeResult = await runtime.observe(ctx, { kind: "utterance", text: "元の発話" });

    const reextractRuntime = buildRuntime(llm, {
      memoryStore: stores.memoryStore,
      outboxStore: stores.outboxStore,
      vectorStore: stores.vectorStore,
      eventStore: stores.eventStore,
      tenantSettingsStore: stores.tenantSettingsStore,
      embeddingProvider: stores.embeddingProvider,
    }).runtime;

    const controller = new AbortController();
    const promise = reextractRuntime.reextract(ctx, observeResult.observationId, {
      signal: controller.signal,
    });
    await flushMicrotasks();
    controller.abort();
    await expect(promise).rejects.toBe(controller.signal.reason);

    const memoriesAfter = await stores.memoryStore.listBySourceObservation(
      ctx,
      observeResult.observationId,
      "v1",
    );
    expect(memoriesAfter).toHaveLength(1);
    expect(memoriesAfter[0]!.id).toBe(observeResult.memoryIds[0]);
  });
});

describe("AbortSignal — recall(): クエリの埋め込み待ち中に abort", () => {
  it("recall() が reject し、recall の記録は作られない（activity_seq も進まない）", async () => {
    const embeddingProvider = new HangingEmbeddingProvider();
    const { runtime, stores } = buildRuntime(succeedingLlm(), { embeddingProvider });
    await stores.tenantSettingsStore.setDecayClock(ctx, "activity");
    const before = await stores.tenantSettingsStore.getActivitySeq(ctx);

    const createRecallSpy = vi.spyOn(stores.memoryStore, "createRecall");

    const controller = new AbortController();
    const promise = runtime.recall(ctx, { text: "クエリ" }, { signal: controller.signal });
    await flushMicrotasks();
    expect(embeddingProvider.calls).toHaveLength(1);
    expect(embeddingProvider.calls[0]!.opts?.signal).toBe(controller.signal);

    controller.abort();
    await expect(promise).rejects.toBe(controller.signal.reason);

    expect(createRecallSpy).not.toHaveBeenCalled();
    const after = await stores.tenantSettingsStore.getActivitySeq(ctx);
    expect(after).toBe(before);

    embeddingProvider.resolveLatest([[1, 2]]);
    await flushMicrotasks();
    expect(createRecallSpy).not.toHaveBeenCalled();
  });

  it("embedding_provider_unavailable には倒さない（abort は omission に丸めない）", async () => {
    const embeddingProvider = new HangingEmbeddingProvider();
    const { runtime } = buildRuntime(succeedingLlm(), { embeddingProvider });
    const controller = new AbortController();

    const promise = runtime.recall(ctx, { text: "クエリ" }, { signal: controller.signal });
    await flushMicrotasks();
    controller.abort();

    await expect(promise).rejects.toBe(controller.signal.reason);
  });
});

describe("AbortSignal — findCorrectionCandidates(): 内部の recall() 待ち中に abort", () => {
  it("reject する（内部で呼ぶ recall と同じ形）", async () => {
    const embeddingProvider = new HangingEmbeddingProvider();
    const { runtime } = buildRuntime(succeedingLlm(), { embeddingProvider });
    const controller = new AbortController();

    const promise = runtime.findCorrectionCandidates(
      ctx,
      { text: "訂正の発話" },
      { signal: controller.signal },
    );
    await flushMicrotasks();
    controller.abort();
    await expect(promise).rejects.toBe(controller.signal.reason);
  });
});

describe("AbortSignal — tick(): embed ジョブの処理中に abort", () => {
  it("tick() が reject し、ジョブは fail() されず claim されたまま残る（embeddingStatus も 'failed' にならない）", async () => {
    const embeddingProvider = new HangingEmbeddingProvider();
    const { runtime, stores } = buildRuntime(succeedingLlm(), { embeddingProvider });
    const observeResult = await runtime.observe(ctx, { kind: "utterance", text: "発話" });
    const memoryId = observeResult.memoryIds[0]!;

    const controller = new AbortController();
    const promise = runtime.tick(ctx, {
      leaseMs: 60_000,
      kinds: ["embed"],
      signal: controller.signal,
    });
    await flushMicrotasks();
    expect(embeddingProvider.calls).toHaveLength(1);

    controller.abort();
    await expect(promise).rejects.toBe(controller.signal.reason);

    const jobs = stores.outboxStore.listJobs(ctx);
    const embedJob = jobs.find((j) => j.kind === "embed")!;
    expect(embedJob.claimedAt).not.toBeNull();
    expect(embedJob.completedAt).toBeNull();
    expect(embedJob.failedAt).toBeNull();
    expect(embedJob.lastError).toBeNull();

    const memory = await stores.memoryStore.get(ctx, memoryId);
    expect(memory?.embeddingStatus).toBe("pending");

    const upsertSpy = vi.spyOn(stores.vectorStore, "upsert");
    embeddingProvider.resolveLatest([[1, 2]]);
    await flushMicrotasks();
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it("リースが切れた後、次の tick() がそのジョブを取り直して正常に処理できる", async () => {
    const embeddingProvider = new HangingEmbeddingProvider();
    let fakeNow = new Date(Date.now() + 10_000);
    const fakeClock = { now: () => fakeNow };
    const { runtime, stores } = buildRuntime(succeedingLlm(), {
      embeddingProvider,
      clock: fakeClock,
    });
    const observeResult = await runtime.observe(ctx, { kind: "utterance", text: "発話" });
    const memoryId = observeResult.memoryIds[0]!;

    const controller = new AbortController();
    const leaseMs = 1_000;
    const promise = runtime.tick(ctx, { leaseMs, kinds: ["embed"], signal: controller.signal });
    await flushMicrotasks();
    controller.abort();
    await expect(promise).rejects.toBe(controller.signal.reason);

    fakeNow = new Date(fakeNow.getTime() + leaseMs + 1);

    const stores2 = stores; // 同じ store を共有し、runtime だけ作り直して provider を差し替える。
    const workingEmbeddingProvider = succeedingEmbeddingProvider();
    const runtime2 = createRuntime({
      memoryStore: stores2.memoryStore,
      outboxStore: stores2.outboxStore,
      vectorStore: stores2.vectorStore,
      eventStore: stores2.eventStore,
      tenantSettingsStore: stores2.tenantSettingsStore,
      llmProvider: succeedingLlm(),
      embeddingProvider: workingEmbeddingProvider,
      hashContent: (content: string) => `sha256(${content})`,
      clock: fakeClock,
    });
    const result = await runtime2.tick(ctx, { leaseMs, kinds: ["embed"] });
    expect(result.processed).toBe(1);
    expect(result.failed).toBe(0);

    const memory = await stores.memoryStore.get(ctx, memoryId);
    expect(memory?.embeddingStatus).toBe("ready");
  });

  it("複数ジョブのうち1件目が完了済みなら、abort 後も1件目の完了は残る", async () => {
    const embeddingProvider = new HangingEmbeddingProvider();
    const { runtime, stores } = buildRuntime(succeedingLlm(), { embeddingProvider });
    await runtime.observe(ctx, { kind: "utterance", text: "発話A" });
    await runtime.observe(ctx, { kind: "utterance", text: "発話B" });

    let embedCall = 0;
    const mixedEmbeddingProvider: EmbeddingProvider = {
      space: { provider: "fake", model: "fake-model", dimensions: 2 },
      embed: async (_ctx: Ctx, texts: string[], opts?: AbortOptions) => {
        embedCall += 1;
        if (embedCall === 1) {
          return texts.map(() => [1, 2]);
        }
        return embeddingProvider.embed(_ctx, texts, opts);
      },
    };

    const { runtime: tickRuntime } = buildRuntime(succeedingLlm(), {
      memoryStore: stores.memoryStore,
      outboxStore: stores.outboxStore,
      vectorStore: stores.vectorStore,
      eventStore: stores.eventStore,
      tenantSettingsStore: stores.tenantSettingsStore,
      embeddingProvider: mixedEmbeddingProvider,
    });

    const controller = new AbortController();
    const promise = tickRuntime.tick(ctx, {
      leaseMs: 60_000,
      kinds: ["embed"],
      signal: controller.signal,
    });
    await flushMicrotasks();
    await flushMicrotasks();
    controller.abort();
    await expect(promise).rejects.toBe(controller.signal.reason);

    const jobs = stores.outboxStore.listJobs(ctx).filter((j) => j.kind === "embed");
    const completedCount = jobs.filter((j) => j.completedAt !== null).length;
    const untouchedCount = jobs.filter((j) => j.completedAt === null && j.failedAt === null).length;
    expect(completedCount).toBe(1);
    expect(untouchedCount).toBe(1);
  });
});

describe("AbortSignal — consolidate()", () => {
  /** eligible が2件以上ないと LLM 呼び出し（手順5）に届かない（1件なら `single_eligible_source` で早期に打ち切られる）。 */
  async function seedTwoActiveMemories(
    runtime: ReturnType<typeof buildRuntime>["runtime"],
  ): Promise<MemoryId[]> {
    const a = await runtime.observe(ctx, { kind: "utterance", text: "発話A" });
    const b = await runtime.observe(ctx, { kind: "utterance", text: "発話B" });
    return [a.memoryIds[0]!, b.memoryIds[0]!];
  }

  it("土台探索（内部の recall）中の abort で reject する", async () => {
    const embeddingProvider = new HangingEmbeddingProvider();
    const { runtime } = buildRuntime(succeedingLlm(), { embeddingProvider });
    const [seedId] = await seedTwoActiveMemories(runtime);

    const controller = new AbortController();
    const promise = runtime.consolidate(ctx, {
      target: { seedMemoryId: seedId! },
      signal: controller.signal,
    });
    await flushMicrotasks();
    controller.abort();
    await expect(promise).rejects.toBe(controller.signal.reason);
  });

  it("LLM 呼び出し中の abort で reject し、統合先は作られない", async () => {
    const llmForSeed = succeedingLlm();
    const { runtime: seedRuntime, stores } = buildRuntime(llmForSeed);
    const ids = await seedTwoActiveMemories(seedRuntime);

    const hangingLlm = new HangingLLMProvider();
    const { runtime } = buildRuntime(hangingLlm, {
      memoryStore: stores.memoryStore,
      outboxStore: stores.outboxStore,
      vectorStore: stores.vectorStore,
      eventStore: stores.eventStore,
      tenantSettingsStore: stores.tenantSettingsStore,
      embeddingProvider: stores.embeddingProvider,
    });

    const createMemoryWithOutboxSpy = vi.spyOn(stores.memoryStore, "createMemoryWithOutbox");

    const controller = new AbortController();
    const promise = runtime.consolidate(ctx, {
      target: { memoryIds: ids },
      signal: controller.signal,
    });
    await flushMicrotasks();
    expect(hangingLlm.calls).toHaveLength(1);
    expect(hangingLlm.calls[0]!.opts?.signal).toBe(controller.signal);

    controller.abort();
    await expect(promise).rejects.toBe(controller.signal.reason);
    expect(createMemoryWithOutboxSpy).not.toHaveBeenCalled();
  });
});

describe("AbortSignal — reflect()", () => {
  it("LLM 呼び出し中の abort で reject し、書き込みは起きない", async () => {
    const llmForSeed = succeedingLlm();
    const { runtime: seedRuntime, stores } = buildRuntime(llmForSeed);
    const seedResult = await seedRuntime.observe(ctx, { kind: "utterance", text: "発話" });

    const hangingLlm = new HangingLLMProvider();
    const { runtime } = buildRuntime(hangingLlm, {
      memoryStore: stores.memoryStore,
      outboxStore: stores.outboxStore,
      vectorStore: stores.vectorStore,
      eventStore: stores.eventStore,
      tenantSettingsStore: stores.tenantSettingsStore,
      embeddingProvider: stores.embeddingProvider,
    });

    const createMemoryWithOutboxSpy = vi.spyOn(stores.memoryStore, "createMemoryWithOutbox");

    const controller = new AbortController();
    const promise = runtime.reflect(ctx, {
      target: { memoryIds: [seedResult.memoryIds[0]!] },
      signal: controller.signal,
    });
    await flushMicrotasks();
    expect(hangingLlm.calls).toHaveLength(1);
    expect(hangingLlm.calls[0]!.opts?.signal).toBe(controller.signal);

    controller.abort();
    await expect(promise).rejects.toBe(controller.signal.reason);
    expect(createMemoryWithOutboxSpy).not.toHaveBeenCalled();
  });
});

describe("AbortSignal — consolidate()・reflect() の土台探索（内部の recall）の { query } 形・reflect の { seedMemoryId } 形", () => {
  async function expectRejectsWhileEmbeddingQuery(
    run: (
      runtime: ReturnType<typeof buildRuntime>["runtime"],
      seedId: MemoryId,
      signal: AbortSignal,
    ) => Promise<unknown>,
  ): Promise<void> {
    const embeddingProvider = new HangingEmbeddingProvider();
    const { runtime } = buildRuntime(succeedingLlm(), { embeddingProvider });
    const a = await runtime.observe(ctx, { kind: "utterance", text: "発話A" });
    await runtime.observe(ctx, { kind: "utterance", text: "発話B" });

    const controller = new AbortController();
    const promise = run(runtime, a.memoryIds[0]!, controller.signal);
    await flushMicrotasks();
    expect(embeddingProvider.calls.length).toBeGreaterThan(0);
    expect(embeddingProvider.calls.at(-1)!.opts?.signal).toBeDefined();
    controller.abort();
    await expect(promise).rejects.toBe(controller.signal.reason);
  }

  it("consolidate({ query }): クエリの埋め込み待ち中の abort で reject する", async () => {
    await expectRejectsWhileEmbeddingQuery((runtime, _seedId, signal) =>
      runtime.consolidate(ctx, { target: { query: { text: "クエリ" } }, signal }),
    );
  });

  it("reflect({ query }): クエリの埋め込み待ち中の abort で reject する", async () => {
    await expectRejectsWhileEmbeddingQuery((runtime, _seedId, signal) =>
      runtime.reflect(ctx, { target: { query: { text: "クエリ" } }, signal }),
    );
  });

  it("reflect({ seedMemoryId }): 種の近傍探索の埋め込み待ち中の abort で reject する", async () => {
    await expectRejectsWhileEmbeddingQuery((runtime, seedId, signal) =>
      runtime.reflect(ctx, { target: { seedMemoryId: seedId }, signal }),
    );
  });
});

describe("AbortSignal — tick() の consolidate・reflect ジョブ（signal がジョブの中の consolidate()/reflect() まで届く）", () => {
  for (const kind of ["consolidate", "reflect"] as const) {
    it(`${kind} ジョブの処理中（種の近傍探索の埋め込み待ち）に abort すると、tick() が reject し、ジョブは fail() されず claim されたまま残る`, async () => {
      const embeddingProvider = new HangingEmbeddingProvider();
      const { runtime, stores } = buildRuntime(succeedingLlm(), { embeddingProvider });
      const recordedAt = new Date("2026-06-01T00:00:00.000Z");
      const { memory, jobs } = await stores.memoryStore.createMemoryWithOutbox(
        ctx,
        {
          tenantId: ctx.tenantId,
          subjectId: null,
          sourceObservationId: null,
          extractorVersion: null,
          content: "種の本文",
          contentHash: "hash-seed",
          digest: "種の要旨",
          digestSource: "llm",
          provenance: { kind: "imported", batchId: "fixture" },
          tags: [],
          occurredAt: null,
          recordedAt,
          lastReinforcedAt: null,
          strength: 1,
          halfLifeHours: 24 * 365,
          decayFloorAt: new Date("2030-01-01T00:00:00.000Z"),
          embeddingStatus: "ready",
        },
        [kind],
      );
      expect(jobs).toHaveLength(1);

      const controller = new AbortController();
      const promise = runtime.tick(ctx, {
        leaseMs: 60_000,
        kinds: [kind],
        signal: controller.signal,
      });
      await flushMicrotasks();
      expect(embeddingProvider.calls.length).toBeGreaterThan(0);
      expect(embeddingProvider.calls.at(-1)!.opts?.signal).toBeDefined();
      controller.abort();
      await expect(promise).rejects.toBe(controller.signal.reason);

      const row = stores.outboxStore.listJobs(ctx).find((j) => j.id === jobs[0]!.id)!;
      expect(row.claimedAt).not.toBeNull();
      expect(row.completedAt).toBeNull();
      expect(row.failedAt).toBeNull();
      expect((await stores.memoryStore.get(ctx, memory.id))?.status).toBe("active");
    });
  }
});

describe("AbortSignal — reject する値は signal.reason（Node は reason を自動で埋める／明示した reason はそのまま）", () => {
  it("Node の AbortController.abort() は既定で reason を自動的に埋めるため、明示しなくても signal.reason が使われる", async () => {
    const llm = new HangingLLMProvider();
    const { runtime } = buildRuntime(llm);
    const controller = new AbortController();

    const promise = runtime.observe(
      ctx,
      { kind: "utterance", text: "発話" },
      { signal: controller.signal },
    );
    await flushMicrotasks();
    controller.abort();
    expect(controller.signal.reason).toBeInstanceOf(Error);
    await expect(promise).rejects.toBe(controller.signal.reason);
  });

  it("明示した reason（任意の値）がそのまま reject の値になる", async () => {
    const llm = new HangingLLMProvider();
    const { runtime } = buildRuntime(llm);
    const controller = new AbortController();
    const reason = { customReason: "テスト用の理由" };

    const promise = runtime.observe(
      ctx,
      { kind: "utterance", text: "発話" },
      { signal: controller.signal },
    );
    await flushMicrotasks();
    controller.abort(reason);
    await expect(promise).rejects.toBe(reason);
  });
});

describe("abortReason — signal.reason が undefined のときだけ AbortError 相当を作る", () => {
  // 🔴 Node の実 AbortSignal は reason を渡さない abort() でも DOMException を自動で入れるため、
  // `reason === undefined` の分岐へは実 AbortController では届かない。reason を持たない
  // signal 相当のオブジェクト（自前の signal 実装など）で確かめる。
  const noReasonSignal = { aborted: true, reason: undefined } as unknown as AbortSignal;

  it("reason が undefined なら、name が 'AbortError' の DOMException を返す", () => {
    const reason = abortReason(noReasonSignal);
    expect(reason).toBeInstanceOf(DOMException);
    expect((reason as DOMException).name).toBe("AbortError");
    expect((reason as DOMException).message).toBe("This operation was aborted");
  });

  it("reason が在れば、null や 0 のような falsy な値も含め、そのまま返す（作り直さない）", () => {
    const custom = { customReason: "x" };
    expect(abortReason({ aborted: true, reason: custom } as unknown as AbortSignal)).toBe(custom);
    expect(abortReason({ aborted: true, reason: null } as unknown as AbortSignal)).toBeNull();
    expect(abortReason({ aborted: true, reason: 0 } as unknown as AbortSignal)).toBe(0);
  });

  it("実 AbortController の abort()（reason 無し）は、Node が自動で入れた reason をそのまま返す", () => {
    const controller = new AbortController();
    controller.abort();
    expect(abortReason(controller.signal)).toBe(controller.signal.reason);
  });
});

describe("runAbortable — abort と run の決着の順序", () => {
  it("run の同期部分の中で abort されたら、run が値で解決しても結果を捨て、signal.reason で reject する", async () => {
    const controller = new AbortController();
    const reason = new Error("aborted inside run");
    const promise = runAbortable(controller.signal, () => {
      controller.abort(reason);
      return Promise.resolve("value");
    });
    await expect(promise).rejects.toBe(reason);
  });

  it("対照: run が abort より前に解決していれば、その値が返る", async () => {
    const controller = new AbortController();
    const value = await runAbortable(controller.signal, () => Promise.resolve("value"));
    controller.abort();
    expect(value).toBe("value");
  });

  it("待っている間の abort でも、reason が undefined の signal（自前の signal 実装）なら AbortError の DOMException で reject する", async () => {
    const target = new EventTarget();
    const signal = Object.assign(target, {
      aborted: false,
      reason: undefined,
    }) as unknown as AbortSignal;
    const promise = runAbortable(signal, () => new Promise<never>(() => undefined));
    Object.assign(signal, { aborted: true });
    signal.dispatchEvent(new Event("abort"));
    const error = await promise.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe("AbortError");
  });
});

import { describe, expect, it, vi } from "vitest";
import type { Ctx } from "../ctx.js";
import { abortReason } from "../abort.js";
import type { AbortOptions } from "../abort.js";
import type { EmbeddingProvider } from "../interfaces/embedding-provider.js";
import type { LLMProvider, StructuredRequest } from "../interfaces/llm-provider.js";
import type { MemoryId } from "../ids.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * [Issue #1200](https://github.com/takecchi/mnemora/issues/1200) /
 * [ADR 0359](../../../docs/decisions/0359-abort-signal-for-provider-calls.md)（クローン miku の判断）:
 * `AbortSignal` による中断の歯。
 *
 * **この歯が測ること:**
 * - provider（LLM/Embedding）呼び出しの間・呼ぶ前に abort されると、呼んだ Runtime の口が
 *   reject すること。
 * - 中断は、既存の「失敗したときの安全弁」（全文フォールバック・`llm_failed`・
 *   `embedding_provider_unavailable`・`embeddingStatus: 'failed'`・outbox の `fail()`）
 *   のどれにも倒れないこと。
 * - abort の時点で何が書かれ、何が書かれないか（Observation・extract ジョブ・Memory・
 *   recall の記録・outbox ジョブの終端状態）。
 * - provider が signal を無視しても、runtime 自身が abort と競わせるので呼んだ口は返ること
 *   （`HangingLLMProvider`/`HangingEmbeddingProvider` は signal を一切見ない——これが
 *   このファイルの fake の核心の性質）。
 * - 遅れて解決した provider の Promise が unhandled rejection を起こさないこと。
 */

const ctx: Ctx = { tenantId: "tenant-abort" };

/**
 * `completeStructured` を呼ぶと**永久に pending のまま**になる `LLMProvider`。
 * `resolve`/`reject` で外からテストコードが決着を付けられる。
 *
 * 🔴 **`opts.signal` を一切見ない**——runtime 自身が abort と競わせることの歯にするため。
 * 呼ばれた `opts` は `calls` に記録するので、「呼んだかどうか」「signal を渡したか」は
 * 別途アサーションできる。
 */
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

  /** 最後の呼び出しを、渡した値で解決する。 */
  resolveLatest(value: unknown): void {
    this.pendingResolve?.(value);
  }

  /** 最後の呼び出しを、渡した理由で拒否する。 */
  rejectLatest(error: unknown): void {
    this.pendingReject?.(error);
  }
}

/** `HangingLLMProvider` と対になる `EmbeddingProvider`。同じ理由・同じ形。 */
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

/**
 * 1回目の `completeStructured` 呼び出しは `firstResponse` で即座に成功させ、
 * 2回目（claim key の呼び出しを想定）は pending のままにする `LLMProvider`。
 * `runExtraction` が「抽出 → (opt-inのときだけ)claim key」の順で呼ぶことを前提にした
 * 単純化——`sequencedLlm`（`runtime.test.ts`）と同じ発想。
 */
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

/** 即座に候補を返す、abort と無関係の正常系 LLM（Memory を1件作るための下ごしらえに使う）。 */
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

/** `succeedingLlm` と対になる、即座に返す `EmbeddingProvider`。 */
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

/**
 * `completeStructured`/`embed` の呼び出しが登録されるまで待つ。
 *
 * provider を呼ぶまでに（`recall()` の decay_clock 読み取りなど）複数回 `await` を挟む
 * 経路があるため、固定回数のマイクロタスクではなく、マクロタスクの境界（`setTimeout`）を
 * 複数回挟んで確実に「provider 呼び出しが起きるところまで」進める。
 */
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
    // `claimBatch` 自体は store 呼び出しであり「provider を呼ぶ前」の判定より前に走るため、
    // job は claim される（`claimedAt` が付く）——ただし handler は一度も呼ばれず、
    // `complete()`/`fail()` のどちらも記録されない。claim されたまま残り、リースが
    // 切れれば次の `tick` が取れる。
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
    // claim はされる（claimBatch はループの前に1回だけ呼ぶ）が、終端（failedAt）には焼かない。
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
    // runtime 自身が signal を渡している（provider がそれを見るかどうかとは別に、
    // 渡されていること自体を確かめる）。
    expect(llm.calls[0]!.opts?.signal).toBe(controller.signal);

    controller.abort();
    await expect(promise).rejects.toBe(controller.signal.reason);

    // Observation・extract ジョブは LLM を呼ぶ前に書かれている（doc コメントのとおり）。
    const jobs = stores.outboxStore.listJobs(ctx);
    expect(jobs).toHaveLength(1);
    const extractJob = jobs[0]!;
    expect(extractJob.kind).toBe("extract");
    expect(extractJob.completedAt).toBeNull();
    expect(extractJob.failedAt).toBeNull();

    const observationId = extractJob.payload.observationId as string;
    const memories = await stores.memoryStore.listBySourceObservation(ctx, observationId, "v1");
    expect(memories).toHaveLength(0);

    // 遅れて LLM が解決しても、observe() は既に reject 済みで、何も書かれない
    // （unhandled rejection にもならない——`runAbortable` が `.then`/`.catch` を
    // 必ず付けているため）。
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

    // 遅れて LLM 自身が失敗しても、unhandled rejection にはならない（後続の it が
    // 走ること自体が、この rejection が捨てられずに握られていたことの傍証になる）。
    llm.rejectLatest(new Error("LLM がようやく失敗した"));
    await flushMicrotasks();
  });

  it("claimKey.enabled: true のとき、claim key の LLM 呼び出し中の abort でも記憶は0件（claim key は書き込みより前）", async () => {
    // 抽出は即座に成功させ、claim key の呼び出し（2回目）だけを止める——実測（下調べの
    // 結果）で claim key の呼び出しは Memory の書き込みより前だと分かったことの歯。
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
    // 元の observe() で作られた1件のまま——reextract は何も足していない。
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

    // 遅れて embed が解決しても、recall の記録は作られない。
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
    // reject した場合、`RecallResult`（`omitted` を含む）はそもそも返らない——
    // 正常応答に丸められていないことは、`rejects` で見ていること自体が証拠。
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

    // 遅れて embed が解決しても、書き込みは起きない（vectorStore へも upsert しない）。
    const upsertSpy = vi.spyOn(stores.vectorStore, "upsert");
    embeddingProvider.resolveLatest([[1, 2]]);
    await flushMicrotasks();
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it("リースが切れた後、次の tick() がそのジョブを取り直して正常に処理できる", async () => {
    const embeddingProvider = new HangingEmbeddingProvider();
    // 以前の Fake は `availableAt` を `FakeBackingStore.enqueueJob` が実時刻 `new Date()` で打ったため、
    // `fakeNow` を実時刻より確実に先に置いている（`runtime.test.ts` の同種の歯と同じ）。今の Fake は
    // `opts.now` に従う（ADR 0555）が、組み替えていない（ADR 0555 の「残り」）。
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

    // リースを進める。
    fakeNow = new Date(fakeNow.getTime() + leaseMs + 1);

    // 次の tick() は abort されておらず、embeddingProvider も正常に返す設定に差し替える。
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

    // 1件目はすぐ解決する embed、2件目は abort まで pending のままにするため、
    // 呼び出し回数で切り替える偽 provider を使う。
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
    // embeddingProvider が Hanging なので observe() の embed ジョブは積まれるだけで
    // 埋め込みは終わらない——ここでは consolidate() の対象選定に要る Memory の
    // 存在だけが必要（`seedMemoryId` 経由は種の get() をまず読むため、embed の成否は
    // 無関係）。
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
    // 内部の recall() がクエリの埋め込みを待っている最中（embed に signal が渡っている）。
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
      // ジョブの中の consolidate()/reflect() が、種の digest を埋め込んで待っている最中。
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

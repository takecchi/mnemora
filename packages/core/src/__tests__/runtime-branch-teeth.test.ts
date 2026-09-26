import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { EmbeddingProvider } from "../interfaces/embedding-provider.js";
import type { LLMProvider, StructuredRequest } from "../interfaces/llm-provider.js";
import type { MemoryStore } from "../interfaces/memory-store.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import type { Runtime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * `runtime.ts` の recall 以外の経路に変異試験を当てたとき、既存の歯がすり抜けた分岐を、
 * それぞれの約束に当てて押さえる歯。1本ごとに、どの変異を捕まえるためのものかと
 * 約束の出所を書く。
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

/** `completeStructured` が schema に通した固定値を返す LLM。`beforeReturn` で割り込める。 */
function llmReturning(value: unknown, beforeReturn?: () => Promise<void>): LLMProvider {
  return {
    complete: async () => {
      throw new Error("not used");
    },
    completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> => {
      if (beforeReturn) await beforeReturn();
      return req.schema.parse(value) as T;
    },
  };
}

function buildRuntime(opts: {
  llm?: LLMProvider;
  embeddingProvider?: (base: EmbeddingProvider) => EmbeddingProvider;
  stores?: ReturnType<typeof createFakeRuntimeStores>;
}) {
  const stores = opts.stores ?? createFakeRuntimeStores();
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: opts.llm ?? llmReturning({}),
    embeddingProvider: opts.embeddingProvider
      ? opts.embeddingProvider(stores.embeddingProvider)
      : stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
    // Fake の outbox はジョブの availableAt を実時刻で付けるので、tick が claim できるよう
    // 実時計で動かす（半減期は10年なので、NOW 起点の記憶が減衰で落ちることはない）。
    clock: { now: () => new Date() },
  });
  return { runtime, stores };
}

describe("抽出：created イベントは実際に INSERT したときだけ", () => {
  // 変異 S02（`if (created)` → `if (true)`）を捕まえる。約束: docs/memory-model.md の
  // lifecycle 表・行2——`memories` への INSERT と `created` イベントが対になっている。
  // 冪等キー（観測・抽出器の版・内容）で既存の行が返っただけなら、INSERT は起きていない。
  it("deferred の抽出で、同じ冪等キーの Memory が既に在れば created イベントを積まない", async () => {
    const { runtime, stores } = buildRuntime({
      llm: llmReturning({ memories: [{ content: "既にある記憶", provenanceKind: "stated" }] }),
    });
    const observed = await runtime.observe(ctx, {
      kind: "utterance",
      text: "既にある記憶",
      extract: "deferred",
    });
    const existing = await stores.memoryStore.createMemory(
      ctx,
      newMemory({
        content: "既にある記憶",
        contentHash: "sha256(既にある記憶)",
        sourceObservationId: observed.observationId,
        extractorVersion: "v1",
      }),
    );

    const tick = await runtime.tick(ctx, { kinds: ["extract"], leaseMs: 60_000 });

    expect(tick.processed).toBe(1);
    const created = stores.eventStore.events.filter(
      (e) => e.memoryId === existing.id && e.kind === "created",
    );
    expect(created).toEqual([]);
  });
});

describe("tick の embed：埋め込みの最中に purge された記憶のベクトルは残さない", () => {
  // 変異 S16（書いた後の読み直しで purge 済みなら消す、を外す）を捕まえる。約束:
  // Issue #1035 / ADR 0124 決定5——purge が「内容の上書き → 埋め込みの削除」を終えた後に
  // purge 前の内容から作ったベクトルが書かれても、読み直して消す。
  it("embed の最中に forget と purge が完了しても、書いたベクトルは消える", async () => {
    // runtime と memoryId は、embed の割り込みより後で決まる——後から埋める入れ物に置く。
    const late: { runtime?: Runtime; memoryId?: string } = {};
    const built = buildRuntime({
      embeddingProvider: (base) => ({
        space: base.space,
        embed: async (c, texts) => {
          const vectors = await base.embed(c, texts);
          await late.runtime!.forget(ctx, { memoryId: late.memoryId! });
          await late.runtime!.purge(ctx, { memoryId: late.memoryId! });
          return vectors;
        },
      }),
    });
    const { runtime, stores } = built;
    late.runtime = runtime;
    const { memory } = await stores.memoryStore.createMemoryWithOutbox(ctx, newMemory(), ["embed"]);
    late.memoryId = memory.id;

    await runtime.tick(ctx, { kinds: ["embed"], leaseMs: 60_000 });

    expect((await stores.memoryStore.get(ctx, memory.id))?.purgedAt ?? null).not.toBeNull();
    const vectors = await stores.vectorStore.getVectors!(ctx, stores.embeddingProvider.space, [
      memory.id,
    ]);
    expect(vectors).toEqual([]);
  });
});

describe("consolidate / reflect の { seedMemoryId }：minAffinity ちょうどの近傍は残る", () => {
  // 変異 S31・S38（`>= minAffinity` → `>`）を捕まえる。約束: `runtime.ts` の
  // `ConsolidateTarget`/`Runtime.consolidate` の doc「`minAffinity` 未満の候補は落とす」
  // （reflect も同じ形）——ちょうど `minAffinity` の近傍は落ちない。
  async function seedAndNeighbor(stores: ReturnType<typeof createFakeRuntimeStores>) {
    const seed = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: "seed content", digest: "seed", embeddingStatus: "ready" }),
    );
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, seed.id, [4, 0]);
    // [8, 0] は [4, 0] と同じ向き ⟹ cosine similarity はちょうど 1。
    const neighbor = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: "neighbor content", digest: "nb", embeddingStatus: "ready" }),
    );
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, neighbor.id, [8, 0]);
    return { seed, neighbor };
  }

  it("consolidate：affinity がちょうど minAffinity(=1) の近傍は種と一緒に統合される", async () => {
    const { runtime, stores } = buildRuntime({ llm: llmReturning({ content: "統合後" }) });
    const { seed, neighbor } = await seedAndNeighbor(stores);

    const result = await runtime.consolidate(ctx, {
      target: { seedMemoryId: seed.id, minAffinity: 1 },
    });

    expect(result.outcome).toBe("consolidated");
    expect(result.sources.map((s) => s.memoryId)).toEqual([seed.id, neighbor.id]);
  });

  it("reflect：affinity がちょうど minAffinity(=1) の近傍は土台に入る", async () => {
    const { runtime, stores } = buildRuntime({
      llm: llmReturning({ outcome: "reflected", content: "気づき" }),
    });
    const { seed, neighbor } = await seedAndNeighbor(stores);

    const result = await runtime.reflect(ctx, {
      target: { seedMemoryId: seed.id, minAffinity: 1 },
    });

    expect(result.outcome).toBe("reflected");
    expect(result.basis.map((b) => b.memoryId)).toEqual([seed.id, neighbor.id]);
  });
});

describe("consolidate：統合元の書き込みが CAS で弾かれたら status_changed_concurrently", () => {
  // 変異 S37（`MemoryStatusConflictError` の扱いを外す）を捕まえる。約束: `runtime.ts` の
  // `ConsolidateSourceOutcome` の doc の `"status_changed_concurrently"`（ADR 0030 の安全弁3）と
  // docs/memory-model.md の lifecycle 表・行12の追記（CAS の破れで superseded にならなかった
  // id もある）。`supersedeWithNewMemories` を持たない adapter の2段の経路で起きる。
  it("LLM を呼んでいる間に統合元の1件が forget されると、その1件だけ status_changed_concurrently になる", async () => {
    const stores = createFakeRuntimeStores();
    (
      stores.memoryStore as { supersedeWithNewMemories?: MemoryStore["supersedeWithNewMemories"] }
    ).supersedeWithNewMemories = undefined;
    const late: { bId?: string } = {};
    const { runtime } = buildRuntime({
      stores,
      llm: llmReturning({ content: "統合後" }, async () => {
        await stores.memoryStore.updateStatus(ctx, late.bId!, "forgotten");
      }),
    });
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ content: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ content: "B" }));
    const c = await stores.memoryStore.createMemory(ctx, newMemory({ content: "C" }));
    late.bId = b.id;

    const result = await runtime.consolidate(ctx, { target: { memoryIds: [a.id, b.id, c.id] } });

    expect(result.outcome).toBe("consolidated");
    expect(result.sources).toEqual([
      { memoryId: a.id, kind: "superseded", previousStatus: "active" },
      { memoryId: b.id, kind: "status_changed_concurrently", observedStatus: "forgotten" },
      { memoryId: c.id, kind: "superseded", previousStatus: "active" },
    ]);
  });
});

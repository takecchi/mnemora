import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider, StructuredRequest } from "../interfaces/llm-provider.js";
import { defaultActivityDecayStrategy, defaultDecayStrategy } from "../strategies/decay.js";
import { DEFAULT_HALF_LIFE_RECALLS } from "../interfaces/tenant-settings-store.js";
import type { Memory, NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * [ADR 0394](../../../docs/decisions/0394-activity-clock-writes-use-memorys-own-subject.md)
 * （ADR 0353 の負債1の解消）: 書く側の活動時計の「いま」は、**対象の Memory 自身の
 * `subjectId`** の `T + S_x` で解く（`ctx.subjectId` ではなく）。
 *
 * 読む側（段1 SQL・段2・掃引）は行ごとに Memory 自身の `S_x` を足す。書く側が
 * `ctx.subjectId` の `S_x` を足すと、`ctx` と Memory の subject がずれる入力で、読む側の式と
 * 食い違う起点（`decayBaseSeq`/`decayFloorSeq`）が書かれる。ここではその「ずれ」を作る:
 *
 * - tick のように `subjectId` の無い ctx から、subject の記憶を作る・強化する。
 * - ctx=alice で bob の記憶を作る・強化する。
 * - subjectless の記憶を ctx=alice で作る・強化する。
 * - 制御: ctx と subject が一致する形。
 *
 * 数値は T=10・S_alice=7・S_bob=20 に固定する（有効ないま: alice=17, bob=30, subjectless=10。
 * どの組も違う値なので、取り違えた subject の値はそのまま assertion に現れる）。
 */

const TENANT = "tenant-1";
const tenantCtx: Ctx = { tenantId: TENANT };
const aliceCtx: Ctx = { tenantId: TENANT, subjectId: "alice" };
const NOW = new Date("2026-06-01T00:00:00.000Z");
const RECORDED_AT = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);
const HALF_LIFE_RECALLS = 100;
// 進められる時計（deferred の extract ジョブは、積んだ時刻より後でないと claim できない）。
let nowMs = NOW.getTime();

const T = 10;
const S_ALICE = 7;
const S_BOB = 20;
const NOW_ALICE = T + S_ALICE;
const NOW_BOB = T + S_BOB;
const NOW_NONE = T;

function floorFrom(baseSeq: number, halfLifeRecalls: number = HALF_LIFE_RECALLS): number {
  return defaultActivityDecayStrategy.floorAt({ baseSeq, strength: 1, halfLifeRecalls });
}

function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  return {
    tenantId: TENANT,
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
    recordedAt: RECORDED_AT,
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 24 * 365 * 10,
    decayFloorAt: defaultDecayStrategy.floorAt({
      recordedAt: RECORDED_AT,
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours: 24 * 365 * 10,
    }),
    embeddingStatus: "pending",
    // 活動時計を持つ記憶（強化が活動時計側に触れる条件）。起点は 0 の古い値。
    halfLifeRecalls: HALF_LIFE_RECALLS,
    decayBaseSeq: 0,
    decayFloorSeq: floorFrom(0),
    ...overrides,
  };
}

interface Candidate {
  content: string;
  provenanceKind: "stated" | "inferred";
  subjectId?: string | null;
}

function llmReturning(memories: Candidate[]): LLMProvider {
  return {
    complete: async () => {
      throw new Error("not used");
    },
    completeStructured: async <U>(_ctx: Ctx, req: StructuredRequest<U>): Promise<U> =>
      req.schema.parse({ memories }) as U,
  };
}

function llmConsolidatingTo(content: string): LLMProvider {
  return {
    complete: async () => {
      throw new Error("not used");
    },
    completeStructured: async <U>(_ctx: Ctx, req: StructuredRequest<U>): Promise<U> =>
      req.schema.parse({ content }) as U,
  };
}

function llmReflectingTo(content: string): LLMProvider {
  return {
    complete: async () => {
      throw new Error("not used");
    },
    completeStructured: async <U>(_ctx: Ctx, req: StructuredRequest<U>): Promise<U> =>
      req.schema.parse({ outcome: "reflected", content }) as U,
  };
}

const recallBase = {
  tenantId: TENANT,
  query: { text: "fixture" },
  budget: null,
  omitted: [],
  usage: {
    chars: 0,
    estimatedTokens: 0,
    counter: "heuristic" as const,
    byTier: { full: 0, digest: 0, index: 0 },
    indexChars: 0,
  },
  indexBand: { groups: [], totalInScope: 0, countKind: "exact" as const },
  explain: { stages: [] },
  returnedMemories: [],
};

/** 'activity' のテナントで T=10・S_alice=7・S_bob=20 にした runtime を作る。 */
async function setup(llmProvider: LLMProvider) {
  nowMs = NOW.getTime();
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
    clock: { now: () => new Date(nowMs) },
  });
  await stores.tenantSettingsStore.setDecayClock(tenantCtx, "activity");
  for (let i = 0; i < T; i += 1) {
    await stores.memoryStore.createRecall(tenantCtx, {
      ...recallBase,
      subjectId: null,
      advanceActivityClock: true,
    });
  }
  for (const [subjectId, n] of [
    ["alice", S_ALICE],
    ["bob", S_BOB],
  ] as const) {
    for (let i = 0; i < n; i += 1) {
      await stores.memoryStore.createRecall(tenantCtx, {
        ...recallBase,
        subjectId,
        advanceActivityClock: { scope: "subject", subjectId },
      });
    }
  }
  expect(await stores.tenantSettingsStore.getActivitySeq(tenantCtx)).toBe(T);
  return { runtime, stores };
}

/**
 * 起点（decayBaseSeq）と床（decayFloorSeq）を確かめる。`halfLifeRecalls` は、その記憶の半減期
 * （強化される記憶は fixture の値、新しく作られる記憶はテナントの既定値）。
 */
function expectOrigin(
  memory: Memory | null | undefined,
  nowSeq: number,
  halfLifeRecalls: number = HALF_LIFE_RECALLS,
): void {
  expect(memory?.decayBaseSeq).toBe(nowSeq);
  expect(memory?.decayFloorSeq).toBe(floorFrom(nowSeq, halfLifeRecalls));
}

/** 新しく作られる記憶（抽出・consolidate・reflect）の起点と床。半減期はテナントの既定値。 */
function expectCreatedOrigin(memory: Memory | null | undefined, nowSeq: number): void {
  expectOrigin(memory, nowSeq, DEFAULT_HALF_LIFE_RECALLS);
}

describe("作成（抽出）— 起点は記憶自身の subject の T + S_x（ADR 0394）", () => {
  it("制御: ctx=alice・候補が alice（省略）なら T + S_alice", async () => {
    const { runtime, stores } = await setup(
      llmReturning([{ content: "aliceの事実", provenanceKind: "stated" }]),
    );
    const result = await runtime.observe(aliceCtx, { kind: "utterance", text: "発話" });
    const memory = await stores.memoryStore.get(aliceCtx, result.memoryIds[0]!);
    expect(memory?.subjectId).toBe("alice");
    expectCreatedOrigin(memory, NOW_ALICE);
  });

  it("tick のように subjectId の無い ctx から、subject の記憶を作る（deferred 抽出）: 記憶は alice のもの → T + S_alice", async () => {
    const { runtime, stores } = await setup(
      llmReturning([{ content: "aliceの事実", provenanceKind: "stated" }]),
    );
    // 観測は alice の ctx で受け付け、抽出は subjectId の無い ctx の tick が行う。
    const { observationId } = await runtime.observe(aliceCtx, {
      kind: "utterance",
      text: "発話",
      extract: "deferred",
    });
    // 以前の Fake は outbox 行の availableAt を実時刻で付けたため、tick の時計を後にしている（今の Fake は `opts.now` に従う。ADR 0555。組み替えは「残り」）。
    nowMs = Date.now() + 60_000;
    const tick = await runtime.tick(tenantCtx, { kinds: ["extract"], leaseMs: 60_000 });
    expect(tick.processed).toBe(1);
    const memories = await stores.memoryStore.listBySourceObservation(
      tenantCtx,
      observationId,
      "v1",
    );
    expect(memories).toHaveLength(1);
    expect(memories[0]?.subjectId).toBe("alice");
    expectCreatedOrigin(memories[0], NOW_ALICE);
  });

  it("ctx=alice で bob の記憶を作る（LLM の candidate.subjectId が ctx と違う）: T + S_bob", async () => {
    const { runtime, stores } = await setup(
      llmReturning([{ content: "bobの事実", provenanceKind: "stated", subjectId: "bob" }]),
    );
    const result = await runtime.observe(aliceCtx, { kind: "utterance", text: "発話" });
    const memory = await stores.memoryStore.get(tenantCtx, result.memoryIds[0]!);
    expect(memory?.subjectId).toBe("bob");
    expectCreatedOrigin(memory, NOW_BOB);
  });

  it("ctx=alice で observe の input.subjectId=bob（ctx と違う）: T + S_bob", async () => {
    const { runtime, stores } = await setup(
      llmReturning([{ content: "bobの事実", provenanceKind: "stated" }]),
    );
    const result = await runtime.observe(aliceCtx, {
      kind: "utterance",
      text: "発話",
      subjectId: "bob",
    });
    const memory = await stores.memoryStore.get(tenantCtx, result.memoryIds[0]!);
    expect(memory?.subjectId).toBe("bob");
    expectCreatedOrigin(memory, NOW_BOB);
  });

  it("subjectless の記憶を ctx=alice で作る（candidate.subjectId=null）: T のみ", async () => {
    const { runtime, stores } = await setup(
      llmReturning([{ content: "主題なしの事実", provenanceKind: "stated", subjectId: null }]),
    );
    const result = await runtime.observe(aliceCtx, { kind: "utterance", text: "発話" });
    const memory = await stores.memoryStore.get(tenantCtx, result.memoryIds[0]!);
    expect(memory?.subjectId ?? null).toBeNull();
    expectCreatedOrigin(memory, NOW_NONE);
  });

  it("1回の observe から subject が違う候補が混ざっても、候補ごとに自身の subject の T + S_x", async () => {
    const { runtime, stores } = await setup(
      llmReturning([
        { content: "aliceの事実", provenanceKind: "stated" },
        { content: "bobの事実", provenanceKind: "stated", subjectId: "bob" },
        { content: "主題なしの事実", provenanceKind: "stated", subjectId: null },
      ]),
    );
    const result = await runtime.observe(aliceCtx, { kind: "utterance", text: "発話" });
    const bySubject = new Map<string | null, Memory>();
    for (const id of result.memoryIds) {
      const m = (await stores.memoryStore.get(tenantCtx, id))!;
      bySubject.set(m.subjectId ?? null, m);
    }
    expectCreatedOrigin(bySubject.get("alice"), NOW_ALICE);
    expectCreatedOrigin(bySubject.get("bob"), NOW_BOB);
    expectCreatedOrigin(bySubject.get(null), NOW_NONE);
  });

  it("reextract: subjectId の無い ctx から再抽出しても、新しい記憶は自身の subject の T + S_x", async () => {
    let content = "aliceの事実";
    const { runtime, stores } = await setup({
      complete: async () => {
        throw new Error("not used");
      },
      completeStructured: async <U>(_ctx: Ctx, req: StructuredRequest<U>): Promise<U> =>
        req.schema.parse({ memories: [{ content, provenanceKind: "stated" }] }) as U,
    });
    const first = await runtime.observe(aliceCtx, { kind: "utterance", text: "発話" });
    // 中身が違えば新しい行になる（同じ content_hash は冪等に既存の行を返すだけ）。
    content = "aliceの別の事実";
    const re = await runtime.reextract(tenantCtx, first.observationId);
    expect(re.memoryIds).toHaveLength(1);
    expect(re.memoryIds[0]).not.toBe(first.memoryIds[0]);
    const memory = await stores.memoryStore.get(tenantCtx, re.memoryIds[0]!);
    expect(memory?.subjectId).toBe("alice");
    expectCreatedOrigin(memory, NOW_ALICE);
  });

  it("'wall' のテナント（既定）では、subject がずれていても活動時計の3つ組は作られない", async () => {
    const stores = createFakeRuntimeStores();
    const runtime = createRuntime({
      memoryStore: stores.memoryStore,
      outboxStore: stores.outboxStore,
      vectorStore: stores.vectorStore,
      eventStore: stores.eventStore,
      tenantSettingsStore: stores.tenantSettingsStore,
      llmProvider: llmReturning([
        { content: "bobの事実", provenanceKind: "stated", subjectId: "bob" },
      ]),
      embeddingProvider: stores.embeddingProvider,
      hashContent: (content: string) => `sha256(${content})`,
      clock: { now: () => new Date(nowMs) },
    });
    const result = await runtime.observe(aliceCtx, { kind: "utterance", text: "発話" });
    const memory = await stores.memoryStore.get(tenantCtx, result.memoryIds[0]!);
    expect(memory?.decayBaseSeq ?? null).toBeNull();
    expect(memory?.decayFloorSeq ?? null).toBeNull();
    expect(memory?.halfLifeRecalls ?? null).toBeNull();
  });
});

describe("consolidate / reflect — 結果の subject（eligible が一致すればその値、割れれば null）の T + S_x", () => {
  async function twoMemories(
    stores: Awaited<ReturnType<typeof setup>>["stores"],
    subjects: [string | null, string | null],
  ) {
    const a = await stores.memoryStore.createMemory(
      tenantCtx,
      newMemory({ content: "A", subjectId: subjects[0] }),
    );
    const b = await stores.memoryStore.createMemory(
      tenantCtx,
      newMemory({ content: "B", subjectId: subjects[1] }),
    );
    return [a.id, b.id];
  }

  for (const op of ["consolidate", "reflect"] as const) {
    const llm = () =>
      op === "consolidate" ? llmConsolidatingTo("統合後") : llmReflectingTo("気づき");
    const run = async (
      runtime: Awaited<ReturnType<typeof setup>>["runtime"],
      ctx: Ctx,
      ids: string[],
    ): Promise<string> => {
      if (op === "consolidate") {
        const r = await runtime.consolidate(ctx, { target: { memoryIds: ids } });
        return r.consolidatedMemoryId!;
      }
      const r = await runtime.reflect(ctx, { target: { memoryIds: ids } });
      return r.reflectedMemoryId!;
    };

    it(`${op}: subjectId の無い ctx から alice の記憶を束ねる（{memoryIds} 形）→ T + S_alice`, async () => {
      const { runtime, stores } = await setup(llm());
      const ids = await twoMemories(stores, ["alice", "alice"]);
      const id = await run(runtime, tenantCtx, ids);
      const memory = await stores.memoryStore.get(tenantCtx, id);
      expect(memory?.subjectId).toBe("alice");
      expectCreatedOrigin(memory, NOW_ALICE);
    });

    it(`${op}: ctx=alice で bob の記憶を束ねる → T + S_bob`, async () => {
      const { runtime, stores } = await setup(llm());
      const ids = await twoMemories(stores, ["bob", "bob"]);
      const id = await run(runtime, aliceCtx, ids);
      const memory = await stores.memoryStore.get(tenantCtx, id);
      expect(memory?.subjectId).toBe("bob");
      expectCreatedOrigin(memory, NOW_BOB);
    });

    it(`${op}: subject が割れた（結果が subjectless）ものを ctx=alice で束ねる → T のみ`, async () => {
      const { runtime, stores } = await setup(llm());
      const ids = await twoMemories(stores, ["alice", "bob"]);
      const id = await run(runtime, aliceCtx, ids);
      const memory = await stores.memoryStore.get(tenantCtx, id);
      expect(memory?.subjectId ?? null).toBeNull();
      expectCreatedOrigin(memory, NOW_NONE);
    });

    it(`${op}: 制御 — ctx=alice で alice の記憶を束ねる → T + S_alice`, async () => {
      const { runtime, stores } = await setup(llm());
      const ids = await twoMemories(stores, ["alice", "alice"]);
      const id = await run(runtime, aliceCtx, ids);
      const memory = await stores.memoryStore.get(tenantCtx, id);
      expectCreatedOrigin(memory, NOW_ALICE);
    });
  }
});

describe("強化（使用報告・restoreArchived）— 起点は強化される記憶自身の subject の T + S_x", () => {
  const notUsedLlm = llmReturning([]);

  async function usageOf(
    stores: Awaited<ReturnType<typeof setup>>["stores"],
    runtime: Awaited<ReturnType<typeof setup>>["runtime"],
    ctx: Ctx,
    memoryIds: string[],
  ) {
    const recallId = await stores.memoryStore.createRecall(tenantCtx, {
      ...recallBase,
      subjectId: null,
    });
    await runtime.observe(ctx, {
      kind: "memory_usage",
      recallId,
      usedMemoryIds: memoryIds,
      externalId: `usage-${Math.random()}`,
    });
  }

  for (const [name, ctx, subject, expected] of [
    ["制御: ctx=alice で alice の記憶", aliceCtx, "alice", NOW_ALICE],
    ["tick のように subjectId の無い ctx から alice の記憶", tenantCtx, "alice", NOW_ALICE],
    ["ctx=alice で bob の記憶", aliceCtx, "bob", NOW_BOB],
    ["ctx=alice で subjectless の記憶", aliceCtx, null, NOW_NONE],
  ] as const) {
    it(`使用報告: ${name}`, async () => {
      const { runtime, stores } = await setup(notUsedLlm);
      const memory = await stores.memoryStore.createMemory(
        tenantCtx,
        newMemory({ subjectId: subject }),
      );
      await usageOf(stores, runtime, ctx, [memory.id]);
      const after = await stores.memoryStore.get(tenantCtx, memory.id);
      expect(after?.lastReinforcedAt).not.toBeNull();
      expectOrigin(after, expected);
    });
  }

  it("使用報告: 1回の報告に subject が違う記憶が混ざっても（reinforceMany は同じ opts を全件へ）、記憶ごとに自身の subject の T + S_x", async () => {
    const { runtime, stores } = await setup(notUsedLlm);
    const a = await stores.memoryStore.createMemory(tenantCtx, newMemory({ subjectId: "alice" }));
    const b = await stores.memoryStore.createMemory(tenantCtx, newMemory({ subjectId: "bob" }));
    const c = await stores.memoryStore.createMemory(tenantCtx, newMemory({ subjectId: null }));
    await usageOf(stores, runtime, aliceCtx, [a.id, b.id, c.id]);
    expectOrigin(await stores.memoryStore.get(tenantCtx, a.id), NOW_ALICE);
    expectOrigin(await stores.memoryStore.get(tenantCtx, b.id), NOW_BOB);
    expectOrigin(await stores.memoryStore.get(tenantCtx, c.id), NOW_NONE);
  });

  for (const [name, ctx, subject, expected] of [
    ["tick のように subjectId の無い ctx から alice の記憶", tenantCtx, "alice", NOW_ALICE],
    ["ctx=alice で bob の記憶", aliceCtx, "bob", NOW_BOB],
    ["ctx=alice で subjectless の記憶", aliceCtx, null, NOW_NONE],
  ] as const) {
    it(`restoreArchived: ${name}`, async () => {
      const { runtime, stores } = await setup(notUsedLlm);
      const memory = await stores.memoryStore.createMemory(
        tenantCtx,
        newMemory({ subjectId: subject, status: "archived" }),
      );
      const result = await runtime.restoreArchived(ctx, { memoryId: memory.id });
      expect(result.outcomes[0]?.kind).toBe("restored");
      expectOrigin(await stores.memoryStore.get(tenantCtx, memory.id), expected);
    });
  }

  it("restoreSuperseded: subjectId の無い ctx から、統合で superseded になった alice の記憶を復帰させると、群の全件が T + S_alice（reinforceMany）", async () => {
    const { runtime, stores } = await setup(llmConsolidatingTo("統合後"));
    const a = await stores.memoryStore.createMemory(tenantCtx, newMemory({ subjectId: "alice" }));
    const b = await stores.memoryStore.createMemory(tenantCtx, newMemory({ subjectId: "alice" }));
    const consolidated = await runtime.consolidate(aliceCtx, {
      target: { memoryIds: [a.id, b.id] },
    });
    expect((await stores.memoryStore.get(tenantCtx, a.id))?.status).toBe("superseded");

    const result = await runtime.restoreSuperseded(tenantCtx, {
      supersededById: consolidated.consolidatedMemoryId!,
    });

    expect(result.outcomes.map((o) => o.kind)).toEqual(["restored", "restored"]);
    expectOrigin(await stores.memoryStore.get(tenantCtx, a.id), NOW_ALICE);
    expectOrigin(await stores.memoryStore.get(tenantCtx, b.id), NOW_ALICE);
  });

  it("subject カウンタを一度も使っていないテナントでは、S_x を足す指示を store へ渡さない（プラン族を変えない）", async () => {
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
      clock: { now: () => new Date(nowMs) },
    });
    await stores.tenantSettingsStore.setDecayClock(tenantCtx, "activity");
    const captured: unknown[] = [];
    const original = stores.memoryStore.reinforceMany.bind(stores.memoryStore);
    stores.memoryStore.reinforceMany = async (...args) => {
      captured.push(args[3]);
      return original(...args);
    };
    const memory = await stores.memoryStore.createMemory(
      tenantCtx,
      newMemory({ subjectId: "alice" }),
    );
    await usageOf(stores, runtime, aliceCtx, [memory.id]);
    expect(captured).toEqual([{ nowSeq: 0 }]);
    expectOrigin(await stores.memoryStore.get(tenantCtx, memory.id), 0);
  });
});

describe("subject カウンタを一度も使っていないテナントでは、tenant_subject_activity を引かない（ADR 0353 決めたこと4）", () => {
  it("抽出は、subject 付きの記憶でも getSubjectActivitySeqs を呼ばず、起点は T のみ", async () => {
    const stores = createFakeRuntimeStores();
    const runtime = createRuntime({
      memoryStore: stores.memoryStore,
      outboxStore: stores.outboxStore,
      vectorStore: stores.vectorStore,
      eventStore: stores.eventStore,
      tenantSettingsStore: stores.tenantSettingsStore,
      llmProvider: llmReturning([
        { content: "aliceの事実", provenanceKind: "stated" },
        { content: "bobの事実", provenanceKind: "stated", subjectId: "bob" },
      ]),
      embeddingProvider: stores.embeddingProvider,
      hashContent: (content: string) => `sha256(${content})`,
      clock: { now: () => new Date(nowMs) },
    });
    await stores.tenantSettingsStore.setDecayClock(tenantCtx, "activity");
    let subjectReads = 0;
    const original = stores.tenantSettingsStore.getSubjectActivitySeqs.bind(
      stores.tenantSettingsStore,
    );
    stores.tenantSettingsStore.getSubjectActivitySeqs = async (...args) => {
      subjectReads += 1;
      return original(...args);
    };
    expect(await stores.tenantSettingsStore.hasSubjectActivityCounters(tenantCtx)).toBe(false);

    const result = await runtime.observe(aliceCtx, { kind: "utterance", text: "発話" });

    expect(result.memoryIds).toHaveLength(2);
    for (const id of result.memoryIds) {
      expectCreatedOrigin(await stores.memoryStore.get(tenantCtx, id), 0);
    }
    expect(subjectReads).toBe(0);
  });
});

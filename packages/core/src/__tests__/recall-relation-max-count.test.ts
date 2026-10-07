import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { NewMemory } from "../memory.js";
import type { MemoryId } from "../ids.js";
import type { RecallQuery } from "../recall.js";
import { RecallQuerySchema } from "../recall.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

const ctx: Ctx = { tenantId: "tenant-relation-max-count" };
const NOW = new Date("2026-06-01T00:00:00.000Z");

function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  const recordedAt = overrides.recordedAt ?? NOW;
  const strength = overrides.strength ?? 1;
  const halfLifeHours = overrides.halfLifeHours ?? 24 * 365 * 10;
  return {
    tenantId: "tenant-relation-max-count",
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

const notUsedLlm: LLMProvider = {
  complete: async () => {
    throw new Error("not used");
  },
  completeStructured: async () => {
    throw new Error("not used");
  },
};

/** 全員が互いに重なる、owner を含めて `size` 件の群を作り、owner だけを ANN で拾える状態にした runtime を返す。 */
async function buildGroup(size: number) {
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
  const ids: MemoryId[] = [];
  for (let i = 0; i < size; i++) {
    const m = await stores.memoryStore.createMemory(
      ctx,
      newMemory({
        digest: `m${String(i).padStart(3, "0")}`,
        validFrom: new Date(Date.UTC(2020, 0, 1 + i)),
        validUntil: null,
      }),
    );
    ids.push(m.id);
  }
  await runtime.markContestedGroup!(ctx, ids);
  await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, ids[0]!, [1, 0]);
  return { runtime, stores, ids };
}

async function recallGroup(size: number, extra: Partial<RecallQuery> = {}) {
  const { runtime, stores, ids } = await buildGroup(size);
  const result = await runtime.recall(ctx, { vector: [1, 0], ...extra });
  const companions = result.memories.filter((m) => m.retrievedVia === "mandatory_companion");
  const relationOverLimit = result.omitted.filter(
    (o) => o.kind === "over_limit" && o.stage === "relation",
  );
  return { result, companions, relationOverLimit, stores, ids };
}

describe("RecallQuery.relationMaxCount — 省略時は既定値10を明示した場合と1バイトも変わらない", () => {
  // ⚠ 同じ store・同じ群に対して2回 recall する。fake の id 採番は module 全体の連番で、
  // 別々に組み直すと id の桁数・辞書順が変わり、index 帯や usage.chars が id の長さ経由で
  // ずれる（この歯の見たいものではない）。recall は同じ状態を読むだけなので2回で足りる。
  for (const size of [3, 4, 11, 16, 30, 120]) {
    it(`群が${size}件: 省略と relationMaxCount: 10 で recall の結果（recallId 以外）が完全に同一`, async () => {
      const { runtime } = await buildGroup(size);
      const omitted = await runtime.recall(ctx, { vector: [1, 0] });
      const explicit = await runtime.recall(ctx, { vector: [1, 0], relationMaxCount: 10 });
      const { recallId: _a, ...omittedRest } = omitted;
      const { recallId: _b, ...explicitRest } = explicit;
      expect(explicitRest).toEqual(omittedRest);
    });
  }

  it("記録された recall の query には、省略なら欄が現れず、指定すれば指定した値がそのまま残る", async () => {
    const a = await recallGroup(4);
    const rec = await a.stores.memoryStore.getRecall(ctx, a.result.recallId);
    expect(rec?.query).not.toHaveProperty("relationMaxCount");

    const b = await recallGroup(4, { relationMaxCount: 3 });
    const rec2 = await b.stores.memoryStore.getRecall(ctx, b.result.recallId);
    expect(rec2?.query).toMatchObject({ relationMaxCount: 3 });
  });
});

describe("RecallQuery.relationMaxCount — 指定した値で同伴の件数と over_limit(relation) が動く", () => {
  it("省略: 10件 + over_limit 4（exact）", async () => {
    const { companions, relationOverLimit } = await recallGroup(15);
    expect(companions).toHaveLength(10);
    expect(relationOverLimit).toEqual([
      { kind: "over_limit", stage: "relation", count: 4, countKind: "exact" },
    ]);
  });

  it("relationMaxCount: 3 → 3件 + over_limit 11（exact）。残るのは validFrom の新しい順", async () => {
    const { companions, relationOverLimit, ids } = await recallGroup(15, { relationMaxCount: 3 });
    expect(companions).toHaveLength(3);
    expect(relationOverLimit).toEqual([
      { kind: "over_limit", stage: "relation", count: 11, countKind: "exact" },
    ]);
    expect(companions.map((c) => c.memoryId).sort()).toEqual([ids[14]!, ids[13]!, ids[12]!].sort());
  });

  it("relationMaxCount: 20（群より大きい）→ 打ち切りなし、over_limit は積まれない", async () => {
    const { companions, relationOverLimit } = await recallGroup(15, { relationMaxCount: 20 });
    expect(companions).toHaveLength(14);
    expect(relationOverLimit).toEqual([]);
  });

  it("relationMaxCount: 14（ちょうど）→ 打ち切りなし。13 → 1件切る", async () => {
    expect((await recallGroup(15, { relationMaxCount: 14 })).relationOverLimit).toEqual([]);
    expect((await recallGroup(15, { relationMaxCount: 13 })).relationOverLimit).toEqual([
      { kind: "over_limit", stage: "relation", count: 1, countKind: "exact" },
    ]);
  });
});

describe("RecallQuery.relationMaxCount — 探索の安全弁（訪れた数の上限）は欄の10倍に連動する", () => {
  it("省略: 群150件は100件で止まり lower_bound（今日どおり）", async () => {
    const { relationOverLimit } = await recallGroup(150);
    expect(relationOverLimit).toEqual([
      { kind: "over_limit", stage: "relation", count: 89, countKind: "lower_bound" },
    ]);
  });

  it("relationMaxCount: 20 → 安全弁は200件。群150件は尽きるまで辿り exact、切る件数は149-20", async () => {
    const { relationOverLimit, companions } = await recallGroup(150, { relationMaxCount: 20 });
    expect(companions).toHaveLength(20);
    expect(relationOverLimit).toEqual([
      { kind: "over_limit", stage: "relation", count: 129, countKind: "exact" },
    ]);
  });

  it("relationMaxCount: 3 → 安全弁は30件。群150件は30件で止まり lower_bound（切る件数は29-3）", async () => {
    const { relationOverLimit, companions } = await recallGroup(150, { relationMaxCount: 3 });
    expect(companions).toHaveLength(3);
    expect(relationOverLimit).toEqual([
      { kind: "over_limit", stage: "relation", count: 26, countKind: "lower_bound" },
    ]);
  });
});

describe("RecallQuery.relationMaxCount — 検証", () => {
  it("正の整数（1〜1000）だけを受ける", () => {
    for (const ok of [1, 10, 1000]) {
      expect(RecallQuerySchema.safeParse({ relationMaxCount: ok }).success).toBe(true);
    }
    for (const bad of [0, -1, 1.5, 1001, Number.NaN, "3"]) {
      expect(RecallQuerySchema.safeParse({ relationMaxCount: bad }).success).toBe(false);
    }
    expect(RecallQuerySchema.safeParse({}).success).toBe(true);
  });

  it("不正な値は recall() が ZodError で拒む", async () => {
    const { runtime } = await buildGroup(3);
    await expect(runtime.recall(ctx, { vector: [1, 0], relationMaxCount: 0 })).rejects.toThrow();
  });
});

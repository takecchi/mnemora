import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { Memory, NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * A・B は同一の vector にする: アンカー類似度を同値にして、decay 以外の差を残さない。
 * `strength` / `tagMatch` / `freshness` も A・B で完全に同条件にする。
 */

const T0 = new Date("2026-06-01T00:00:00.000Z");
const T1 = new Date("2026-06-05T00:00:00.000Z");
const T2 = new Date("2026-06-20T00:00:00.000Z");

const ctx: Ctx = { tenantId: "tenant-1" };

function buildRuntime() {
  const stores = createFakeRuntimeStores();
  let now = T0;
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    lexicalStore: stores.lexicalStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: {
      complete: async () => {
        throw new Error("not used");
      },
      completeStructured: async () => {
        throw new Error("not used");
      },
    },
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => now },
  });
  return {
    runtime,
    stores,
    setNow: (next: Date) => {
      now = next;
    },
  };
}

/** アンカーの半減期は長くする: 連想の起点の `total` が段2の閾値を割らないようにするため。 */
const ANCHOR_HALF_LIFE_HOURS = 24 * 365 * 10;

/** A・B の半減期は意図して短くする: T2 で decay にはっきり差を持たせるため（忘却ゲートを見る配置ではない）。 */
const USAGE_HALF_LIFE_HOURS = 150;

function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  const recordedAt = overrides.recordedAt ?? T0;
  const strength = overrides.strength ?? 1;
  const halfLifeHours = overrides.halfLifeHours ?? ANCHOR_HALF_LIFE_HOURS;
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
    embeddingStatus: "ready",
    ...overrides,
  };
}

async function createEmbeddedMemory(
  stores: ReturnType<typeof createFakeRuntimeStores>,
  vector: number[],
  overrides: Partial<NewMemory> = {},
): Promise<Memory> {
  const memory = await stores.memoryStore.createMemory(ctx, newMemory(overrides));
  await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, memory.id, vector);
  return memory;
}

const QUERY_VECTOR = [1, 0, 0];
const ANCHOR_VECTOR = [0.8, 0.6, 0];
const CANDIDATE_VECTOR = [0, 1, 0];

describe("recall() — 連想枠の席は、使用報告で decay が動くと順位が入れ替わる（Issue #402 順位軸）", () => {
  it("A だけ使用報告すると、maxCount:1 の席は A が取り、B は返らない", async () => {
    const { runtime, stores, setNow } = buildRuntime();

    const anchor = await createEmbeddedMemory(stores, ANCHOR_VECTOR, { digest: "アンカー" });
    // A を先に作る——「報告が無ければ作成順で席が決まる」対照条件（it 3）の前提を、
    // ここでも同じ順序で保つ。
    const a = await createEmbeddedMemory(stores, CANDIDATE_VECTOR, {
      digest: "A",
      halfLifeHours: USAGE_HALF_LIFE_HOURS,
    });
    const b = await createEmbeddedMemory(stores, CANDIDATE_VECTOR, {
      digest: "B",
      halfLifeHours: USAGE_HALF_LIFE_HOURS,
    });

    setNow(T1);
    const baseline = await runtime.recall(ctx, { vector: QUERY_VECTOR, limit: 10 });
    const report = await runtime.observe(ctx, {
      kind: "memory_usage",
      recallId: baseline.recallId,
      usedMemoryIds: [a.id],
    });
    expect(report.memoryIds).toEqual([a.id]);

    setNow(T2);

    const aAfter = await stores.memoryStore.get(ctx, a.id);
    const bAfter = await stores.memoryStore.get(ctx, b.id);
    expect(aAfter!.decayFloorAt.getTime()).toBeGreaterThan(T2.getTime());
    expect(bAfter!.decayFloorAt.getTime()).toBeGreaterThan(T2.getTime());

    const result = await runtime.recall(ctx, {
      vector: QUERY_VECTOR,
      association: { maxCount: 1, anchorCount: 1 },
    });

    const memoryIds = result.memories.map((m) => m.memoryId);
    expect(memoryIds).toContain(a.id);
    expect(memoryIds).not.toContain(b.id);

    const aEntry = result.memories.find((m) => m.memoryId === a.id);
    expect(aEntry?.retrievedVia).toBe("association");
    expect(aEntry?.associationOf).toBe(anchor.id);

    expect(result.omitted).toContainEqual({
      kind: "over_limit",
      stage: "association",
      count: 1,
      countKind: "exact",
    });
  });

  it("⭐ B だけ使用報告すると（器も作成順も同一）、席は B が取る——勝者が入れ替わる", async () => {
    const { runtime, stores, setNow } = buildRuntime();

    await createEmbeddedMemory(stores, ANCHOR_VECTOR, { digest: "アンカー" });
    const a = await createEmbeddedMemory(stores, CANDIDATE_VECTOR, {
      digest: "A",
      halfLifeHours: USAGE_HALF_LIFE_HOURS,
    });
    const b = await createEmbeddedMemory(stores, CANDIDATE_VECTOR, {
      digest: "B",
      halfLifeHours: USAGE_HALF_LIFE_HOURS,
    });

    setNow(T1);
    const baseline = await runtime.recall(ctx, { vector: QUERY_VECTOR, limit: 10 });
    const report = await runtime.observe(ctx, {
      kind: "memory_usage",
      recallId: baseline.recallId,
      usedMemoryIds: [b.id],
    });
    expect(report.memoryIds).toEqual([b.id]);

    setNow(T2);

    const aAfter = await stores.memoryStore.get(ctx, a.id);
    const bAfter = await stores.memoryStore.get(ctx, b.id);
    expect(aAfter!.decayFloorAt.getTime()).toBeGreaterThan(T2.getTime());
    expect(bAfter!.decayFloorAt.getTime()).toBeGreaterThan(T2.getTime());

    const result = await runtime.recall(ctx, {
      vector: QUERY_VECTOR,
      association: { maxCount: 1, anchorCount: 1 },
    });

    const memoryIds = result.memories.map((m) => m.memoryId);
    expect(memoryIds).toContain(b.id);
    expect(memoryIds).not.toContain(a.id);

    const bEntry = result.memories.find((m) => m.memoryId === b.id);
    expect(bEntry?.retrievedVia).toBe("association");
  });

  it("対照条件: どちらも使用報告しなければ、席は作成順（前置きの順）のまま——先に作った A が取る", async () => {
    const { runtime, stores, setNow } = buildRuntime();

    await createEmbeddedMemory(stores, ANCHOR_VECTOR, { digest: "アンカー" });
    const a = await createEmbeddedMemory(stores, CANDIDATE_VECTOR, {
      digest: "A",
      halfLifeHours: USAGE_HALF_LIFE_HOURS,
    });
    const b = await createEmbeddedMemory(stores, CANDIDATE_VECTOR, {
      digest: "B",
      halfLifeHours: USAGE_HALF_LIFE_HOURS,
    });

    setNow(T1);
    // ⛔ ここで `observe({ kind: 'memory_usage' })` を一切呼ばない——それがこの対照条件である。
    await runtime.recall(ctx, { vector: QUERY_VECTOR, limit: 10 });

    setNow(T2);

    const aAfter = await stores.memoryStore.get(ctx, a.id);
    const bAfter = await stores.memoryStore.get(ctx, b.id);
    expect(aAfter!.decayFloorAt.getTime()).toBeGreaterThan(T2.getTime());
    expect(bAfter!.decayFloorAt.getTime()).toBeGreaterThan(T2.getTime());

    const result = await runtime.recall(ctx, {
      vector: QUERY_VECTOR,
      association: { maxCount: 1, anchorCount: 1 },
    });

    const memoryIds = result.memories.map((m) => m.memoryId);
    expect(memoryIds).toContain(a.id);
    expect(memoryIds).not.toContain(b.id);
  });

  it("maxCount:2 で両方返るとき、報告した側（＝後から作った B）が前に並ぶ——並びが作成順ではないことまで測る", async () => {
    const { runtime, stores, setNow } = buildRuntime();

    await createEmbeddedMemory(stores, ANCHOR_VECTOR, { digest: "アンカー" });
    const a = await createEmbeddedMemory(stores, CANDIDATE_VECTOR, {
      digest: "A",
      halfLifeHours: USAGE_HALF_LIFE_HOURS,
    });
    const b = await createEmbeddedMemory(stores, CANDIDATE_VECTOR, {
      digest: "B",
      halfLifeHours: USAGE_HALF_LIFE_HOURS,
    });

    setNow(T1);
    const baseline = await runtime.recall(ctx, { vector: QUERY_VECTOR, limit: 10 });
    // 報告するのは後から作った B にする。A を報告すると、順位キーがアンカー類似度だけに退化していても
    // A が先に並んでしまい（挿入順と一致する）、変異を素通しする。
    await runtime.observe(ctx, {
      kind: "memory_usage",
      recallId: baseline.recallId,
      usedMemoryIds: [b.id],
    });

    setNow(T2);

    const aAfter = await stores.memoryStore.get(ctx, a.id);
    const bAfter = await stores.memoryStore.get(ctx, b.id);
    expect(aAfter!.decayFloorAt.getTime()).toBeGreaterThan(T2.getTime());
    expect(bAfter!.decayFloorAt.getTime()).toBeGreaterThan(T2.getTime());

    const result = await runtime.recall(ctx, {
      vector: QUERY_VECTOR,
      association: { maxCount: 2, anchorCount: 1 },
    });

    const memoryIds = result.memories.map((m) => m.memoryId);
    expect(memoryIds).toContain(a.id);
    expect(memoryIds).toContain(b.id);
    // ⚠ 段4/段5 を通った後の並びが連想枠内の順位をそのまま保つかは自明ではないため、
    // ここで現物として検算する。
    expect(memoryIds.indexOf(b.id)).toBeLessThan(memoryIds.indexOf(a.id));
  });
});

const NEAR_VECTOR = [0, 1, 0];
const FAR_VECTOR = [0, 0.5, Math.sqrt(0.75)];
/** 類似度の差を使う歯は、既定の `minSimilarity`（0.5）より低い候補を使うので、下げて渡す。 */
const LOW_MIN_SIMILARITY = 0.1;

type Spec = { digest: string; vector: number[]; overrides?: Partial<NewMemory> };

async function associationDigests(
  specs: [Spec, Spec],
  association: { maxCount: number; minSimilarity?: number },
  extra: { tags?: string[]; overFetchFactor?: number } = {},
): Promise<string[]> {
  const { runtime, stores, setNow } = buildRuntime();
  await createEmbeddedMemory(stores, ANCHOR_VECTOR, { digest: "アンカー" });
  for (const spec of specs) {
    await createEmbeddedMemory(stores, spec.vector, { digest: spec.digest, ...spec.overrides });
  }
  setNow(T2);
  const result = await runtime.recall(ctx, {
    vector: QUERY_VECTOR,
    association: { anchorCount: 1, ...association },
    ...extra,
  });
  return result.memories.filter((m) => m.retrievedVia === "association").map((m) => m.digest);
}

describe("recall() — 連想枠の席の順位キーは、アンカー類似度と decay・strength・freshness・tagMatch の積（Issue #402 / ADR 0246 決定1、#1793）", () => {
  it("近いが decay が少し低いほうが、遠いが decay の高いほうに勝つ（類似度も順位に効く。積であって decay だけではない）", async () => {
    // total は decay と freshness（同じ起点・同じ半減期）の両方を掛けるので decay² になる。
    // 積: A = 0.6 × 0.73² ≒ 0.32、B = 0.3 × 0.90² ≒ 0.24 ⟹ A。decay だけなら B、類似度だけなら A。
    const digests = await associationDigests(
      [
        { digest: "A", vector: NEAR_VECTOR, overrides: { halfLifeHours: 1000 } },
        { digest: "B", vector: FAR_VECTOR, overrides: { halfLifeHours: 3000 } },
      ],
      { maxCount: 1, minSimilarity: LOW_MIN_SIMILARITY },
    );
    expect(digests).toEqual(["A"]);
  });

  it("近いが decay がずっと低いほうは、遠いが decay の高いほうに負ける（類似度だけでは決まらない。対照）", async () => {
    // 積: A = 0.6 × 0.12 ≒ 0.07、B = 0.3 × 0.90 = 0.27 ⟹ B。類似度だけなら A。
    const digests = await associationDigests(
      [
        { digest: "A", vector: NEAR_VECTOR, overrides: { halfLifeHours: 150 } },
        { digest: "B", vector: FAR_VECTOR, overrides: { halfLifeHours: 3000 } },
      ],
      { maxCount: 1, minSimilarity: LOW_MIN_SIMILARITY },
    );
    expect(digests).toEqual(["B"]);
  });

  it("strength が高いほうが席を取る（先に作った A の strength が低く、後から作った B が高い）", async () => {
    const digests = await associationDigests(
      [
        { digest: "A", vector: NEAR_VECTOR, overrides: { strength: 0.5 } },
        { digest: "B", vector: NEAR_VECTOR, overrides: { strength: 1 } },
      ],
      { maxCount: 1 },
    );
    expect(digests).toEqual(["B"]);
  });

  it("freshness が高いほうが席を取る（出来事時刻が新しい B。recordedAt・decay は同じ）", async () => {
    const digests = await associationDigests(
      [
        {
          digest: "A",
          vector: NEAR_VECTOR,
          overrides: {
            halfLifeHours: 600,
            occurredAt: new Date(T0.getTime() - 2000 * 3_600_000),
          },
        },
        { digest: "B", vector: NEAR_VECTOR, overrides: { halfLifeHours: 600, occurredAt: T0 } },
      ],
      { maxCount: 1 },
    );
    expect(digests).toEqual(["B"]);
  });

  it("クエリのタグに当たる記憶が席を取る（tagMatch。先に作った A はタグ無し、後から作った B が一致）", async () => {
    const digests = await associationDigests(
      [
        { digest: "A", vector: NEAR_VECTOR },
        { digest: "B", vector: NEAR_VECTOR, overrides: { tags: ["x"] } },
      ],
      { maxCount: 1 },
      { tags: ["x"] },
    );
    expect(digests).toEqual(["B"]);
  });
});

describe("recall() — 連想枠の過取得の幅・同点の並び（ADR 0246 決定3・4、#1793）", () => {
  it("overFetchFactor が 1 未満でも、maxCount 件は返る（過取得の幅の下限は maxCount）", async () => {
    const digests = await associationDigests(
      [
        { digest: "A", vector: NEAR_VECTOR },
        { digest: "B", vector: NEAR_VECTOR },
      ],
      { maxCount: 2 },
      { overFetchFactor: 0.5 },
    );
    expect([...digests].sort()).toEqual(["A", "B"]);
  });

  it.each([
    ["A, B", false],
    ["B, A", true],
  ])(
    "順位キーが同点なら、adapter が返した順のまま席を埋める（adapter の返す順が %s のとき。memoryId では並べ直さない。ADR 0170）",
    async (_label, reversed) => {
      const { runtime, stores, setNow } = buildRuntime();
      const anchor = await createEmbeddedMemory(stores, ANCHOR_VECTOR, { digest: "アンカー" });
      await createEmbeddedMemory(stores, NEAR_VECTOR, { digest: "A" });
      await createEmbeddedMemory(stores, NEAR_VECTOR, { digest: "B" });
      // 連想用の search()（2本目以降）だけ、返す順を差し替える。類似度は同値のまま。
      const originalSearch = stores.vectorStore.search.bind(stores.vectorStore);
      let calls = 0;
      let firstId: string | undefined;
      stores.vectorStore.search = async (c, space, query, opts) => {
        calls += 1;
        const hits = await originalSearch(c, space, query, opts);
        if (calls === 1) return hits;
        const ordered = reversed ? [...hits].reverse() : hits;
        // アンカー自身も近傍に出る（後で除かれる）ので、候補の先頭は anchor を除いて数える。
        firstId = ordered.find((h) => h.memoryId !== anchor.id)?.memoryId;
        return ordered;
      };
      setNow(T2);
      const result = await runtime.recall(ctx, {
        vector: QUERY_VECTOR,
        association: { anchorCount: 1, maxCount: 1 },
      });
      const got = result.memories.filter((m) => m.retrievedVia === "association");
      expect(firstId).toBeDefined();
      expect(got.map((m) => m.memoryId)).toEqual([firstId]);
    },
  );
});

describe("recall() — over_limit(association) は席を競り負けた分だけを数える（ADR 0246 決定5、#1793）", () => {
  it("連想用 search() がゲートを剥がして減衰しきった記憶を混ぜても、その分は over_limit に入らない（二重計上しない）", async () => {
    const { runtime, stores, setNow } = buildRuntime();
    await createEmbeddedMemory(stores, ANCHOR_VECTOR, { digest: "アンカー" });
    await createEmbeddedMemory(stores, NEAR_VECTOR, { digest: "A" });
    await createEmbeddedMemory(stores, NEAR_VECTOR, { digest: "B" });
    // 減衰しきった記憶。連想用の search() が押し下げを無視すると候補に混ざり、後置の多層防御で落ちる。
    const dead = await createEmbeddedMemory(stores, NEAR_VECTOR, {
      digest: "D",
      decayFloorAt: new Date(T0.getTime() - 1_000),
    });
    const originalSearch = stores.vectorStore.search.bind(stores.vectorStore);
    let calls = 0;
    stores.vectorStore.search = async (c, space, query, opts) => {
      calls += 1;
      if (calls === 1) return originalSearch(c, space, query, opts);
      const {
        decayFloorAtAfter: _a,
        decayFloorSeqAfter: _b,
        decayFloorAnyAxis: _c,
        validAt: _d,
        ...stripped
      } = opts.filter;
      return originalSearch(c, space, query, { ...opts, filter: stripped });
    };
    setNow(T2);
    const result = await runtime.recall(ctx, {
      vector: QUERY_VECTOR,
      association: { anchorCount: 1, maxCount: 1 },
    });

    expect(result.memories.map((m) => m.memoryId)).not.toContain(dead.id);
    expect(result.memories.filter((m) => m.retrievedVia === "association")).toHaveLength(1);
    // 席を競り負けたのは候補2件（A・B）のうち1件。D は多層防御で落ちており、段5が
    // `filtered(decayed)` として数える——ここに足すと二重計上になる。
    const overLimit = result.omitted.filter(
      (o) => o.kind === "over_limit" && o.stage === "association",
    );
    expect(overLimit).toEqual([
      { kind: "over_limit", stage: "association", count: 1, countKind: "exact" },
    ]);
  });
});

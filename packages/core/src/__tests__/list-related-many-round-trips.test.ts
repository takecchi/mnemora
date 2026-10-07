import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider, StructuredRequest } from "../interfaces/llm-provider.js";
import type { MemoryStore } from "../interfaces/memory-store.js";
import type { Relation, RelationKind, RelationStore } from "../interfaces/relation-store.js";
import { ExtractionResultSchema } from "../extraction.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { NewMemory } from "../memory.js";
import type { MemoryId } from "../ids.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

const ctx: Ctx = { tenantId: "tenant-list-related-many" };
const NOW = new Date("2026-06-01T00:00:00.000Z");
const ADDRESS_CLAIM_KEY = { subject: "user", predicate: "address" };

function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  const recordedAt = overrides.recordedAt ?? NOW;
  const strength = overrides.strength ?? 1;
  const halfLifeHours = overrides.halfLifeHours ?? 24 * 365 * 10;
  return {
    tenantId: ctx.tenantId,
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

/**
 * 中身の `RelationStore`（Fake）を包み、呼び出しを数える。`withMany: true` のときだけ
 * `listRelatedMany` を持つ（持たないときは**プロパティ自体が無い**——`Runtime` の分岐は
 * `listRelatedMany !== undefined` で決まる）。
 */
class SpyRelationStore implements RelationStore {
  listRelatedCalls: MemoryId[] = [];
  listRelatedManyCalls: MemoryId[][] = [];
  listRelatedMany?: (
    ctx: Ctx,
    memoryIds: readonly MemoryId[],
    kind?: RelationKind,
  ) => Promise<Relation[][]>;

  constructor(
    private readonly inner: RelationStore,
    withMany: boolean,
  ) {
    if (withMany) {
      this.listRelatedMany = async (c, memoryIds, kind) => {
        this.listRelatedManyCalls.push([...memoryIds]);
        // 中身の `listRelated` を直に呼ぶ（この spy の `listRelated` の回数には数えない）。
        return Promise.all(memoryIds.map((id) => this.inner.listRelated(c, id, kind)));
      };
    }
  }

  link(c: Ctx, kind: RelationKind, fromId: MemoryId, toId: MemoryId): Promise<void> {
    return this.inner.link(c, kind, fromId, toId);
  }
  unlink(c: Ctx, kind: RelationKind, fromId: MemoryId, toId: MemoryId): Promise<void> {
    return this.inner.unlink(c, kind, fromId, toId);
  }
  listRelated(c: Ctx, memoryId: MemoryId, kind?: RelationKind): Promise<Relation[]> {
    this.listRelatedCalls.push(memoryId);
    return this.inner.listRelated(c, memoryId, kind);
  }
  reset(): void {
    this.listRelatedCalls = [];
    this.listRelatedManyCalls = [];
  }
}

const notUsedLlm: LLMProvider = {
  complete: async () => {
    throw new Error("not used");
  },
  completeStructured: async () => {
    throw new Error("not used");
  },
};

/** 抽出には発話をそのまま1件返し、claim key の導出にはいつも同じ鍵を返す偽の LLM。 */
function sameKeyLlm(contents: string[]): LLMProvider {
  let next = 0;
  return {
    complete: async () => {
      throw new Error("not used");
    },
    completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> => {
      if ((req.schema as unknown) === ExtractionResultSchema) {
        const content = contents[next++]!;
        return req.schema.parse({ memories: [{ content, provenanceKind: "stated" }] });
      }
      return req.schema.parse({ claims: [ADDRESS_CLAIM_KEY] });
    },
  };
}

/** 同じデータ（`stores`）に、`listRelatedMany` がある／無い2つの Runtime を載せる。 */
function buildRuntimes(
  llm: LLMProvider = notUsedLlm,
  wrapMemoryStore: (inner: MemoryStore) => MemoryStore = (inner) => inner,
) {
  const stores = createFakeRuntimeStores();
  const make = (withMany: boolean) => {
    const spy = new SpyRelationStore(stores.relationStore, withMany);
    const runtime = createRuntime({
      memoryStore: wrapMemoryStore(stores.memoryStore),
      outboxStore: stores.outboxStore,
      vectorStore: stores.vectorStore,
      eventStore: stores.eventStore,
      tenantSettingsStore: stores.tenantSettingsStore,
      llmProvider: llm,
      embeddingProvider: stores.embeddingProvider,
      hashContent: (content: string) => `sha256(${content})`,
      clock: { now: () => NOW },
      relationStore: spy,
    });
    return { runtime, spy };
  };
  return { stores, withMany: make(true), withoutMany: make(false) };
}

type Stores = ReturnType<typeof createFakeRuntimeStores>;

async function contested(stores: Stores, digest: string, overrides: Partial<NewMemory> = {}) {
  return stores.memoryStore.createMemory(
    ctx,
    newMemory({ digest, status: "contested", ...overrides }),
  );
}

async function link2(stores: Stores, x: MemoryId, y: MemoryId) {
  await stores.relationStore.link(ctx, "contradicts", x, y);
  await stores.relationStore.link(ctx, "contradicts", y, x);
}

/** owner と n 個の葉。葉どうしはつながない（owner だけがつながる星）。 */
async function buildStar(stores: Stores, leaves: number) {
  const owner = await contested(stores, "owner");
  const ids: MemoryId[] = [];
  for (let i = 0; i < leaves; i++) {
    const leaf = await contested(stores, `leaf${i}`);
    await link2(stores, owner.id, leaf.id);
    ids.push(leaf.id);
  }
  await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, owner.id, [1, 0]);
  return { owner: owner.id, leaves: ids };
}

/** m0 - m1 - ... - m(n-1) の鎖。先頭だけが候補生成で見つかる。 */
async function buildChain(stores: Stores, n: number) {
  const ids: MemoryId[] = [];
  for (let i = 0; i < n; i++) {
    ids.push((await contested(stores, `m${i}`)).id);
  }
  for (let i = 0; i + 1 < n; i++) await link2(stores, ids[i]!, ids[i + 1]!);
  await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, ids[0]!, [1, 0]);
  return ids;
}

/** 完全グラフ（`markContestedGroup` が張る形）。先頭だけが候補生成で見つかる。 */
async function buildComplete(
  stores: Stores,
  runtime: ReturnType<typeof createRuntime>,
  n: number,
): Promise<MemoryId[]> {
  const ids: MemoryId[] = [];
  for (let i = 0; i < n; i++) {
    ids.push(
      (await stores.memoryStore.createMemory(ctx, newMemory({ digest: `k${i}`, validFrom: null })))
        .id,
    );
  }
  await runtime.markContestedGroup!(ctx, ids);
  await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, ids[0]!, [1, 0]);
  return ids;
}

/** owner - 子 c(i) - 孫 g(i)。安全弁（既定100）が子の処理の途中で効く形にできる。 */
async function buildTwoHop(stores: Stores, children: number) {
  const owner = await contested(stores, "owner");
  for (let i = 0; i < children; i++) {
    const c = await contested(stores, `c${i}`, {
      validFrom: new Date(Date.UTC(2020, 0, 1 + i)),
      validUntil: null,
    });
    const g = await contested(stores, `g${i}`, {
      validFrom: new Date(Date.UTC(2021, 0, 1 + i)),
      validUntil: null,
    });
    await link2(stores, owner.id, c.id);
    await link2(stores, c.id, g.id);
  }
  await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, owner.id, [1, 0]);
  return owner.id;
}

/**
 * 菱形: O が起点、O-B・O-C・B-D・C-D。D へは B からも C からも同じ段で届く。関係を張る順を入れ替えて、
 * `listRelated`／`listRelatedMany` の返す順が変わっても D の発見元が変わらないことを見るための形。
 */
async function buildDiamond(stores: Stores, reversed: boolean) {
  const o = await contested(stores, "O");
  const b = await contested(stores, "B");
  const c = await contested(stores, "C");
  const d = await contested(stores, "D");
  const [first, second] = reversed ? [c, b] : [b, c];
  await link2(stores, o.id, first.id);
  await link2(stores, o.id, second.id);
  await link2(stores, first.id, d.id);
  await link2(stores, second.id, d.id);
  await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, o.id, [1, 0]);
  return { o: o.id, b: b.id, c: c.id, d: d.id };
}

/**
 * `getMany` の返す順を id の降順にする包み。`MemoryStore.getMany` の返す順は契約が規定しない
 * （Postgres は順序なし）ので、Runtime が自前で整列していることを見るための偽物。
 */
function descendingGetMany(inner: MemoryStore): MemoryStore {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (prop === "getMany" && typeof value === "function") {
        return async (...args: unknown[]) => {
          const found = (await (value as (...a: unknown[]) => Promise<Array<{ id: string }>>).apply(
            target,
            args,
          )) as Array<{ id: string }>;
          return [...found].sort((x, y) => (x.id < y.id ? 1 : x.id > y.id ? -1 : 0));
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** 入力と長さの違う結果を返す `listRelatedMany`（adapter の契約違反）。 */
const wrongLengthMany = {
  短い: (ids: readonly MemoryId[]): Relation[][] => ids.slice(1).map(() => []),
  長い: (ids: readonly MemoryId[]): Relation[][] => [...ids, ...ids].map(() => []),
};

/** 結果の比較用: 提示順・発見元・省略・段の説明。 */
function shape(result: Awaited<ReturnType<ReturnType<typeof createRuntime>["recall"]>>) {
  return {
    memories: result.memories.map((m) => [m.memoryId, m.retrievedVia, m.companionOf ?? null]),
    omitted: result.omitted,
    stages: result.explain.stages,
  };
}

describe("recall 段3: listRelatedMany があると、1段1往復になる", () => {
  it("星（owner + 6 葉）: listRelatedMany 2回（owner の段・葉の段）、listRelated 0回", async () => {
    const { stores, withMany } = buildRuntimes();
    await buildStar(stores, 6);

    const result = await withMany.runtime.recall(ctx, { vector: [1, 0] });

    expect(result.memories.filter((m) => m.retrievedVia === "mandatory_companion")).toHaveLength(6);
    expect(withMany.spy.listRelatedCalls).toEqual([]);
    expect(withMany.spy.listRelatedManyCalls.map((c) => c.length)).toEqual([1, 6]);
  });

  it("完全グラフ（6件）: listRelatedMany 2回、listRelated 0回", async () => {
    const { stores, withMany } = buildRuntimes();
    await buildComplete(stores, withMany.runtime, 6);

    await withMany.runtime.recall(ctx, { vector: [1, 0] });

    expect(withMany.spy.listRelatedCalls).toEqual([]);
    expect(withMany.spy.listRelatedManyCalls.map((c) => c.length)).toEqual([1, 5]);
  });

  it("鎖（5件）: 1段1件なので listRelatedMany は5回（段数）、listRelated 0回", async () => {
    const { stores, withMany } = buildRuntimes();
    await buildChain(stores, 5);

    await withMany.runtime.recall(ctx, { vector: [1, 0] });

    expect(withMany.spy.listRelatedCalls).toEqual([]);
    expect(withMany.spy.listRelatedManyCalls.map((c) => c.length)).toEqual([1, 1, 1, 1, 1]);
  });

  it("frontier は id の昇順で渡す（companionOf を id の小さい親に決める規則をそのまま保つ）", async () => {
    const { stores, withMany } = buildRuntimes();
    await buildStar(stores, 6);

    await withMany.runtime.recall(ctx, { vector: [1, 0] });

    const level1 = withMany.spy.listRelatedManyCalls[1]!;
    expect(level1).toEqual([...level1].sort());
  });
});

describe("recall 段3: listRelatedMany が無い store では今と同じ（起点ごとに直列）", () => {
  it("星（owner + 6 葉）: listRelated 7回（owner と葉6）、listRelatedMany は持たない", async () => {
    const { stores, withoutMany } = buildRuntimes();
    const { owner } = await buildStar(stores, 6);

    await withoutMany.runtime.recall(ctx, { vector: [1, 0] });

    expect(withoutMany.spy.listRelatedMany).toBeUndefined();
    expect(withoutMany.spy.listRelatedCalls).toHaveLength(7);
    expect(withoutMany.spy.listRelatedCalls[0]).toBe(owner);
  });

  it("安全弁で打ち切った後は listRelated を呼ばない（1件ごとに確かめる今の規則）", async () => {
    const { stores, withoutMany } = buildRuntimes();
    await buildStar(stores, 150);

    await withoutMany.runtime.recall(ctx, { vector: [1, 0] });

    expect(withoutMany.spy.listRelatedCalls).toHaveLength(1);
  });
});

describe("recall 段3: listRelatedMany があるときと無いときで結果が完全に一致する", () => {
  const scenarios: Array<
    [string, (stores: Stores, rt: ReturnType<typeof createRuntime>) => Promise<void>, object]
  > = [
    ["星 6", async (s) => void (await buildStar(s, 6)), {}],
    [
      "星 150（安全弁 100 で owner の段の途中で止まる）",
      async (s) => void (await buildStar(s, 150)),
      {},
    ],
    ["鎖 12", async (s) => void (await buildChain(s, 12)), {}],
    ["鎖 130（安全弁で止まる）", async (s) => void (await buildChain(s, 130)), {}],
    ["完全 30", async (s, rt) => void (await buildComplete(s, rt, 30)), {}],
    ["完全 101（安全弁で止まる）", async (s, rt) => void (await buildComplete(s, rt, 101)), {}],
    ["子孫 30（121件にならない。exact）", async (s) => void (await buildTwoHop(s, 30)), {}],
    [
      "子孫 60（子の段の途中で安全弁が効く。辺の記録の位置も同じ）",
      async (s) => void (await buildTwoHop(s, 60)),
      {},
    ],
    [
      "relationMaxCount=5 で子孫 30（安全弁 50 が子の段の途中で効く）",
      async (s) => void (await buildTwoHop(s, 30)),
      { relationMaxCount: 5 },
    ],
  ];
  it.each(scenarios)("%s", async (_name, build, extra) => {
    const { stores, withMany, withoutMany } = buildRuntimes();
    await build(stores, withMany.runtime);

    const a = await withMany.runtime.recall(ctx, { vector: [1, 0], ...extra });
    const b = await withoutMany.runtime.recall(ctx, { vector: [1, 0], ...extra });

    expect(withMany.spy.listRelatedManyCalls.length).toBeGreaterThan(0);
    expect(withoutMany.spy.listRelatedCalls.length).toBeGreaterThan(0);
    expect(shape(a)).toEqual(shape(b));
    // 打ち切りの位置が observable な前提の確認: 安全弁に当たる形では lower_bound が出る。
    if (/安全弁/.test(_name)) {
      expect(JSON.stringify(a.omitted)).toContain("lower_bound");
    }
  });
});

describe("recall 段3: listRelatedMany の返す順に依らず、companionOf は同じ段の id の小さい親に決まる", () => {
  it.each([false, true])(
    "菱形（逆順に張る=%s）: listRelatedMany 経由でも D の companionOf は B と C のうち id の小さいほう",
    async (reversed) => {
      const { stores, withMany, withoutMany } = buildRuntimes();
      const { b, c, d } = await buildDiamond(stores, reversed);

      const a = await withMany.runtime.recall(ctx, { vector: [1, 0] });
      const s = await withoutMany.runtime.recall(ctx, { vector: [1, 0] });

      expect(withMany.spy.listRelatedManyCalls.length).toBeGreaterThan(0);
      const smaller = b < c ? b : c;
      expect(a.memories.find((m) => m.memoryId === d)?.companionOf).toBe(smaller);
      expect(shape(a)).toEqual(shape(s));
    },
  );
});

describe("recall 段3: getMany の返す順が降順の store でも、companionOf は同じ段の id の小さい親に決まる", () => {
  it.each([false, true])(
    "菱形（逆順に張る=%s）: 次の frontier を Runtime が id 昇順に整列し直すので、D の発見元は id の小さいほう",
    async (reversed) => {
      const { stores, withMany, withoutMany } = buildRuntimes(notUsedLlm, descendingGetMany);
      const { b, c, d } = await buildDiamond(stores, reversed);

      const a = await withMany.runtime.recall(ctx, { vector: [1, 0] });
      const s = await withoutMany.runtime.recall(ctx, { vector: [1, 0] });

      expect(withMany.spy.listRelatedManyCalls.length).toBeGreaterThan(0);
      const smaller = b < c ? b : c;
      expect(a.memories.find((m) => m.memoryId === d)?.companionOf).toBe(smaller);
      expect(s.memories.find((m) => m.memoryId === d)?.companionOf).toBe(smaller);
    },
  );
});

describe("recall 段3: 安全弁で止まった後は、listRelatedMany をもう撃たない", () => {
  it("星 150（owner の段の途中で止まる）: listRelatedMany は owner の1回だけ（葉の段へ進まない）", async () => {
    const { stores, withMany, withoutMany } = buildRuntimes();
    await buildStar(stores, 150);

    await withMany.runtime.recall(ctx, { vector: [1, 0] });
    await withoutMany.runtime.recall(ctx, { vector: [1, 0] });

    expect(withMany.spy.listRelatedManyCalls.map((c) => c.length)).toEqual([1]);
    expect(withMany.spy.listRelatedCalls).toEqual([]);
    expect(withoutMany.spy.listRelatedCalls).toHaveLength(1);
  });

  it("鎖 130（100件目で止まる）: listRelatedMany の回数は、無いときの listRelated の回数と同じ", async () => {
    const { stores, withMany, withoutMany } = buildRuntimes();
    await buildChain(stores, 130);

    await withMany.runtime.recall(ctx, { vector: [1, 0] });
    await withoutMany.runtime.recall(ctx, { vector: [1, 0] });

    expect(withMany.spy.listRelatedManyCalls.length).toBeGreaterThan(1);
    expect(withMany.spy.listRelatedManyCalls.length).toBe(withoutMany.spy.listRelatedCalls.length);
    expect(withMany.spy.listRelatedCalls).toEqual([]);
  });

  it("子孫 60（子の段の途中で止まる）: listRelatedMany は owner の段・子の段の2回だけ", async () => {
    const { stores, withMany } = buildRuntimes();
    await buildTwoHop(stores, 60);

    await withMany.runtime.recall(ctx, { vector: [1, 0] });

    expect(withMany.spy.listRelatedManyCalls.map((c) => c.length)).toEqual([1, 60]);
  });
});

describe("listRelatedMany が入力と違う長さを返したら、位置をずらさず例外にする（adapter の契約違反）", () => {
  const lengths = Object.entries(wrongLengthMany);

  it.each(lengths)("recall 段3（%s配列）", async (_name, wrong) => {
    const { stores, withMany } = buildRuntimes();
    await buildStar(stores, 6);
    withMany.spy.listRelatedMany = async (_c, ids) => wrong(ids);

    await expect(withMany.runtime.recall(ctx, { vector: [1, 0] })).rejects.toThrow(
      /listRelatedMany returned \d+ results for 1 ids/,
    );
  });

  it.each(lengths)("resolveContestedGroup の部分解消の確認（%s配列）", async (_name, wrong) => {
    const { stores, withMany } = buildRuntimes();
    const ids = await buildComplete(stores, withMany.runtime, 6);
    withMany.spy.listRelatedMany = async (_c, many) => wrong(many);

    await expect(
      withMany.runtime.resolveContestedGroup!(ctx, ids, { kind: "both_active" }),
    ).rejects.toThrow(/listRelatedMany returned \d+ results for 6 ids/);
  });
});

describe("resolveContestedGroup: listRelatedMany があると、部分解消の確認が1段1往復になる", () => {
  it("完全グラフ 6件を全員渡して解消: 確認は listRelatedMany 1回（全員を1度に）、listRelated 0回", async () => {
    const { stores, withMany } = buildRuntimes();
    const ids = await buildComplete(stores, withMany.runtime, 6);
    withMany.spy.reset();

    const result = await withMany.runtime.resolveContestedGroup!(ctx, ids, { kind: "both_active" });

    expect(result.outcome.kind).toBe("resolved");
    expect(withMany.spy.listRelatedCalls).toEqual([]);
    expect(withMany.spy.listRelatedManyCalls).toHaveLength(1);
    expect(withMany.spy.listRelatedManyCalls[0]).toEqual(ids);
  });

  it("星（owner + 5 葉）の3件だけを渡す: 2段（渡した3件・見つけた3件）、missingMembers は今と同じ", async () => {
    const { stores, withMany, withoutMany } = buildRuntimes();
    const { owner, leaves } = await buildStar(stores, 5);
    const partial = [owner, leaves[0]!, leaves[1]!];
    withMany.spy.reset();

    const a = await withMany.runtime.resolveContestedGroup!(ctx, partial, { kind: "both_active" });
    const b = await withoutMany.runtime.resolveContestedGroup!(ctx, partial, {
      kind: "both_active",
    });

    expect(withMany.spy.listRelatedCalls).toEqual([]);
    expect(withMany.spy.listRelatedManyCalls.map((c) => c.length)).toEqual([3, 3]);
    expect(withoutMany.spy.listRelatedCalls).toHaveLength(6);
    expect(a.outcome.kind).toBe("ineligible");
    expect(a).toEqual(b);
    if (a.outcome.kind === "ineligible") {
      expect(a.outcome.missingMembers).toEqual(leaves.slice(2));
    }
  });

  it("鎖（6件）の先頭3件を渡す: 段は 3件 → 1件 → 1件 → 1件、missingMembers は今と同じ", async () => {
    const { stores, withMany, withoutMany } = buildRuntimes();
    const ids = await buildChain(stores, 6);
    const partial = ids.slice(0, 3);
    withMany.spy.reset();

    const a = await withMany.runtime.resolveContestedGroup!(ctx, partial, { kind: "both_active" });
    const b = await withoutMany.runtime.resolveContestedGroup!(ctx, partial, {
      kind: "both_active",
    });

    expect(withMany.spy.listRelatedManyCalls.map((c) => c.length)).toEqual([3, 1, 1, 1]);
    expect(a).toEqual(b);
    if (a.outcome.kind === "ineligible") {
      expect(a.outcome.missingMembers).toEqual(ids.slice(3));
    }
  });
});

describe("resolveContestedGroup: listRelatedMany が無い store では今と同じ", () => {
  it("完全グラフ 6件を全員渡して解消: listRelated 6回（渡した順に1件ずつ）", async () => {
    const { stores, withMany, withoutMany } = buildRuntimes();
    const ids = await buildComplete(stores, withMany.runtime, 6);
    withoutMany.spy.reset();

    const result = await withoutMany.runtime.resolveContestedGroup!(ctx, ids, {
      kind: "both_active",
    });

    expect(result.outcome.kind).toBe("resolved");
    expect(withoutMany.spy.listRelatedCalls).toEqual(ids);
  });
});

describe("claim key の群の検出: listRelatedMany があると、合併の探索が1段1往復になる", () => {
  /** 既存の2群（各3件）を作り、両方と重なる新しい記憶を observe する（合併の歯と同じ形）。 */
  async function mergeTwoGroups(
    withMany: boolean,
    wrong?: (ids: readonly MemoryId[]) => Relation[][],
  ) {
    const { stores, withMany: m, withoutMany: n } = buildRuntimes(sameKeyLlm(["新しい記憶"]));
    const target = withMany ? m : n;
    const mk = (digest: string, from: string, until: string) =>
      stores.memoryStore.createMemory(
        ctx,
        newMemory({
          digest,
          claimKey: ADDRESS_CLAIM_KEY,
          validFrom: new Date(from),
          validUntil: new Date(until),
        }),
      );
    const g1 = [
      await mk("g1a", "2019-01-01T00:00:00Z", "2026-01-01T00:00:00Z"),
      await mk("g1b", "2019-01-01T00:00:00Z", "2019-06-01T00:00:00Z"),
      await mk("g1c", "2023-01-01T00:00:00Z", "2023-06-01T00:00:00Z"),
    ];
    await target.runtime.markContestedGroup!(
      ctx,
      g1.map((x) => x.id),
    );
    const g2 = [
      await mk("g2a", "2024-06-01T00:00:00Z", "2028-01-01T00:00:00Z"),
      await mk("g2b", "2024-06-01T00:00:00Z", "2024-07-01T00:00:00Z"),
      await mk("g2c", "2027-01-01T00:00:00Z", "2027-06-01T00:00:00Z"),
    ];
    await target.runtime.markContestedGroup!(
      ctx,
      g2.map((x) => x.id),
    );
    target.spy.reset();
    // 契約違反の adapter（長さの違う結果を返す）に差し替える。群を作った後なので、検出の探索だけが影響を受ける。
    if (wrong !== undefined) target.spy.listRelatedMany = async (_c, many) => wrong(many);
    const triggering = await target.runtime.observe(ctx, {
      kind: "utterance",
      text: "新しい記憶",
      claimKey: { enabled: true, detectContested: true },
      validFrom: new Date("2025-01-01T00:00:00Z"),
      validUntil: new Date("2025-02-01T00:00:00Z"),
    });
    const labels = new Map<string, string>([
      ...[...g1, ...g2].map((x) => [x.id, x.digest] as [string, string]),
      [triggering.memoryIds[0]!, "new"],
    ]);
    const detection = triggering.contestedDetection![0]!;
    const memberLabels =
      detection.result.kind === "contested_group"
        ? detection.result.memberIds.map((id) => labels.get(id)!)
        : [];
    return { spy: target.spy, kind: detection.result.kind, memberLabels };
  }

  it("2群の合併: 段は 2件（g1a・g2a）→ 4件（残りの4件）の2回、listRelated 0回", async () => {
    const { spy, kind } = await mergeTwoGroups(true);

    expect(kind).toBe("contested_group");
    expect(spy.listRelatedCalls).toEqual([]);
    expect(spy.listRelatedManyCalls.map((c) => c.length)).toEqual([2, 4]);
  });

  it.each(Object.entries(wrongLengthMany))(
    "listRelatedMany が入力と違う長さ（%s配列）を返したら、位置をずらさず例外にする",
    async (_name, wrong) => {
      await expect(mergeTwoGroups(true, wrong)).rejects.toThrow(
        /listRelatedMany returned \d+ results for 2 ids/,
      );
    },
  );

  it("listRelatedMany が無い store では今と同じ: 6回、群のメンバーも一致", async () => {
    const withMany = await mergeTwoGroups(true);
    const withoutMany = await mergeTwoGroups(false);

    expect(withoutMany.spy.listRelatedCalls).toHaveLength(6);
    expect(withoutMany.kind).toBe("contested_group");
    expect(withoutMany.memberLabels).toEqual(withMany.memberLabels);
    expect([...withMany.memberLabels].sort()).toEqual(
      ["new", "g1a", "g1b", "g1c", "g2a", "g2b", "g2c"].sort(),
    );
  });
});

describe("FakeRelationStore.link / listRelated の入力（ADR 0488。InMemory・Postgres と同じ）", () => {
  async function twoMemories() {
    const stores = createFakeRuntimeStores();
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ contentHash: "rel-a" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ contentHash: "rel-b" }));
    return { stores, a: a.id, b: b.id };
  }

  it.each(["", null, "Contradicts", "bogus", "__proto__", "toString", 0])(
    "link は範囲外の kind (%j) を unknown relation kind で断り、何も書かない",
    async (kind) => {
      const { stores, a, b } = await twoMemories();
      await expect(
        stores.relationStore.link(ctx, kind as unknown as RelationKind, a, b),
      ).rejects.toThrow(/unknown relation kind/);
      expect(await stores.relationStore.listRelated(ctx, a)).toEqual([]);
    },
  );

  it("陽性対照: contradicts は書ける。同じ組をもう一度 link しても1行のまま", async () => {
    const { stores, a, b } = await twoMemories();
    await stores.relationStore.link(ctx, "contradicts", a, b);
    await stores.relationStore.link(ctx, "contradicts", a, b);
    expect((await stores.relationStore.listRelated(ctx, a)).map((r) => r.memoryId)).toEqual([b]);
  });

  it("listRelated が返す createdAt を書き換えても、store の中の行は変わらない", async () => {
    const { stores, a, b } = await twoMemories();
    await stores.relationStore.link(ctx, "contradicts", a, b);
    const first = await stores.relationStore.listRelated(ctx, a);
    const original = first[0]!.createdAt.getTime();
    first[0]!.createdAt.setFullYear(1999);
    const second = await stores.relationStore.listRelated(ctx, a);
    expect(second[0]!.createdAt.getTime()).toBe(original);
  });
});

describe("FakeRelationStore.listRelated の kind が偽の値のとき、絞り込まずに全件を返す（ADR 0488。Postgres と同じ）", () => {
  it.each(["", null, 0])("kind=%j", async (kind) => {
    const stores = createFakeRuntimeStores();
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ contentHash: "rel-a" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ contentHash: "rel-b" }));
    await stores.relationStore.link(ctx, "contradicts", a.id, b.id);
    expect(
      await stores.relationStore.listRelated(ctx, a.id, kind as unknown as RelationKind),
    ).toHaveLength(1);
    expect(await stores.relationStore.listRelated(ctx, a.id, "bogus" as never)).toHaveLength(0);
    expect(await stores.relationStore.listRelated(ctx, a.id, "contradicts")).toHaveLength(1);
  });
});

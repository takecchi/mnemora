import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { NewMemory } from "../memory.js";
import type { MemoryId } from "../ids.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/** `@mnemora/testkit` には依存しない（`runtime-fakes.ts` 冒頭と同じ理由）。 */

const ctx: Ctx = { tenantId: "tenant-relation-group" };
const NOW = new Date("2026-06-01T00:00:00.000Z");

function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  const recordedAt = overrides.recordedAt ?? NOW;
  const strength = overrides.strength ?? 1;
  const halfLifeHours = overrides.halfLifeHours ?? 24 * 365 * 10;
  return {
    tenantId: "tenant-relation-group",
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

function buildRuntime(opts: { withRelationStore?: boolean } = {}) {
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
    relationStore: opts.withRelationStore === false ? undefined : stores.relationStore,
  });
  return { runtime, stores };
}

describe("recall() — 段3が多者間の contested 群も同伴として拾う（relationStore 配線あり）", () => {
  it("群のうち1件だけが候補に上がると、RelationStore 経由で残りの仲間も同伴取得され、1つの単位として隣接する", async () => {
    const { runtime, stores } = buildRuntime({ withRelationStore: true });
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "B" }));
    const c = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "C" }));
    await runtime.markContestedGroup!(ctx, [a.id, b.id, c.id]);
    // a だけを候補生成（ANN）で拾えるようにする——b・c は埋め込みを持たない
    // （段3の同伴取得だけが b・c への経路になる）。
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, a.id, [1, 0]);

    const result = await runtime.recall(ctx, { vector: [1, 0] });
    const ids = result.memories.map((m) => m.memoryId);

    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
    expect(ids).toContain(c.id);
    const positions = [a.id, b.id, c.id].map((id) => ids.indexOf(id)).sort((x, y) => x - y);
    expect(positions[2]! - positions[0]!).toBe(2);

    const bResult = result.memories.find((m) => m.memoryId === b.id);
    const cResult = result.memories.find((m) => m.memoryId === c.id);
    expect(bResult?.retrievedVia).toBe("mandatory_companion");
    expect(cResult?.retrievedVia).toBe("mandatory_companion");
    expect(bResult?.score.affinityMeasured).toBe(false);

    const stage = result.explain.stages.find((s) => s.stage === "contradiction_resolution");
    expect(stage?.executed).toBe(true);
    expect(stage?.detail).toEqual({ companionsAdded: 2 });

    expect(bResult?.contestedWith).toBeUndefined();
  });

  it("forget 等で群を離れた（もう contested でない）メンバーは同伴に含まれない", async () => {
    const { runtime, stores } = buildRuntime({ withRelationStore: true });
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "B" }));
    const c = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "C" }));
    await runtime.markContestedGroup!(ctx, [a.id, b.id, c.id]);
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, a.id, [1, 0]);

    await runtime.forget(ctx, { memoryIds: [b.id] });

    const result = await runtime.recall(ctx, { vector: [1, 0] });
    const ids = result.memories.map((m) => m.memoryId);

    expect(ids).toContain(a.id);
    expect(ids).toContain(c.id);
    expect(ids).not.toContain(b.id);
  });

  it("上限（DEFAULT_RECALL_ASSOCIATION.maxCount = 10）を超えた分は validFrom の新しい順→id の順で切り、over_limit(stage:'relation') に件数を積む", async () => {
    const { runtime, stores } = buildRuntime({ withRelationStore: true });
    const owner = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "owner" }));
    const members: { id: MemoryId; validFrom: Date }[] = [];
    for (let i = 0; i < 12; i++) {
      const validFrom = new Date(Date.UTC(2020, 0, 1 + i));
      const m = await stores.memoryStore.createMemory(
        ctx,
        newMemory({ digest: `member-${i}`, validFrom, validUntil: null }),
      );
      members.push({ id: m.id, validFrom });
    }
    await runtime.markContestedGroup!(ctx, [owner.id, ...members.map((m) => m.id)]);
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, owner.id, [1, 0]);

    const result = await runtime.recall(ctx, { vector: [1, 0] });
    const ids = new Set(result.memories.map((m) => m.memoryId));

    expect(ids).toContain(owner.id);
    const expectedKept = [...members].sort((a, b) => b.validFrom.getTime() - a.validFrom.getTime());
    const keptIds = expectedKept.slice(0, 10).map((m) => m.id);
    const droppedIds = expectedKept.slice(10).map((m) => m.id);
    for (const id of keptIds) {
      expect(ids).toContain(id);
    }
    for (const id of droppedIds) {
      expect(ids).not.toContain(id);
    }

    expect(result.omitted).toContainEqual({
      kind: "over_limit",
      stage: "relation",
      count: 2,
      countKind: "exact",
    });
  });

  it("relationStore が配線されていても、群の候補が無ければ stage_skipped/over_limit のどちらも積まない", async () => {
    const { runtime, stores } = buildRuntime({ withRelationStore: true });
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "A" }));
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, a.id, [1, 0]);

    const result = await runtime.recall(ctx, { vector: [1, 0] });

    expect(result.omitted.some((o) => o.kind === "over_limit" && o.stage === "relation")).toBe(
      false,
    );
    expect(result.omitted.some((o) => o.kind === "stage_skipped" && o.stage === "relation")).toBe(
      false,
    );
  });

  it("2026-09-30 のさらなる直し: A-B・A-C がつながり B-C はつながっていない形で、B を引くと A と C まで幅優先で並ぶ（1段では止まらない）", async () => {
    const { runtime, stores } = buildRuntime({ withRelationStore: true });
    // 同伴〔a・c〕は `survivesAttributesFilter` だけを通り validAt では検査されないので、期限切れの窓でもよい。
    // `markContestedGroup` は重なる組だけに辺を張るので、a-b・a-c の辺だけが張られ b-c には無い。
    const b = await stores.memoryStore.createMemory(
      ctx,
      newMemory({
        digest: "B",
        validFrom: new Date("2026-01-01T00:00:00Z"),
        validUntil: null,
      }),
    );
    const a = await stores.memoryStore.createMemory(
      ctx,
      newMemory({
        digest: "A",
        validFrom: null,
        validUntil: null,
      }),
    );
    const c = await stores.memoryStore.createMemory(
      ctx,
      newMemory({
        digest: "C",
        validFrom: new Date("2020-01-01T00:00:00Z"),
        validUntil: new Date("2021-01-01T00:00:00Z"),
      }),
    );
    await runtime.markContestedGroup!(ctx, [a.id, b.id, c.id]);
    const related = await stores.relationStore.listRelated(ctx, b.id, "contradicts");
    expect(related.map((r) => r.memoryId)).toEqual([a.id]); // 前提: b は a とだけ直接つながる。

    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, b.id, [1, 0]);

    const result = await runtime.recall(ctx, { vector: [1, 0] });
    const ids = result.memories.map((m) => m.memoryId);

    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
    expect(ids).toContain(c.id);
    const stage = result.explain.stages.find((s) => s.stage === "contradiction_resolution");
    expect(stage?.detail).toEqual({ companionsAdded: 2 });
  });

  it("鎖 a-b-c の真ん中の b が（archived で）群を離れていれば、a を引いても b の先の c は同伴に入らない", async () => {
    const { runtime, stores } = buildRuntime({ withRelationStore: true });
    // a-b・b-c の辺だけが張られ a-c には無い。c へ届く道は b を通る道だけになる。
    const a = await stores.memoryStore.createMemory(
      ctx,
      newMemory({
        digest: "A",
        validFrom: new Date("2026-01-01T00:00:00Z"),
        validUntil: null,
      }),
    );
    const b = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ digest: "B", validFrom: null, validUntil: null }),
    );
    const c = await stores.memoryStore.createMemory(
      ctx,
      newMemory({
        digest: "C",
        validFrom: new Date("2020-01-01T00:00:00Z"),
        validUntil: new Date("2021-01-01T00:00:00Z"),
      }),
    );
    await runtime.markContestedGroup!(ctx, [a.id, b.id, c.id]);
    const related = await stores.relationStore.listRelated(ctx, a.id, "contradicts");
    expect(related.map((r) => r.memoryId)).toEqual([b.id]); // 前提: a は b とだけ直接つながる。

    // forget 済みは getMany が返さず探索に入らないので、status の門に当たるのは contested でなくなった場合（archived にして離れさせる）。
    await stores.memoryStore.updateStatus(ctx, b.id, "archived");
    expect((await stores.memoryStore.get(ctx, b.id))?.status).toBe("archived");
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, a.id, [1, 0]);

    const result = await runtime.recall(ctx, { vector: [1, 0] });
    const ids = result.memories.map((m) => m.memoryId);

    expect(ids).not.toContain(b.id);
    expect(ids).not.toContain(c.id);
  });

  it("attributes で絞った recall では、群の同伴のうち attributes が絞りの外の1件は入らない（subjectId・period は見ない設計）", async () => {
    const { runtime, stores } = buildRuntime({ withRelationStore: true });
    const a = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ digest: "A", attributes: { team: "x" } }),
    );
    const b = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ digest: "B", attributes: { team: "y" } }),
    );
    const c = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ digest: "C", attributes: { team: "x" } }),
    );
    await runtime.markContestedGroup!(ctx, [a.id, b.id, c.id]);
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, a.id, [1, 0]);

    const result = await runtime.recall(ctx, { vector: [1, 0], attributes: { team: "x" } });
    const ids = result.memories.map((m) => m.memoryId);

    expect(ids).toContain(a.id);
    expect(ids).toContain(c.id);
    expect(ids).not.toContain(b.id);
  });
});

describe("recall() — relationStore が配線されていなければ、群のメンバーは今までどおり単独で出ない", () => {
  it("relationStore を配線しない呼び出しでは stage_skipped(stage:'relation') を積み、群のメンバーは unit_assembly_dropped のまま", async () => {
    const { runtime, stores } = buildRuntime({ withRelationStore: false });
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "B" }));
    const c = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "C" }));
    await runtime.markContestedGroup!(ctx, [a.id, b.id, c.id]);
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, a.id, [1, 0]);

    const result = await runtime.recall(ctx, { vector: [1, 0] });
    const ids = result.memories.map((m) => m.memoryId);

    expect(ids).not.toContain(a.id);
    expect(ids).not.toContain(b.id);
    expect(ids).not.toContain(c.id);
    expect(result.omitted).toContainEqual({
      kind: "stage_skipped",
      stage: "relation",
      reason: "relation_store_unavailable",
    });
    expect(result.omitted).toContainEqual({
      kind: "unit_assembly_dropped",
      count: 1,
      countKind: "lower_bound",
    });
  });

  it("群のメンバーが1件もこの recall の候補に無ければ、stage_skipped も積まない", async () => {
    const { runtime, stores } = buildRuntime({ withRelationStore: false });
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "A" }));
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, a.id, [1, 0]);

    const result = await runtime.recall(ctx, { vector: [1, 0] });

    expect(result.omitted.some((o) => o.kind === "stage_skipped" && o.stage === "relation")).toBe(
      false,
    );
  });
});

/** 2段先まで含めて11件以上になる群: owner は a とだけ、a は owner と c0〜c10 と、c0〜c10 は互いに重なる。validFrom の新しい順は a → c10 … c0 なので、10件で切ると c1・c0 が落ちる。 */
async function buildTwoHopGroup(
  runtime: ReturnType<typeof buildRuntime>["runtime"],
  stores: ReturnType<typeof buildRuntime>["stores"],
  label: string,
) {
  const owner = await stores.memoryStore.createMemory(
    ctx,
    newMemory({
      digest: `${label}-owner`,
      validFrom: new Date("2026-01-01T00:00:00Z"),
      validUntil: null,
    }),
  );
  const a = await stores.memoryStore.createMemory(
    ctx,
    newMemory({
      digest: `${label}-a`,
      validFrom: new Date("2025-01-01T00:00:00Z"),
      validUntil: null,
    }),
  );
  const cs: MemoryId[] = [];
  for (let i = 0; i < 11; i++) {
    const c = await stores.memoryStore.createMemory(
      ctx,
      newMemory({
        digest: `${label}-c${i}`,
        validFrom: new Date(Date.UTC(2020, 0, 1 + i)),
        validUntil: new Date("2025-06-01T00:00:00Z"),
      }),
    );
    cs.push(c.id);
  }
  await runtime.markContestedGroup!(ctx, [owner.id, a.id, ...cs]);
  const related = await stores.relationStore.listRelated(ctx, owner.id, "contradicts");
  expect(related.map((r) => r.memoryId)).toEqual([a.id]); // 前提: owner は a とだけ直接つながる。
  await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, owner.id, [1, 0]);
  const kept = [a.id, ...[...cs].reverse().slice(0, 9)];
  const dropped = [cs[1]!, cs[0]!];
  return { owner, kept, dropped };
}

describe("recall() — 段3の上限と安全弁は群ごとに効く（2026-09-30 の3つ目の直し）", () => {
  it("始点から2段先まで含めて11件以上になる群は、validFrom の新しい順→id の順で10件に切られ、切った件数が over_limit に出る", async () => {
    const { runtime, stores } = buildRuntime({ withRelationStore: true });
    const { owner, kept, dropped } = await buildTwoHopGroup(runtime, stores, "g1");

    const result = await runtime.recall(ctx, { vector: [1, 0] });
    const ids = result.memories.map((m) => m.memoryId);

    expect(ids).toContain(owner.id);
    for (const id of kept) expect(ids).toContain(id);
    for (const id of dropped) expect(ids).not.toContain(id);
    // 提示の並び（単位の中の順）は owner から辺をたどる順で決まり validFrom の順ではない。ここで縛るのは「どれを残したか」である。
    const companionIds = result.memories
      .filter((m) => m.retrievedVia === "mandatory_companion")
      .map((m) => m.memoryId);
    expect([...companionIds].sort()).toEqual([...kept].sort());
    const positions = [owner.id, ...kept].map((id) => ids.indexOf(id)).sort((p, q) => p - q);
    expect(positions[positions.length - 1]! - positions[0]!).toBe(kept.length);
    expect(result.omitted.filter((o) => o.kind === "over_limit" && o.stage === "relation")).toEqual(
      [{ kind: "over_limit", stage: "relation", count: 2, countKind: "exact" }],
    );
  });

  it("群が2つ見つかり片方が11件以上でも、もう片方の群は削られない（上限と切った件数は群ごと）", async () => {
    const { runtime, stores } = buildRuntime({ withRelationStore: true });
    const big = await buildTwoHopGroup(runtime, stores, "big");
    // y・z は大きい群のどれより古い validFrom: 全体を合わせた数で切ると真っ先に落ちる形にする。
    const x = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ digest: "x", validFrom: new Date("2010-01-01T00:00:00Z"), validUntil: null }),
    );
    const y = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ digest: "y", validFrom: new Date("2010-01-02T00:00:00Z"), validUntil: null }),
    );
    const z = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ digest: "z", validFrom: new Date("2010-01-03T00:00:00Z"), validUntil: null }),
    );
    await runtime.markContestedGroup!(ctx, [x.id, y.id, z.id]);
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, x.id, [1, 0]);

    const result = await runtime.recall(ctx, { vector: [1, 0] });
    const ids = result.memories.map((m) => m.memoryId);

    expect(ids).toContain(x.id);
    expect(ids).toContain(y.id);
    expect(ids).toContain(z.id);
    expect(ids).toContain(big.owner.id);
    for (const id of big.kept) expect(ids).toContain(id);
    for (const id of big.dropped) expect(ids).not.toContain(id);
    expect(result.omitted.filter((o) => o.kind === "over_limit" && o.stage === "relation")).toEqual(
      [{ kind: "over_limit", stage: "relation", count: 2, countKind: "exact" }],
    );
  });

  it("探索の安全弁（100件）は1件たどるごとに確かめる: 100件ちょうどの群は exact、101件の群は100件で止まり lower_bound", async () => {
    async function recallGroupOfSize(n: number) {
      const { runtime, stores } = buildRuntime({ withRelationStore: true });
      const ids: MemoryId[] = [];
      for (let i = 0; i < n; i++) {
        const m = await stores.memoryStore.createMemory(
          ctx,
          newMemory({ digest: `m${i}`, validFrom: null, validUntil: null }),
        );
        ids.push(m.id);
      }
      await runtime.markContestedGroup!(ctx, ids);
      await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, ids[0]!, [1, 0]);
      const result = await runtime.recall(ctx, { vector: [1, 0] });
      return result.omitted.filter((o) => o.kind === "over_limit" && o.stage === "relation");
    }

    expect(await recallGroupOfSize(100)).toEqual([
      { kind: "over_limit", stage: "relation", count: 89, countKind: "exact" },
    ]);
    expect(await recallGroupOfSize(101)).toEqual([
      { kind: "over_limit", stage: "relation", count: 89, countKind: "lower_bound" },
    ]);
  });
});

describe("recall() — 群の単位の中の見せる順（2026-09-30、ADR 0381 決定4）", () => {
  it("起点の後ろの同伴は、たどる順ではなく validFrom の新しい順→id の順に並ぶ（2段先の記憶のほうが新しい形）", async () => {
    const { runtime, stores } = buildRuntime({ withRelationStore: true });
    // たどる順は owner → a → c1・c2 だが、新しい順は c2 → c1 → a（両者を食い違わせる）。
    const owner = await stores.memoryStore.createMemory(
      ctx,
      newMemory({
        digest: "owner",
        validFrom: new Date("2026-01-01T00:00:00Z"),
        validUntil: null,
      }),
    );
    const a = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ digest: "a", validFrom: new Date("2000-01-01T00:00:00Z"), validUntil: null }),
    );
    const c1 = await stores.memoryStore.createMemory(
      ctx,
      newMemory({
        digest: "c1",
        validFrom: new Date("2024-01-01T00:00:00Z"),
        validUntil: new Date("2025-12-01T00:00:00Z"),
      }),
    );
    const c2 = await stores.memoryStore.createMemory(
      ctx,
      newMemory({
        digest: "c2",
        validFrom: new Date("2024-06-01T00:00:00Z"),
        validUntil: new Date("2025-12-01T00:00:00Z"),
      }),
    );
    await runtime.markContestedGroup!(ctx, [owner.id, a.id, c1.id, c2.id]);
    const related = await stores.relationStore.listRelated(ctx, owner.id, "contradicts");
    expect(related.map((r) => r.memoryId)).toEqual([a.id]); // 前提: owner は a とだけ直接つながる。
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, owner.id, [1, 0]);

    const result = await runtime.recall(ctx, { vector: [1, 0] });
    const groupIds = new Set([owner.id, a.id, c1.id, c2.id]);
    const shown = result.memories.map((m) => m.memoryId).filter((id) => groupIds.has(id));

    expect(shown).toEqual([owner.id, c2.id, c1.id, a.id]);
  });
});

describe("recall() — 同じ段で複数の親から届く同伴の companionOf は id の小さい親に決まる（Issue #1449 項目7）", () => {
  // `listRelated` の順は契約が規定しない（InMemory は挿入順）ので、関係を張る順を入れ替えた2通りで作り、D の companionOf が同じになることを縛る。
  const orders: Array<[string, boolean]> = [
    ["O-B, O-C, B-D, C-D の順に張る", false],
    ["O-C, O-B, C-D, B-D の順に張る（逆）", true],
  ];
  it.each(orders)(
    "菱形（%s）でも D の companionOf は B と C のうち id の小さいほう",
    async (_n, reversed) => {
      const { runtime, stores } = buildRuntime({ withRelationStore: true });
      const make = (digest: string) =>
        stores.memoryStore.createMemory(ctx, newMemory({ digest, status: "contested" }));
      const o = await make("O");
      const b = await make("B");
      const c = await make("C");
      const d = await make("D");
      const link2 = async (x: MemoryId, y: MemoryId) => {
        await stores.relationStore.link(ctx, "contradicts", x, y);
        await stores.relationStore.link(ctx, "contradicts", y, x);
      };
      const [first, second] = reversed ? [c, b] : [b, c];
      await link2(o.id, first.id);
      await link2(o.id, second.id);
      await link2(first.id, d.id);
      await link2(second.id, d.id);
      // 前提: O から見た listRelated の順が張った順（= 入れ替えが効いている）。
      const viaO = await stores.relationStore.listRelated(ctx, o.id, "contradicts");
      expect(viaO.map((r) => r.memoryId)).toEqual([first.id, second.id]);
      await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, o.id, [1, 0]);

      const result = await runtime.recall(ctx, { vector: [1, 0] });

      const smaller = b.id < c.id ? b.id : c.id;
      const byId = new Map(result.memories.map((m) => [m.memoryId, m]));
      expect(byId.get(d.id)?.retrievedVia).toBe("mandatory_companion");
      expect(byId.get(d.id)?.companionOf).toBe(smaller);
      expect(byId.get(b.id)?.companionOf).toBe(o.id);
      expect(byId.get(c.id)?.companionOf).toBe(o.id);
    },
  );
});

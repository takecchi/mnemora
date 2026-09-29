import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { NewMemory } from "../memory.js";
import type { MemoryId } from "../ids.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * Issue #207/#933 PR2（ADR 0292 決定2・3、ADR 0381、この回のマネージャー指示）: 段3
 * （必須の同伴取得、`contradiction_resolution`）を多者間の `contested` 群にも広げた歯。
 *
 * `contestedWithId` を持たない `contested`（3件以上の群のメンバー）は、
 * `RelationStore.listRelated` で1段だけ辿って仲間を同伴として拾う——2者間の対
 * （`recall-companion-status-gate.test.ts`・`contested-pair-invariant.test.ts` が
 * 縛る既存の `contestedWithId` 経路）は1バイトも変えていない。
 *
 * `@mnemora/testkit` には依存しない（`runtime-fakes.ts` 冒頭のコメントと同じ理由）。
 */

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
    // 隣接性: 3件が並び順で連続している（間に他の候補が挟まらない）。
    const positions = [a.id, b.id, c.id].map((id) => ids.indexOf(id)).sort((x, y) => x - y);
    expect(positions[2]! - positions[0]!).toBe(2);

    const bResult = result.memories.find((m) => m.memoryId === b.id);
    const cResult = result.memories.find((m) => m.memoryId === c.id);
    expect(bResult?.retrievedVia).toBe("mandatory_companion");
    expect(cResult?.retrievedVia).toBe("mandatory_companion");
    // affinity を測っていない（`fetchMandatoryCompanions` と同じ規律）。
    expect(bResult?.score.affinityMeasured).toBe(false);

    const stage = result.explain.stages.find((s) => s.stage === "contradiction_resolution");
    expect(stage?.executed).toBe(true);
    expect(stage?.detail).toEqual({ companionsAdded: 2 });

    // 2者間の対（`contestedWith`）とは別物——群のメンバーは contestedWithId を
    // 持たないので `contestedWith` は付かない。
    expect(bResult?.contestedWith).toBeUndefined();
  });

  it("forget 等で群を離れた（もう contested でない）メンバーは同伴に含まれない", async () => {
    const { runtime, stores } = buildRuntime({ withRelationStore: true });
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "B" }));
    const c = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "C" }));
    await runtime.markContestedGroup!(ctx, [a.id, b.id, c.id]);
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, a.id, [1, 0]);

    // b を forget で群から離脱させる（関係の行は残る——decision10）。
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
    // owner との対で12件の群を作る（owner + 12 = 13件、markContestedGroup 自体は
    // 3件以上なら何件でもよい）。各メンバーの validFrom をずらし、新しい順の並びを
    // 決定的に作る。
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
    // validFrom 降順（新しい順）で上位10件だけが残る——member-11 が最新、member-2 が
    // 10番目に新しい（12件中、古い2件 member-0・member-1 が切られる）。
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
    // b は候補生成（ANN）で見つかる「owner」——NOW（2026-06-01）の時点で有効な窓
    // （[2026-01-01, 無期限)）を持たせる（同伴〔a・c〕は survivesAttributesFilter だけを
    // 通り、validAt では検査されないため、期限切れの窓でもよい——`fetchMandatoryCompanions`
    // の doc コメントと同じ規律）。a は無期限（null-null、誰とでも重なる）、c は
    // b より前に終わる過去の窓（b の validFrom より前に validUntil が来る）——
    // markContestedGroup の fix1（重なる組だけに行を張る）により、a-b・a-c の辺だけが
    // 張られ、b-c には辺が無い。
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

    // b だけを候補生成（ANN）で拾えるようにする——a・c は埋め込みを持たない。
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, b.id, [1, 0]);

    const result = await runtime.recall(ctx, { vector: [1, 0] });
    const ids = result.memories.map((m) => m.memoryId);

    // 1段（b の直接の隣接）だけなら a までしか見つからない。幅優先で a から先も
    // 辿ることで、c（b からは2ホップ先）まで同伴取得される。
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
    expect(ids).toContain(c.id);
    const stage = result.explain.stages.find((s) => s.stage === "contradiction_resolution");
    expect(stage?.detail).toEqual({ companionsAdded: 2 });
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

/**
 * 2026-09-30 の3つ目の直し（ADR 0381 決定4・§5.5）: 段3の上限（10件）と探索の安全弁
 * （100件）は**群ごと**に効き、安全弁は1件たどるごとに確かめる。
 *
 * 2段先まで含めて11件以上になる群の形（`buildTwoHopGroup`）:
 * - owner（候補生成で見つかる）は a とだけ重なる。
 * - a は owner とも c0〜c10 とも重なる。
 * - c0〜c10 は互いに重なるが、owner とは重ならない。
 * ⟹ 関係の行は owner-a・a-ci・ci-cj だけ。owner から見て a は1段先、ci は2段先。
 * 同伴の候補は a と c0〜c10 の12件。`validFrom` の新しい順で a（2025）→ c10 … c0（2020）と
 * 並ぶので、10件で切ると c1・c0 の2件が落ちる。
 */
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
  // 新しい順: a、c10、c9 … c2 が残り、c1・c0 が落ちる。
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
    // 残った同伴は、新しい順の上位10件とちょうど同じ集合（多くも少なくもない）。
    // ⚠ 提示の並び（単位の中の順）は `collectGroupComponent` が owner から辺をたどる順で
    // 決まり、validFrom の順ではない——ここで縛るのは「どれを残したか」の順である。
    const companionIds = result.memories
      .filter((m) => m.retrievedVia === "mandatory_companion")
      .map((m) => m.memoryId);
    expect([...companionIds].sort()).toEqual([...kept].sort());
    // 群は1つの単位として隣接する（owner と同伴10件の11件が連続する）。
    const positions = [owner.id, ...kept].map((id) => ids.indexOf(id)).sort((p, q) => p - q);
    expect(positions[positions.length - 1]! - positions[0]!).toBe(kept.length);
    expect(result.omitted.filter((o) => o.kind === "over_limit" && o.stage === "relation")).toEqual(
      [{ kind: "over_limit", stage: "relation", count: 2, countKind: "exact" }],
    );
  });

  it("群が2つ見つかり片方が11件以上でも、もう片方の群は削られない（上限と切った件数は群ごと）", async () => {
    const { runtime, stores } = buildRuntime({ withRelationStore: true });
    const big = await buildTwoHopGroup(runtime, stores, "big");
    // 小さい群: x（候補生成で見つかる）・y・z。y・z は大きい群のどれよりも古い validFrom を
    // 持つ——全体を合わせた数で切ると、y・z が真っ先に落ちる形。
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
    // 切ったのは大きい群の2件だけで、over_limit はその群の分の1件だけ。
    expect(result.omitted.filter((o) => o.kind === "over_limit" && o.stage === "relation")).toEqual(
      [{ kind: "over_limit", stage: "relation", count: 2, countKind: "exact" }],
    );
  });

  it("探索の安全弁（100件）は1件たどるごとに確かめる: 100件ちょうどの群は exact、101件の群は100件で止まり lower_bound", async () => {
    // owner を含めて n 件の、全員が互いに重なる群（validFrom・validUntil とも null）。
    // 同伴の候補は n-1 件、10件に切るので切った件数は n-11 件。
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

    // 100件ちょうど: 訪れた数は owner を含めて100件で、安全弁に届かずに尽きる。
    expect(await recallGroupOfSize(100)).toEqual([
      { kind: "over_limit", stage: "relation", count: 89, countKind: "exact" },
    ]);
    // 101件: 101件目をたどる前に止まる——訪れた数は100件を1件も超えない。
    // 見つかった同伴の候補は99件なので、切った件数は89件（下限）。
    expect(await recallGroupOfSize(101)).toEqual([
      { kind: "over_limit", stage: "relation", count: 89, countKind: "lower_bound" },
    ]);
  });
});

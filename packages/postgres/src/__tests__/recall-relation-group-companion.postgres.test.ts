import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx, EmbeddingProvider, LLMProvider } from "@mnemora/core";
import { createRuntime } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { PostgresRelationStore } from "../relation-store.js";
import {
  closeTestClient,
  getTestClient,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
} from "./test-db.js";

/**
 * Issue #207/#933 PR2（ADR 0292 決定2・3、ADR 0381、この回のマネージャー指示、本物の
 * Postgres + pgvector に対する歯）: 段3（必須の同伴取得）を多者間の `contested` 群にも
 * 広げたことを、実データに対して確かめる。
 *
 * `packages/core` 側の歯（`recall-relation-group-companion.test.ts`）が Fake で網羅的に
 * 検査している——ここでは同じ最小再現・上限と並び順・relationStore 未配線の3本だけを、
 * 実際の `PostgresMemoryStore`/`PostgresRelationStore` に対して繰り返す
 * （`AGENTS.md` の「テストは本物の Postgres + pgvector に対して走る」原則）。
 */

const TENANT = "recall-relation-group-tenant";

const throwingLlm: LLMProvider = {
  complete: async () => {
    throw new Error("not used by recall tests");
  },
  completeStructured: async () => {
    throw new Error("not used by recall tests");
  },
};

function makeEmbeddingProvider(): EmbeddingProvider {
  return {
    space: TEST_EMBEDDING_SPACE,
    embed: async (_ctx, texts) => texts.map(() => [1, 0, 0]),
  };
}

async function buildTestRuntime(opts: { withRelationStore?: boolean } = {}) {
  const { db } = await getTestClient();
  const memoryStore = new PostgresMemoryStore(db);
  const vectorStore = new PostgresVectorStore(db);
  const relationStore = new PostgresRelationStore(db);
  const runtime = createRuntime({
    memoryStore,
    outboxStore: {
      claimBatch: async () => [],
      complete: async () => {},
      fail: async () => {},
    },
    vectorStore,
    eventStore: {
      append: async (_ctx, e) => ({ id: "evt", ...e, at: e.at ?? new Date() }),
      get: async () => null,
      list: async () => [],
    },
    tenantSettingsStore: {
      getDefaultHalfLifeHours: async () => 720,
      getEventRetention: async () => {
        throw new Error(
          "recall-relation-group-companion.postgres.test.ts のダミーは getEventRetention を呼ばないはず",
        );
      },
      setEventRetention: async () => {
        throw new Error(
          "recall-relation-group-companion.postgres.test.ts のダミーは setEventRetention を呼ばないはず",
        );
      },
    },
    llmProvider: throwingLlm,
    embeddingProvider: makeEmbeddingProvider(),
    hashContent: (content: string) => `sha256(${content})`,
    // buildNewMemoryFixture の既定 recordedAt（2026-01-01）に固定する
    // （recall.postgres.test.ts と同じ理由——decay で score.total が落ちるのを防ぐ）。
    clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
    relationStore: opts.withRelationStore === false ? undefined : relationStore,
  });
  return { runtime, memoryStore, vectorStore, relationStore };
}

async function createEmbeddedMemory(
  memoryStore: PostgresMemoryStore,
  vectorStore: PostgresVectorStore,
  ctx: Ctx,
  vector: number[],
  overrides: Parameters<typeof buildNewMemoryFixture>[0] = {},
) {
  const memory = await memoryStore.createMemory(
    ctx,
    buildNewMemoryFixture({ tenantId: ctx.tenantId, embeddingStatus: "ready", ...overrides }),
  );
  await vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, memory.id, vector);
  return memory;
}

describe("runtime.recall() — 段3が多者間の contested 群も同伴取得する（Issue #207/#933 PR2、本物の Postgres + pgvector）", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("群のうち1件だけが候補に上がると、残りの仲間も RelationStore 経由で同伴取得される", async () => {
    const { runtime, memoryStore, vectorStore } = await buildTestRuntime({
      withRelationStore: true,
    });
    const ctx: Ctx = { tenantId: TENANT };

    const owner = await createEmbeddedMemory(memoryStore, vectorStore, ctx, [1, 0, 0]);
    // ⚠ owner だけ埋め込みを付け、b・c は候補生成（ANN）に出さない
    // （段3の同伴取得だけが b・c への経路になる）。
    const b = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: TENANT, embeddingStatus: "pending" }),
    );
    const c = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: TENANT, embeddingStatus: "pending" }),
    );
    await runtime.markContestedGroup!(ctx, [owner.id, b.id, c.id]);

    const result = await runtime.recall(ctx, { vector: [1, 0, 0] });
    const ids = result.memories.map((m) => m.memoryId);

    expect(ids).toContain(owner.id);
    expect(ids).toContain(b.id);
    expect(ids).toContain(c.id);
    const stage = result.explain.stages.find((s) => s.stage === "contradiction_resolution");
    expect(stage?.detail).toEqual({ companionsAdded: 2 });
  });

  it("relationStore が配線されていなければ、群のメンバーは単独で出ず stage_skipped(stage:'relation') を積む", async () => {
    const { runtime, memoryStore, vectorStore } = await buildTestRuntime({
      withRelationStore: false,
    });
    const ctx: Ctx = { tenantId: TENANT };

    const owner = await createEmbeddedMemory(memoryStore, vectorStore, ctx, [1, 0, 0]);
    const b = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: TENANT, embeddingStatus: "pending" }),
    );
    const c = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: TENANT, embeddingStatus: "pending" }),
    );
    await runtime.markContestedGroup!(ctx, [owner.id, b.id, c.id]);

    const result = await runtime.recall(ctx, { vector: [1, 0, 0] });
    const ids = result.memories.map((m) => m.memoryId);

    expect(ids).not.toContain(owner.id);
    expect(ids).not.toContain(b.id);
    expect(ids).not.toContain(c.id);
    expect(result.omitted).toContainEqual({
      kind: "stage_skipped",
      stage: "relation",
      reason: "relation_store_unavailable",
    });
  });

  it("上限（maxCount=10）を超えた分は validFrom の新しい順→id の順で切り、over_limit(stage:'relation') に件数を積む", async () => {
    const { runtime, memoryStore, vectorStore } = await buildTestRuntime({
      withRelationStore: true,
    });
    const ctx: Ctx = { tenantId: TENANT };

    const owner = await createEmbeddedMemory(memoryStore, vectorStore, ctx, [1, 0, 0]);
    const members: { id: string; validFrom: Date }[] = [];
    for (let i = 0; i < 12; i++) {
      const validFrom = new Date(Date.UTC(2020, 0, 1 + i));
      const m = await memoryStore.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: TENANT,
          embeddingStatus: "pending",
          validFrom,
          validUntil: null,
        }),
      );
      members.push({ id: m.id, validFrom });
    }
    await runtime.markContestedGroup!(ctx, [owner.id, ...members.map((m) => m.id)]);

    const result = await runtime.recall(ctx, { vector: [1, 0, 0] });
    const ids = new Set(result.memories.map((m) => m.memoryId));

    expect(ids).toContain(owner.id);
    const expectedKept = [...members].sort((a, b) => b.validFrom.getTime() - a.validFrom.getTime());
    for (const m of expectedKept.slice(0, 10)) {
      expect(ids).toContain(m.id);
    }
    for (const m of expectedKept.slice(10)) {
      expect(ids).not.toContain(m.id);
    }
    expect(result.omitted).toContainEqual({
      kind: "over_limit",
      stage: "relation",
      count: 2,
      countKind: "exact",
    });
  });

  it("2026-09-30 のさらなる直し: owner-a・a-c がつながり owner-c はつながっていない形で、owner を引くと a と c まで幅優先で並ぶ（1段では止まらない）", async () => {
    const { runtime, memoryStore, vectorStore, relationStore } = await buildTestRuntime({
      withRelationStore: true,
    });
    const ctx: Ctx = { tenantId: TENANT };

    // owner: NOW（buildTestRuntime の clock、2026-01-01）の時点で有効な窓。
    const owner = await createEmbeddedMemory(memoryStore, vectorStore, ctx, [1, 0, 0], {
      validFrom: new Date("2025-12-01T00:00:00Z"),
      validUntil: null,
    });
    // a: 無期限（誰とでも重なる）。
    const a = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        embeddingStatus: "pending",
        validFrom: null,
        validUntil: null,
      }),
    );
    // c: owner の validFrom より前に終わる過去の窓——owner とは重ならないが、
    // 無期限の a とは重なる。companion（a・c）は validAt を検査されないため、
    // 期限切れの窓でも同伴取得の対象になる（`fetchMandatoryCompanions` の doc
    // コメントと同じ規律）。
    const c = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        embeddingStatus: "pending",
        validFrom: new Date("2020-01-01T00:00:00Z"),
        validUntil: new Date("2021-01-01T00:00:00Z"),
      }),
    );
    await runtime.markContestedGroup!(ctx, [owner.id, a.id, c.id]);
    const related = await relationStore.listRelated(ctx, owner.id, "contradicts");
    expect(related.map((r) => r.memoryId)).toEqual([a.id]); // 前提: owner は a とだけ直接つながる。

    const result = await runtime.recall(ctx, { vector: [1, 0, 0] });
    const ids = result.memories.map((m) => m.memoryId);

    // 1段（owner の直接の隣接）だけなら a までしか見つからない。幅優先で a から先も
    // 辿ることで、c（owner からは2ホップ先）まで同伴取得される。
    expect(ids).toContain(owner.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(c.id);
    const stage = result.explain.stages.find((s) => s.stage === "contradiction_resolution");
    expect(stage?.detail).toEqual({ companionsAdded: 2 });
  });

  /**
   * 2026-09-30 の3つ目の直し（ADR 0381 決定4・§5.5）: 上限は群ごと。2段先まで含めて
   * 11件以上になる群の形（core の `recall-relation-group-companion.test.ts` の
   * `buildTwoHopGroup` と同じ形。owner は a とだけ重なり、a は c0〜c10 と重なり、
   * c0〜c10 は owner と重ならない）。
   */
  async function buildTwoHopGroup(
    built: Awaited<ReturnType<typeof buildTestRuntime>>,
    ctx: Ctx,
    vector: number[],
  ) {
    const { runtime, memoryStore, vectorStore, relationStore } = built;
    const owner = await createEmbeddedMemory(memoryStore, vectorStore, ctx, vector, {
      validFrom: new Date("2025-12-01T00:00:00Z"),
      validUntil: null,
    });
    const a = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        embeddingStatus: "pending",
        validFrom: new Date("2025-06-01T00:00:00Z"),
        validUntil: null,
      }),
    );
    const cs: string[] = [];
    for (let i = 0; i < 11; i++) {
      const c = await memoryStore.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: TENANT,
          embeddingStatus: "pending",
          validFrom: new Date(Date.UTC(2020, 0, 1 + i)),
          validUntil: new Date("2025-09-01T00:00:00Z"),
        }),
      );
      cs.push(c.id);
    }
    await runtime.markContestedGroup!(ctx, [owner.id, a.id, ...cs]);
    const related = await relationStore.listRelated(ctx, owner.id, "contradicts");
    expect(related.map((r) => r.memoryId)).toEqual([a.id]); // 前提: owner は a とだけ直接つながる。
    // 新しい順: a、c10、c9 … c2 が残り、c1・c0 が落ちる。
    const kept = [a.id, ...[...cs].reverse().slice(0, 9)];
    const dropped = [cs[1]!, cs[0]!];
    return { owner, kept, dropped };
  }

  it("2026-09-30 の3つ目の直し: 始点から2段先まで含めて11件以上になる群は、validFrom の新しい順→id の順で10件に切られ、切った件数が over_limit に出る", async () => {
    const built = await buildTestRuntime({ withRelationStore: true });
    const ctx: Ctx = { tenantId: TENANT };
    const { owner, kept, dropped } = await buildTwoHopGroup(built, ctx, [1, 0, 0]);

    const result = await built.runtime.recall(ctx, { vector: [1, 0, 0] });
    const ids = result.memories.map((m) => m.memoryId);

    expect(ids).toContain(owner.id);
    for (const id of kept) expect(ids).toContain(id);
    for (const id of dropped) expect(ids).not.toContain(id);
    const companionIds = result.memories
      .filter((m) => m.retrievedVia === "mandatory_companion")
      .map((m) => m.memoryId);
    expect([...companionIds].sort()).toEqual([...kept].sort());
    expect(result.omitted.filter((o) => o.kind === "over_limit" && o.stage === "relation")).toEqual(
      [{ kind: "over_limit", stage: "relation", count: 2, countKind: "exact" }],
    );
  });

  it("2026-09-30 の3つ目の直し: 群が2つ見つかり片方が11件以上でも、もう片方の群は削られない（上限と切った件数は群ごと）", async () => {
    const built = await buildTestRuntime({ withRelationStore: true });
    const ctx: Ctx = { tenantId: TENANT };
    const big = await buildTwoHopGroup(built, ctx, [1, 0, 0]);
    // 小さい群: x（候補生成で見つかる）・y・z。y・z は大きい群のどれよりも古い validFrom。
    const x = await createEmbeddedMemory(built.memoryStore, built.vectorStore, ctx, [1, 0, 0], {
      validFrom: new Date("2010-01-01T00:00:00Z"),
      validUntil: null,
    });
    const y = await built.memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        embeddingStatus: "pending",
        validFrom: new Date("2010-01-02T00:00:00Z"),
        validUntil: null,
      }),
    );
    const z = await built.memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        embeddingStatus: "pending",
        validFrom: new Date("2010-01-03T00:00:00Z"),
        validUntil: null,
      }),
    );
    await built.runtime.markContestedGroup!(ctx, [x.id, y.id, z.id]);

    const result = await built.runtime.recall(ctx, { vector: [1, 0, 0] });
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

  it("2026-09-30（ADR 0381 決定4）: 群の単位の中で、起点の後ろの同伴は、たどる順ではなく validFrom の新しい順→id の順に並ぶ（2段先の記憶のほうが新しい形）", async () => {
    const { runtime, memoryStore, vectorStore, relationStore } = await buildTestRuntime({
      withRelationStore: true,
    });
    const ctx: Ctx = { tenantId: TENANT };
    // owner は a とだけ重なる。a（古い）は c1・c2（新しい）と重なる。c1・c2 は owner と
    // 重ならない。⟹ たどる順は owner → a → c1・c2 だが、新しい順は c2 → c1 → a。
    const owner = await createEmbeddedMemory(memoryStore, vectorStore, ctx, [1, 0, 0], {
      validFrom: new Date("2025-12-01T00:00:00Z"),
      validUntil: null,
    });
    const make = (validFrom: Date, validUntil: Date | null) =>
      memoryStore.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: TENANT,
          embeddingStatus: "pending",
          validFrom,
          validUntil,
        }),
      );
    const a = await make(new Date("2000-01-01T00:00:00Z"), null);
    const c1 = await make(new Date("2024-01-01T00:00:00Z"), new Date("2025-11-01T00:00:00Z"));
    const c2 = await make(new Date("2024-06-01T00:00:00Z"), new Date("2025-11-01T00:00:00Z"));
    await runtime.markContestedGroup!(ctx, [owner.id, a.id, c1.id, c2.id]);
    const related = await relationStore.listRelated(ctx, owner.id, "contradicts");
    expect(related.map((r) => r.memoryId)).toEqual([a.id]); // 前提: owner は a とだけ直接つながる。

    const result = await runtime.recall(ctx, { vector: [1, 0, 0] });
    const groupIds = new Set([owner.id, a.id, c1.id, c2.id]);
    const shown = result.memories.map((m) => m.memoryId).filter((id) => groupIds.has(id));

    expect(shown).toEqual([owner.id, c2.id, c1.id, a.id]);
  });

  // Issue #1449 項目7: 菱形（O が起点、O-B・O-C・B-D・C-D）。D へは B からも C からも同じ段で届く。
  // `listRelated` は ORDER BY を持たない（契約も順を規定しない）ので、関係を張る順を入れ替えた
  // 2通りで作り、どちらでも D の companionOf が id の小さい親になることを縛る。
  it.each([
    ["O-B, O-C, B-D, C-D の順に張る", false],
    ["O-C, O-B, C-D, B-D の順に張る（逆）", true],
  ] as const)(
    "菱形（%s）でも D の companionOf は B と C のうち id の小さいほう",
    async (_name, reversed) => {
      const { runtime, memoryStore, vectorStore, relationStore } = await buildTestRuntime({
        withRelationStore: true,
      });
      const ctx: Ctx = { tenantId: TENANT };
      const make = () =>
        memoryStore.createMemory(
          ctx,
          buildNewMemoryFixture({
            tenantId: TENANT,
            embeddingStatus: "pending",
          }),
        );
      const o = await make();
      await vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, o.id, [1, 0, 0]);
      // 段3の frontier は `getMany` の返す順（ORDER BY なし＝ヒープ順＝作った順）に並ぶ。
      // 「作った順で先の B」が id の大きいほうになる組を選ぶ（順に頼った実装なら B が親になって赤）。
      const b = await make();
      let c = await make();
      while (!(b.id > c.id)) c = await make();
      const d = await make();
      // 3件以上の contested は markContestedGroup でしか作れない（createMemory は拒む）。
      // 4件の完全な群を作ってから、全辺を外して菱形だけを張る順を選んで張り直す。
      await runtime.markContestedGroup!(ctx, [o.id, b.id, c.id, d.id]);
      const all = [o.id, b.id, c.id, d.id];
      for (const x of all) {
        for (const y of all) {
          if (x !== y) await relationStore.unlink(ctx, "contradicts", x, y);
        }
      }
      const link2 = async (x: string, y: string) => {
        await relationStore.link(ctx, "contradicts", x, y);
        await relationStore.link(ctx, "contradicts", y, x);
      };
      const [first, second] = reversed ? [c, b] : [b, c];
      await link2(o.id, first.id);
      await link2(o.id, second.id);
      await link2(first.id, d.id);
      await link2(second.id, d.id);

      const result = await runtime.recall(ctx, { vector: [1, 0, 0] });

      const smaller = b.id < c.id ? b.id : c.id;
      const byId = new Map(result.memories.map((m) => [m.memoryId, m]));
      expect(byId.get(d.id)?.retrievedVia).toBe("mandatory_companion");
      expect(byId.get(d.id)?.companionOf).toBe(smaller);
      expect(byId.get(b.id)?.companionOf).toBe(o.id);
      expect(byId.get(c.id)?.companionOf).toBe(o.id);
    },
  );

  it("鎖 a-b-c の真ん中の b が（archived で）群を離れていれば、a を引いても b の先の c は同伴に入らない", async () => {
    const { runtime, memoryStore, vectorStore, relationStore } = await buildTestRuntime({
      withRelationStore: true,
    });
    const ctx: Ctx = { tenantId: TENANT };
    // b は無期限（誰とでも重なる）、a は今も有効な窓、c は a と重ならない過去の窓——
    // a-b・b-c の辺だけが張られ、a-c には辺が無い。
    const a = await createEmbeddedMemory(memoryStore, vectorStore, ctx, [1, 0, 0], {
      validFrom: new Date("2025-06-01T00:00:00Z"),
      validUntil: null,
    });
    const b = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        embeddingStatus: "pending",
        validFrom: null,
        validUntil: null,
      }),
    );
    const c = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        embeddingStatus: "pending",
        validFrom: new Date("2020-01-01T00:00:00Z"),
        validUntil: new Date("2021-01-01T00:00:00Z"),
      }),
    );
    await runtime.markContestedGroup!(ctx, [a.id, b.id, c.id]);
    const related = await relationStore.listRelated(ctx, a.id, "contradicts");
    expect(related.map((r) => r.memoryId)).toEqual([b.id]); // 前提: a は b とだけ直接つながる。

    await memoryStore.updateStatus(ctx, b.id, "archived");

    const result = await runtime.recall(ctx, { vector: [1, 0, 0] });
    const ids = result.memories.map((m) => m.memoryId);

    expect(ids).not.toContain(b.id);
    expect(ids).not.toContain(c.id);
  });

  it("attributes で絞った recall では、群の同伴のうち attributes が絞りの外の1件は入らない", async () => {
    const { runtime, memoryStore, vectorStore } = await buildTestRuntime({
      withRelationStore: true,
    });
    const ctx: Ctx = { tenantId: TENANT };
    const a = await createEmbeddedMemory(memoryStore, vectorStore, ctx, [1, 0, 0], {
      attributes: { team: "x" },
    });
    const b = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        embeddingStatus: "pending",
        attributes: { team: "y" },
      }),
    );
    const c = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        embeddingStatus: "pending",
        attributes: { team: "x" },
      }),
    );
    await runtime.markContestedGroup!(ctx, [a.id, b.id, c.id]);

    const result = await runtime.recall(ctx, { vector: [1, 0, 0], attributes: { team: "x" } });
    const ids = result.memories.map((m) => m.memoryId);

    expect(ids).toContain(a.id);
    expect(ids).toContain(c.id);
    expect(ids).not.toContain(b.id);
  });
});

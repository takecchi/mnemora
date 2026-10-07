import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx, LLMProvider, RecallQuery } from "@mnemora/core";
import { createRuntime } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import {
  closeTestClient,
  getTestClient,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
} from "./test-db.js";

/**
 * 連想枠にも忘却ゲートと `validAt` ゲートが掛かることを、本物の Postgres + pgvector で実測する。core の歯は `FakeVectorStore`（`VectorFilter` の各欄を自前で適用する擬似物）に対するもので、`PostgresVectorStore` が連想枠の呼び出しでも
 * `decayFloorAtAfter`/`decayFloorSeqAfter`/`decayFloorAnyAxis` を実際に SQL へ効かせることは、2つを繋いだ経路として走っていなかった。
 *
 * 配置は連想枠でしか届かない三角形: クエリ `Q = [1,0,0]`、アンカー `A = [0.70710678,0.70710678,0]`（`cos(Q,A) ≈ 0.7071` で段1で拾われ、連想のアンカーになる）、
 * 相方 `B = [0,1,0]`（`cos(Q,B) = 0` ちょうどで段1では below_threshold に落ちるが、`cos(A,B) ≈ 0.7071` で既定 `minSimilarity` 0.5 以上）。
 * `B` が `result.memories` に現れたら、それは段3.5 を通ったということである（`retrievedVia: 'association'` と `associationOf` でも検算する）。
 *
 * ⚠ 段3.5 の候補は段2の閾値分割（`scoreThreshold`）を通らない（`associationUnits` を `units` の後ろに連結するのは閾値の後）ので、`recall-decay-cross-day.postgres.test.ts` が必要とした `scoreThreshold: 0` はこの歯では要らない。
 * `recall-decay-cross-day.postgres.test.ts` には足さない。
 */

const throwingLlm: LLMProvider = {
  complete: async () => {
    throw new Error("not used by association gate tests");
  },
  completeStructured: async () => {
    throw new Error("not used by association gate tests");
  },
};

/** クエリ・アンカー・相方の三角形（上の doc コメント参照）。 */
const QUERY_VECTOR = [1, 0, 0];
const ANCHOR_VECTOR = [0.70710678, 0.70710678, 0];
const ASSOCIATED_VECTOR = [0, 1, 0];

/** `buildNewMemoryFixture` の既定 `recordedAt`（2026-01-01）に時計を固定する（実時計のままだと、段2の decay でアンカー自身が below_threshold に化ける）。 */
const NOW = new Date("2026-01-01T00:00:00.000Z");
const FAR_FUTURE = new Date(NOW.getTime() + 1_000 * 60 * 60 * 24 * 365 * 100);

async function buildTestRuntime() {
  const { db } = await getTestClient();
  const memoryStore = new PostgresMemoryStore(db);
  const vectorStore = new PostgresVectorStore(db);
  const tenantSettingsStore = new PostgresTenantSettingsStore(db);
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
    tenantSettingsStore,
    llmProvider: throwingLlm,
    embeddingProvider: {
      space: TEST_EMBEDDING_SPACE,
      embed: async () => {
        throw new Error("この歯は RecallQuery.vector を直接渡すので embed を呼ばないはず");
      },
    },
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => NOW },
  });
  return { runtime, memoryStore, vectorStore, tenantSettingsStore };
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
    buildNewMemoryFixture({
      tenantId: ctx.tenantId,
      embeddingStatus: "ready",
      contentHash: `hash-${randomUUID()}`,
      ...overrides,
    }),
  );
  await vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, memory.id, vector);
  return memory;
}

/** アンカーと、連想でしか届かない相方を1組置く。 */
async function seedAnchorAndAssociated(
  memoryStore: PostgresMemoryStore,
  vectorStore: PostgresVectorStore,
  ctx: Ctx,
  associatedOverrides: Parameters<typeof buildNewMemoryFixture>[0],
  anchorOverrides: Parameters<typeof buildNewMemoryFixture>[0] = {},
) {
  const anchor = await createEmbeddedMemory(memoryStore, vectorStore, ctx, ANCHOR_VECTOR, {
    digest: "アンカー本文",
    decayFloorAt: FAR_FUTURE,
    ...anchorOverrides,
  });
  const associated = await createEmbeddedMemory(memoryStore, vectorStore, ctx, ASSOCIATED_VECTOR, {
    digest: "連想本文",
    ...associatedOverrides,
  });
  return { anchor, associated };
}

const ASSOCIATION_QUERY: RecallQuery = {
  vector: QUERY_VECTOR,
  limit: 10,
  association: { maxCount: 5, anchorCount: 1 },
};

describe("runtime.recall() の連想枠に忘却ゲートが掛かる — 本物の Postgres + pgvector（Issue #347）", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("対照（この配置が本当に段3.5 を通ることの検算）: 沈んでいない記憶は、連想枠から返る", async () => {
    const ctx: Ctx = { tenantId: `tenant-assoc-alive-${randomUUID()}` };
    const { runtime, memoryStore, vectorStore } = await buildTestRuntime();
    const { anchor, associated } = await seedAnchorAndAssociated(memoryStore, vectorStore, ctx, {
      decayFloorAt: FAR_FUTURE,
    });

    const result = await runtime.recall(ctx, ASSOCIATION_QUERY);

    const anchorEntry = result.memories.find((m) => m.memoryId === anchor.id);
    expect(anchorEntry?.retrievedVia).toBe("ann");
    const entry = result.memories.find((m) => m.memoryId === associated.id);
    expect(entry?.retrievedVia).toBe("association");
    expect(entry?.associationOf).toBe(anchor.id);
  });

  it("(甲) 完全に減衰しきった記憶は、連想枠からも返らない（既定のゲート）", async () => {
    const ctx: Ctx = { tenantId: `tenant-assoc-decayed-${randomUUID()}` };
    const { runtime, memoryStore, vectorStore } = await buildTestRuntime();
    const { anchor, associated } = await seedAnchorAndAssociated(memoryStore, vectorStore, ctx, {
      decayFloorAt: new Date(NOW.getTime() - 1_000),
    });

    const result = await runtime.recall(ctx, ASSOCIATION_QUERY);

    expect(result.memories.map((m) => m.memoryId)).toContain(anchor.id);
    expect(result.memories.map((m) => m.memoryId)).not.toContain(associated.id);
    expect(result.memories.some((m) => m.retrievedVia === "association")).toBe(false);
  });

  it("(乙) includeFullyDecayed: true を渡すと、実 adapter 経路でも連想枠から返る（opt-out）", async () => {
    const ctx: Ctx = { tenantId: `tenant-assoc-optout-${randomUUID()}` };
    const { runtime, memoryStore, vectorStore } = await buildTestRuntime();
    const { anchor, associated } = await seedAnchorAndAssociated(memoryStore, vectorStore, ctx, {
      decayFloorAt: new Date(NOW.getTime() - 1_000),
    });

    const result = await runtime.recall(ctx, { ...ASSOCIATION_QUERY, includeFullyDecayed: true });

    const entry = result.memories.find((m) => m.memoryId === associated.id);
    expect(entry?.retrievedVia).toBe("association");
    expect(entry?.associationOf).toBe(anchor.id);
  });

  it("(丙) 'activity' のテナントでは、壁時計が遠い未来でも decay_floor_seq を割った記憶は連想枠から返らない（ADR 0165 の2軸目）", async () => {
    const ctx: Ctx = { tenantId: `tenant-assoc-activity-${randomUUID()}` };
    const { runtime, memoryStore, vectorStore, tenantSettingsStore } = await buildTestRuntime();
    await tenantSettingsStore.setDecayClock(ctx, "activity");
    expect(await tenantSettingsStore.getActivitySeq(ctx)).toBe(0);

    const { anchor, associated } = await seedAnchorAndAssociated(
      memoryStore,
      vectorStore,
      ctx,
      {
        decayFloorAt: FAR_FUTURE, // 壁時計では絶対に沈まない——活動時計の軸だけが落とせる
        decayBaseSeq: 0,
        decayFloorSeq: 0, // nowSeq(=0) ちょうど。狭義の `>` が効かず沈んでいる
      },
      { decayBaseSeq: null, decayFloorSeq: null },
    );

    const result = await runtime.recall(ctx, ASSOCIATION_QUERY);

    expect(result.memories.map((m) => m.memoryId)).toContain(anchor.id);
    expect(result.memories.map((m) => m.memoryId)).not.toContain(associated.id);
  });

  it("(戊) 期限切れ（valid_until が過去）の記憶は、連想枠からも返らない（validAt ゲート、Issue #280 / ADR 0164）", async () => {
    const ctx: Ctx = { tenantId: `tenant-assoc-expired-${randomUUID()}` };
    const { runtime, memoryStore, vectorStore } = await buildTestRuntime();
    const { anchor, associated } = await seedAnchorAndAssociated(memoryStore, vectorStore, ctx, {
      decayFloorAt: FAR_FUTURE, // 忘却ゲートでは落ちない——validAt ゲートだけが落とせる
      validUntil: new Date(NOW.getTime() - 1_000),
    });

    const result = await runtime.recall(ctx, ASSOCIATION_QUERY);

    expect(result.memories.map((m) => m.memoryId)).toContain(anchor.id);
    expect(result.memories.map((m) => m.memoryId)).not.toContain(associated.id);
  });

  it("(己) includeOutsideValidity: true を渡すと、実 adapter 経路でも連想枠から返る（opt-out）", async () => {
    const ctx: Ctx = { tenantId: `tenant-assoc-validity-optout-${randomUUID()}` };
    const { runtime, memoryStore, vectorStore } = await buildTestRuntime();
    const { anchor, associated } = await seedAnchorAndAssociated(memoryStore, vectorStore, ctx, {
      decayFloorAt: FAR_FUTURE,
      validUntil: new Date(NOW.getTime() - 1_000),
    });

    const result = await runtime.recall(ctx, {
      ...ASSOCIATION_QUERY,
      includeOutsideValidity: true,
    });

    const entry = result.memories.find((m) => m.memoryId === associated.id);
    expect(entry?.retrievedVia).toBe("association");
    expect(entry?.associationOf).toBe(anchor.id);
  });

  it("(丁) 対照: 同じ記憶を 'wall'（既定）のテナントで引くと、活動時計の床は無視され連想枠から返る", async () => {
    const ctx: Ctx = { tenantId: `tenant-assoc-wall-${randomUUID()}` };
    const { runtime, memoryStore, vectorStore } = await buildTestRuntime();
    const { associated } = await seedAnchorAndAssociated(memoryStore, vectorStore, ctx, {
      decayFloorAt: FAR_FUTURE,
      decayBaseSeq: 0,
      decayFloorSeq: 0,
    });

    const result = await runtime.recall(ctx, ASSOCIATION_QUERY);

    expect(result.memories.find((m) => m.memoryId === associated.id)?.retrievedVia).toBe(
      "association",
    );
  });

  /* `'either'` のテナントでは、片方の軸だけが生きている記憶は、どちらの向きでも連想枠から返る。両軸とも沈んでいれば返らない（`VectorFilter.decayFloorAnyAxis` は両方の境界が与えられているときに限り、その2つを OR で結ぶ）。 */
  it("(庚) 'either' のテナントでは、活動時計が沈んでいても壁時計が生きていれば、連想枠から返る", async () => {
    const ctx: Ctx = { tenantId: `tenant-assoc-either-activity-decayed-${randomUUID()}` };
    const { runtime, memoryStore, vectorStore, tenantSettingsStore } = await buildTestRuntime();
    await tenantSettingsStore.setDecayClock(ctx, "either");
    expect(await tenantSettingsStore.getActivitySeq(ctx)).toBe(0);

    const { anchor, associated } = await seedAnchorAndAssociated(
      memoryStore,
      vectorStore,
      ctx,
      {
        decayFloorAt: FAR_FUTURE, // 壁時計は生きている
        decayBaseSeq: 0,
        decayFloorSeq: 0, // 活動時計は沈んでいる（nowSeq(=0) ちょうど。ゲートは狭義の `>`）
      },
      { decayBaseSeq: null, decayFloorSeq: null },
    );

    const result = await runtime.recall(ctx, ASSOCIATION_QUERY);

    const entry = result.memories.find((m) => m.memoryId === associated.id);
    expect(entry?.retrievedVia).toBe("association");
    expect(entry?.associationOf).toBe(anchor.id);
  });

  it("(辛) 'either' のテナントでは、壁時計が沈んでいても活動時計が生きていれば、連想枠から返る（逆の向き）", async () => {
    const ctx: Ctx = { tenantId: `tenant-assoc-either-wall-decayed-${randomUUID()}` };
    const { runtime, memoryStore, vectorStore, tenantSettingsStore } = await buildTestRuntime();
    await tenantSettingsStore.setDecayClock(ctx, "either");
    expect(await tenantSettingsStore.getActivitySeq(ctx)).toBe(0);

    const { anchor, associated } = await seedAnchorAndAssociated(
      memoryStore,
      vectorStore,
      ctx,
      {
        decayFloorAt: new Date(NOW.getTime() - 1_000), // 壁時計は「いま」の1秒前に沈んでいる
        decayBaseSeq: 0,
        decayFloorSeq: 1, // 活動時計は生きている（decayFloorSeq(=1) > nowSeq(=0)）
      },
      { decayBaseSeq: null, decayFloorSeq: null },
    );

    const result = await runtime.recall(ctx, ASSOCIATION_QUERY);

    const entry = result.memories.find((m) => m.memoryId === associated.id);
    expect(entry?.retrievedVia).toBe("association");
    expect(entry?.associationOf).toBe(anchor.id);
  });

  it("(壬) 'either' のテナントでも、両方の軸で沈んでいれば、連想枠から返らない（OR は「常に通す」ではない）", async () => {
    const ctx: Ctx = { tenantId: `tenant-assoc-either-both-decayed-${randomUUID()}` };
    const { runtime, memoryStore, vectorStore, tenantSettingsStore } = await buildTestRuntime();
    await tenantSettingsStore.setDecayClock(ctx, "either");

    const { anchor, associated } = await seedAnchorAndAssociated(
      memoryStore,
      vectorStore,
      ctx,
      {
        decayFloorAt: new Date(NOW.getTime() - 1_000), // 壁時計も沈んでいる
        decayBaseSeq: 0,
        decayFloorSeq: 0, // 活動時計も沈んでいる
      },
      { decayBaseSeq: null, decayFloorSeq: null },
    );

    const result = await runtime.recall(ctx, ASSOCIATION_QUERY);

    // アンカーは返る（この配置が段3.5 まで届いていることの検算）。相方だけが落ちる。
    // ⚠ 段3.5 の後置フィルタ（core の `survivesDecayGate`）も同じ述語で落とすので、SQL の押し下げだけを外しても、この歯は緑のままである。押し下げと後置の両方を外したときに赤になる。
    expect(result.memories.map((m) => m.memoryId)).toContain(anchor.id);
    expect(result.memories.map((m) => m.memoryId)).not.toContain(associated.id);
    expect(result.memories.some((m) => m.retrievedVia === "association")).toBe(false);
  });
});

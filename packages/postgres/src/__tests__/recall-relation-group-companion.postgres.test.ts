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
});

import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx, EmbeddingProvider, LLMProvider, MemoryStatus } from "@mnemora/core";
import { createRuntime } from "@mnemora/core";
import { buildNewMemoryFixture, buildNewObservationFixture } from "@mnemora/testkit";
import { InMemoryMemoryStore, InMemoryVectorStore } from "@mnemora/testkit/fixtures";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { embeddingSpaceTableName } from "../embedding-space-table.js";
import {
  captureClientQuery,
  closeTestClient,
  explainCaptured,
  getTestClient,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
  seededRandom,
} from "./test-db.js";

/**
 * 段階4「想起」・段階5「説明」の完了条件を、擬似物ではなく本物の Postgres + pgvector に対して検査する（擬似物のほうが本物より偶然厳しいことがあるので、必ず本物に通す）。
 *
 * ここで検査すること:
 * - 段1の ANN クエリが実際に HNSW 索引を使うこと（`runtime.recall()` の実行経路そのものを EXPLAIN する。
 *   `vector-search-hnsw.test.ts` は `PostgresVectorStore.search` 単体を検査しているが、ここでは recall() 全体の配線が同じクエリ形を保っていることを確認する）。
 * - 被覆不変条件（groups の総和 == totalInScope）が、単一クエリ由来であること（構造的な検査: aggregateScope が1回の SQL 往復で完結すること）と、並行して書き込みが起きている最中でも成立すること。
 * - omitted の各 kind が実データに対して実際に発生すること。
 */

const TENANT = "recall-pg-tenant";
const TABLE = embeddingSpaceTableName(TEST_EMBEDDING_SPACE);

const throwingLlm: LLMProvider = {
  complete: async () => {
    throw new Error("not used by recall tests");
  },
  completeStructured: async () => {
    throw new Error("not used by recall tests");
  },
};

function makeEmbeddingProvider(opts: { shouldFail?: boolean } = {}): EmbeddingProvider {
  return {
    space: TEST_EMBEDDING_SPACE,
    embed: async (_ctx, texts) => {
      if (opts.shouldFail) {
        throw new Error("simulated embedding provider failure");
      }
      return texts.map(() => [1, 0, 0]);
    },
  };
}

async function buildTestRuntime(opts: { embeddingShouldFail?: boolean } = {}) {
  const { db } = await getTestClient();
  const memoryStore = new PostgresMemoryStore(db);
  const vectorStore = new PostgresVectorStore(db);
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
      // recall() 経路は event retention を読み書きしないため、呼ばれたら壊れる形で
      // 埋めておく（ダミーの他プロパティと同じ作法）。
      getEventRetention: async () => {
        throw new Error("recall.postgres.test.ts のダミーは getEventRetention を呼ばないはず");
      },
      setEventRetention: async () => {
        throw new Error("recall.postgres.test.ts のダミーは setEventRetention を呼ばないはず");
      },
    },
    llmProvider: throwingLlm,
    embeddingProvider: makeEmbeddingProvider({ shouldFail: opts.embeddingShouldFail }),
    hashContent: (content: string) => `sha256(${content})`,
    // buildNewMemoryFixture の既定 recordedAt（2026-01-01）に固定する。
    // 実時計のままだと、既定の halfLifeHours（720h=30日）に対して経過時間が何倍にもなり、decay で score.total がほぼ0まで落ちて below_threshold に化けてしまう。
    clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
  });
  return { runtime, memoryStore, vectorStore };
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

describe("runtime.recall() — 本物の Postgres + pgvector（roadmap.md 段階4/5）", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("段1の ANN クエリは EXPLAIN で HNSW 索引を使う（recall() 全体の実行経路として）", async () => {
    const { pool } = await getTestClient();
    const { runtime, memoryStore, vectorStore } = await buildTestRuntime();
    const ctx: Ctx = { tenantId: TENANT };
    const rand = seededRandom(20260905);

    for (let i = 0; i < 3000; i += 1) {
      await createEmbeddedMemory(memoryStore, vectorStore, ctx, [rand(), rand(), rand()]);
    }
    await pool.query(`ANALYZE ${TABLE}`);
    await pool.query("ANALYZE memories");

    const captured = await captureClientQuery(
      (text) => text.includes(TABLE) && /order by/i.test(text),
      () => runtime.recall(ctx, { vector: [0.5, 0.5, 0.5], limit: 10 }),
    );

    // 本番と同じ transaction の文脈で EXPLAIN する（test-db.ts の explainCaptured の doc コメント参照）。
    const plan = await explainCaptured(pool, captured);
    // ⚠ この2行はプランナの選択を assert している。版・統計・データ規模に依存する。
    // 赤くなったら疑うもの: (1) 自分の変更 (2) 実行中の Postgres のメジャー版 (3) ANALYZE / 統計情報。まず `origin/main` で対照を取ること。
    expect(plan).toMatch(/Index Scan.*using idx_memory_embeddings_hnsw/);
    expect(plan).not.toMatch(/Seq Scan/);
  }, 60_000);

  it("status ゲートは段1と同じ status IN ('active','contested')", async () => {
    const { runtime, memoryStore, vectorStore } = await buildTestRuntime();
    const ctx: Ctx = { tenantId: TENANT };
    const excluded: MemoryStatus[] = ["superseded", "archived", "forgotten"];
    for (const status of excluded) {
      await createEmbeddedMemory(memoryStore, vectorStore, ctx, [1, 0, 0], { status });
    }
    const included = await createEmbeddedMemory(memoryStore, vectorStore, ctx, [1, 0, 0], {
      status: "active",
    });

    const result = await runtime.recall(ctx, { vector: [1, 0, 0] });
    const ids = result.memories.map((m) => m.memoryId);
    expect(ids).toEqual([included.id]);
  });

  it("omitted: stage_skipped(empty_query_content) / stage_skipped(embedding_provider_unavailable)", async () => {
    const ctx: Ctx = { tenantId: TENANT };
    const { runtime: runtimeNoQuery } = await buildTestRuntime();
    const noQuery = await runtimeNoQuery.recall(ctx, {});
    expect(noQuery.omitted).toContainEqual({
      kind: "stage_skipped",
      stage: "candidate_generation",
      reason: "empty_query_content",
    });

    const { runtime: runtimeFailingEmbed } = await buildTestRuntime({ embeddingShouldFail: true });
    const failedEmbed = await runtimeFailingEmbed.recall(ctx, { text: "hello" });
    // 任意欄 `cause`（原因の種類）が付くので、既存の3欄だけを objectContaining で見る。
    expect(failedEmbed.omitted).toContainEqual(
      expect.objectContaining({
        kind: "stage_skipped",
        stage: "candidate_generation",
        reason: "embedding_provider_unavailable",
      }),
    );
  });

  it("omitted: filtered(archived) / filtered(superseded) / filtered(forgotten) / filtered(period) / not_indexed", async () => {
    const { runtime, memoryStore, vectorStore } = await buildTestRuntime();
    const ctx: Ctx = { tenantId: TENANT };

    // in-scope(active/contested かつ period 内)を2件(どちらも ready)にしておく。
    // not_indexed の FILTER 条件が壊れて逆転しても(例: <> と = を取り違えても)、in-scope の ready/pending が 1:1 のままだと件数が偶然一致してしまい、検査として機能しない。
    await createEmbeddedMemory(memoryStore, vectorStore, ctx, [1, 0, 0], { status: "active" });
    await createEmbeddedMemory(memoryStore, vectorStore, ctx, [0.9, 0.1, 0], { status: "active" });
    await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: TENANT, status: "archived" }),
    );
    // superseded と forgotten を非対称の件数にする（2件と1件）。
    // 1件ずつだと、取り違え（superseded/forgotten を入れ替えて数える）も束ねたまま（両方を1つの filtered omission に合算する）も見抜けない。
    await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: TENANT, status: "superseded" }),
    );
    await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: TENANT, status: "superseded" }),
    );
    await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: TENANT, status: "forgotten" }),
    );
    await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        occurredAt: new Date("2000-01-01T00:00:00.000Z"),
      }),
    );
    await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: TENANT, embeddingStatus: "pending" }),
    );

    const result = await runtime.recall(ctx, {
      vector: [1, 0, 0],
      occurredAfter: new Date("2020-01-01T00:00:00.000Z"),
    });

    expect(result.omitted).toContainEqual({
      kind: "filtered",
      condition: "archived",
      scopeRelation: "outside_scope",
      count: 1,
      countKind: "exact",
    });
    expect(result.omitted).toContainEqual({
      kind: "filtered",
      condition: "superseded",
      scopeRelation: "outside_scope",
      count: 2,
      countKind: "exact",
    });
    expect(result.omitted).toContainEqual({
      kind: "filtered",
      condition: "forgotten",
      scopeRelation: "outside_scope",
      count: 1,
      countKind: "exact",
    });
    expect(result.omitted).toContainEqual({
      kind: "filtered",
      condition: "period",
      scopeRelation: "outside_scope",
      count: 1,
      countKind: "exact",
    });
    expect(result.omitted).toContainEqual({
      kind: "not_indexed",
      reason: "pending",
      count: 1,
      countKind: "exact",
    });
  });

  it("⚠ ゼロベクトルの候補は scoreThreshold を 0 にしても返らない（ADR 0040）", async () => {
    // 契約: ゼロベクトルが絡む候補は recall() の結果に出ない。
    //
    // 既定の scoreThreshold（0.1）では「similarity 0（in-memory）」でも「NaN（Postgres）」でも落ちるので、差が観測できるのは閾値を 0 以下にしたときだけである。ここは 0 で測る。
    //
    // フィクスチャは非対称: ゼロベクトル1件に対して正常な候補2件を、互いに違う距離で置く。正常な候補が返ることを同時に見ないと、「閾値0では何も返らない」実装でも緑になる。
    const ctx: Ctx = { tenantId: `tenant-zero-vector-${randomUUID()}` };
    const { runtime, memoryStore, vectorStore } = await buildTestRuntime();
    const zero = await createEmbeddedMemory(memoryStore, vectorStore, ctx, [0, 0, 0], {
      digest: "ゼロベクトルの記憶",
      contentHash: `zero-${randomUUID()}`,
    });
    const near = await createEmbeddedMemory(memoryStore, vectorStore, ctx, [1, 0, 0], {
      digest: "近い記憶",
      contentHash: `near-${randomUUID()}`,
    });
    const far = await createEmbeddedMemory(memoryStore, vectorStore, ctx, [0, 1, 0], {
      digest: "遠い記憶",
      contentHash: `far-${randomUUID()}`,
    });

    const result = await runtime.recall(ctx, {
      vector: [1, 0, 0],
      scoreThreshold: 0,
      limit: 10,
    });
    const ids = result.memories.map((m) => m.memoryId);

    expect(ids).toContain(near.id);
    expect(ids).toContain(far.id);
    expect(ids).not.toContain(zero.id);
  });

  it("omitted: score_not_comparable（ゼロベクトルの候補、ADR 0044）", async () => {
    // 本物の pgvector で NaN を作る唯一の実用的な経路がゼロベクトルである（`<=>` はゼロベクトルに対してエラーではなく NaN を返す）。
    //
    // ⚠ `scoreThreshold: 0` で測る。既定の 0.1 では「返らない」ところまでは同じなので、`omitted` に出るかどうかの差が観測できない。
    const ctx: Ctx = { tenantId: `tenant-not-comparable-${randomUUID()}` };
    const { runtime, memoryStore, vectorStore } = await buildTestRuntime();
    // ⚠ 件数を 1 対 2 と違える。
    const zero = await createEmbeddedMemory(memoryStore, vectorStore, ctx, [0, 0, 0], {
      digest: "ゼロベクトル",
      contentHash: `z-${randomUUID()}`,
    });
    const near = await createEmbeddedMemory(memoryStore, vectorStore, ctx, [1, 0, 0], {
      digest: "近い",
      contentHash: `n-${randomUUID()}`,
    });
    const far = await createEmbeddedMemory(memoryStore, vectorStore, ctx, [0, 1, 0], {
      digest: "遠い",
      contentHash: `f-${randomUUID()}`,
    });

    const result = await runtime.recall(ctx, { vector: [1, 0, 0], limit: 10, scoreThreshold: 0 });
    const ids = result.memories.map((m) => m.memoryId);

    expect(ids).toContain(near.id);
    expect(ids).toContain(far.id);
    expect(ids).not.toContain(zero.id);

    expect(result.omitted).toContainEqual({
      kind: "score_not_comparable",
      count: 1,
      countKind: "exact",
    });

    const rescore = result.explain.stages.find((st) => st.stage === "rescore");
    const detail = rescore?.detail as { scored: number; passedThreshold: number } | undefined;
    const below = result.omitted.find((o) => o.kind === "below_threshold")?.count ?? 0;
    expect(detail!.passedThreshold + below + 1).toBe(detail!.scored);
  });

  it("⚠ 鳴ってはいけない側: ゼロベクトルが無ければ score_not_comparable は出ない", async () => {
    const ctx: Ctx = { tenantId: `tenant-comparable-${randomUUID()}` };
    const { runtime, memoryStore, vectorStore } = await buildTestRuntime();
    await createEmbeddedMemory(memoryStore, vectorStore, ctx, [1, 0, 0], {
      digest: "近い",
      contentHash: `n2-${randomUUID()}`,
    });
    await createEmbeddedMemory(memoryStore, vectorStore, ctx, [0, 1, 0], {
      digest: "遠い",
      contentHash: `f2-${randomUUID()}`,
    });

    for (const scoreThreshold of [undefined, 0]) {
      const result = await runtime.recall(ctx, {
        vector: [1, 0, 0],
        limit: 10,
        ...(scoreThreshold === undefined ? {} : { scoreThreshold }),
      });
      expect(result.omitted.some((o) => o.kind === "score_not_comparable")).toBe(false);
    }
  });

  it("omitted: below_threshold（閾値未満）", async () => {
    const { runtime, memoryStore, vectorStore } = await buildTestRuntime();
    const ctx: Ctx = { tenantId: TENANT };

    await createEmbeddedMemory(memoryStore, vectorStore, ctx, [0, 1, 0]);

    const result = await runtime.recall(ctx, { vector: [1, 0, 0] });
    expect(result.memories).toHaveLength(0);
    const omission = result.omitted.find((o) => o.kind === "below_threshold");
    expect(omission).toBeDefined();
  });

  it("omitted: over_limit と ann_truncated が同時に発生しうる", async () => {
    const { runtime, memoryStore, vectorStore } = await buildTestRuntime();
    const ctx: Ctx = { tenantId: TENANT };

    // クエリに近い候補を4件用意する。limit=1, overFetchFactor=3 -> k'=3。
    // ANN は4件中3件しか返さない(ann_truncated) が、返った3件はいずれも閾値を超えるため limit=1 を超えた2件が over_limit になる。
    await createEmbeddedMemory(memoryStore, vectorStore, ctx, [1, 0, 0]);
    await createEmbeddedMemory(memoryStore, vectorStore, ctx, [0.99, 0.01, 0]);
    await createEmbeddedMemory(memoryStore, vectorStore, ctx, [0.98, 0.02, 0]);
    await createEmbeddedMemory(memoryStore, vectorStore, ctx, [0.97, 0.03, 0]);

    // `ann_truncated` は「窓が埋まった」だけでは鳴らない。「窓の外が top-k へ入りえたか」まで判定してから鳴る。
    // この歯の主題は「2つの omission が同時に出うる」ことであって `ann_truncated` の鳴り方ではないので、鳴る側になる形（どの候補も持たないタグをクエリへ足し、上界を 1.1 倍にする）で作る。
    // association: null — 連想枠は既定 on。この歯は over_limit と ann_truncated が同時に発生しうることだけを検査する。
    // limit の外に押し出された3件はアンカーとの類似度が高いままなので連想の対象になりうる。この歯の対象外の効果を持ち込まないよう明示的に止める。
    const result = await runtime.recall(ctx, {
      vector: [1, 0, 0],
      limit: 1,
      overFetchFactor: 3,
      tags: ["どの候補も持っていないタグ"],
      association: null,
    });

    expect(result.memories).toHaveLength(1);
    expect(result.omitted).toContainEqual({
      kind: "over_limit",
      stage: "rescore",
      count: 2,
      countKind: "exact",
    });
    const truncated = result.omitted.find((o) => o.kind === "ann_truncated");
    if (truncated === undefined || truncated.kind !== "ann_truncated") {
      throw new Error("ann_truncated が積まれていない");
    }
    expect(truncated.certainty).toBe("loss_possible");
    expect(truncated.countKind).toBe("unknown");
  });

  it("段3/段4: 矛盾の同伴取得は予算に収まらなければペアごと落とす", async () => {
    const { runtime, memoryStore, vectorStore } = await buildTestRuntime();
    const ctx: Ctx = { tenantId: TENANT };

    // `createMemory` は `status: 'contested'` を `contestedWithId` 無しでは作れない（`ContestedWithoutCompanionError`）。
    // `status: 'contested'` を正しく（両側 CAS・相互参照・同一トランザクション）書く唯一の口は `markContestedPair` なので、まず両方を active で作り、それから相互に contested へ倒す。
    const b = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: TENANT, digest: "B".repeat(30) }),
    );
    const a = await createEmbeddedMemory(memoryStore, vectorStore, ctx, [1, 0, 0], {
      digest: "A".repeat(5),
    });
    await memoryStore.markContestedPair!(
      ctx,
      {
        id: a.id,
        event: {
          tenantId: TENANT,
          memoryId: a.id,
          kind: "updated",
          actor: { type: "system" },
          digestSnapshot: a.digest,
          meta: { reason: "contested" },
        },
      },
      {
        id: b.id,
        event: {
          tenantId: TENANT,
          memoryId: b.id,
          kind: "updated",
          actor: { type: "system" },
          digestSnapshot: b.digest,
          meta: { reason: "contested" },
        },
      },
    );

    const withoutBudget = await runtime.recall(ctx, { vector: [1, 0, 0] });
    const withoutBudgetIds = withoutBudget.memories.map((m) => m.memoryId);
    expect(withoutBudgetIds).toContain(a.id);
    expect(withoutBudgetIds).toContain(b.id);
    const companion = withoutBudget.memories.find((m) => m.memoryId === b.id);
    expect(companion?.retrievedVia).toBe("mandatory_companion");
    expect(companion?.companionOf).toBe(a.id);
    const indexA = withoutBudgetIds.indexOf(a.id);
    const indexB = withoutBudgetIds.indexOf(b.id);
    // ⚠ `indexOf` は見つからないとき `-1` を返すため、片方だけが結果から完全に消えた世界でも `Math.abs(indexA - indexB) === 1` が偶然成立しうる
    // （例: a だけ残り b が消えると `Math.abs(0 - (-1)) === 1`）。両方が実際に結果に含まれていること（`index >= 0`）を、この assert 自身の前提としても先に assert する。
    expect(indexA).toBeGreaterThanOrEqual(0);
    expect(indexB).toBeGreaterThanOrEqual(0);
    expect(Math.abs(indexA - indexB)).toBe(1);

    const withTightBudget = await runtime.recall(ctx, {
      vector: [1, 0, 0],
      budget: { maxMemoryChars: 10 },
    });
    const tightIds = withTightBudget.memories.map((m) => m.memoryId);
    expect(tightIds).not.toContain(a.id);
    expect(tightIds).not.toContain(b.id);
    expect(withTightBudget.omitted).toContainEqual({
      kind: "budget_dropped",
      count: 2,
      countKind: "exact",
    });
  });

  it("Issue #823（ADR 0203「これが覆るとしたら」3番の是正）: over_limit(stage:'rescore') に回った companion が段3の必須同伴取得で昇格すると、over_limit の Omission 自体が消える", async () => {
    const { runtime, memoryStore, vectorStore } = await buildTestRuntime();
    const ctx: Ctx = { tenantId: TENANT };

    // companion: クエリにほぼ一致する候補として ANN 経由で見つかる（段2で passed する）が、
    // owner よりわずかにスコアが低い。limit=1 なので owner だけが withinLimit に入り、
    // companion は段2の passed.slice(limit) で over_limit(stage:"rescore") に落ちる。
    const companion = await createEmbeddedMemory(memoryStore, vectorStore, ctx, [0.999, 0.001, 0], {
      digest: "companion",
    });
    // owner: クエリと完全一致。limit=1 なので withinLimit の1件を占める。
    const owner = await createEmbeddedMemory(memoryStore, vectorStore, ctx, [1, 0, 0], {
      digest: "owner",
    });
    // `createMemory` は contested を contestedWithId 無しでは作れない（`ContestedWithoutCompanionError`）ため、両方を active で作ってから `markContestedPair` で相互に contested へ倒す。
    await memoryStore.markContestedPair!(
      ctx,
      {
        id: owner.id,
        event: {
          tenantId: TENANT,
          memoryId: owner.id,
          kind: "updated",
          actor: { type: "system" },
          digestSnapshot: owner.digest,
          meta: { reason: "contested" },
        },
      },
      {
        id: companion.id,
        event: {
          tenantId: TENANT,
          memoryId: companion.id,
          kind: "updated",
          actor: { type: "system" },
          digestSnapshot: companion.digest,
          meta: { reason: "contested" },
        },
      },
    );

    // association: null — 連想枠は既定 on。この歯が検査したいのは段2の over_limit(stage:"rescore") と段3（必須の同伴取得）だけであり、
    // 連想が同じ候補を独立に拾い直すと検証が段3.5の挙動と混ざる。
    const result = await runtime.recall(ctx, {
      vector: [1, 0, 0],
      limit: 1,
      overFetchFactor: 10,
      association: null,
    });

    const returnedCompanion = result.memories.find((m) => m.memoryId === companion.id);
    expect(returnedCompanion).toBeDefined();
    expect(returnedCompanion?.retrievedVia).toBe("mandatory_companion");
    const returnedOwner = result.memories.find((m) => m.memoryId === owner.id);
    expect(returnedOwner).toBeDefined();
    expect(result.memories).toHaveLength(2);

    const overLimit = result.omitted.find((o) => o.kind === "over_limit" && o.stage === "rescore");
    expect(overLimit).toBeUndefined();
  });

  it("Issue #925（ADR 0203「引き受けた負債」2番の是正）: over_limit(stage:'rescore') に回った候補が段3.5（連想）で拾い直されると、over_limit の Omission 自体が消える", async () => {
    const { runtime, memoryStore, vectorStore } = await buildTestRuntime();
    const ctx: Ctx = { tenantId: TENANT };

    // A: クエリと完全一致。limit=1 なので withinLimit の1件を占め、連想のアンカーになる。
    const a = await createEmbeddedMemory(memoryStore, vectorStore, ctx, [1, 0, 0], {
      digest: "A",
    });
    // B: A にわずかに劣るだけ。limit=1 なので段2で over_limit(stage:"rescore") へ回る一方、A への類似度が連想の minSimilarity（既定 0.5）を軽々超えるため、
    // 段3.5 のアンカー A から拾い直され、retrievedVia:"association" として finalMemories に足される（A/B は contested のペアではない）。
    const b = await createEmbeddedMemory(memoryStore, vectorStore, ctx, [0.999, 0.001, 0], {
      digest: "B",
    });

    const result = await runtime.recall(ctx, {
      vector: [1, 0, 0],
      limit: 1,
      overFetchFactor: 10,
    });

    expect(result.memories).toHaveLength(2);
    const returnedA = result.memories.find((m) => m.memoryId === a.id);
    expect(returnedA).toBeDefined();
    expect(returnedA?.retrievedVia).toBe("ann");
    const returnedB = result.memories.find((m) => m.memoryId === b.id);
    expect(returnedB).toBeDefined();
    expect(returnedB?.retrievedVia).toBe("association");
    expect(returnedB?.associationOf).toBe(a.id);

    const overLimitAssociation = result.omitted.find(
      (o) => o.kind === "over_limit" && o.stage === "rescore",
    );
    expect(overLimitAssociation).toBeUndefined();
  });

  it("Issue #940（ADR 0203 追記3の是正）: 段3の必須同伴取得で候補集合に戻った over_limit(stage:'rescore') の候補が、段4の予算で改めて落ちると、over_limit(rescore) は消え budget_dropped だけに数えられる", async () => {
    const { runtime, memoryStore, vectorStore } = await buildTestRuntime();
    const ctx: Ctx = { tenantId: TENANT };

    // cand1: クエリと完全一致。limit=2 の1枠を占め、予算にちょうど収まる唯一の候補。
    const cand1 = await createEmbeddedMemory(memoryStore, vectorStore, ctx, [1, 0, 0], {
      digest: "C",
    });
    // companion: owner の対向。owner にさらに劣り、limit=2 の外——段2で
    // over_limit(stage:"rescore") に落ちるが、段3の必須同伴取得で owner の対向として
    // 候補集合に戻る。
    const companion = await createEmbeddedMemory(memoryStore, vectorStore, ctx, [0.99, 0.1411, 0], {
      digest: "COMPANION",
    });
    // owner: cand1 にわずかに劣るが、limit=2 のもう1枠を占める。
    const owner = await createEmbeddedMemory(memoryStore, vectorStore, ctx, [0.999, 0.0447, 0], {
      digest: "OWNER",
    });
    // `createMemory` は `status: 'contested'` を `contestedWithId` 無しでは作れない。両方を active で作ってから `markContestedPair` で相互に contested へ倒す。
    await memoryStore.markContestedPair!(
      ctx,
      {
        id: owner.id,
        event: {
          tenantId: TENANT,
          memoryId: owner.id,
          kind: "updated",
          actor: { type: "system" },
          digestSnapshot: owner.digest,
          meta: { reason: "contested" },
        },
      },
      {
        id: companion.id,
        event: {
          tenantId: TENANT,
          memoryId: companion.id,
          kind: "updated",
          actor: { type: "system" },
          digestSnapshot: companion.digest,
          meta: { reason: "contested" },
        },
      },
    );

    const result = await runtime.recall(ctx, {
      vector: [1, 0, 0],
      limit: 2,
      overFetchFactor: 10,
      association: null,
      // cand1 の digest（1文字）しか収まらない予算。owner+companion の単位（隣接性の
      // 不変条件で分割できない、docs/recall.md §8）は丸ごと budget_dropped になる。
      budget: { maxMemoryChars: cand1.digest.length },
    });

    expect(result.memories.map((m) => m.memoryId)).toEqual([cand1.id]);

    const overLimit = result.omitted.find((o) => o.kind === "over_limit" && o.stage === "rescore");
    expect(overLimit).toBeUndefined();

    const budgetDropped = result.omitted.find((o) => o.kind === "budget_dropped");
    expect(budgetDropped).toBeDefined();
    if (budgetDropped?.kind === "budget_dropped") {
      expect(budgetDropped.count).toBe(2);
    }
  });

  it("Issue #949（ADR 0203 追記3「範囲外と分かったこと」1番目の是正）: over_limit(stage:'rescore') の候補が段3.5（連想）の候補プールで maxCount の席を競り負けると、over_limit(rescore) からも差し引かれ over_limit(association) に1回だけ残る", async () => {
    const { runtime, memoryStore, vectorStore } = await buildTestRuntime();
    const ctx: Ctx = { tenantId: TENANT };

    // owner を [1, 0, 0]（クエリと完全一致）に置き、他の全候補は owner への類似度を
    // 単位ベクトルの第1成分 c だけで制御する（cos(vector(c), owner) = c）——owner が
    // クエリそのものなので、「クエリでの順位」と「アンカー owner への近さ」を同じ1つの
    // 数で同時に決められる（packages/core の同型テストと同じ設計）。
    const vec = (c: number): [number, number, number] => [c, Math.sqrt(1 - c * c), 0];

    const owner = await createEmbeddedMemory(memoryStore, vectorStore, ctx, vec(1.0), {
      digest: "owner",
    });
    // F1〜F4: limit=5 の残り4席を占め、withinLimit を owner+フィラーで満杯にする。
    const f1 = await createEmbeddedMemory(memoryStore, vectorStore, ctx, vec(0.95), {
      digest: "F1",
    });
    const f2 = await createEmbeddedMemory(memoryStore, vectorStore, ctx, vec(0.9), {
      digest: "F2",
    });
    const f3 = await createEmbeddedMemory(memoryStore, vectorStore, ctx, vec(0.85), {
      digest: "F3",
    });
    const f4 = await createEmbeddedMemory(memoryStore, vectorStore, ctx, vec(0.8), {
      digest: "F4",
    });
    // C1: limit=5 の外——over_limit(stage:"rescore") に回るが、owner への類似度
    // （0.65）が連想の minSimilarity（既定 0.5）を超えるので段3.5 の候補プールに入る。
    const c1 = await createEmbeddedMemory(memoryStore, vectorStore, ctx, vec(0.65), {
      digest: "C1",
    });
    // T: C1 と同じ理由で候補プールに入るが、owner への類似度（0.60）が C1（0.65）に
    // 劣るため、maxCount=1 の唯一の席を C1 に奪われる——「土俵に上がって競り負けた」形
    // （packages/core の同型テストの(a)）。
    const t = await createEmbeddedMemory(memoryStore, vectorStore, ctx, vec(0.6), {
      digest: "T",
    });

    // overFetchFactor=2.0: rankFetchCount = max(1, round(1*2)) = 2 —— C1・T の
    // associationHits（2件）が両方とも過取得の窓に入り、maxCount=1 の席を similarity で
    // 競う。anchorCount=1 で連想のアンカーを owner だけに絞る（F1〜F4 が
    // withinLimit に居るため既定の anchorCount=3 だとフィラーもアンカーになってしまう）。
    const result = await runtime.recall(ctx, {
      vector: [1, 0, 0],
      limit: 5,
      overFetchFactor: 2.0,
      association: { maxCount: 1, anchorCount: 1 },
    });

    expect(result.memories.map((m) => m.memoryId).sort()).toEqual(
      [owner.id, f1.id, f2.id, f3.id, f4.id, c1.id].sort(),
    );
    const returnedC1 = result.memories.find((m) => m.memoryId === c1.id);
    expect(returnedC1?.retrievedVia).toBe("association");
    expect(result.memories.some((m) => m.memoryId === t.id)).toBe(false);

    const overLimitRescore = result.omitted.find(
      (o) => o.kind === "over_limit" && o.stage === "rescore",
    );
    expect(overLimitRescore).toBeUndefined();

    const overLimitAssociation = result.omitted.find(
      (o) => o.kind === "over_limit" && o.stage === "association",
    );
    expect(overLimitAssociation).toBeDefined();
    if (overLimitAssociation?.kind === "over_limit") {
      expect(overLimitAssociation.count).toBe(1);
    }
  });

  it("段6: recallId が発行され、observe({kind:'memory_usage'}) から参照できる", async () => {
    const { runtime, memoryStore, vectorStore } = await buildTestRuntime();
    const ctx: Ctx = { tenantId: TENANT };
    const memory = await createEmbeddedMemory(memoryStore, vectorStore, ctx, [1, 0, 0]);

    const result = await runtime.recall(ctx, { vector: [1, 0, 0] });
    expect(result.recallId).toBeTruthy();

    const usageResult = await runtime.observe(ctx, {
      kind: "memory_usage",
      recallId: result.recallId,
      usedMemoryIds: [memory.id],
    });
    expect(usageResult.memoryIds).toEqual([memory.id]);
  });

  it("被覆不変条件: aggregateScope は単一の SQL 往復で完結する（構造的な検査）", async () => {
    const { pool } = await getTestClient();
    const { memoryStore } = await buildTestRuntime();
    const ctx: Ctx = { tenantId: TENANT };

    await memoryStore.createMemory(ctx, buildNewMemoryFixture({ tenantId: TENANT }));
    await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: TENANT, status: "archived" }),
    );

    let queryCount = 0;
    const originalQuery = pool.query.bind(pool);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pool as any).query = (...args: unknown[]) => {
      const [config] = args as [string | { text: string }];
      const text = typeof config === "string" ? config : config.text;
      if (text.includes("FROM memories")) {
        queryCount += 1;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (originalQuery as any)(...args);
    };

    try {
      await memoryStore.aggregateScope(ctx, {});
    } finally {
      pool.query = originalQuery;
    }

    // この歯は「群カウントと totalInScope を別クエリにした」瞬間に赤くなるはずである。
    expect(queryCount).toBe(1);
  });

  it("被覆不変条件: 並行して書き込みが起きている最中でも groups の総和 == totalInScope が崩れない", async () => {
    const { memoryStore } = await buildTestRuntime();
    const ctx: Ctx = { tenantId: TENANT };

    for (let i = 0; i < 20; i += 1) {
      await memoryStore.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: TENANT, subjectId: `user-${i % 3}` }),
      );
    }

    let stop = false;
    const writer = (async () => {
      let i = 0;
      while (!stop) {
        await memoryStore.createMemory(
          ctx,
          buildNewMemoryFixture({ tenantId: TENANT, subjectId: `user-${i % 5}` }),
        );
        i += 1;
      }
    })();

    try {
      for (let i = 0; i < 30; i += 1) {
        const aggregate = await memoryStore.aggregateScope(ctx, {});
        const sumOfGroups = aggregate.groups.reduce((sum, g) => sum + g.count, 0);
        expect(sumOfGroups).toBe(aggregate.totalInScope);
      }
    } finally {
      stop = true;
      await writer;
    }
  }, 60_000);

  it("Issue #857: vector: [] は Postgres でも Fake と同じ形の RecallResult になる（reject しない）", async () => {
    // 同じ入力 `{ vector: [] }` に対して、Postgres は `toVectorLiteral([])` が `"[]"` を作り、`::vector` キャストが「vector must have at least 1 dimension」で落ちうる。
    // Fake（`@mnemora/testkit/fixtures` の `InMemoryVectorStore`）は短い方の配列を 0 で zero-pad してから長さを揃えるため、空配列は暗黙にゼロベクトルとして扱われ、
    // ゼロベクトルは NaN 類似度になり候補に出ない経路にそのまま乗って正常に完走する。
    // この it は、その Fake の挙動（reject しない・memories: []・omitted に score_not_comparable が候補の件数ぶん出る）を Postgres 側でも確かめる。
    const ctx: Ctx = { tenantId: `tenant-857-${randomUUID()}` };
    const digest = "Issue #857 の再現データ";
    const contentHash = `issue-857-${randomUUID()}`;

    const {
      runtime: pgRuntime,
      memoryStore: pgMemoryStore,
      vectorStore: pgVectorStore,
    } = await buildTestRuntime();
    await createEmbeddedMemory(pgMemoryStore, pgVectorStore, ctx, [1, 0, 0], {
      digest,
      contentHash,
    });

    // Fake 側に、同じ ctx・同じ内容のデータを組む（`@mnemora/testkit/fixtures` は
    // 適合スイートの入力ではなく、`Runtime` を組み立てるための別入口——fixtures.ts 冒頭参照）。
    const fakeMemoryStore = new InMemoryMemoryStore();
    const fakeVectorStore = new InMemoryVectorStore(fakeMemoryStore);
    const fakeMemory = await fakeMemoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        embeddingStatus: "ready",
        digest,
        contentHash,
      }),
    );
    await fakeVectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, fakeMemory.id, [1, 0, 0]);
    const fakeRuntime = createRuntime({
      memoryStore: fakeMemoryStore,
      outboxStore: {
        claimBatch: async () => [],
        complete: async () => {},
        fail: async () => {},
      },
      vectorStore: fakeVectorStore,
      eventStore: {
        append: async (_ctx, e) => ({ id: "evt", ...e, at: e.at ?? new Date() }),
        get: async () => null,
        list: async () => [],
      },
      tenantSettingsStore: {
        getDefaultHalfLifeHours: async () => 720,
        getEventRetention: async () => {
          throw new Error("この it の Fake ダミーは getEventRetention を呼ばないはず");
        },
        setEventRetention: async () => {
          throw new Error("この it の Fake ダミーは setEventRetention を呼ばないはず");
        },
      },
      llmProvider: throwingLlm,
      embeddingProvider: makeEmbeddingProvider(),
      hashContent: (content: string) => `sha256(${content})`,
      clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
    });

    const fakeResult = await fakeRuntime.recall(ctx, { vector: [] });
    expect(fakeResult.memories).toEqual([]);
    const fakeNotComparable = fakeResult.omitted.find((o) => o.kind === "score_not_comparable");
    expect(fakeNotComparable).toEqual({
      kind: "score_not_comparable",
      count: 1,
      countKind: "exact",
    });

    const pgResult = await pgRuntime.recall(ctx, { vector: [] });
    expect(pgResult.memories).toEqual([]);
    const pgNotComparable = pgResult.omitted.find((o) => o.kind === "score_not_comparable");
    expect(pgNotComparable).toEqual(fakeNotComparable);
  });

  // `space.dimensions`（ここでは3）と長さが違うクエリベクトルは、空配列と同じ形で「比較不能」として扱う（新しい throw は足さない）。
  //
  // 保存 `[1,0,0]` に対して `[1,2]`（短い）・`[1,2,3,4]`（長い）は pgvector の「different vector dimensions」になりうる。
  // Fake は足りない側を `0` で zero-pad して計算を続け、意味の無い点数を普通のヒットとして返しうるので、adapter 間で挙動が割れる。
  // どちらの adapter でも `memories: []`・`omitted` に `score_not_comparable` が候補の件数ぶん出る。
  it.each([
    ["短い", [1, 2]],
    ["長い", [1, 2, 3, 4]],
  ] as const)(
    "Issue #867: 次元がずれたクエリ（%s、%j）は Postgres でも Fake と同じ score_not_comparable になる（reject しない）",
    async (_label, query) => {
      const ctx: Ctx = { tenantId: `tenant-867-${randomUUID()}` };
      const digest = "Issue #867 の再現データ";
      const contentHash = `issue-867-${randomUUID()}`;

      const {
        runtime: pgRuntime,
        memoryStore: pgMemoryStore,
        vectorStore: pgVectorStore,
      } = await buildTestRuntime();
      await createEmbeddedMemory(pgMemoryStore, pgVectorStore, ctx, [1, 0, 0], {
        digest,
        contentHash,
      });

      const fakeMemoryStore = new InMemoryMemoryStore();
      const fakeVectorStore = new InMemoryVectorStore(fakeMemoryStore);
      const fakeMemory = await fakeMemoryStore.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: ctx.tenantId,
          embeddingStatus: "ready",
          digest,
          contentHash,
        }),
      );
      await fakeVectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, fakeMemory.id, [1, 0, 0]);
      const fakeRuntime = createRuntime({
        memoryStore: fakeMemoryStore,
        outboxStore: {
          claimBatch: async () => [],
          complete: async () => {},
          fail: async () => {},
        },
        vectorStore: fakeVectorStore,
        eventStore: {
          append: async (_ctx, e) => ({ id: "evt", ...e, at: e.at ?? new Date() }),
          get: async () => null,
          list: async () => [],
        },
        tenantSettingsStore: {
          getDefaultHalfLifeHours: async () => 720,
          getEventRetention: async () => {
            throw new Error("この it の Fake ダミーは getEventRetention を呼ばないはず");
          },
          setEventRetention: async () => {
            throw new Error("この it の Fake ダミーは setEventRetention を呼ばないはず");
          },
        },
        llmProvider: throwingLlm,
        embeddingProvider: makeEmbeddingProvider(),
        hashContent: (content: string) => `sha256(${content})`,
        clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
      });

      const fakeResult = await fakeRuntime.recall(ctx, { vector: [...query] });
      expect(fakeResult.memories).toEqual([]);
      const fakeNotComparable = fakeResult.omitted.find((o) => o.kind === "score_not_comparable");
      expect(fakeNotComparable).toEqual({
        kind: "score_not_comparable",
        count: 1,
        countKind: "exact",
      });

      const pgResult = await pgRuntime.recall(ctx, { vector: [...query] });
      expect(pgResult.memories).toEqual([]);
      const pgNotComparable = pgResult.omitted.find((o) => o.kind === "score_not_comparable");
      expect(pgNotComparable).toEqual(fakeNotComparable);
    },
  );

  describe("runtime.recall() — RecalledMemory.basisLost（Issue #883、ADR 0342）本物の Postgres", () => {
    // `memories_check`: `provenance_kind IN ('stated','inferred')` のときは `source_observation_id IS NOT NULL` を要求する（`observations` への FK）。
    // `inferred` を作るにはまず本物の Observation を1件作っておく必要がある。
    async function createInferredMemory(
      memoryStore: PostgresMemoryStore,
      vectorStore: PostgresVectorStore,
      ctx: Ctx,
      vector: number[],
      digest: string,
      basisMemoryIds: string[],
    ) {
      const observation = await memoryStore.createObservation(
        ctx,
        buildNewObservationFixture({ tenantId: ctx.tenantId }),
      );
      return createEmbeddedMemory(memoryStore, vectorStore, ctx, vector, {
        digest,
        sourceObservationId: observation.id,
        provenance: {
          kind: "inferred",
          model: "test-model",
          promptVersion: "v1",
          basis: { memoryIds: basisMemoryIds, observationIds: [] },
          confidence: 0.9,
        },
      });
    }

    it("basis の相手を forget した後、inferred の記憶には basisLost: true が付く", async () => {
      const { runtime, memoryStore, vectorStore } = await buildTestRuntime();
      const ctx: Ctx = { tenantId: TENANT };

      const basis = await memoryStore.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: TENANT, digest: "basis-memory" }),
      );
      const inferred = await createInferredMemory(
        memoryStore,
        vectorStore,
        ctx,
        [1, 0, 0],
        "推論された記憶",
        [basis.id],
      );

      const forgetResult = await runtime.forget(ctx, { memoryId: basis.id });
      expect(forgetResult.outcomes[0]?.kind).toBe("forgotten");

      const result = await runtime.recall(ctx, { vector: [1, 0, 0] });
      const returned = result.memories.find((m) => m.memoryId === inferred.id);
      expect(returned).toBeDefined();
      expect(returned?.basisLost).toBe(true);
    });

    it("basis が active のままなら、basisLost キー自体が無い", async () => {
      const { runtime, memoryStore, vectorStore } = await buildTestRuntime();
      const ctx: Ctx = { tenantId: TENANT };

      const basis = await memoryStore.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: TENANT, digest: "basis-alive" }),
      );
      const inferred = await createInferredMemory(
        memoryStore,
        vectorStore,
        ctx,
        [1, 0, 0],
        "根拠が生きている推論",
        [basis.id],
      );

      const result = await runtime.recall(ctx, { vector: [1, 0, 0] });
      const returned = result.memories.find((m) => m.memoryId === inferred.id);
      expect(returned).toBeDefined();
      expect("basisLost" in returned!).toBe(false);
    });
  });
});

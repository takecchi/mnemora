import { Client } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Ctx } from "@mnemora/core";
import {
  describeEventStoreConformance,
  describeLexicalStoreConformance,
  describeMemoryStoreConformance,
  describeOutboxStoreConformance,
  describeRelationStoreConformance,
  describeTenantSettingsStoreConformance,
  describeVectorStoreConformance,
} from "@mnemora/testkit";
import { buildNewMemoryFixture, buildProvenanceFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresRelationStore } from "../relation-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { PostgresLexicalStore } from "../lexical-store.js";
import { PostgresEventStore } from "../event-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import { rowToOutboxJob, toPgTimestamp, type OutboxJobRow } from "../mapping.js";
import { registerEmbeddingSpace } from "../vector-space.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

describeMemoryStoreConformance({
  name: "postgres",
  createStore: async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    return new PostgresMemoryStore(db);
  },
  prepareRecallId: async (ctx: Ctx) => {
    const { db } = await getTestClient();
    // `returned_memories` は NOT NULL・DEFAULT 無し。このフィクスチャは `recall_usages.recall_id` の外部キーの相手が要るだけなので、
    // 「内訳ありの新規行」の最小形 `{ breakdownCaptured: true, memories: [] }` を渡す。
    const result = await db.execute(sql`
      INSERT INTO recalls (id, tenant_id, query, usage, index_band, returned_memories)
      VALUES (
        gen_random_uuid(), ${ctx.tenantId}, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
        '{"breakdownCaptured":true,"memories":[]}'::jsonb
      )
      RETURNING id
    `);
    return (result.rows[0] as unknown as { id: string }).id;
  },
  // ⚠ 生 SQL ではなく PostgresEventStore.list を通す。このフックは形式不正な id を渡される検査でも使われ、
  // 生 SQL のままだと memory_id が uuid 型なのでドライバのパースエラーになり、測りたい差ではなくフィクスチャ側の都合で赤くなる。
  // adapter が読むのと同じ経路で読めば、その経路のガード（isUuidLike）がそのまま効く。
  listEventsForMemory: async (ctx: Ctx, memoryId: string) => {
    const { db } = await getTestClient();
    return new PostgresEventStore(db).list(ctx, { memoryId });
  },
  // 積み直した `embed` ジョブを、運搬役が実際に claim できるところまで見る。`leaseMs` はこの検査の中だけの値。
  claimEmbedJobs: async (ctx: Ctx, now: Date) => {
    const { db } = await getTestClient();
    return new PostgresOutboxStore(db).claimBatch(ctx, {
      kinds: ["embed"],
      limit: 100,
      now,
      claimedBy: "conformance-requeue",
      leaseMs: 60_000,
    });
  },
  supportsSupersedeWithNewMemories: true,
  supportsAbortIfForgotten: true,
  supportsAbortIfSuperseded: true,
  supportsAbortIfAllConflicted: true,
  supportsPurgeExpiredEvents: true,
  supportsPurgeExpiredRecalls: true,
  supportsPurgeExpiredEventsByRetention: true,
  setEventRetention: async (ctx: Ctx, retention) => {
    const { db } = await getTestClient();
    await new PostgresTenantSettingsStore(db).setEventRetention(ctx, retention);
  },
  listPurgedEvents: async (ctx: Ctx) => {
    const { db } = await getTestClient();
    return new PostgresEventStore(db).list(ctx, { kind: "events_purged" });
  },
  supportsArchiveDecayed: true,
  supportsPurgeMemory: true,
  // v1.0.x の purge が残した状態（purged_at だけ立ち、tags・attributes・claim key・memory_labels が残る）は、生 SQL で作る。
  supportsScrubPurged: true,
  seedLegacyPurgedRow: async (ctx: Ctx, memoryId: string) => {
    const { db } = await getTestClient();
    await db.execute(sql`
      UPDATE memories
      SET content = '[purged]', digest = '[purged]', purged_at = now()
      WHERE tenant_id = ${ctx.tenantId} AND id = ${memoryId}
    `);
  },
  supportsMarkContestedPair: true,
  supportsResolveContestedPair: true,
  supportsRestoreSupersededBy: true,
  supportsPreviewRestoreSupersededBy: true,
  supportsOnlyMemoryIdsFilter: true,
  supportsLabels: true,
  supportsFindActiveByClaimKey: true,
  supportsFindContestedByClaimKey: true,
  supportsListActiveClaimPredicates: true,
  supportsResolveOrphanedContested: true,
  supportsEraseTenant: true,
  supportsMarkContestedGroup: true,
  supportsResolveContestedGroup: true,
  supportsCreateMemoriesWithOutboxAndEvents: true,
  supportsSupersedeCreatedEvents: true,
  listRelationsForMemory: async (ctx: Ctx, memoryId: string) => {
    const { db } = await getTestClient();
    return new PostgresRelationStore(db).listRelated(ctx, memoryId);
  },
  // `aggregateScope(..., { scopeAggregate: "skip" })` が `GROUP BY subject_id`（`agg` CTE）を含む SQL を発行しないことを、
  // `pool.query` の差し替えで計測する。
  countScopeAggregateQueries: async (fn) => {
    const { pool } = await getTestClient();
    let count = 0;
    const originalQuery = pool.query.bind(pool);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pool as any).query = (...args: unknown[]) => {
      const [config] = args as [string | { text: string }];
      const text = typeof config === "string" ? config : config.text;
      if (text.includes("GROUP BY subject_id")) {
        count += 1;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (originalQuery as any)(...args);
    };
    try {
      await fn();
    } finally {
      pool.query = originalQuery;
    }
    return count;
  },
});

describeRelationStoreConformance({
  name: "postgres",
  implementsListRelatedMany: true,
  createStore: async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    return new PostgresRelationStore(db);
  },
  prepareMemoryId: async (ctx: Ctx) => {
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const memory = await store.createMemory(ctx, buildNewMemoryFixture({ tenantId: ctx.tenantId }));
    return memory.id;
  },
});

describeEventStoreConformance({
  name: "postgres",
  createStore: async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    return new PostgresEventStore(db);
  },
  prepareMemoryId: async (ctx: Ctx) => {
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const memory = await store.createMemory(ctx, buildNewMemoryFixture({ tenantId: ctx.tenantId }));
    return memory.id;
  },
});

describeVectorStoreConformance({
  name: "postgres",
  createStore: async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    return new PostgresVectorStore(db);
  },
  prepareMemoryId: async (ctx: Ctx, attrs) => {
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const memory = await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        ...(attrs?.status !== undefined ? { status: attrs.status } : {}),
        ...(attrs?.subjectId !== undefined ? { subjectId: attrs.subjectId } : {}),
        ...(attrs?.decayFloorAt !== undefined ? { decayFloorAt: attrs.decayFloorAt } : {}),
        ...(attrs?.decayFloorSeq !== undefined ? { decayFloorSeq: attrs.decayFloorSeq } : {}),
        ...(attrs?.provenanceKind !== undefined
          ? { provenance: buildProvenanceFixture(attrs.provenanceKind) }
          : {}),
        ...(attrs?.occurredAt !== undefined ? { occurredAt: attrs.occurredAt } : {}),
        ...(attrs?.recordedAt !== undefined ? { recordedAt: attrs.recordedAt } : {}),
        ...(attrs?.validFrom !== undefined ? { validFrom: attrs.validFrom } : {}),
        ...(attrs?.validUntil !== undefined ? { validUntil: attrs.validUntil } : {}),
        ...(attrs?.attributes !== undefined ? { attributes: attrs.attributes } : {}),
        ...(attrs?.tags !== undefined ? { tags: attrs.tags } : {}),
      }),
    );
    return memory.id;
  },
  // 既定の space は `getTestClient()` が登録済みだが、「space 分離」の歯が使う2つ目の space はここで登録する。
  // `registerEmbeddingSpace` は `IF NOT EXISTS` でべき等なので、毎 `it()` で呼んでも問題ない。
  // テーブルの行は `resetTestDatabase()` の `TRUNCATE ... CASCADE` が `memories` への外部キー経由で空にする。
  prepareEmbeddingSpace: async (space) => {
    const { pool } = await getTestClient();
    await registerEmbeddingSpace(pool, space);
  },
  supportsGetVectors: true,
  supportsEraseTenant: true,
  supportsSearchMany: true,
});

describeLexicalStoreConformance({
  name: "postgres",
  createStore: async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    return new PostgresLexicalStore(db);
  },
  // `LexicalStore` は upsert/delete を持たない。`memories.content` の上の式索引を `search` するだけなので、書き込み口は `createMemory` の一択。
  prepareMemory: async (ctx: Ctx, attrs) => {
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const memory = await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        content: attrs.content,
        ...(attrs.status !== undefined ? { status: attrs.status } : {}),
        ...(attrs.subjectId !== undefined ? { subjectId: attrs.subjectId } : {}),
        ...(attrs.provenanceKind !== undefined
          ? { provenance: buildProvenanceFixture(attrs.provenanceKind) }
          : {}),
        ...(attrs.occurredAt !== undefined ? { occurredAt: attrs.occurredAt } : {}),
        ...(attrs.recordedAt !== undefined ? { recordedAt: attrs.recordedAt } : {}),
        ...(attrs.validFrom !== undefined ? { validFrom: attrs.validFrom } : {}),
        ...(attrs.validUntil !== undefined ? { validUntil: attrs.validUntil } : {}),
        ...(attrs.attributes !== undefined ? { attributes: attrs.attributes } : {}),
        ...(attrs.tags !== undefined ? { tags: attrs.tags } : {}),
      }),
    );
    return memory.id;
  },
});

describeOutboxStoreConformance({
  name: "postgres",
  createStore: async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    return new PostgresOutboxStore(db);
  },
  seedJob: async (ctx: Ctx, input) => {
    const { db } = await getTestClient();
    const result = await db.execute(sql`
      INSERT INTO outbox (id, tenant_id, kind, payload, available_at, attempts, created_at)
      VALUES (
        gen_random_uuid(),
        ${ctx.tenantId},
        ${input.kind},
        ${JSON.stringify(input.payload ?? {})}::jsonb,
        ${toPgTimestamp(input.availableAt ?? new Date())},
        0,
        now()
      )
      RETURNING *
    `);
    return rowToOutboxJob(result.rows[0] as unknown as OutboxJobRow);
  },
  peekJob: async (_ctx: Ctx, jobId: string) => {
    const { db } = await getTestClient();
    const result = await db.execute(sql`SELECT * FROM outbox WHERE id = ${jobId} LIMIT 1`);
    return result.rows.length > 0
      ? rowToOutboxJob(result.rows[0] as unknown as OutboxJobRow)
      : null;
  },
  /**
   * ⚠ この pool は `getTestClient()` がプロセス内で使い回す単一のものである。
   * 並行数が `max` を超えると、超えたぶんは接続待ちになり並行度が落ちる。
   */
  supportsRealConcurrency: true,
  supportsEraseTenant: true,
  supportsPurgeCompletedJobs: true,
});

describeTenantSettingsStoreConformance({
  name: "postgres",
  createStore: async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    return new PostgresTenantSettingsStore(db);
  },
  setDefaultHalfLifeHours: async (ctx: Ctx, hours: number) => {
    const { db } = await getTestClient();
    await db.execute(sql`
      INSERT INTO tenant_settings (tenant_id, default_half_life_hours, taxonomy_mode, created_at, updated_at)
      VALUES (${ctx.tenantId}, ${hours}, 'open', now(), now())
      ON CONFLICT (tenant_id) DO UPDATE SET default_half_life_hours = EXCLUDED.default_half_life_hours
    `);
  },
  supportsDecayClock: true,
  // 本番の書き込み口を直接呼ぶ（生 SQL の UPSERT で行を作らない）。
  // `PostgresTenantSettingsStore` はステートレスなので、新しいインスタンスを作っても `createStore()` が返したものと同じ DB 行を指す。
  setDefaultHalfLifeRecalls: async (ctx: Ctx, recalls: number) => {
    const { db } = await getTestClient();
    await new PostgresTenantSettingsStore(db).setDefaultHalfLifeRecalls(ctx, recalls);
  },
  // `getActivitySeq` は読み出し専用で、進める唯一の口は `createRecall({ advanceActivityClock: true })`。
  // 同じ DB（`tenant_activity`）を共有するので、別 adapter でも書いた値がそのまま読み直せる。
  advanceActivitySeq: async (ctx: Ctx) => {
    const { db } = await getTestClient();
    await new PostgresMemoryStore(db).createRecall(ctx, {
      tenantId: ctx.tenantId,
      subjectId: null,
      query: { text: "fixture" },
      budget: null,
      omitted: [],
      usage: {
        chars: 0,
        estimatedTokens: 0,
        counter: "heuristic",
        byTier: { full: 0, digest: 0, index: 0 },
        indexChars: 0,
      },
      indexBand: { groups: [], totalInScope: 0, countKind: "exact" },
      explain: { stages: [] },
      returnedMemories: [],
      advanceActivityClock: true,
    });
  },
  advanceSubjectActivitySeq: async (ctx: Ctx, subjectId: string) => {
    const { db } = await getTestClient();
    await new PostgresMemoryStore(db).createRecall(ctx, {
      tenantId: ctx.tenantId,
      subjectId,
      query: { text: "fixture" },
      budget: null,
      omitted: [],
      usage: {
        chars: 0,
        estimatedTokens: 0,
        counter: "heuristic",
        byTier: { full: 0, digest: 0, index: 0 },
        indexChars: 0,
      },
      indexBand: { groups: [], totalInScope: 0, countKind: "exact" },
      explain: { stages: [] },
      returnedMemories: [],
      advanceActivityClock: { scope: "subject", subjectId },
    });
  },
  supportsTaxonomyMode: true,
  supportsEraseTenant: true,
});

/**
 * SQL に `Date` を渡す口は、すべて `toPgTimestamp`（UTC の文字列）を通す。node-postgres は `Date` のパラメータを
 * プロセスのローカル時刻の文字列にして時差を分に切り捨てるので、素の `Date` が `pg` まで届くと、
 * 地方平均時の時代の日時が秒単位でずれて保存される。個別の口の歯は memory の insert と event の append/list だけを見るので、
 * 適合テストが一巡する間に発行されたすべてのクエリの束縛値を見て、`Date` のインスタンスが1つでも届いたら、その SQL の頭を名指しして落とす。
 */
const rawDateParamSites = new Set<string>();
const originalClientQuery = Client.prototype.query;
beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Client.prototype as any).query = function (this: Client, ...args: unknown[]) {
    const [config, params] = args as [
      string | { text: string; values?: unknown[] },
      unknown[] | undefined,
    ];
    const values = params ?? (typeof config === "string" ? undefined : config.values);
    if (Array.isArray(values) && values.some((v) => v instanceof Date)) {
      const text = typeof config === "string" ? config : config.text;
      rawDateParamSites.add(text.replace(/\s+/g, " ").trim().slice(0, 100));
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (originalClientQuery as any).apply(this, args);
  };
});

// 上の適合テストがすべて終わった後（同じファイルの中では、登録順に直列で走る）に検査する。
it("適合テストが一巡する間に、素の Date が pg の束縛値へ届いた口は無い（Issue #1040）", () => {
  Client.prototype.query = originalClientQuery;
  expect([...rawDateParamSites]).toEqual([]);
});

afterAll(async () => {
  await closeTestClient();
});

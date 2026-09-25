import { sql, type SQL } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type {
  AggregateScopeOptions,
  Ctx,
  Memory,
  MemoryId,
  RecallScope,
  ScopeAggregate,
} from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import type { Db } from "../client.js";
import { PostgresMemoryStore } from "../memory-store.js";
import {
  captureClientQuery,
  closeTestClient,
  explainCaptured,
  getTestClient,
  resetTestDatabase,
} from "./test-db.js";

/**
 * Issue #355 / ADR 0307: `PostgresMemoryStore.aggregateScope` を
 * 「各行の述語を1回だけ計算し `GROUP BY subject_id` で1パスに畳む」形へ書き換えた
 * （`memory-store.ts` の doc コメント「単一パス書き換え」節）。この歯は、
 * **書き換え前の実装が返していたのとビット単位で同じ結果を、書き換え後の実装が
 * 返し続けること**を検査する——公開 API・返り値・既定挙動は1バイトも変えていない、
 * という主張の根拠である。
 *
 * `oracleAggregateScope` は、本 PR が分岐した時点（`f3b3516`）の
 * `PostgresMemoryStore.aggregateScope` の SQL を**そのまま書き写した**参照実装である。
 * ⛔ **この関数は書き換えない**——「旧実装が何を返していたか」の固定された記録として、
 * 新実装（`memory-store.ts`）の変更から独立に保つ。
 *
 * **⚠ 唯一の例外（2026-09-25、Issue #201 PR-B、
 * [ADR 0323](../../../docs/decisions/0323-taxonomy-recall-filter.md)）**:
 * `ScopeAggregate.filteredTaxonomy` が新設の**必須**フィールドになったため、
 * この関数の返り値もこの型を満たすには何かを書かなければ型検査が通らない。
 * **SQL・計算ロジックは1行も変えていない**——`filteredTaxonomy: { count: 0,
 * countKind: 'exact' }` を返り値の末尾に固定値として足しただけである。当時の実装は
 * taxonomy という概念自体を持たなかったので「0」以外の値を計算しようがない
 * （この歯のどのフィクスチャも `scope.labels` を渡さないため、新実装側の
 * `filteredTaxonomy.count` も常に0になり、比較は成立する）。
 */

const TENANT = "agg-scope-oracle-tenant";
const EMPTY_TENANT = "agg-scope-oracle-empty-tenant";

async function oracleAggregateScope(
  db: Db,
  ctx: Ctx,
  scope: RecallScope,
  opts?: AggregateScopeOptions,
): Promise<ScopeAggregate> {
  const subjectFilter =
    scope.subjectId !== undefined
      ? scope.includeSubjectless === true
        ? sql`AND (subject_id = ${scope.subjectId} OR subject_id IS NULL)`
        : sql`AND subject_id = ${scope.subjectId}`
      : sql``;
  const occurredAfter = scope.occurredAfter ?? null;
  const occurredBefore = scope.occurredBefore ?? null;

  const inPeriod = sql`(
      ${occurredAfter}::timestamptz IS NULL OR COALESCE(occurred_at, recorded_at) >= ${occurredAfter}::timestamptz
    ) AND (
      ${occurredBefore}::timestamptz IS NULL OR COALESCE(occurred_at, recorded_at) <= ${occurredBefore}::timestamptz
    )`;

  const validAt = scope.validAt ?? null;
  const isValid = sql`(
      ${validAt}::timestamptz IS NULL OR (
        (valid_from IS NULL OR valid_from <= ${validAt}::timestamptz)
        AND (valid_until IS NULL OR valid_until > ${validAt}::timestamptz)
      )
    )`;
  const isExpired = sql`(
      ${validAt}::timestamptz IS NOT NULL AND valid_until IS NOT NULL AND valid_until <= ${validAt}::timestamptz
    )`;
  const isNotYetValid = sql`(
      ${validAt}::timestamptz IS NOT NULL AND valid_from IS NOT NULL AND valid_from > ${validAt}::timestamptz
    )`;

  const decayFloorAtAfter = scope.decayFloorAtAfter;
  const decayFloorSeqAfter = scope.decayFloorSeqAfter;
  const wallAxisAlive =
    decayFloorAtAfter !== undefined
      ? sql`(decay_floor_at > ${decayFloorAtAfter}::timestamptz)`
      : undefined;
  const activityAxisAlive =
    decayFloorSeqAfter !== undefined
      ? sql`(decay_floor_seq IS NULL OR decay_floor_seq > ${decayFloorSeqAfter})`
      : undefined;
  let isDecayed: SQL;
  if (wallAxisAlive === undefined && activityAxisAlive === undefined) {
    isDecayed = sql`false`;
  } else if (
    scope.decayFloorAnyAxis === true &&
    wallAxisAlive !== undefined &&
    activityAxisAlive !== undefined
  ) {
    isDecayed = sql`(NOT ${wallAxisAlive} AND NOT ${activityAxisAlive})`;
  } else if (wallAxisAlive !== undefined && activityAxisAlive !== undefined) {
    isDecayed = sql`(NOT ${wallAxisAlive} OR NOT ${activityAxisAlive})`;
  } else if (wallAxisAlive !== undefined) {
    isDecayed = sql`(NOT ${wallAxisAlive})`;
  } else {
    isDecayed = sql`(NOT ${activityAxisAlive!})`;
  }

  const digestBand = opts?.digestBand;
  const excludeFilter = digestBand
    ? sql`AND NOT (id = ANY(${sql.param([...digestBand.excludeMemoryIds])}::uuid[]))`
    : sql``;
  const digestBandColumns = digestBand
    ? sql`,
        (
          SELECT coalesce(
            json_agg(
              json_build_object('memoryId', id, 'digest', digest)
              ORDER BY eff_time DESC, id DESC
            ),
            '[]'::json
          )
          FROM (
            SELECT id, digest, COALESCE(occurred_at, recorded_at) AS eff_time
            FROM scoped
            WHERE status IN ('active', 'contested') AND ${inPeriod} AND ${isValid} ${excludeFilter}
            ORDER BY COALESCE(occurred_at, recorded_at) DESC, id DESC
            LIMIT ${digestBand.limit}
          ) band
        ) AS digests,
        count(*) FILTER (
          WHERE status IN ('active', 'contested') AND ${inPeriod} AND ${isValid} ${excludeFilter}
        )::int AS digest_eligible_count`
    : sql``;

  const result = await db.execute(sql`
      WITH scoped AS (
        SELECT id, subject_id, digest, occurred_at, recorded_at, embedding_status, status,
               valid_from, valid_until, decay_floor_at, decay_floor_seq
        FROM memories
        WHERE tenant_id = ${ctx.tenantId} ${subjectFilter}
      )
      SELECT
        (
          SELECT coalesce(json_agg(json_build_object('key', key, 'count', cnt)), '[]'::json)
          FROM (
            SELECT subject_id AS key, count(*)::int AS cnt
            FROM scoped
            WHERE status IN ('active', 'contested') AND ${inPeriod} AND ${isValid}
            GROUP BY subject_id
          ) g
        ) AS groups,
        count(*) FILTER (
          WHERE status IN ('active', 'contested') AND ${inPeriod} AND ${isValid}
        )::int AS in_scope,
        count(*) FILTER (
          WHERE status IN ('active', 'contested') AND ${inPeriod} AND ${isValid} AND embedding_status = 'pending'
        )::int AS not_indexed_pending,
        count(*) FILTER (
          WHERE status IN ('active', 'contested') AND ${inPeriod} AND ${isValid} AND embedding_status = 'failed'
        )::int AS not_indexed_failed,
        count(*) FILTER (
          WHERE status IN ('active', 'contested') AND ${inPeriod} AND ${isValid} AND embedding_status = 'skipped'
        )::int AS not_indexed_skipped,
        count(*) FILTER (WHERE status = 'archived')::int AS archived,
        count(*) FILTER (WHERE status = 'superseded')::int AS superseded,
        count(*) FILTER (WHERE status = 'forgotten')::int AS forgotten,
        count(*) FILTER (
          WHERE status IN ('active', 'contested') AND NOT (${inPeriod})
        )::int AS period_filtered,
        count(*) FILTER (
          WHERE status IN ('active', 'contested') AND ${inPeriod} AND ${isExpired}
        )::int AS expired_filtered,
        count(*) FILTER (
          WHERE status IN ('active', 'contested') AND ${inPeriod} AND ${isNotYetValid}
        )::int AS not_yet_valid_filtered,
        count(*) FILTER (
          WHERE status IN ('active', 'contested') AND ${inPeriod} AND ${isValid} AND ${isDecayed}
        )::int AS decayed_filtered
        ${digestBandColumns}
      FROM scoped
    `);

  const row = result.rows[0] as unknown as {
    groups: { key: string | null; count: number }[];
    in_scope: number;
    not_indexed_pending: number;
    not_indexed_failed: number;
    not_indexed_skipped: number;
    archived: number;
    superseded: number;
    forgotten: number;
    period_filtered: number;
    expired_filtered: number;
    not_yet_valid_filtered: number;
    decayed_filtered: number;
    digests?: { memoryId: string; digest: string }[];
    digest_eligible_count?: number;
  };

  const groups: ScopeAggregate["groups"] = (row.groups ?? []).map((g) => ({
    axis: "subject" as const,
    key: g.key,
    count: g.count,
    countKind: "exact" as const,
  }));

  const digests: ScopeAggregate["digests"] = digestBand
    ? (row.digests ?? []).map((d) => ({
        memoryId: d.memoryId as MemoryId,
        digest: d.digest,
      }))
    : [];
  const digestEligible: ScopeAggregate["digestEligible"] = digestBand
    ? { count: row.digest_eligible_count ?? 0, countKind: "exact" }
    : { count: 0, countKind: "exact" };

  return {
    groups,
    totalInScope: row.in_scope,
    countKind: "exact",
    notIndexed: {
      pending: { count: row.not_indexed_pending, countKind: "exact" },
      failed: { count: row.not_indexed_failed, countKind: "exact" },
      skipped: { count: row.not_indexed_skipped, countKind: "exact" },
    },
    filteredArchived: { count: row.archived, countKind: "exact" },
    filteredSuperseded: { count: row.superseded, countKind: "exact" },
    filteredForgotten: { count: row.forgotten, countKind: "exact" },
    filteredPeriod: { count: row.period_filtered, countKind: "exact" },
    filteredExpired: { count: row.expired_filtered, countKind: "exact" },
    filteredNotYetValid: { count: row.not_yet_valid_filtered, countKind: "exact" },
    filteredDecayed: { count: row.decayed_filtered, countKind: "exact" },
    // Issue #201 PR-B（ADR 0323）: クラス doc の「唯一の例外」参照。
    filteredTaxonomy: { count: 0, countKind: "exact" },
    digests,
    digestEligible,
  };
}

/** groups は順序不定（doc コメント参照）——比較の前に key で安定ソートする。 */
function sortedGroups(groups: ScopeAggregate["groups"]): ScopeAggregate["groups"] {
  return [...groups].sort((a, b) => {
    const ak = a.key ?? "";
    const bk = b.key ?? "";
    return ak < bk ? -1 : ak > bk ? 1 : 0;
  });
}

function expectSameAggregate(actual: ScopeAggregate, oracle: ScopeAggregate): void {
  expect(sortedGroups(actual.groups)).toEqual(sortedGroups(oracle.groups));
  // digests は決定的な順序（ORDER BY eff_time DESC, id DESC）そのものが契約なので、
  // 配列全体を順序込みで比較する。
  expect(actual).toEqual({ ...oracle, groups: actual.groups });
}

describe("aggregateScope: 単一パス書き換えの等価性（Issue #355、本物の Postgres）", () => {
  let memoryStore: PostgresMemoryStore;
  let db: Db;

  beforeEach(async () => {
    const client = await getTestClient();
    db = client.db;
    memoryStore = new PostgresMemoryStore(client.db);
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  const ctx: Ctx = { tenantId: TENANT };

  /**
   * 各 FILTER 枝・subject 有無・NULL subject・decay の各軸を踏むデータセットを作る。
   * 返り値は、除外リストや contestedWithId に使う id を後段のテストが参照できるように、
   * ラベル付きで返す。
   */
  async function seedMatrix(): Promise<Record<string, Memory>> {
    const created: Record<string, Memory> = {};
    const put = async (label: string, overrides: Parameters<typeof buildNewMemoryFixture>[0]) => {
      created[label] = await memoryStore.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: TENANT, ...overrides }),
      );
    };

    const t = (iso: string) => new Date(iso);

    // --- subject s1: 通常の active、period 内、validity ゲート無し ---
    await put("s1-active-1", {
      subjectId: "s1",
      status: "active",
      occurredAt: t("2026-01-10T00:00:00Z"),
      recordedAt: t("2026-01-10T00:00:00Z"),
      digest: "s1 active 1",
      embeddingStatus: "ready",
    });
    await put("s1-active-2", {
      subjectId: "s1",
      status: "active",
      occurredAt: t("2026-01-12T00:00:00Z"),
      recordedAt: t("2026-01-12T00:00:00Z"),
      digest: "s1 active 2",
      embeddingStatus: "pending",
    });

    // --- subject s2: embeddingStatus 3種 ---
    await put("s2-pending", {
      subjectId: "s2",
      status: "active",
      embeddingStatus: "pending",
      occurredAt: t("2026-01-05T00:00:00Z"),
      recordedAt: t("2026-01-05T00:00:00Z"),
    });
    await put("s2-failed", {
      subjectId: "s2",
      status: "active",
      embeddingStatus: "failed",
      occurredAt: t("2026-01-06T00:00:00Z"),
      recordedAt: t("2026-01-06T00:00:00Z"),
    });
    await put("s2-skipped", {
      subjectId: "s2",
      status: "active",
      embeddingStatus: "skipped",
      occurredAt: t("2026-01-07T00:00:00Z"),
      recordedAt: t("2026-01-07T00:00:00Z"),
    });

    // --- subject s3: status 4分岐（archived/superseded/forgotten/contested） ---
    await put("s3-archived", { subjectId: "s3", status: "archived" });
    await put("s3-superseded", { subjectId: "s3", status: "superseded" });
    await put("s3-forgotten", { subjectId: "s3", status: "forgotten" });
    // contested は companion（実在する memory）を要求する（FK・ADR 0140）。
    await put("s3-companion", { subjectId: "s3", status: "active" });
    created["s3-contested"] = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        subjectId: "s3",
        status: "contested",
        contestedWithId: created["s3-companion"]!.id,
      }),
    );

    // --- NULL subject（主題なし） ---
    await put("null-subject-active", {
      subjectId: null,
      status: "active",
      occurredAt: t("2026-01-08T00:00:00Z"),
      recordedAt: t("2026-01-08T00:00:00Z"),
      digest: "null subject active",
    });
    await put("null-subject-archived", { subjectId: null, status: "archived" });

    // --- period: 窓の外（前・後） ---
    await put("s1-before-window", {
      subjectId: "s1",
      status: "active",
      occurredAt: t("2025-01-01T00:00:00Z"),
      recordedAt: t("2025-01-01T00:00:00Z"),
    });
    await put("s1-after-window", {
      subjectId: "s1",
      status: "active",
      occurredAt: t("2026-06-01T00:00:00Z"),
      recordedAt: t("2026-06-01T00:00:00Z"),
    });

    // --- validity: expired / not_yet_valid / valid ---
    await put("s1-expired", {
      subjectId: "s1",
      status: "active",
      validFrom: t("2025-01-01T00:00:00Z"),
      validUntil: t("2026-01-01T00:00:00Z"),
      occurredAt: t("2026-01-10T00:00:00Z"),
      recordedAt: t("2026-01-10T00:00:00Z"),
    });
    await put("s1-not-yet-valid", {
      subjectId: "s1",
      status: "active",
      validFrom: t("2026-06-01T00:00:00Z"),
      occurredAt: t("2026-01-10T00:00:00Z"),
      recordedAt: t("2026-01-10T00:00:00Z"),
    });
    await put("s1-still-valid", {
      subjectId: "s1",
      status: "active",
      validFrom: t("2025-01-01T00:00:00Z"),
      validUntil: t("2027-01-01T00:00:00Z"),
      occurredAt: t("2026-01-10T00:00:00Z"),
      recordedAt: t("2026-01-10T00:00:00Z"),
    });

    // --- decay: wall/activity 両軸、生存/減衰の組合せ ---
    await put("s4-wall-alive-seq-alive", {
      subjectId: "s4",
      status: "active",
      decayFloorAt: t("2026-02-01T00:00:00Z"),
      decayFloorSeq: 200,
      occurredAt: t("2026-01-10T00:00:00Z"),
      recordedAt: t("2026-01-10T00:00:00Z"),
    });
    await put("s4-wall-decayed-seq-alive", {
      subjectId: "s4",
      status: "active",
      decayFloorAt: t("2025-01-01T00:00:00Z"),
      decayFloorSeq: 200,
      occurredAt: t("2026-01-10T00:00:00Z"),
      recordedAt: t("2026-01-10T00:00:00Z"),
    });
    await put("s4-wall-alive-seq-decayed", {
      subjectId: "s4",
      status: "active",
      decayFloorAt: t("2026-02-01T00:00:00Z"),
      decayFloorSeq: 10,
      occurredAt: t("2026-01-10T00:00:00Z"),
      recordedAt: t("2026-01-10T00:00:00Z"),
    });
    await put("s4-wall-decayed-seq-decayed", {
      subjectId: "s4",
      status: "active",
      decayFloorAt: t("2025-01-01T00:00:00Z"),
      decayFloorSeq: 10,
      occurredAt: t("2026-01-10T00:00:00Z"),
      recordedAt: t("2026-01-10T00:00:00Z"),
    });
    await put("s4-seq-null-floor", {
      subjectId: "s4",
      status: "active",
      decayFloorAt: t("2025-01-01T00:00:00Z"),
      decayFloorSeq: null,
      occurredAt: t("2026-01-10T00:00:00Z"),
      recordedAt: t("2026-01-10T00:00:00Z"),
    });

    // --- digest tie: 同時刻（occurred_at 一致）で id DESC のタイブレークを踏む ---
    const tieTime = t("2026-01-11T00:00:00Z");
    await put("tie-a", {
      subjectId: "s1",
      status: "active",
      occurredAt: tieTime,
      recordedAt: tieTime,
      digest: "tie a",
    });
    await put("tie-b", {
      subjectId: "s1",
      status: "active",
      occurredAt: tieTime,
      recordedAt: tieTime,
      digest: "tie b",
    });

    return created;
  }

  it("subjectId 無し・opts 無し: 旧実装と完全一致する", async () => {
    await seedMatrix();
    const scope: RecallScope = {};
    const actual = await memoryStore.aggregateScope(ctx, scope);
    const oracle = await oracleAggregateScope(db, ctx, scope);
    expectSameAggregate(actual, oracle);
    // 被覆不変条件そのものも、この歯の副産物として確認しておく。
    expect(actual.groups.reduce((sum, g) => sum + g.count, 0)).toBe(actual.totalInScope);
  });

  it("subjectId 有り: 旧実装と完全一致する", async () => {
    await seedMatrix();
    const scope: RecallScope = { subjectId: "s1" };
    const actual = await memoryStore.aggregateScope(ctx, scope);
    const oracle = await oracleAggregateScope(db, ctx, scope);
    expectSameAggregate(actual, oracle);
  });

  it("subjectId 有り・存在しない subject: 旧実装と完全一致する（0件）", async () => {
    await seedMatrix();
    const scope: RecallScope = { subjectId: "no-such-subject" };
    const actual = await memoryStore.aggregateScope(ctx, scope);
    const oracle = await oracleAggregateScope(db, ctx, scope);
    expectSameAggregate(actual, oracle);
    expect(actual.totalInScope).toBe(0);
    expect(actual.groups).toEqual([]);
  });

  it("includeSubjectless: 旧実装と完全一致する（s1 + NULL subject）", async () => {
    await seedMatrix();
    const scope: RecallScope = { subjectId: "s1", includeSubjectless: true };
    const actual = await memoryStore.aggregateScope(ctx, scope);
    const oracle = await oracleAggregateScope(db, ctx, scope);
    expectSameAggregate(actual, oracle);
    // NULL subject の在る groups が実際に含まれることを確認する
    // （書き換えが GROUP BY で NULL を別グループとして保つことの直接証拠）。
    expect(actual.groups.some((g) => g.key === null)).toBe(true);
  });

  it("period（occurredAfter/occurredBefore）: 旧実装と完全一致する", async () => {
    await seedMatrix();
    const scope: RecallScope = {
      occurredAfter: new Date("2026-01-01T00:00:00Z"),
      occurredBefore: new Date("2026-02-01T00:00:00Z"),
    };
    const actual = await memoryStore.aggregateScope(ctx, scope);
    const oracle = await oracleAggregateScope(db, ctx, scope);
    expectSameAggregate(actual, oracle);
    expect(actual.filteredPeriod.count).toBeGreaterThan(0);
  });

  it("validAt（expired/not_yet_valid）: 旧実装と完全一致する", async () => {
    await seedMatrix();
    const scope: RecallScope = { validAt: new Date("2026-01-15T00:00:00Z") };
    const actual = await memoryStore.aggregateScope(ctx, scope);
    const oracle = await oracleAggregateScope(db, ctx, scope);
    expectSameAggregate(actual, oracle);
    expect(actual.filteredExpired.count).toBeGreaterThan(0);
    expect(actual.filteredNotYetValid.count).toBeGreaterThan(0);
  });

  it("decayFloorAtAfter（壁時計のみ）: 旧実装と完全一致する", async () => {
    await seedMatrix();
    const scope: RecallScope = { decayFloorAtAfter: new Date("2026-01-01T00:00:00Z") };
    const actual = await memoryStore.aggregateScope(ctx, scope);
    const oracle = await oracleAggregateScope(db, ctx, scope);
    expectSameAggregate(actual, oracle);
    expect(actual.filteredDecayed.count).toBeGreaterThan(0);
  });

  it("decayFloorSeqAfter（活動時計のみ、NULL floor は素通し）: 旧実装と完全一致する", async () => {
    await seedMatrix();
    const scope: RecallScope = { decayFloorSeqAfter: 50 };
    const actual = await memoryStore.aggregateScope(ctx, scope);
    const oracle = await oracleAggregateScope(db, ctx, scope);
    expectSameAggregate(actual, oracle);
  });

  it("decayFloorAnyAxis=true（OR）: 旧実装と完全一致する", async () => {
    await seedMatrix();
    const scope: RecallScope = {
      decayFloorAtAfter: new Date("2026-01-01T00:00:00Z"),
      decayFloorSeqAfter: 50,
      decayFloorAnyAxis: true,
    };
    const actual = await memoryStore.aggregateScope(ctx, scope);
    const oracle = await oracleAggregateScope(db, ctx, scope);
    expectSameAggregate(actual, oracle);
  });

  it("decayFloorAnyAxis 未指定・両軸あり（AND）: 旧実装と完全一致する", async () => {
    await seedMatrix();
    const scope: RecallScope = {
      decayFloorAtAfter: new Date("2026-01-01T00:00:00Z"),
      decayFloorSeqAfter: 50,
    };
    const actual = await memoryStore.aggregateScope(ctx, scope);
    const oracle = await oracleAggregateScope(db, ctx, scope);
    expectSameAggregate(actual, oracle);
  });

  it("digestBand あり・除外 id あり: 旧実装と完全一致する（tie は id DESC）", async () => {
    const rows = await seedMatrix();
    const scope: RecallScope = {};
    const opts: AggregateScopeOptions = {
      digestBand: {
        limit: 5,
        excludeMemoryIds: [rows["s1-active-2"]!.id],
      },
    };
    const actual = await memoryStore.aggregateScope(ctx, scope, opts);
    const oracle = await oracleAggregateScope(db, ctx, scope, opts);
    expectSameAggregate(actual, oracle);
    expect(actual.digests.length).toBe(5);
    expect(actual.digests.some((d) => d.memoryId === rows["s1-active-2"]!.id)).toBe(false);
    // tie-a/tie-b は occurred_at が同一 → id の降順で並ぶはず。オラクルと完全一致することで、
    // 新実装が `memories` を直接引いても同じタイブレークを保っていることが分かる。
  });

  it("digestBand あり・除外 id 無し（空配列）: 旧実装と完全一致する", async () => {
    await seedMatrix();
    const scope: RecallScope = { subjectId: "s1" };
    const opts: AggregateScopeOptions = { digestBand: { limit: 100, excludeMemoryIds: [] } };
    const actual = await memoryStore.aggregateScope(ctx, scope, opts);
    const oracle = await oracleAggregateScope(db, ctx, scope, opts);
    expectSameAggregate(actual, oracle);
    expect(actual.digestEligible.count).toBe(actual.totalInScope);
  });

  it("digestBand の limit が eligible 件数より小さい: 旧実装と完全一致する", async () => {
    await seedMatrix();
    const scope: RecallScope = {};
    const opts: AggregateScopeOptions = { digestBand: { limit: 2, excludeMemoryIds: [] } };
    const actual = await memoryStore.aggregateScope(ctx, scope, opts);
    const oracle = await oracleAggregateScope(db, ctx, scope, opts);
    expectSameAggregate(actual, oracle);
    expect(actual.digests.length).toBe(2);
  });

  it("空テナント: 旧実装と完全一致する（groups=[]・全カウント0、NULL ではない）", async () => {
    const emptyCtx: Ctx = { tenantId: EMPTY_TENANT };
    const scope: RecallScope = {};
    const opts: AggregateScopeOptions = { digestBand: { limit: 10, excludeMemoryIds: [] } };
    const actual = await memoryStore.aggregateScope(emptyCtx, scope, opts);
    const oracle = await oracleAggregateScope(db, emptyCtx, scope, opts);
    expectSameAggregate(actual, oracle);
    expect(actual.totalInScope).toBe(0);
    expect(actual.groups).toEqual([]);
    expect(actual.digests).toEqual([]);
    expect(actual.digestEligible).toEqual({ count: 0, countKind: "exact" });
  });

  it("組合せ: subjectId + includeSubjectless + period + validAt + decay 両軸 + digestBand", async () => {
    const rows = await seedMatrix();
    const scope: RecallScope = {
      subjectId: "s1",
      includeSubjectless: true,
      occurredAfter: new Date("2025-06-01T00:00:00Z"),
      occurredBefore: new Date("2026-03-01T00:00:00Z"),
      validAt: new Date("2026-01-15T00:00:00Z"),
      decayFloorAtAfter: new Date("2020-01-01T00:00:00Z"),
      decayFloorSeqAfter: 0,
    };
    const opts: AggregateScopeOptions = {
      digestBand: { limit: 10, excludeMemoryIds: [rows["tie-a"]!.id] },
    };
    const actual = await memoryStore.aggregateScope(ctx, scope, opts);
    const oracle = await oracleAggregateScope(db, ctx, scope, opts);
    expectSameAggregate(actual, oracle);
  });

  it("被覆不変条件: 書き換え後も並行書き込み下で groups の総和 == totalInScope が崩れない", async () => {
    await seedMatrix();

    let stop = false;
    const writer = (async () => {
      let i = 0;
      while (!stop) {
        await memoryStore.createMemory(
          ctx,
          buildNewMemoryFixture({ tenantId: TENANT, subjectId: `writer-${i % 4}` }),
        );
        i += 1;
      }
    })();

    try {
      for (let i = 0; i < 15; i += 1) {
        const aggregate = await memoryStore.aggregateScope(ctx, {});
        const sumOfGroups = aggregate.groups.reduce((sum, g) => sum + g.count, 0);
        expect(sumOfGroups).toBe(aggregate.totalInScope);
      }
    } finally {
      stop = true;
      await writer;
    }
  }, 60_000);

  /**
   * 赤→緑の記録（PR 本文参照）: 書き換え前の実装は `scoped` CTE を3回参照するため
   * Postgres が実体化し、`EXPLAIN` に `CTE Scan on scoped` が複数回現れる
   * （【実測】本 PR 分岐点 `f3b3516` の実装、`digestBand` を渡した呼び出しで
   * 3箇所に出現。テスト行数の多寡に関わらず、CTE の参照回数だけで決まる
   * planner の判断であることを、少数行のテストデータでも確認した）。
   * 書き換え後は `scoped`/`agg` とも1回しか参照されないため、Postgres は既定で
   * インライン化し、`CTE Scan` は1つも現れない。
   */
  it("構造的な検査: digestBand 込みでも `scoped`/`agg` を実体化しない（CTE Scan が無い）", async () => {
    const { pool } = await getTestClient();
    await seedMatrix();

    const captured = await captureClientQuery(
      (text) => text.includes("FROM memories") && text.includes("digest_eligible_count"),
      () => memoryStore.aggregateScope(ctx, {}, { digestBand: { limit: 5, excludeMemoryIds: [] } }),
    );
    const plan = await explainCaptured(pool, captured);
    expect(plan).not.toMatch(/CTE Scan/);
  });
});

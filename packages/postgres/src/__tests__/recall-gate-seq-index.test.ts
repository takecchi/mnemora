import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Ctx, MemoryStatus } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * `idx_memories_recall_gate_seq`（`(tenant_id, status, decay_floor_seq)`、`WHERE status IN ('active', 'contested')`）に、
 * `recall-gate-index.test.ts` と同じ3本立て（歯1 形・歯2 適用可能性・歯3 同値）を置く。冒頭の doc コメントを先に読むこと。
 *
 * 代表クエリ（`GATE_SELECT`）は、段1の実際のゲート述語 `(decay_floor_seq IS NULL OR decay_floor_seq > $n)` から NULL 分岐を外した素の範囲比較にしてある。
 * `IS NULL OR >` という複合条件は bitmap 経由でしか1本の索引にまとめられないので、`enable_bitmapscan = off` で歯2を測るとこの条件では索引が引けなくなり、
 * 測りたい性質（この索引が range 述語に使えるか）から外れてしまう。
 * NULL 分岐を含む実際のゲート述語の検査は、`packages/testkit` の `vector-store-conformance.ts`（`decayFloorSeqAfter`）に委ねる。
 */

const TENANT = "recall-gate-seq-tenant";

const ROW_COUNT = 4000;

const GATE_STATUSES = ["active", "contested"] as const;

/** 全行に同じ `decay_floor_seq`（非 null）を持たせ、閾値 `0` は常に真になるようにしてある。この歯が測るのは `status` の集合であって、`decay_floor_seq` の選択性ではない。 */
const FIXED_DECAY_FLOOR_SEQ = 1_000_000;

/** 段1の関門クエリ（活動時計版）。本番が実際に発行している SQL ではなく、NULL 分岐を持たない素の範囲比較にしてある。 */
const GATE_SELECT = `SELECT id, status FROM memories
       WHERE tenant_id = $1 AND status = ANY($2::text[]) AND decay_floor_seq > $3
       ORDER BY decay_floor_seq, id
       LIMIT 50`;

const GATE_PARAMS: [string, string[], number] = [TENANT, [...GATE_STATUSES], 0];

async function insertManyMemories(
  store: PostgresMemoryStore,
  ctx: Ctx,
  statuses: MemoryStatus[],
  pool: Pool,
) {
  // `createMemory` は `status: 'contested'` を `contestedWithId` 無しでは作れないので、対向を1件だけ用意する。
  const contestedCompanion = await store.createMemory(
    ctx,
    buildNewMemoryFixture({
      tenantId: ctx.tenantId,
      decayBaseSeq: 0,
      decayFloorSeq: FIXED_DECAY_FLOOR_SEQ,
      halfLifeRecalls: 720,
    }),
  );
  for (let i = 0; i < ROW_COUNT; i += 1) {
    const status = statuses[i % statuses.length]!;
    await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        status,
        contestedWithId: status === "contested" ? contestedCompanion.id : undefined,
        decayBaseSeq: 0,
        decayFloorSeq: FIXED_DECAY_FLOOR_SEQ,
        halfLifeRecalls: 720,
      }),
    );
  }
  // 統計情報が無いと、プランナが誤った行数見積もりで無関係な索引を選んでしまうことがある。
  await pool.query("ANALYZE memories");
}

type Forcing = "none" | "btreeIndex" | "seqscan";

async function withForcing<T>(
  pool: Pool,
  forcing: Forcing,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (forcing === "btreeIndex") {
      await client.query("SET LOCAL enable_seqscan = off");
      await client.query("SET LOCAL enable_bitmapscan = off");
    } else if (forcing === "seqscan") {
      await client.query("SET LOCAL enable_indexscan = off");
      await client.query("SET LOCAL enable_indexonlyscan = off");
      await client.query("SET LOCAL enable_bitmapscan = off");
    }
    return await fn(client);
  } finally {
    try {
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  }
}

async function explainGate(pool: Pool, forcing: Forcing): Promise<string> {
  return withForcing(pool, forcing, async (client) => {
    const result = await client.query(`EXPLAIN (FORMAT TEXT) ${GATE_SELECT}`, GATE_PARAMS);
    return result.rows.map((row: { "QUERY PLAN": string }) => row["QUERY PLAN"]).join("\n");
  });
}

async function gateRowIds(pool: Pool, forcing: Forcing): Promise<string[]> {
  return withForcing(pool, forcing, async (client) => {
    const result = await client.query<{ id: string }>(GATE_SELECT, GATE_PARAMS);
    return result.rows.map((row) => row.id);
  });
}

describe("idx_memories_recall_gate_seq（ADR 0165 / Issue #305）", () => {
  // 歯2・歯3は、同じ `insertManyMemories` の表を読むだけで書かない（`withForcing` は ROLLBACK で閉じる）ので、積むのは最初に1回だけにする。
  beforeAll(async () => {
    await resetTestDatabase();
    const { db, pool } = await getTestClient();
    await insertManyMemories(
      new PostgresMemoryStore(db),
      { tenantId: TENANT },
      ["active", "contested", "superseded", "archived", "forgotten"],
      pool,
    );
  }, 60_000);

  afterAll(async () => {
    await closeTestClient();
  });

  it("形: idx_memories_recall_gate_seq は (tenant_id, status, decay_floor_seq) の3列で、部分述語が拾う status は active と contested の2つちょうど", async () => {
    const { pool } = await getTestClient();

    const shape = await pool.query<{
      col0: string | null;
      col1: string | null;
      col2: string | null;
      natts: number;
      is_partial: boolean;
      pred_expr: string | null;
      is_valid: boolean;
    }>(
      `SELECT
         (SELECT attname FROM pg_attribute WHERE attrelid = i.indrelid AND attnum = i.indkey[0]) AS col0,
         (SELECT attname FROM pg_attribute WHERE attrelid = i.indrelid AND attnum = i.indkey[1]) AS col1,
         (SELECT attname FROM pg_attribute WHERE attrelid = i.indrelid AND attnum = i.indkey[2]) AS col2,
         i.indnatts AS natts,
         i.indpred IS NOT NULL AS is_partial,
         pg_get_expr(i.indpred, i.indrelid) AS pred_expr,
         i.indisvalid AS is_valid
       FROM pg_index i
       WHERE i.indexrelid = 'idx_memories_recall_gate_seq'::regclass`,
    );

    expect(shape.rows).toHaveLength(1);
    const row = shape.rows[0]!;
    expect([row.col0, row.col1, row.col2]).toEqual(["tenant_id", "status", "decay_floor_seq"]);
    expect(row.natts).toBe(3);
    expect(row.is_valid).toBe(true);

    expect(row.is_partial).toBe(true);
    const pred = row.pred_expr ?? "";
    const literals = [...pred.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
    expect([...new Set(literals)].sort(), pred).toEqual([...GATE_STATUSES].sort());
  });

  it("適用可能性: btree 経路だけに絞ると、部分述語 (status IN ('active','contested')) でも idx_memories_recall_gate_seq が引ける", async () => {
    const { pool } = await getTestClient();

    const naturalPlan = await explainGate(pool, "none");
    console.log(`=== EXPLAIN（自然な計画・強制なし。assert しない観測）===\n${naturalPlan}`);

    const forcedPlan = await explainGate(pool, "btreeIndex");
    console.log(
      `=== EXPLAIN（enable_seqscan = off, enable_bitmapscan = off。歯2が assert する計画）===\n${forcedPlan}`,
    );

    expect(forcedPlan, forcedPlan).toContain("idx_memories_recall_gate_seq");
    expect(forcedPlan, forcedPlan).not.toMatch(/Seq Scan on memories/);
  }, 60_000);

  it("同値: 自然な計画・btree を強制した計画・全走査を強制した計画が、同じ行を返す（contested を含み、他の status を含まない）", async () => {
    const { pool } = await getTestClient();

    const natural = await gateRowIds(pool, "none");
    const viaBtree = await gateRowIds(pool, "btreeIndex");
    const viaSeqScan = await gateRowIds(pool, "seqscan");

    expect(viaBtree).toEqual(viaSeqScan);
    expect(natural).toEqual(viaSeqScan);
    expect(natural).toHaveLength(50);

    const dataResult = await pool.query<{ status: string }>(
      `SELECT status FROM memories
       WHERE tenant_id = $1 AND status = ANY($2::text[])`,
      [GATE_PARAMS[0], GATE_PARAMS[1]],
    );
    const statusesReturned = new Set(dataResult.rows.map((row) => row.status));
    expect(statusesReturned.has("active")).toBe(true);
    expect(statusesReturned.has("contested")).toBe(true);
    expect(statusesReturned.has("superseded")).toBe(false);
    expect(statusesReturned.has("archived")).toBe(false);
    expect(statusesReturned.has("forgotten")).toBe(false);
  }, 60_000);
});

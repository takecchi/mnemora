import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Ctx, MemoryStatus } from "@mnemora/core";
import { defaultDecayStrategy } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * `idx_memories_recall_gate` の部分述語が `WHERE status IN ('active', 'contested')` であることを、プランナの選択ではなく索引の性質で検査する。
 * `contested` が段1の候補集合に入らないと、争われている主張を争われていない顔で出さない（mandatory companion retrieval）が成立しない。
 *
 * `EXPLAIN` に索引名が現れることを assert しない。「プランナがこの索引を選んだ」はコスト見積り（行数・統計・他にどんな索引が在るか）に依存するので、
 * 同じ部分述語を持つ別の索引（`idx_memories_lexical`）が足されただけで、実装が正しいまま赤くなる。
 * 守りたいのは「この索引がこの述語に使える」という、コストにも他の索引の有無にも依存しない性質のほうである。
 * - 歯1（形）: `pg_index` から索引の列順と部分述語そのものを読む。プランナを通さない。
 * - 歯2（適用可能性）: seq scan と bitmap scan を外したとき、プランナがこの索引を選べること。
 *   関門の述語 `status = ANY($2)` が部分述語を含意しなければ、どれだけコストを歪めてもこの索引は選ばれない。
 * - 歯3（同値）: 自然な計画・索引を強制した計画・全走査を強制した計画が同じ行集合を返すこと。
 *   強制した側だけを測ると「索引経路が行を弾いていないこと」が測れない。
 *
 * `enable_bitmapscan = off` は `idx_memories_lexical` を候補から外す（GIN 索引は bitmap 経由でしか使えない）。
 * 歯2は「btree の索引経路に限ればこの索引が選ばれる」までしか言わず、本番でこの索引が選ばれることは保証しない。
 * 段1が `memories` を全走査しないことは `vector-search-provenance.test.ts` の歯Bが測る。
 *
 * 自然な計画に `not.toMatch(/Seq Scan on memories/)` を書かない: この seed は1テナント・4000行で、`status` は5値のうち2値が候補（全体の40%）。
 * 40%が散らばって当たるので、索引を使ってもヒープのページはほぼ全部読み、コスト差も小さい（約1.2倍）。
 * コスト定数や統計が少し動けば順位が入れ替わるが、入れ替わっても実装は壊れていない。
 *
 * 自然な計画は `console.log` で CI ログに全文を残す（assert はしない）。失敗メッセージだけでは何が選ばれたかが読めない。この出力を削らないこと。
 */

const TENANT = "recall-gate-tenant";

/** 歯1・歯2・歯3 はいずれも行数に依存しない。減らしてよい（失うのはログの情報量だけである）。 */
const ROW_COUNT = 4000;

/** 段1の関門が候補に含める status。索引の部分述語と同じ集合であること自体を歯1が測る。 */
const GATE_STATUSES = ["active", "contested"] as const;

/**
 * 段1の関門の述語を写したクエリ。本番が発行している SQL そのものではない。
 *
 * `ORDER BY` に `id` を足してある。`buildNewMemoryFixture` は `recordedAt` を固定値で返すので、seed した4000行の `decay_floor_at` は全部同じ値になり、
 * 同値が並ぶと `LIMIT 50` が返す50行は計画ごとに変わりうる。歯3が3つの計画の行集合を突き合わせる以上、順序は全順序でなければならない。
 */
const GATE_SELECT = `SELECT id, status FROM memories
       WHERE tenant_id = $1 AND status = ANY($2::text[]) AND decay_floor_at > now() - interval '1000 days'
       ORDER BY decay_floor_at, id
       LIMIT 50`;

const GATE_PARAMS: [string, string[]] = [TENANT, [...GATE_STATUSES]];

async function insertManyMemories(
  store: PostgresMemoryStore,
  ctx: Ctx,
  statuses: MemoryStatus[],
  pool: Pool,
) {
  // `createMemory` は `status: 'contested'` を `contestedWithId` 無しでは作れない。この歯の主題は段1のゲート述語が拾う status の集合なので、
  // 対向として使うだけの companion（active。ゲートの述語にはどのみち入る値）を1件だけ先に作る。
  const contestedCompanion = await store.createMemory(
    ctx,
    buildNewMemoryFixture({ tenantId: ctx.tenantId }),
  );
  for (let i = 0; i < ROW_COUNT; i += 1) {
    const status = statuses[i % statuses.length]!;
    await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        status,
        contestedWithId: status === "contested" ? contestedCompanion.id : undefined,
      }),
    );
  }
  // 統計情報が無いと、プランナが誤った行数見積もりで無関係な索引を選んでしまうことがある。
  // ⚠ `ANALYZE` は GIN の pending list を片付けない。競合する索引 idx_memories_lexical が GIN であることと合わせて、自然な計画は run ごとに揺れうる。
  await pool.query("ANALYZE memories");
}

/**
 * プランナに何を禁じるか。
 * - `none`: 既定＝本番と同じ条件。assert には使わない（観測とログのため）。
 * - `btreeIndex`: seq scan と bitmap scan を外す。bitmap を外すのは、GIN 索引（`idx_memories_lexical`）が bitmap 経由でしか使えず、外さないとそちらが選ばれるため。
 * - `seqscan`: 索引経路を全部外す。歯3の基準（索引の形に一切依存しない答え）。
 */
type Forcing = "none" | "btreeIndex" | "seqscan";

/**
 * 別接続・別トランザクションで `SET LOCAL` し、`ROLLBACK` で設定を後に残さない
 * （プールを共有しているので、設定が接続に残ると他のテストの計画まで変えてしまう）。
 *
 * ⚠ `enable_seqscan = off` は seq scan を禁止しない。莫大なコストを足して後回しにするだけである。
 * だから歯2は「seq scan が出ないこと」だけでなく「この索引の名前が出ること」も見る。
 * 述語が含意されず索引が適用できないとき、プランナは seq scan へ戻るか、`tenant_id` を先頭に持つ別の btree へ逃げる
 * （`idx_memories_by_subject` / `idx_memories_provenance_kind`）。どちらでも赤くなる。
 */
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
    // ⚠ `release()` を `ROLLBACK` の外側へ出してある。同じ finally の中に並べると、`ROLLBACK` が投げたとき `release()` に到達せず、
    //   その接続はプールへ戻らないまま失われる（プールは共有なので、詰まったときに落ちるのは後続のテストである）。
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

describe("idx_memories_recall_gate (誤り1の修正)", () => {
  // 適用可能性・同値の2件は、同じ `insertManyMemories` の表を読むだけで書かない（`withForcing` は ROLLBACK で閉じる）ので、積むのは最初に1回だけにする。
  // 形の歯は catalog だけを読み、最後の歯は自分で書いた1件の値だけを見るので、表の中身に左右されない。
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

  /**
   * 歯1（形）: プランナを一切通さずに、索引の形を catalog から読む。行数にも統計にも他の索引の有無にも依存しない。
   *
   * 列の判定に `pg_indexes.indexdef`（DDL 文字列）の部分一致を使わない。`"status"` が含まれることを見ると**部分述語の中の `status`** にも当たり、
   * 「列から `status` を落として述語にだけ残す」という壊れ方を検出できない。`pg_index.indkey` が指す `pg_attribute.attnum` は表記に依存しない実体である。
   *
   * 述語の突き合わせは `pg_get_expr` の全体一致ではなく現れるリテラルの集合で行う。
   * `IN ('active','contested')` が `= ANY (ARRAY[...])` と展開されるかどうかは版の表記の都合であり、測りたいのは「どの status が入るか」だからである。
   */
  it("形: idx_memories_recall_gate は (tenant_id, status, decay_floor_at) の3列で、部分述語が拾う status は active と contested の2つちょうど", async () => {
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
       WHERE i.indexrelid = 'idx_memories_recall_gate'::regclass`,
    );

    expect(shape.rows).toHaveLength(1);
    const row = shape.rows[0]!;
    expect([row.col0, row.col1, row.col2]).toEqual(["tenant_id", "status", "decay_floor_at"]);
    expect(row.natts).toBe(3);
    expect(row.is_valid).toBe(true);

    // 部分索引であること。述語を丸ごと落として無条件索引にする壊れ方は
    // 「contested を拾う」を偶然満たしてしまうので、中身とは別に「部分索引である」ことも見る。
    expect(row.is_partial).toBe(true);
    const pred = row.pred_expr ?? "";
    const literals = [...pred.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
    expect([...new Set(literals)].sort(), pred).toEqual([...GATE_STATUSES].sort());
  });

  /**
   * 歯2（適用可能性）: btree の索引経路だけを残したとき、プランナがこの索引を選べること。
   * 部分索引の述語が関門の述語から含意されることを測る。述語を `status = 'active'` へ戻すと含意されず、
   * コストの話ではなく適用可能性の話なので、seq scan を外しても索引は選ばれず赤くなる。
   *
   * ⚠ 強制は、コスト比較という揺れる軸を外して、含意という揺れない軸だけを残すために入れている。
   * ⚠ それでもこの歯は「どの索引を選ぶか」という選択を残している。`memories` には `tenant_id` を先頭に持つ btree が他にも在る
   * （`idx_memories_by_subject` / `idx_memories_provenance_kind`）ので、将来、同じ部分述語を持つ btree が足されたらこの歯も赤くなりうる。
   * そのときは「実装が壊れた」ではなく「この歯が代理を測り始めた」と読むこと。
   */
  it("適用可能性: btree 経路だけに絞ると、修正後の述語 (status IN ('active','contested')) でも idx_memories_recall_gate が引ける", async () => {
    const { pool } = await getTestClient();

    // 自然な計画は assert せず、全文をログへ残す。
    const naturalPlan = await explainGate(pool, "none");
    console.log(`=== EXPLAIN（自然な計画・強制なし。assert しない観測）===\n${naturalPlan}`);

    const forcedPlan = await explainGate(pool, "btreeIndex");
    console.log(
      `=== EXPLAIN（enable_seqscan = off, enable_bitmapscan = off。歯2が assert する計画）===\n${forcedPlan}`,
    );

    expect(forcedPlan, forcedPlan).toContain("idx_memories_recall_gate");
    expect(forcedPlan, forcedPlan).not.toMatch(/Seq Scan on memories/);
  }, 60_000);

  /**
   * 歯3（同値）: 索引経路が行を弾いていないこと。
   * 3経路（自然・btree強制・全走査強制）を同じ問いに当てて同じ答えが返ることを見る。全走査の答えは索引の形に一切依存しないので基準として使える。
   *
   * ⚠ この歯が検出できないもの: PostgreSQL は部分索引の述語が含意されないときその索引を使わないので、「索引を使ったせいで行が落ちる」は本来起こらない。
   * この歯が実際に守っているのは、歯2の強制が測定そのものを歪めていないことと、関門の述語が拾う status の集合（下半分）である。
   * 緑のまま動かない歯になりうることを承知で、「強制しても答えは変わらない」という主張を歯に名乗らせるために置いている。
   */
  it("同値: 自然な計画・btree を強制した計画・全走査を強制した計画が、同じ行を返す（contested を含み、他の status を含まない）", async () => {
    const { pool } = await getTestClient();

    const natural = await gateRowIds(pool, "none");
    const viaBtree = await gateRowIds(pool, "btreeIndex");
    const viaSeqScan = await gateRowIds(pool, "seqscan");

    expect(viaBtree).toEqual(viaSeqScan);
    expect(natural).toEqual(viaSeqScan);
    expect(natural).toHaveLength(50);

    // 索引の話とデータの話の両方を検査する（「索引はあるが述語を書き間違えて何も拾えていない」を見逃さないため）。こちらは LIMIT を外した全件で見る。
    const dataResult = await pool.query<{ status: string }>(
      `SELECT status FROM memories
       WHERE tenant_id = $1 AND status = ANY($2::text[])`,
      GATE_PARAMS,
    );
    const statusesReturned = new Set(dataResult.rows.map((row) => row.status));
    expect(statusesReturned.has("active")).toBe(true);
    expect(statusesReturned.has("contested")).toBe(true);
    expect(statusesReturned.has("superseded")).toBe(false);
    expect(statusesReturned.has("archived")).toBe(false);
    expect(statusesReturned.has("forgotten")).toBe(false);
  }, 60_000);

  it("decay_floor_at は ADR 0153（PR #286）で recall() の既定の読み取りフィルタになった——ここで見るのは書き込み時に値が計算されていることだけ", async () => {
    const ctx: Ctx = { tenantId: TENANT };
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const memory = await store.createMemory(ctx, buildNewMemoryFixture({ tenantId: TENANT }));
    const expected = defaultDecayStrategy.floorAt({
      recordedAt: memory.recordedAt,
      lastReinforcedAt: null,
      strength: memory.strength,
      halfLifeHours: memory.halfLifeHours,
    });
    expect(memory.decayFloorAt.getTime()).toBe(expected.getTime());
  });
});

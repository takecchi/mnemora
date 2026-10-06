import { afterAll, describe, expect, it } from "vitest";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * `MemoryStore.eraseTenant`（PR #1444、ADR 0383）は、削除の最中に外部キー違反（SQLSTATE 23503）に
 * なったとき、トランザクションごとロールバックしたうえで他テナントからの参照を数え直す。
 *
 * - 数え直して1件以上なら `blocked_by_foreign_reference`（検査のあとに他テナントが参照を作った場合）。
 * - 数え直して0件なら、他テナント由来ではないので、元の例外をそのまま投げる。
 *
 * 検査と削除の間に参照を作る競合を、決まった順で起こすために、`memory_events` / `memories` の
 * BEFORE DELETE トリガ（対象のテナントの行だけ）で止める。止めている間に、テスト側が別の接続で
 * 他テナントの行を足す。トリガは、この歯が作って、終わりに必ず落とす。
 *
 * ⚠ `pg_locks` はクラスタ全体の表なので、読むときは自分の DB に絞る。
 */

afterAll(async () => {
  await closeTestClient();
});

const GATE_KEY = 7_261_006;
const VICTIM = "recount-victim";
const OTHER = "recount-other";
const NON_FOREIGN = "recount-nonforeign";

type Pool = Awaited<ReturnType<typeof getTestClient>>["pool"];

async function newMemory(pool: Pool, tenantId: string, hash: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO memories (
       id, tenant_id, content, content_hash, digest, digest_source, provenance_kind, provenance,
       status, tags, recorded_at, strength, half_life_hours, decay_floor_at, embedding_status
     ) VALUES (
       gen_random_uuid(), $1, '本文', $2, 'digest', 'llm', 'imported',
       '{"kind":"imported","batchId":"fixture"}'::jsonb,
       'active', '{}', now(), 1.0, 720, now() + interval '180 days', 'pending'
     ) RETURNING id`,
    [tenantId, hash],
  );
  return r.rows[0]!.id;
}

async function addEvent(pool: Pool, tenantId: string, memoryId: string): Promise<void> {
  await pool.query(
    `INSERT INTO memory_events (id, tenant_id, memory_id, kind, at, actor, meta)
     VALUES (gen_random_uuid(), $1, $2, 'updated', now(), '{"type":"system"}'::jsonb, '{}'::jsonb)`,
    [tenantId, memoryId],
  );
}

async function waitUntilGateIsWaiting(pool: Pool): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const r = await pool.query(
      `SELECT 1 FROM pg_locks
       WHERE locktype = 'advisory' AND NOT granted AND objid = $1::oid
         AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
      [GATE_KEY],
    );
    if (r.rows.length > 0) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error("eraseTenant が BEFORE DELETE トリガで止まらなかった");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function messagesOf(error: unknown): string[] {
  const out: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current !== null && current !== undefined; depth += 1) {
    const message = (current as { message?: unknown }).message;
    if (typeof message === "string") {
      out.push(message);
    }
    current = (current as { cause?: unknown }).cause;
  }
  return out;
}

describe("eraseTenant は、削除の最中の外部キー違反を、他テナント由来かどうかを数え直して見分ける", () => {
  it("検査のあとに他テナントが参照を作ったときは、ロールバックして blocked_by_foreign_reference を返し、このテナントの行は1行も消えない", async () => {
    await resetTestDatabase();
    const { db, pool } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const victimMemory = await newMemory(pool, VICTIM, "recount-victim-1");
    await addEvent(pool, VICTIM, victimMemory);

    // memory_events を消す文が、このテナントの行の削除で止まる（検査はもう終わっている）。
    await pool.query(`
      CREATE OR REPLACE FUNCTION erase_recount_gate() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        PERFORM pg_advisory_lock(${GATE_KEY});
        PERFORM pg_advisory_unlock(${GATE_KEY});
        RETURN OLD;
      END
      $fn$
    `);
    await pool.query(`
      CREATE TRIGGER erase_recount_gate BEFORE DELETE ON memory_events
      FOR EACH ROW WHEN (OLD.tenant_id = '${VICTIM}') EXECUTE FUNCTION erase_recount_gate()
    `);
    const holder = await pool.connect();
    let holding = false;
    let pending: Promise<unknown> | undefined;
    try {
      await holder.query("SELECT pg_advisory_lock($1)", [GATE_KEY]);
      holding = true;

      pending = store.eraseTenant({ tenantId: VICTIM }, { limit: 1000 });
      await waitUntilGateIsWaiting(pool);

      // 止まっている間に、他テナントが VICTIM の記憶を指す行を足して、コミットする。
      await addEvent(pool, OTHER, victimMemory);

      await holder.query("SELECT pg_advisory_unlock($1)", [GATE_KEY]);
      holding = false;

      expect(await pending).toEqual({ kind: "blocked_by_foreign_reference", count: 1 });

      // ロールバックされている: VICTIM の記憶も、その events も残っている。
      const left = await pool.query<{ n: number }>(
        `SELECT (SELECT count(*) FROM memories WHERE tenant_id = $1)::int
              + (SELECT count(*) FROM memory_events WHERE tenant_id = $1)::int AS n`,
        [VICTIM],
      );
      expect(left.rows[0]!.n).toBe(2);
    } finally {
      if (holding) {
        await holder.query("SELECT pg_advisory_unlock($1)", [GATE_KEY]);
      }
      holder.release();
      await pending?.catch(() => undefined);
      await pool.query("DROP TRIGGER IF EXISTS erase_recount_gate ON memory_events");
      await pool.query("DROP FUNCTION IF EXISTS erase_recount_gate()");
    }
  }, 60_000);

  it("他テナント由来ではない外部キー違反は、blocked_by_foreign_reference にせず、元の例外をそのまま投げる", async () => {
    await resetTestDatabase();
    const { db, pool } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    await newMemory(pool, NON_FOREIGN, "recount-nonforeign-1");

    await pool.query(`
      CREATE OR REPLACE FUNCTION erase_recount_inject() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        RAISE EXCEPTION 'recount-injected' USING ERRCODE = '23503';
      END
      $fn$
    `);
    await pool.query(`
      CREATE TRIGGER erase_recount_inject BEFORE DELETE ON memories
      FOR EACH ROW WHEN (OLD.tenant_id = '${NON_FOREIGN}') EXECUTE FUNCTION erase_recount_inject()
    `);
    try {
      const error = await store.eraseTenant({ tenantId: NON_FOREIGN }, { limit: 1000 }).then(
        (value) => ({ resolved: value }),
        (e: unknown) => ({ rejected: e }),
      );
      expect(error).toHaveProperty("rejected");
      const rejected = (error as { rejected: unknown }).rejected;
      expect(messagesOf(rejected).join(" | ")).toContain("recount-injected");
    } finally {
      await pool.query("DROP TRIGGER IF EXISTS erase_recount_inject ON memories");
      await pool.query("DROP FUNCTION IF EXISTS erase_recount_inject()");
    }

    // ロールバックされている。
    const left = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM memories WHERE tenant_id = $1",
      [NON_FOREIGN],
    );
    expect(left.rows[0]!.n).toBe(1);
  }, 60_000);
});

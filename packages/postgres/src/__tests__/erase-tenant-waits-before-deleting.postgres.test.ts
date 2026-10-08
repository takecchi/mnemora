import { afterAll, describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import { eraseTenantLockKey } from "../erase-tenant-lock.js";
import { embeddingSpaceTableName } from "../embedding-space-table.js";
import {
  closeTestClient,
  getTestClient,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
} from "./test-db.js";
import {
  buildEraseTenantTestRuntime,
  seedAllTablesForTenant,
} from "./erase-tenant-test-helpers.js";

/**
 * `eraseTenant` は、同じテナントの lock を取ってから行を消す。lock を待っている間は、そのテナントの行にまだ手を付けていない。
 * lock を `DELETE` の後で取ると、先客を待つ点は変わらないが、待っている間に自分の `DELETE` が行を掴んでいる。
 * 先に消した行は相手の `DELETE` に数えられないので、直列にしても「消せた行数が予算未満なら空」と読む前提が崩れる。
 *
 * テスト側が先にそのテナントの lock を握り、消去がその lock を待ち始めたことを `pg_locks`（`granted = false`）で
 * 見てから、別の接続でそのテナントの行を `FOR UPDATE SKIP LOCKED` で数える。待っている側が行を掴んでいなければ、
 * 全行を数えられる。時間の長さには頼らない。
 */

afterAll(async () => {
  await closeTestClient();
});

const VICTIM = "erase-waits-before-deleting-victim";
const S = "erase-waits-before-deleting";

/** `pg_locks` を自分の DB に絞る条件（クラスタ全体の表なので、ほかの DB の行を数えない）。 */
const OWN_DATABASE = "database = (SELECT oid FROM pg_database WHERE datname = current_database())";

/** `key` の advisory lock を、だれかが待ち始める（`granted = false` の行が現れる）まで待つ。 */
async function waitUntilSomeoneWaitsFor(observer: PoolClient, key: bigint): Promise<void> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const { rows } = await observer.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_locks
       WHERE locktype = 'advisory' AND NOT granted AND objsubid = 1 AND ${OWN_DATABASE}
         AND ((classid::bigint << 32) | objid::bigint) = $1::bigint`,
      [key.toString()],
    );
    if (rows[0]!.n > 0) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error("eraseTenant が lock を待ち始めなかった");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** `tenant_id` 列を持つ表ごとに、そのテナントの行数と、`FOR UPDATE SKIP LOCKED` で掴めた行数を数える。 */
async function countRowsAndLockable(
  observer: PoolClient,
  tenantId: string,
): Promise<Record<string, { rows: number; lockable: number }>> {
  const { rows: tables } = await observer.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.columns
     WHERE table_schema = current_schema() AND column_name = 'tenant_id'
     ORDER BY table_name`,
  );
  const counts: Record<string, { rows: number; lockable: number }> = {};
  for (const { table_name: table } of tables) {
    const quoted = `"${table}"`;
    const all = await observer.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${quoted} WHERE tenant_id = $1`,
      [tenantId],
    );
    const lockable = await observer.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM (
         SELECT 1 FROM ${quoted} WHERE tenant_id = $1 FOR UPDATE SKIP LOCKED
       ) s`,
      [tenantId],
    );
    counts[table] = { rows: all.rows[0]!.n, lockable: lockable.rows[0]!.n };
  }
  return counts;
}

type Port = "memoryStore" | "vectorStore" | "outboxStore";

/** port ごとに、消す前に行が在ることを確かめる表（在らなければ、掴んでいないことを見ても意味が無い）。 */
const PORT_TABLE: Record<Port, string> = {
  memoryStore: "memories",
  vectorStore: embeddingSpaceTableName(TEST_EMBEDDING_SPACE),
  outboxStore: "outbox",
};

describe("eraseTenant の各 port は、同じテナントの lock を待っている間、そのテナントの行を掴んでいない", () => {
  for (const port of ["memoryStore", "vectorStore", "outboxStore"] as const satisfies Port[]) {
    it(`${port}: lock を待っている間は、そのテナントのどの行も掴まず、lock が離れると消す`, async () => {
      await resetTestDatabase();
      const { db, pool } = await getTestClient();
      const runtime = buildEraseTenantTestRuntime(db, S);
      await seedAllTablesForTenant(runtime, new PostgresTenantSettingsStore(db), VICTIM, S);
      const stores = {
        memoryStore: new PostgresMemoryStore(db),
        vectorStore: new PostgresVectorStore(db),
        outboxStore: new PostgresOutboxStore(db),
      };

      const holder = await pool.connect();
      const observer = await pool.connect();
      let holding = false;
      let observing = false;
      let victim: Promise<unknown> | undefined;
      try {
        await holder.query("BEGIN");
        holding = true;
        await holder.query("SELECT pg_advisory_xact_lock($1::bigint)", [
          eraseTenantLockKey(VICTIM).toString(),
        ]);

        victim = stores[port].eraseTenant({ tenantId: VICTIM }, { limit: 100_000 });
        await waitUntilSomeoneWaitsFor(observer, eraseTenantLockKey(VICTIM));

        await observer.query("BEGIN");
        observing = true;
        const counts = await countRowsAndLockable(observer, VICTIM);
        await observer.query("ROLLBACK");
        observing = false;

        expect(counts[PORT_TABLE[port]]?.rows ?? 0).toBeGreaterThan(0);
        const grabbed = Object.entries(counts).filter(([, c]) => c.lockable !== c.rows);
        expect(grabbed).toEqual([]);

        await holder.query("COMMIT");
        holding = false;
        await victim;
        const after = await observer.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM "${PORT_TABLE[port]}" WHERE tenant_id = $1`,
          [VICTIM],
        );
        expect(after.rows[0]!.n).toBe(0);
      } finally {
        if (observing) {
          await observer.query("ROLLBACK");
        }
        if (holding) {
          await holder.query("ROLLBACK");
        }
        observer.release();
        holder.release();
        await victim?.catch(() => undefined);
      }
    }, 120_000);
  }
});

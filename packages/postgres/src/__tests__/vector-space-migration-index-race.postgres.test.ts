import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  embeddingSpaceMemoryIdIndexName,
  embeddingSpaceTableName,
  embeddingSpaceZeroNormIndexName,
} from "../embedding-space-table.js";
import { runMigrations } from "../migrate.js";
import { registerEmbeddingSpace } from "../vector-space.js";
import { dropTempDatabase } from "./temp-database.js";
import { requireDatabaseUrl } from "./test-db.js";

/**
 * ADR 0464: `registerEmbeddingSpace` の `CREATE INDEX IF NOT EXISTS`（零ノルムの部分索引・`memory_id` の索引）が、
 * migration（0022・0027 の DO ブロック。1ファイル1トランザクション）が同じ名前の索引を作っている最中と重なっても、
 * `23505`（`pg_class_relname_nsp_index`）で落ちない。
 *
 * 機序: migration 側の索引は、コミットされるまで `pg_class` に見えない。`IF NOT EXISTS` の存在確認はそれを見ず、
 * 同じ名前の行を入れようとして一意索引の上で相手の終わりを待ち、相手がコミットすると `23505` になる。
 * 2つの advisory lock のキーは別（`MIGRATION_LOCK_KEY` と `REGISTER_EMBEDDING_SPACE_LOCK_KEY`）なので、lock は守らない。
 *
 * 決定的に作る: 別の接続で `BEGIN; CREATE INDEX IF NOT EXISTS <同じ名前> …`（migration の代用）を未コミットで握り、
 * `registerEmbeddingSpace` がその索引の作成で待ちに入った（`pg_locks` の `transactionid` の待ち）のを見てからコミットする。
 * `pg_locks` を読むので、直列の群に入れてある。
 */

const DATABASE = "mnemora_vs_migration_index_race";
const SPACE = { provider: "test", model: "vs-index-race", dimensions: 3 };
const TABLE = embeddingSpaceTableName(SPACE);

let admin: Pool | undefined;
let pool: Pool | undefined;

function connectionStringFor(database: string): string {
  const url = new URL(requireDatabaseUrl());
  url.pathname = `/${database}`;
  return url.toString();
}

async function waitUntilBlockedOnTransactionId(): Promise<void> {
  for (let i = 0; i < 500; i++) {
    const r = await pool!.query(
      `SELECT 1 FROM pg_locks l JOIN pg_stat_activity a USING (pid)
        WHERE a.datname = $1 AND l.locktype = 'transactionid' AND NOT l.granted`,
      [DATABASE],
    );
    if (r.rowCount && r.rowCount > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("registerEmbeddingSpace が migration 側の索引の作成を待つ状態にならなかった");
}

describe("registerEmbeddingSpace と migration が同じ名前の索引を同時に作る（ADR 0464）", () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString: requireDatabaseUrl(), max: 1 });
    await dropTempDatabase(admin, DATABASE);
    await admin.query(`CREATE DATABASE ${DATABASE}`);
    pool = new Pool({ connectionString: connectionStringFor(DATABASE), max: 4 });
    await runMigrations(pool);
  }, 60_000);

  afterAll(async () => {
    if (pool) await pool.end();
    if (admin) {
      await dropTempDatabase(admin, DATABASE);
      await admin.end();
    }
  });

  const cases: Array<[string, string, (sql: string) => string]> = [
    [
      "0022 の零ノルムの部分索引",
      embeddingSpaceZeroNormIndexName(SPACE),
      (name) =>
        `CREATE INDEX IF NOT EXISTS ${name} ON ${TABLE} (tenant_id, memory_id) WHERE vector_norm(embedding) = 0`,
    ],
    [
      "0027 の memory_id の索引",
      embeddingSpaceMemoryIdIndexName(SPACE),
      (name) => `CREATE INDEX IF NOT EXISTS ${name} ON ${TABLE} (memory_id)`,
    ],
  ];

  for (const [label, indexName, statement] of cases) {
    it(`${label}: migration 側が未コミットの間に registerEmbeddingSpace を撃ち、コミットしても reject しない`, async () => {
      // 空間を登録し直せる状態に戻す（表は在る。この索引だけ無い）。
      await registerEmbeddingSpace(pool!, SPACE);
      await pool!.query(`DROP INDEX IF EXISTS ${indexName}`);

      const holder = await pool!.connect();
      try {
        await holder.query("BEGIN");
        await holder.query(statement(indexName));
        const registering = registerEmbeddingSpace(pool!, SPACE).then(
          () => "resolved",
          (error: unknown) => `rejected: ${(error as { code?: string }).code ?? String(error)}`,
        );
        await waitUntilBlockedOnTransactionId();
        await holder.query("COMMIT");
        expect(await registering).toBe("resolved");
      } finally {
        await holder.query("ROLLBACK").catch(() => {});
        holder.release();
      }

      const found = await pool!.query("SELECT 1 FROM pg_indexes WHERE indexname = $1", [indexName]);
      expect(found.rowCount).toBe(1);
    }, 30_000);
  }
});

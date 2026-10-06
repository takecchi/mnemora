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
 * ADR 0638（ADR 0464 の負債 D1b、逆向き）: `registerEmbeddingSpace` が `CREATE INDEX IF NOT EXISTS`（autocommit の1文）で
 * 索引を作っている最中に、`runMigrations`（0022・0027 が未適用）が同じ名前の索引を作ろうとしても、migration が
 * `23505`（`pg_class_relname_nsp_index`）で落ちない。
 *
 * 機序: register 側の索引はコミットされるまで `pg_class` に見えない。migration の DO ブロックの `IF NOT EXISTS` は
 * それを見ずに同じ名前の行を入れようとして待ち、register がコミットすると `23505` になる。ファイルごと巻き戻る。
 *
 * 決定的に作る: 別の接続で `BEGIN; CREATE INDEX IF NOT EXISTS <同じ名前> …`（register の代用）を未コミットで握り、
 * `runMigrations` がその索引の作成で待ちに入った（`pg_locks` の `transactionid` の待ち）のを見てからコミットする。
 * `pg_locks` を読むので、直列の群に入れてある。
 */

const DATABASE = "mnemora_migrate_vs_register_race";
const SPACE = { provider: "test", model: "migrate-vs-register", dimensions: 3 };
const TABLE = embeddingSpaceTableName(SPACE);

const FK_INDEXES_0027 = [
  "idx_memory_events_memory_id",
  "idx_recall_usages_memory_id",
  "idx_recall_usages_recall_id",
  "idx_memory_labels_memory_id",
  "idx_memories_source_observation_id",
  "idx_memories_superseded_by_id",
  "idx_memory_relations_from_memory_id",
  "idx_memory_relations_to_memory_id",
];

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
  throw new Error("runMigrations が register 側の索引の作成を待つ状態にならなかった");
}

describe("runMigrations と registerEmbeddingSpace が同じ名前の索引を同時に作る・逆向き（ADR 0638）", () => {
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

  const cases: Array<[string, string, string, (name: string) => string]> = [
    [
      "0022 の零ノルムの部分索引",
      "0022_embedding_zero_norm_index.sql",
      embeddingSpaceZeroNormIndexName(SPACE),
      (name) =>
        `CREATE INDEX IF NOT EXISTS ${name} ON ${TABLE} (tenant_id, memory_id) WHERE vector_norm(embedding) = 0`,
    ],
    [
      "0027 の memory_id の索引",
      "0027_erase_tenant_fk_indexes.sql",
      embeddingSpaceMemoryIdIndexName(SPACE),
      (name) => `CREATE INDEX IF NOT EXISTS ${name} ON ${TABLE} (memory_id)`,
    ],
  ];

  for (const [label, file, indexName, statement] of cases) {
    it(`${label}: register 側が未コミットの間に runMigrations を撃ち、コミットしても reject せず、台帳に残る`, async () => {
      // 表は在る・この索引だけ無い・この migration だけ未適用、の状態へ戻す。
      await registerEmbeddingSpace(pool!, SPACE);
      await pool!.query(`DROP INDEX IF EXISTS ${indexName}`);
      await pool!.query(`DELETE FROM _mnemora_migrations WHERE name = $1`, [file]);
      // 0027 の先頭の8本は素の `CREATE INDEX`（`IF NOT EXISTS` 無し）なので、未適用の状態へ戻すには先に落とす。
      if (file.startsWith("0027_")) {
        for (const name of FK_INDEXES_0027) await pool!.query(`DROP INDEX IF EXISTS ${name}`);
      }

      const holder = await pool!.connect();
      try {
        await holder.query("BEGIN");
        await holder.query(statement(indexName));
        const migrating = runMigrations(pool!).then(
          (result) => `resolved: ${result.applied.join(",")}`,
          (error: unknown) =>
            `rejected: ${(error as { cause?: { code?: string } }).cause?.code ?? String(error)}`,
        );
        await waitUntilBlockedOnTransactionId();
        await holder.query("COMMIT");
        expect(await migrating).toBe(`resolved: ${file}`);
      } finally {
        await holder.query("ROLLBACK").catch(() => {});
        holder.release();
      }

      const found = await pool!.query("SELECT 1 FROM pg_indexes WHERE indexname = $1", [indexName]);
      expect(found.rowCount).toBe(1);
      const ledgered = await pool!.query("SELECT 1 FROM _mnemora_migrations WHERE name = $1", [
        file,
      ]);
      expect(ledgered.rowCount).toBe(1);
    }, 30_000);
  }
});

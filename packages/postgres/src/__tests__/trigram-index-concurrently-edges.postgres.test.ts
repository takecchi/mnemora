import type { Pool, PoolClient } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePostgresClient, createPostgresClient } from "../client.js";
import {
  createOptionalTrigramIndex,
  createOptionalTrigramIndexConcurrently,
  PostgresTrigramLexicalStore,
  probeTrigramLexicalSupport,
} from "../trigram-lexical-store.js";
import {
  closeTestClient,
  getTestClient,
  requireDatabaseUrl,
  resetTestDatabase,
} from "./test-db.js";

/**
 * VALID な索引の oid で見るのは、作り直しても `indisvalid` と定義は同じになり、前後の状態の比較では見えないため。
 * 消すときのロックを `pg_locks` で見るのは、作り直したあとの状態だけでは、素の `DROP INDEX`（書き込みを待たせる）と
 * `DROP INDEX CONCURRENTLY` が区別できないため（`pg_locks` を読むので `SERIAL_TEST_FILES` に入れてある）。
 * 別名・別スキーマの INVALID な索引を残すのは、消してよいのが `memories` と同じスキーマの `idx_memories_trigram` だけで、
 * 利用者の別の索引を黙って落とさないため。
 * INVALID な索引は、catalog を書き換えず、待ちの最中の `statement_timeout` で実際に作る。偽造すると、実際の失敗の
 * 残り方（`indisready` など他の列）と食い違いうる。
 */

const TENANT = "trigram-concurrently-edges-tenant";
const INDEX_NAME = "idx_memories_trigram";
const OTHER_INDEX = "idx_memories_trigram_edges_other";
const OTHER_SCHEMA = "trigram_edges_other_schema";

const PG_LOCKS_OF_PID = `
  SELECT mode, granted FROM pg_locks
   WHERE database = (SELECT oid FROM pg_database WHERE datname = current_database())
     AND relation = 'memories'::regclass
     AND locktype = 'relation'
     AND pid = $1`;

afterAll(async () => {
  const { pool } = await getTestClient();
  await pool.query(`DROP INDEX IF EXISTS ${INDEX_NAME}`);
  await pool.query(`DROP INDEX IF EXISTS ${OTHER_INDEX}`);
  await pool.query(`DROP SCHEMA IF EXISTS ${OTHER_SCHEMA} CASCADE`);
  await closeTestClient();
});

async function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = await Promise.race([
    p.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), ms))),
  ]);
  clearTimeout(timer);
  return settled;
}

async function insertOne(client: Pool | PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO memories (
       id, tenant_id, subject_id, content, content_hash, digest, digest_source,
       provenance_kind, provenance, status, tags, occurred_at, recorded_at,
       last_reinforced_at, strength, half_life_hours, decay_floor_at,
       embedding_status, created_at, updated_at
     ) VALUES (
       gen_random_uuid(), $1, NULL, '田中さんが会議に参加します', md5(random()::text), 'digest', 'llm',
       'imported', '{"kind":"imported","batchId":"fixture-batch"}'::jsonb, 'active',
       '{}', NULL, now(), NULL, 1.0, 720, now() + interval '30 days', 'ready', now(), now()
     )`,
    [TENANT],
  );
}

async function indexState(
  pool: Pool,
  name: string,
): Promise<{ valid: boolean; oid: number } | undefined> {
  const { rows } = await pool.query<{ valid: boolean; oid: number }>(
    `SELECT i.indisvalid AS valid, i.indexrelid::int AS oid
       FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE i.indrelid = 'memories'::regclass AND c.relname = $1`,
    [name],
  );
  return rows[0];
}

/** 自 DB で `query` が `pattern`（ILIKE）に当たる、走行中の backend の pid が出るまで待つ。 */
async function waitForBackend(pool: Pool, pattern: string): Promise<number> {
  for (let i = 0; i < 100; i++) {
    const { rows } = await pool.query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()
          AND btrim(query, E' \n\t') ILIKE $1
          AND state = 'active'`,
      [pattern],
    );
    if (rows[0]) return rows[0].pid;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`${pattern} を実行している backend が見つからなかった`);
}

/**
 * 書き込みトランザクションを開いたまま `CREATE INDEX CONCURRENTLY` をキャンセルして、
 * INVALID な索引を実際に作る。`createSql` は表に対する `CREATE INDEX CONCURRENTLY ...`、
 * `insertSql` はその表に未完了の書き込みを置く文。
 */
async function leaveInvalidIndex(pool: Pool, insertSql: string, createSql: string): Promise<void> {
  const holder = await pool.connect();
  const victim = createPostgresClient(requireDatabaseUrl(), {
    options: "-c statement_timeout=500",
    max: 1,
  });
  try {
    await holder.query("BEGIN");
    await holder.query(insertSql);
    await expect(victim.pool.query(createSql)).rejects.toMatchObject({ code: "57014" });
  } finally {
    await holder.query("ROLLBACK").catch(() => {});
    holder.release();
    await closePostgresClient(victim).catch(() => {});
  }
}

const CREATE_SIGNATURE = `USING gin (tenant_id, content gin_trgm_ops) WHERE status IN ('active', 'contested')`;

let supported = false;

beforeEach(async () => {
  await resetTestDatabase();
  const { db, pool } = await getTestClient();
  const probe = await probeTrigramLexicalSupport(db);
  supported = probe.ok;
  if (probe.ok) await PostgresTrigramLexicalStore.create(db);
  await pool.query(`DROP INDEX IF EXISTS ${INDEX_NAME}`);
  await pool.query(`DROP INDEX IF EXISTS ${OTHER_INDEX}`);
  await pool.query(`DROP SCHEMA IF EXISTS ${OTHER_SCHEMA} CASCADE`);
});

describe("createOptionalTrigramIndexConcurrently: VALID な索引には触れない", () => {
  it("VALID な索引があるとき、何度呼んでも索引の oid は変わらない（作り直さない）", async () => {
    if (!supported) return;
    const { db, pool } = await getTestClient();
    await createOptionalTrigramIndex(db);
    const before = await indexState(pool, INDEX_NAME);
    expect(before?.valid).toBe(true);

    await createOptionalTrigramIndexConcurrently(db);
    await createOptionalTrigramIndexConcurrently(db);

    expect(await indexState(pool, INDEX_NAME)).toEqual(before);
  }, 30_000);
});

describe("createOptionalTrigramIndexConcurrently: 消してよい索引は memories と同じスキーマの idx_memories_trigram だけ", () => {
  it("memories の別名の INVALID な索引は、呼んでも残る", async () => {
    if (!supported) return;
    const { db, pool } = await getTestClient();
    await leaveInvalidIndex(
      pool,
      `INSERT INTO memories (
         id, tenant_id, subject_id, content, content_hash, digest, digest_source,
         provenance_kind, provenance, status, tags, occurred_at, recorded_at,
         last_reinforced_at, strength, half_life_hours, decay_floor_at,
         embedding_status, created_at, updated_at
       ) VALUES (
         gen_random_uuid(), '${TENANT}', NULL, 'x', md5(random()::text), 'digest', 'llm',
         'imported', '{"kind":"imported","batchId":"fixture-batch"}'::jsonb, 'active',
         '{}', NULL, now(), NULL, 1.0, 720, now() + interval '30 days', 'ready', now(), now()
       )`,
      `CREATE INDEX CONCURRENTLY ${OTHER_INDEX} ON memories ${CREATE_SIGNATURE}`,
    );
    // 前提: 別名の INVALID な索引が実際に残っている。
    expect((await indexState(pool, OTHER_INDEX))?.valid).toBe(false);

    await createOptionalTrigramIndexConcurrently(db);

    expect((await indexState(pool, INDEX_NAME))?.valid).toBe(true);
    expect((await indexState(pool, OTHER_INDEX))?.valid).toBe(false);
  }, 30_000);

  it("memories と違うスキーマの同名の INVALID な索引は、呼んでも残る", async () => {
    if (!supported) return;
    const { db, pool } = await getTestClient();
    await pool.query(`CREATE SCHEMA ${OTHER_SCHEMA}`);
    await pool.query(`CREATE TABLE ${OTHER_SCHEMA}.t (content text)`);
    await leaveInvalidIndex(
      pool,
      `INSERT INTO ${OTHER_SCHEMA}.t (content) VALUES ('x')`,
      `CREATE INDEX CONCURRENTLY ${INDEX_NAME} ON ${OTHER_SCHEMA}.t USING gin (content gin_trgm_ops)`,
    );
    const otherState = async () => {
      const { rows } = await pool.query<{ valid: boolean }>(
        `SELECT i.indisvalid AS valid
           FROM pg_index i
           JOIN pg_class c ON c.oid = i.indexrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relname = $2`,
        [OTHER_SCHEMA, INDEX_NAME],
      );
      return rows[0]?.valid;
    };
    // 前提: 別スキーマに INVALID な同名の索引が実際に残っている。
    expect(await otherState()).toBe(false);

    await createOptionalTrigramIndexConcurrently(db);

    expect((await indexState(pool, INDEX_NAME))?.valid).toBe(true);
    expect(await otherState()).toBe(false);
  }, 30_000);
});

describe("createOptionalTrigramIndexConcurrently: INVALID な索引を消すときも書き込みを止めない", () => {
  it("DROP は AccessExclusiveLock を要求せず、待っている間も別接続の INSERT は通る", async () => {
    if (!supported) return;
    const { db, pool } = await getTestClient();
    // 前提: INVALID な idx_memories_trigram を作る。
    await leaveInvalidIndex(
      pool,
      `INSERT INTO memories (
         id, tenant_id, subject_id, content, content_hash, digest, digest_source,
         provenance_kind, provenance, status, tags, occurred_at, recorded_at,
         last_reinforced_at, strength, half_life_hours, decay_floor_at,
         embedding_status, created_at, updated_at
       ) VALUES (
         gen_random_uuid(), '${TENANT}', NULL, 'x', md5(random()::text), 'digest', 'llm',
         'imported', '{"kind":"imported","batchId":"fixture-batch"}'::jsonb, 'active',
         '{}', NULL, now(), NULL, 1.0, 720, now() + interval '30 days', 'ready', now(), now()
       )`,
      `CREATE INDEX CONCURRENTLY ${INDEX_NAME} ON memories ${CREATE_SIGNATURE}`,
    );
    expect((await indexState(pool, INDEX_NAME))?.valid).toBe(false);

    // 未完了の書き込みで、DROP を最初の待ちに止める。
    const holder = await pool.connect();
    let build: Promise<void> | undefined;
    try {
      await holder.query("BEGIN");
      await insertOne(holder);

      build = createOptionalTrigramIndexConcurrently(db);
      const pid = await waitForBackend(pool, "DROP INDEX%");

      const { rows } = await pool.query<{ mode: string; granted: boolean }>(PG_LOCKS_OF_PID, [pid]);
      const modes = rows.map((r) => r.mode);
      expect(modes).not.toContain("AccessExclusiveLock");
      expect(rows.filter((r) => r.granted).map((r) => r.mode)).toContain(
        "ShareUpdateExclusiveLock",
      );

      const write = insertOne(pool);
      expect(await settlesWithin(write, 2000)).toBe(true);
      await write;
    } finally {
      await holder.query("ROLLBACK").catch(() => {});
      holder.release();
      await build;
    }
    expect((await indexState(pool, INDEX_NAME))?.valid).toBe(true);
  }, 30_000);
});

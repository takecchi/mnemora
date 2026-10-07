import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Ctx, EmbeddingSpaceId } from "@mnemora/core";
import { closePostgresClient, createPostgresClient, type PostgresClient } from "../client.js";
import { runMigrations } from "../migrate.js";
import { PostgresVectorStore } from "../vector-store.js";
import { registerEmbeddingSpace } from "../vector-space.js";
import { embeddingSpaceTableName } from "../embedding-space-table.js";
import { INITIAL_ANALYZE_THRESHOLD } from "../embedding-statistics.js";
import { requireDatabaseUrl } from "./test-db.js";
import { dropTempDatabase } from "./temp-database.js";

/**
 * 埋め込み表の自動 ANALYZE が、`upsert` で実際に書いた行数だけを、空間ごとに数えて、
 * 閾値ちょうどの書き込みの後に、その空間の表だけに撃つこと。
 *
 * 見るのは `pg_class.reltuples`（`ANALYZE` した瞬間に更新される。一度も撃っていない表は -1）。
 * `last_analyze` は統計の反映が遅れうるので使わない。表は autovacuum を切る。切らないと
 * `reltuples` が autovacuum の `ANALYZE` で動き、「撃たなかった」ことを確かめられない。
 *
 * 専用の使い捨てデータベースを使う: 並列群は `isolate: false` で worker をファイルをまたいで使い回すので、
 * 他ファイルの埋め込み表・累計カウンタと混ざらないようにするため。空間の名前は毎回新しく作り、
 * プロセスローカルの累計が 0 から始まることに頼らない。
 */

const TEST_DATABASE = "mnemora_embedding_statistics_recheck_0916_test";
const TENANT = "embedding-statistics-recheck-tenant";
const ctx: Ctx = { tenantId: TENANT };
const MEMORY_COUNT = INITIAL_ANALYZE_THRESHOLD;

function connectionStringFor(database: string): string {
  const url = new URL(requireDatabaseUrl());
  url.pathname = `/${database}`;
  return url.toString();
}

let adminPool: Pool | undefined;
function admin(): Pool {
  adminPool ??= new Pool({ connectionString: requireDatabaseUrl(), max: 1 });
  return adminPool;
}

let client: PostgresClient | undefined;
let memoryIds: string[] = [];

function uniqueSpace(label: string): EmbeddingSpaceId {
  return {
    provider: "embedding-statistics-recheck",
    model: `${label}-${randomUUID()}`,
    dimensions: 3,
  };
}

async function newSpace(label: string): Promise<{ space: EmbeddingSpaceId; table: string }> {
  const space = uniqueSpace(label);
  await registerEmbeddingSpace(client!.pool, space);
  const table = embeddingSpaceTableName(space);
  await client!.pool.query(`ALTER TABLE ${table} SET (autovacuum_enabled = false)`);
  return { space, table };
}

async function reltuples(table: string): Promise<number> {
  const result = await client!.pool.query(
    `SELECT reltuples FROM pg_class WHERE oid = $1::regclass`,
    [table],
  );
  return Number(result.rows[0].reltuples);
}

async function upsertRange(
  store: PostgresVectorStore,
  space: EmbeddingSpaceId,
  from: number,
  to: number,
): Promise<void> {
  for (let i = from; i < to; i += 1) {
    await store.upsert(ctx, space, memoryIds[i]!, [0.1, 0.2, (i % 10) / 10]);
  }
}

beforeAll(async () => {
  await dropTempDatabase(admin(), TEST_DATABASE);
  await admin().query(`CREATE DATABASE ${TEST_DATABASE}`);
  client = createPostgresClient(connectionStringFor(TEST_DATABASE));
  await runMigrations(client.pool);
  await client.pool.query(
    `INSERT INTO memories (
       id, tenant_id, content, content_hash, digest, digest_source,
       provenance_kind, provenance, status, tags, recorded_at,
       strength, half_life_hours, decay_floor_at, embedding_status, created_at, updated_at
     )
     SELECT gen_random_uuid(), $1, 'row ' || n, 'hash-' || n, 'digest', 'llm',
            'imported', '{"kind":"imported"}'::jsonb, 'active', '{}'::text[], now(),
            1.0, 720, now() + interval '30 days', 'ready', now(), now()
     FROM generate_series(1, $2) AS n`,
    [TENANT, MEMORY_COUNT],
  );
  const rows = await client.pool.query<{ id: string }>(
    `SELECT id FROM memories WHERE tenant_id = $1 ORDER BY content_hash`,
    [TENANT],
  );
  memoryIds = rows.rows.map((r) => r.id);
}, 60_000);

afterAll(async () => {
  if (client) {
    await closePostgresClient(client);
  }
  await dropTempDatabase(admin(), TEST_DATABASE);
  if (adminPool) {
    await adminPool.end();
    adminPool = undefined;
  }
}, 30_000);

describe("PostgresVectorStore.upsert の埋め込み表の自動 ANALYZE", () => {
  it("閾値の1つ手前の upsert までは撃たず、閾値ちょうどの upsert が書き終えた後の行数で撃つ", async () => {
    const store = new PostgresVectorStore(client!.db);
    const { space, table } = await newSpace("threshold");
    expect(await reltuples(table)).toBe(-1);

    await upsertRange(store, space, 0, INITIAL_ANALYZE_THRESHOLD - 1);
    expect(await reltuples(table)).toBe(-1);

    await upsertRange(store, space, INITIAL_ANALYZE_THRESHOLD - 1, INITIAL_ANALYZE_THRESHOLD);
    expect(await reltuples(table)).toBe(INITIAL_ANALYZE_THRESHOLD);
  }, 120_000);

  it("累計は空間ごとに数え、撃つのは閾値に届いた空間の表だけ", async () => {
    const store = new PostgresVectorStore(client!.db);
    const other = await newSpace("counted-other");
    const target = await newSpace("counted-target");

    await upsertRange(store, other.space, 0, 600);
    await upsertRange(store, target.space, 0, INITIAL_ANALYZE_THRESHOLD - 1);
    expect(await reltuples(target.table)).toBe(-1);
    expect(await reltuples(other.table)).toBe(-1);

    await upsertRange(
      store,
      target.space,
      INITIAL_ANALYZE_THRESHOLD - 1,
      INITIAL_ANALYZE_THRESHOLD,
    );
    expect(await reltuples(target.table)).toBe(INITIAL_ANALYZE_THRESHOLD);
    expect(await reltuples(other.table)).toBe(-1);
  }, 120_000);

  it("記憶が無くて断られた upsert は数えない（書いていないので）", async () => {
    const store = new PostgresVectorStore(client!.db);
    const { space, table } = await newSpace("rejected");

    for (let i = 0; i < INITIAL_ANALYZE_THRESHOLD - 1; i += 1) {
      await expect(store.upsert(ctx, space, randomUUID(), [0.1, 0.2, 0.3])).rejects.toThrow();
    }
    await upsertRange(store, space, 0, 1);
    expect(await reltuples(table)).toBe(-1);

    await upsertRange(store, space, 1, INITIAL_ANALYZE_THRESHOLD);
    expect(await reltuples(table)).toBe(INITIAL_ANALYZE_THRESHOLD);
  }, 120_000);

  it("search と delete は書き込みとして数えない", async () => {
    const store = new PostgresVectorStore(client!.db);
    const { space, table } = await newSpace("read-and-delete");
    await upsertRange(store, space, 0, 1);

    for (let i = 0; i < INITIAL_ANALYZE_THRESHOLD; i += 1) {
      await store.search(ctx, space, [0.1, 0.2, 0.3], { limit: 1, filter: { tenantId: TENANT } });
      await store.delete(ctx, space, randomUUID());
    }

    expect(await reltuples(table)).toBe(-1);
  }, 120_000);
});

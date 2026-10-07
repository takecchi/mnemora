import { afterAll, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { PostgresMemoryStore } from "../memory-store.js";
import { embeddingSpaceTableName } from "../embedding-space-table.js";
import {
  closeTestClient,
  getTestClient,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
} from "./test-db.js";

/** 外部キーを `pg_constraint` から数え上げる（表名を焼き込まない）ので、数え上げた経路とこの歯が持つ経路の集合が一致しないとき（外部キーが増えたとき）は、名指しで落ちる。 */

afterAll(async () => {
  await closeTestClient();
});

const T = "fk-path-victim";
const O = "fk-path-other";
const EMBEDDINGS = embeddingSpaceTableName(TEST_EMBEDDING_SPACE);

type Pool = Awaited<ReturnType<typeof getTestClient>>["pool"];

interface Fixture {
  mT: string;
  mO: string;
  obsT: string;
  rcT: string;
  rcO: string;
  lbT: string;
  lbO: string;
}

async function one(pool: Pool, text: string, params: unknown[]): Promise<string> {
  const r = await pool.query<{ id: string }>(text, params);
  return r.rows[0]!.id;
}

async function newMemory(pool: Pool, tenantId: string, hash: string): Promise<string> {
  return one(
    pool,
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
}

async function seedFixture(pool: Pool): Promise<Fixture> {
  const recall = (tenantId: string) =>
    one(
      pool,
      `INSERT INTO recalls (id, tenant_id, query, usage, index_band, returned_memories)
       VALUES (gen_random_uuid(), $1, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb)
       RETURNING id`,
      [tenantId],
    );
  const label = (tenantId: string) =>
    one(pool, `INSERT INTO labels (tenant_id, name) VALUES ($1, 'ラベル') RETURNING id`, [
      tenantId,
    ]);
  return {
    mT: await newMemory(pool, T, "fk-path-victim-1"),
    mO: await newMemory(pool, O, "fk-path-other-1"),
    obsT: await one(
      pool,
      `INSERT INTO observations (id, tenant_id, kind, payload)
       VALUES (gen_random_uuid(), $1, 'utterance', '{}'::jsonb) RETURNING id`,
      [T],
    ),
    rcT: await recall(T),
    rcO: await recall(O),
    lbT: await label(T),
    lbO: await label(O),
  };
}

/** 他テナント（O）の行から、テナント T の行を指す参照を、生 SQL で1本だけ作る。 */
const PATHS: Array<{ path: string; reference: (pool: Pool, f: Fixture) => Promise<unknown> }> = [
  {
    path: "memories.superseded_by_id",
    reference: (pool, f) =>
      pool.query("UPDATE memories SET superseded_by_id = $1 WHERE id = $2", [f.mT, f.mO]),
  },
  {
    path: "memories.contested_with_id",
    reference: (pool, f) =>
      pool.query("UPDATE memories SET contested_with_id = $1 WHERE id = $2", [f.mT, f.mO]),
  },
  {
    path: "memories.source_observation_id",
    reference: (pool, f) =>
      pool.query("UPDATE memories SET source_observation_id = $1 WHERE id = $2", [f.obsT, f.mO]),
  },
  {
    path: "memory_events.memory_id",
    reference: (pool, f) =>
      pool.query(
        `INSERT INTO memory_events (id, tenant_id, memory_id, kind, at, actor, meta)
         VALUES (gen_random_uuid(), $1, $2, 'updated', now(), '{"type":"system"}'::jsonb, '{}'::jsonb)`,
        [O, f.mT],
      ),
  },
  {
    path: "recall_usages.memory_id",
    reference: (pool, f) =>
      pool.query(
        "INSERT INTO recall_usages (tenant_id, recall_id, memory_id) VALUES ($1, $2, $3)",
        [O, f.rcO, f.mT],
      ),
  },
  {
    path: "recall_usages.recall_id",
    reference: (pool, f) =>
      pool.query(
        "INSERT INTO recall_usages (tenant_id, recall_id, memory_id) VALUES ($1, $2, $3)",
        [O, f.rcT, f.mO],
      ),
  },
  {
    path: "memory_labels.memory_id",
    reference: (pool, f) =>
      pool.query("INSERT INTO memory_labels (tenant_id, memory_id, label_id) VALUES ($1, $2, $3)", [
        O,
        f.mT,
        f.lbO,
      ]),
  },
  {
    path: "memory_labels.label_id",
    reference: (pool, f) =>
      pool.query("INSERT INTO memory_labels (tenant_id, memory_id, label_id) VALUES ($1, $2, $3)", [
        O,
        f.mO,
        f.lbT,
      ]),
  },
  {
    path: "memory_relations.from_memory_id",
    reference: (pool, f) =>
      pool.query(
        `INSERT INTO memory_relations (tenant_id, from_memory_id, to_memory_id, kind)
         VALUES ($1, $2, $3, 'contradicts')`,
        [O, f.mT, f.mO],
      ),
  },
  {
    path: "memory_relations.to_memory_id",
    reference: (pool, f) =>
      pool.query(
        `INSERT INTO memory_relations (tenant_id, from_memory_id, to_memory_id, kind)
         VALUES ($1, $2, $3, 'contradicts')`,
        [O, f.mO, f.mT],
      ),
  },
  {
    path: "memory_embeddings_<space>.memory_id",
    reference: (pool, f) =>
      pool.query(
        `INSERT INTO ${EMBEDDINGS} (tenant_id, memory_id, embedding, model)
         VALUES ($1, $2, '[1,2,3]', 'fk-path')`,
        [O, f.mT],
      ),
  },
];

/** tenant_id を持つ表どうしの単一列の外部キーを、実装とは別の問い合わせで数え上げる。 */
async function enumerateForeignKeyPaths(pool: Pool): Promise<string[]> {
  const r = await pool.query<{ child: string; col: string }>(`
    SELECT c.relname AS child, a.attname AS col
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_class p ON p.oid = con.confrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = con.conkey[1]
    WHERE con.contype = 'f'
      AND n.nspname = current_schema()
      AND array_length(con.conkey, 1) = 1
      AND EXISTS (SELECT 1 FROM pg_attribute t
                  WHERE t.attrelid = c.oid AND t.attname = 'tenant_id' AND NOT t.attisdropped)
      AND EXISTS (SELECT 1 FROM pg_attribute t
                  WHERE t.attrelid = p.oid AND t.attname = 'tenant_id' AND NOT t.attisdropped)
  `);
  const names = r.rows.map((row) =>
    row.child.startsWith("memory_embeddings_")
      ? `memory_embeddings_<space>.${row.col}`
      : `${row.child}.${row.col}`,
  );
  return [...new Set(names)].sort();
}

async function countRows(pool: Pool, tenantId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of [
    "memories",
    "observations",
    "recalls",
    "labels",
    "memory_events",
    "recall_usages",
    "memory_labels",
    "memory_relations",
    EMBEDDINGS,
  ]) {
    const r = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`,
      [tenantId],
    );
    out[table] = r.rows[0]!.n;
  }
  return out;
}

describe("eraseTenant は、他テナントの行がこのテナントの行を外部キーで参照する、どの経路でも止まる", () => {
  it("以下で検査する経路（PATHS）は、tenant_id を持つ表どうしの単一列の外部キーの全部である", async () => {
    await resetTestDatabase();
    const { pool } = await getTestClient();
    expect(await enumerateForeignKeyPaths(pool)).toEqual(PATHS.map((p) => p.path).sort());
  });

  for (const { path, reference } of PATHS) {
    it(`${path}: 他テナントからの参照が1本あると、dryRun でも本番でも blocked_by_foreign_reference（count 1）で、どちらのテナントの行も変わらない`, async () => {
      await resetTestDatabase();
      const { db, pool } = await getTestClient();
      const store = new PostgresMemoryStore(db);
      const f = await seedFixture(pool);
      await reference(pool, f);
      const ctx: Ctx = { tenantId: T };
      const beforeT = await countRows(pool, T);
      const beforeO = await countRows(pool, O);

      expect(await store.eraseTenant(ctx, { limit: 1000, dryRun: true })).toEqual({
        kind: "blocked_by_foreign_reference",
        count: 1,
      });
      expect(await store.eraseTenant(ctx, { limit: 1000 })).toEqual({
        kind: "blocked_by_foreign_reference",
        count: 1,
      });

      expect(await countRows(pool, T)).toEqual(beforeT);
      expect(await countRows(pool, O)).toEqual(beforeO);
    }, 60_000);
  }
});

import { mkdtempSync, copyFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Ctx, Provenance } from "@mnemora/core";
import {
  buildNewMemoryFixture,
  buildNewObservationFixture,
  buildProvenanceFixture,
} from "@mnemora/testkit";
import { closePostgresClient, createPostgresClient, type PostgresClient } from "../client.js";
import { runMigrations } from "../migrate.js";
import { DEFAULT_MIGRATIONS_DIR } from "../migrations-dir.cjs";
import { PostgresMemoryStore } from "../memory-store.js";
import { requireDatabaseUrl } from "./test-db.js";
import { dropTempDatabase } from "./temp-database.js";

/**
 * `provenance_kind` 列と `provenance->>'kind'` の一致を DB が強制すること。
 *
 * - 全部の migration を適用した後の制約が、既存行も検証済みであること。
 * - 一致していれば、5種のどの kind の行も通ること（正しい行を拒まない）。
 * - 一致していなければ、kind の取り違え・大文字小文字・前後の空白の違いも拒むこと。
 * - 既存行にずれた行があるとき、制約を足す migration は台帳に残って新しい書き込みを守り、
 *   検証する migration だけが失敗すること（1つの migration に同居させない理由は、この形でしか観測できない）。
 *
 * 専用の使い捨てデータベースを使う。migration を途中まで当てた状態を作るため、共有の DB は使えない。
 */

const CONSTRAINT = "memories_provenance_kind_matches_provenance";
const KINDS = ["stated", "inferred", "consolidated", "reflected", "imported"] as const;
const TENANT = "provenance-kind-check-recheck";
const ctx: Ctx = { tenantId: TENANT };

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

async function createDatabase(name: string): Promise<PostgresClient> {
  await dropTempDatabase(admin(), name);
  await admin().query(`CREATE DATABASE ${name}`);
  return createPostgresClient(connectionStringFor(name));
}

async function dropDatabase(name: string, client: PostgresClient | undefined): Promise<void> {
  if (client) {
    await closePostgresClient(client);
  }
  await dropTempDatabase(admin(), name);
}

async function constraintState(pool: Pool): Promise<{ validated: boolean } | null> {
  const result = await pool.query<{ convalidated: boolean }>(
    `SELECT convalidated FROM pg_constraint WHERE conname = $1 AND conrelid = 'memories'::regclass`,
    [CONSTRAINT],
  );
  const row = result.rows[0];
  return row === undefined ? null : { validated: row.convalidated };
}

async function insertRaw(
  pool: Pool,
  hash: string,
  kind: string,
  provenanceKindInJson: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO memories (
       id, tenant_id, content, content_hash, digest, digest_source,
       provenance_kind, provenance, status, tags, recorded_at,
       strength, half_life_hours, decay_floor_at, embedding_status, created_at, updated_at
     ) VALUES (
       gen_random_uuid(), $1, 'content', $2, 'digest', 'llm',
       $3, jsonb_build_object('kind', $4::text), 'active', '{}'::text[], now(),
       1.0, 720, now() + interval '30 days', 'pending', now(), now()
     )`,
    [TENANT, hash, kind, provenanceKindInJson],
  );
}

function provenanceOf(kind: (typeof KINDS)[number], observationId: string): Provenance {
  if (kind === "stated") {
    return { kind, sourceObservationId: observationId, at: new Date().toISOString() };
  }
  if (kind === "inferred") {
    return {
      kind,
      model: "test-model",
      promptVersion: "v1",
      basis: { memoryIds: [], observationIds: [observationId] },
      confidence: 0.5,
    };
  }
  return buildProvenanceFixture(kind);
}

const FULL_DB = "mnemora_provenance_kind_check_recheck_full_test";
const STAGED_DB = "mnemora_provenance_kind_check_recheck_staged_test";
let full: PostgresClient | undefined;
let staged: PostgresClient | undefined;

beforeAll(async () => {
  full = await createDatabase(FULL_DB);
  await runMigrations(full.pool);
  staged = await createDatabase(STAGED_DB);
}, 60_000);

afterAll(async () => {
  await dropDatabase(FULL_DB, full);
  await dropDatabase(STAGED_DB, staged);
  if (adminPool) {
    await adminPool.end();
    adminPool = undefined;
  }
}, 30_000);

describe("全部の migration を適用した後の provenance_kind の制約", () => {
  it("制約は既存行も検証済みである", async () => {
    expect(await constraintState(full!.pool)).toEqual({ validated: true });
  });

  it.each(KINDS)("kind が一致している %s の行は書き込める", async (kind) => {
    const store = new PostgresMemoryStore(full!.db);
    const observation = await store.createObservation(
      ctx,
      buildNewObservationFixture({ tenantId: TENANT }),
    );

    const memory = await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        contentHash: `matching-${kind}`,
        sourceObservationId: observation.id,
        provenance: provenanceOf(kind, observation.id),
      }),
    );

    const stored = await full!.pool.query<{ provenance_kind: string; kind: string }>(
      `SELECT provenance_kind, provenance->>'kind' AS kind FROM memories WHERE id = $1`,
      [memory.id],
    );
    expect(stored.rows[0]).toEqual({ provenance_kind: kind, kind });
  });

  it.each([
    ["consolidated", "imported"],
    ["consolidated", "reflected"],
    ["reflected", "consolidated"],
    ["reflected", "imported"],
    ["imported", "consolidated"],
    ["imported", "reflected"],
    ["imported", "Imported"],
    ["imported", "imported "],
    ["imported", " imported"],
    ["imported", ""],
  ])("列が %s で jsonb の kind が %j の行は拒まれる", async (kind, kindInJson) => {
    await expect(
      insertRaw(full!.pool, `mismatch-${kind}-${kindInJson}`, kind, kindInJson),
    ).rejects.toThrow(new RegExp(CONSTRAINT));
  });

  it.each([
    ["consolidated", "consolidated"],
    ["reflected", "reflected"],
    ["imported", "imported"],
  ])("列も jsonb の kind も %s の行は生 SQL でも書き込める", async (kind, kindInJson) => {
    await expect(
      insertRaw(full!.pool, `raw-match-${kind}`, kind, kindInJson),
    ).resolves.toBeUndefined();
  });
});

describe("既存行にずれた行があるとき", () => {
  it("制約を足す migration は台帳に残って新しい書き込みを守り、検証する migration だけが失敗する。ずれを直して再実行すると検証だけが走る", async () => {
    const { pool } = staged!;
    const before = mkdtempSync(join(tmpdir(), "mnemora-provenance-staged-"));
    for (const name of readdirSync(DEFAULT_MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort()) {
      if (name < "0016") {
        copyFileSync(join(DEFAULT_MIGRATIONS_DIR, name), join(before, name));
      }
    }
    await runMigrations(pool, before);
    expect(await constraintState(pool)).toBeNull();
    await insertRaw(pool, "pre-existing-mismatch", "consolidated", "imported");

    await expect(runMigrations(pool)).rejects.toThrow(
      /0017_provenance_kind_matches_provenance_validate\.sql/,
    );

    const ledger = await pool.query<{ name: string }>(
      `SELECT name FROM _mnemora_migrations WHERE name LIKE '0016%' OR name LIKE '0017%' ORDER BY name`,
    );
    expect(ledger.rows.map((r) => r.name)).toEqual(["0016_provenance_kind_matches_provenance.sql"]);
    expect(await constraintState(pool)).toEqual({ validated: false });
    await expect(insertRaw(pool, "new-mismatch", "reflected", "imported")).rejects.toThrow(
      new RegExp(CONSTRAINT),
    );
    await expect(insertRaw(pool, "new-match", "reflected", "reflected")).resolves.toBeUndefined();

    await pool.query(
      `UPDATE memories SET provenance_kind = provenance->>'kind' WHERE content_hash = 'pre-existing-mismatch'`,
    );
    const second = await runMigrations(pool);

    expect(second.applied).toContain("0017_provenance_kind_matches_provenance_validate.sql");
    expect(second.applied).not.toContain("0016_provenance_kind_matches_provenance.sql");
    expect(await constraintState(pool)).toEqual({ validated: true });
  }, 60_000);
});

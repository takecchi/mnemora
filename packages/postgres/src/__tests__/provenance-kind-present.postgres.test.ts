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
import { PostgresMemoryStore } from "../memory-store.js";
import { closePostgresClient, createPostgresClient, type PostgresClient } from "../client.js";
import { runMigrations } from "../migrate.js";
import { DEFAULT_MIGRATIONS_DIR } from "../migrations-dir.cjs";
import { requireDatabaseUrl } from "./test-db.js";
import { dropTempDatabase } from "./temp-database.js";

/**
 * `memories.provenance` の jsonb に `kind` が無い行を、DB が拒むこと（Issue #1909）。
 *
 * 元の制約 `memories_provenance_kind_matches_provenance`（`provenance_kind = provenance->>'kind'`）は、
 * jsonb に `kind` が無いと比較が NULL になって通る。それを `memories_provenance_kind_present`
 * （`provenance->>'kind' IS NOT NULL`）が拒む。
 *
 * - `kind` を欠く3つの形（`{}`・`{"kind": null}`・オブジェクトでない `"x"`）は拒まれること。
 * - `kind` が在って一致している行は、5種のどれも通ること（やりすぎて正しい行まで拒まないこと）。
 * - `kind` が在って一致していない行は、元の制約が引き続き拒むこと。
 * - 既存行に kind を欠く行があるとき、制約を足す migration は台帳に残って新しい書き込みを守り、
 *   検証する migration だけが失敗すること。
 *
 * 専用の使い捨てデータベースを使う。migration を途中まで当てた状態を作るため、共有の DB は使えない。
 */

const PRESENT = "memories_provenance_kind_present";
const MATCHES = "memories_provenance_kind_matches_provenance";
const KINDS = ["stated", "inferred", "consolidated", "reflected", "imported"] as const;
const TENANT = "provenance-kind-present";
const ctx: Ctx = { tenantId: TENANT };

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

async function constraintState(pool: Pool, name: string): Promise<{ validated: boolean } | null> {
  const result = await pool.query<{ convalidated: boolean }>(
    `SELECT convalidated FROM pg_constraint WHERE conname = $1 AND conrelid = 'memories'::regclass`,
    [name],
  );
  const row = result.rows[0];
  return row === undefined ? null : { validated: row.convalidated };
}

/** `provenance` の jsonb を、JSON のリテラルそのままで渡して INSERT する。 */
async function insertRaw(
  pool: Pool,
  hash: string,
  kind: string,
  provenanceJson: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO memories (
       id, tenant_id, content, content_hash, digest, digest_source,
       provenance_kind, provenance, status, tags, recorded_at,
       strength, half_life_hours, decay_floor_at, embedding_status, created_at, updated_at
     ) VALUES (
       gen_random_uuid(), $1, 'content', $2, 'digest', 'llm',
       $3, $4::jsonb, 'active', '{}'::text[], now(),
       1.0, 720, now() + interval '30 days', 'pending', now(), now()
     )`,
    [TENANT, hash, kind, provenanceJson],
  );
}

const FULL_DB = "mnemora_provenance_kind_present_full_test";
const STAGED_DB = "mnemora_provenance_kind_present_staged_test";
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

describe("全部の migration を適用した後の provenance の kind の有無", () => {
  it("制約は既存行も検証済みである", async () => {
    expect(await constraintState(full!.pool, PRESENT)).toEqual({ validated: true });
  });

  it.each([
    ["{}", "空のオブジェクト"],
    ['{"kind": null}', "kind が JSON の null"],
    ['"x"', "オブジェクトでない（文字列）"],
    ['"kind"', "オブジェクトでない（文字列 kind。`?` なら真になる）"],
    ["[]", "オブジェクトでない（配列）"],
    ["null", "JSON の null"],
  ])("jsonb が %s（%s）の行は拒まれる", async (provenanceJson) => {
    await expect(
      insertRaw(full!.pool, `absent-${provenanceJson}`, "imported", provenanceJson),
    ).rejects.toThrow(new RegExp(PRESENT));
  });

  it("書き込み済みの行の provenance から kind を外す UPDATE も拒まれる", async () => {
    await insertRaw(full!.pool, "update-guard", "imported", '{"kind":"imported"}');
    await expect(
      full!.pool.query(
        `UPDATE memories SET provenance = '{}'::jsonb WHERE content_hash = 'update-guard'`,
      ),
    ).rejects.toThrow(new RegExp(PRESENT));
  });

  it.each(KINDS)("kind が在って一致している %s の行は書き込める", async (kind) => {
    const store = new PostgresMemoryStore(full!.db);
    const observation = await store.createObservation(
      ctx,
      buildNewObservationFixture({ tenantId: TENANT }),
    );
    const memory = await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        contentHash: `present-${kind}`,
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

  it("kind が在って一致していない行は、元の制約が拒む", async () => {
    await expect(
      insertRaw(full!.pool, "mismatch", "consolidated", '{"kind":"imported"}'),
    ).rejects.toThrow(new RegExp(MATCHES));
  });
});

describe("既存行に kind を欠く行があるとき", () => {
  it("制約を足す migration は台帳に残って新しい書き込みを守り、検証する migration だけが失敗する。直して再実行すると検証だけが走る", async () => {
    const { pool } = staged!;
    const before = mkdtempSync(join(tmpdir(), "mnemora-provenance-present-staged-"));
    for (const name of readdirSync(DEFAULT_MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort()) {
      if (name < "0033") {
        copyFileSync(join(DEFAULT_MIGRATIONS_DIR, name), join(before, name));
      }
    }
    await runMigrations(pool, before);
    expect(await constraintState(pool, PRESENT)).toBeNull();
    // 元の制約は、kind を欠く行を通す。それが今回の穴である。
    await insertRaw(pool, "pre-existing-absent", "imported", "{}");

    await expect(runMigrations(pool)).rejects.toThrow(/0034_provenance_kind_present_validate\.sql/);

    const ledger = await pool.query<{ name: string }>(
      `SELECT name FROM _mnemora_migrations WHERE name LIKE '0033%' OR name LIKE '0034%' ORDER BY name`,
    );
    expect(ledger.rows.map((r) => r.name)).toEqual(["0033_provenance_kind_present.sql"]);
    expect(await constraintState(pool, PRESENT)).toEqual({ validated: false });
    await expect(insertRaw(pool, "new-absent", "imported", "{}")).rejects.toThrow(
      new RegExp(PRESENT),
    );
    await expect(
      insertRaw(pool, "new-present", "reflected", '{"kind":"reflected"}'),
    ).resolves.toBeUndefined();

    await pool.query(
      `UPDATE memories SET provenance = '{"kind":"imported"}'::jsonb WHERE content_hash = 'pre-existing-absent'`,
    );
    const second = await runMigrations(pool);

    expect(second.applied).toContain("0034_provenance_kind_present_validate.sql");
    expect(second.applied).not.toContain("0033_provenance_kind_present.sql");
    expect(await constraintState(pool, PRESENT)).toEqual({ validated: true });
  }, 60_000);
});

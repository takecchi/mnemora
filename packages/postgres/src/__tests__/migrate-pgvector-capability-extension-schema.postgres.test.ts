import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { runMigrations } from "../migrate.js";
import { countMatchingQueries, requireDatabaseUrl } from "./test-db.js";
import { dropTempDatabase } from "./temp-database.js";

/**
 * 検査の SQL は `'[0]'::vector` と型をスキーマ修飾せずに書く。ところが検査は、各ファイルを流すときの `SET LOCAL search_path TO <schema>,<extensionSchema>` の外で流れる。
 * 接続の既定の `search_path`（`"$user", public`）に `extensionSchema` は入っていないので、`vector` が `public` 以外にあると `type "vector" does not exist` で落ちる。
 *
 * 再現の条件: `vector` が `public` に無い DB（使い捨ての DB を作り、`extensionSchema` に拡張を置く。共有の `mnemora_test` は `public` にあるので落ちない）、
 * `schema` と `extensionSchema` の両方を渡す（`schema` 未指定だと `extensionSchema` は捨てられる）、`search_path` に手を加えない普通の `pg.Pool`。
 *
 * 直し方に対する縛り: 検査のあと同じ接続（`max: 1` の pool）の `SHOW search_path` が元のまま（`SET`・`set_config(..., false)` で恒久的に書き換える実装を捕まえる）。
 * `schema` 未指定の呼び出しは `search_path` を一切触らない（`SET`・`set_config` を含む文が0本）。検査を飛ばす・握りつぶす実装は結果だけでは捕まらないので、検査の問い合わせが実際に流れたことも数える。
 */

const EXT_SCHEMA = "mnemora_ext_1780";
const SCHEMA = "mnemora_app_1780";
const BASE_PATH = '"$user", public';
const CAPABILITY_QUERY_MARK = /hnsw\.iterative_scan/;
const SEARCH_PATH_TOUCH = /search_path/i;

const createdDatabases: string[] = [];
const openedPools: Pool[] = [];
let adminPool: Pool | undefined;

function admin(): Pool {
  adminPool ??= new Pool({ connectionString: requireDatabaseUrl(), max: 1 });
  return adminPool;
}

/** 使い捨ての DB を作り、`max: 1`（検査のあとの接続をそのまま見るため）の素の Pool を返す。 */
async function createBlankDatabase(database: string): Promise<Pool> {
  await dropTempDatabase(admin(), database);
  await admin().query(`CREATE DATABASE ${database}`);
  createdDatabases.push(database);
  const url = new URL(requireDatabaseUrl());
  url.pathname = `/${database}`;
  const pool = new Pool({ connectionString: url.toString(), max: 1 });
  openedPools.push(pool);
  return pool;
}

async function installExtensions(pool: Pool, extensionSchema: string): Promise<void> {
  if (extensionSchema !== "public") {
    await pool.query(`CREATE SCHEMA "${extensionSchema}"`);
  }
  for (const ext of ["vector", "btree_gin", "pgcrypto"]) {
    await pool.query(`CREATE EXTENSION ${ext} WITH SCHEMA "${extensionSchema}"`);
  }
}

async function showSearchPath(pool: Pool): Promise<string> {
  const { rows } = await pool.query<{ search_path: string }>("SHOW search_path");
  return rows[0]!.search_path;
}

describe("runMigrations: pgvector 能力検査と extensionSchema（Issue #1780）", () => {
  afterAll(async () => {
    for (const pool of openedPools) {
      await pool.end();
    }
    for (const database of createdDatabases) {
      await dropTempDatabase(admin(), database);
    }
    await adminPool?.end();
  });

  it("create: vector が extensionSchema にあっても通り、検査のあと search_path は元のまま", async () => {
    const pool = await createBlankDatabase("mnemora_capext_create");
    await installExtensions(pool, EXT_SCHEMA);
    expect(await showSearchPath(pool)).toBe(BASE_PATH);

    const result = await runMigrations(pool, undefined, {
      schema: SCHEMA,
      extensionSchema: EXT_SCHEMA,
      extensionMode: "create",
    });

    expect(result.applied.length).toBeGreaterThan(0);
    expect(await showSearchPath(pool)).toBe(BASE_PATH);
  });

  it("create（2回目、適用済み）: 検査だけが流れる定常状態でも通り、検査の問い合わせが流れ、search_path は元のまま", async () => {
    const pool = await createBlankDatabase("mnemora_capext_create_again");
    await installExtensions(pool, EXT_SCHEMA);
    const options = { schema: SCHEMA, extensionSchema: EXT_SCHEMA } as const;
    await runMigrations(pool, undefined, options);

    let result: Awaited<ReturnType<typeof runMigrations>> | undefined;
    const probes = await countMatchingQueries(
      (text) => CAPABILITY_QUERY_MARK.test(text),
      async () => {
        result = await runMigrations(pool, undefined, options);
      },
    );

    expect(result!.applied).toEqual([]);
    expect(probes).toBe(1);
    expect(await showSearchPath(pool)).toBe(BASE_PATH);
  });

  it("verify: vector が extensionSchema にあっても通り、検査のあと search_path は元のまま", async () => {
    const pool = await createBlankDatabase("mnemora_capext_verify");
    await installExtensions(pool, EXT_SCHEMA);

    const probes = await countMatchingQueries(
      (text) => CAPABILITY_QUERY_MARK.test(text),
      async () => {
        const result = await runMigrations(pool, undefined, {
          schema: SCHEMA,
          extensionSchema: EXT_SCHEMA,
          extensionMode: "verify",
        });
        expect(result.extensionCheck).toEqual({
          verified: ["vector", "btree_gin", "pgcrypto"],
        });
      },
    );

    expect(probes).toBe(1);
    expect(await showSearchPath(pool)).toBe(BASE_PATH);
  });

  it("対照: schema 指定・extensionSchema 省略（public）は、create/verify とも通り、search_path は元のまま", async () => {
    const pool = await createBlankDatabase("mnemora_capext_schema_public");
    await installExtensions(pool, "public");

    await runMigrations(pool, undefined, { schema: SCHEMA });
    expect(await showSearchPath(pool)).toBe(BASE_PATH);
    await runMigrations(pool, undefined, { schema: SCHEMA, extensionMode: "verify" });
    expect(await showSearchPath(pool)).toBe(BASE_PATH);
  });

  it("対照: schema 未指定（public）は、create/verify とも通り、2回目の呼び出しは search_path に触れない", async () => {
    const pool = await createBlankDatabase("mnemora_capext_no_schema");
    await runMigrations(pool); // create。vector は 0001_init.sql が public に作る。
    expect(await showSearchPath(pool)).toBe(BASE_PATH);

    for (const extensionMode of ["create", "verify"] as const) {
      let probed = 0;
      const touches = await countMatchingQueries(
        (text) => {
          if (CAPABILITY_QUERY_MARK.test(text)) probed += 1;
          return SEARCH_PATH_TOUCH.test(text);
        },
        async () => {
          await runMigrations(pool, undefined, { extensionMode });
        },
      );
      expect(probed).toBe(1);
      expect(touches).toBe(0);
      expect(await showSearchPath(pool)).toBe(BASE_PATH);
    }
  });
});

import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, EmbeddingSpaceId } from "@mnemora/core";
import { buildNewMemoryFixture, buildNewObservationFixture } from "@mnemora/testkit";
import { DEFAULT_MIGRATIONS_DIR, listMigrationFiles, runMigrations } from "../migrate.js";
import { registerEmbeddingSpace } from "../vector-space.js";
import { embeddingSpaceIndexName, embeddingSpaceTableName } from "../embedding-space-table.js";
import { closePostgresClient, createPostgresClient } from "../client.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { requireDatabaseUrl } from "./test-db.js";
import { dropTempDatabase } from "./temp-database.js";

/**
 * 「専用スキーマを使う側が指定できる」（feat/dedicated-schema）の適合テスト。
 *
 * `schema-namespace-probe.postgres.test.ts`（🔬 段1の測定用の探針、既に削除済み）が
 * 本物の PostgreSQL に対して測った性質のうち、実装（`schema-namespace.ts` /
 * `migrate.ts` / `vector-space.ts` / `client.ts`）が採用した設計に対応する部分を、
 * ここで「契約」として置き直す。探針の doc がそう約束していた
 * （「設計判断が済んで実装が入ったら、ここで測った性質は本物の適合テストへ移し、
 * このファイルは消す」）。
 *
 * ## 探針から運ばなかったもの
 *
 * - 測定5（`ALTER TABLE ... SET SCHEMA` で既存環境を後から移す）: 実装のどの関数も
 *   この操作を行わない。移行手順そのものが製品コードに存在しないため、適合テストの
 *   対象が無い。
 * - 測定6b（既に別スキーマに在る拡張へ `WITH SCHEMA public` 付き
 *   `CREATE EXTENSION IF NOT EXISTS` を撃ったときの挙動）: `extensionSchema` の既定値
 *   （`DEFAULT_EXTENSION_SCHEMA = "public"`）を変える呼び出しは実装が公開していない
 *   経路であり、ここでは確認していない。
 *
 * ## 🔴 探針の唯一の赤の原因（この歯で踏まないための注意）
 *
 * `to_regclass(...)::text` は、`search_path` から到達できるスキーマ修飾を**描画時に
 * 省く**。つまり結果の文字列は `search_path` の中身で変わる——「存在するか」を
 * `::text` の文字列一致で問うと、`search_path` が変われば同じ問い合わせでも別の
 * 文字列を返し、偽陰性/偽陽性になる。ここでは常に `IS NOT NULL`（存在の有無）か
 * `::oid`（同一性の比較）で問い、`::text` の文字列一致は使わない。
 */

const DOMAIN_TABLES = [
  "observations",
  "memories",
  "memory_events",
  "recalls",
  "recall_usages",
  "outbox",
  "tenant_settings",
] as const;

const DB_ISOLATE = "mnemora_ds_isolate";
const DB_TWO_SCHEMAS = "mnemora_ds_two_schemas";
const DB_FRESH_EXT = "mnemora_ds_fresh_ext";
const DB_VECTOR_SPACE = "mnemora_ds_vector_space";
const DB_CLIENT = "mnemora_ds_client";
const DB_DEFAULT = "mnemora_ds_default";

const VECTOR_SPACE: EmbeddingSpaceId = {
  provider: "test",
  model: "dedicated-schema-fixture",
  dimensions: 3,
};

const createdDatabases: string[] = [];
const openedPools: Pool[] = [];
let adminPool: Pool | undefined;

function admin(): Pool {
  adminPool ??= new Pool({ connectionString: requireDatabaseUrl(), max: 1 });
  return adminPool;
}

function connectionStringFor(database: string): string {
  const url = new URL(requireDatabaseUrl());
  url.pathname = `/${database}`;
  return url.toString();
}

/** 使い捨てのデータベースを作り、専用の Pool を返す（`temp-database.ts` の作法どおり FORCE を使わない）。 */
async function createBlankDatabase(database: string): Promise<Pool> {
  await dropTempDatabase(admin(), database);
  await admin().query(`CREATE DATABASE ${database}`);
  createdDatabases.push(database);
  const pool = new Pool({ connectionString: connectionStringFor(database), max: 5 });
  openedPools.push(pool);
  return pool;
}

/**
 * `qualifiedName` は `'"schema"."name"'` の形（二重引用符込み）で渡す。
 * `to_regclass` へパラメータとして渡すので SQL 文字列へ埋め込まない
 * （`::text` へ落とさず `::oid` で比較する——冒頭 doc の注意点参照）。
 */
async function regclassOid(pool: Pool, qualifiedName: string): Promise<string | null> {
  const { rows } = await pool.query<{ oid: string | null }>(
    "SELECT to_regclass($1)::oid::text AS oid",
    [qualifiedName],
  );
  return rows[0]!.oid;
}

function qualifiedName(schema: string, name: string): string {
  return `"${schema}"."${name}"`;
}

async function extensionNamespace(pool: Pool, extname: string): Promise<string | null> {
  const { rows } = await pool.query<{ nspname: string | null }>(
    `SELECT n.nspname AS nspname
       FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
      WHERE e.extname = $1`,
    [extname],
  );
  return rows[0]?.nspname ?? null;
}

/** `table` の外部キーが実際に指しているスキーマ修飾済みの参照先テーブル名の一覧。 */
async function foreignKeyTargets(pool: Pool, schema: string, table: string): Promise<string[]> {
  const { rows } = await pool.query<{ loc: string }>(
    `SELECT nf.nspname || '.' || cf.relname AS loc
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_class cf ON cf.oid = con.confrelid
       JOIN pg_namespace nf ON nf.oid = cf.relnamespace
      WHERE c.relname = $1 AND n.nspname = $2 AND con.contype = 'f'`,
    [table, schema],
  );
  return rows.map((r) => r.loc);
}

describe("専用スキーマ（feat/dedicated-schema）", () => {
  afterAll(async () => {
    for (const pool of openedPools) {
      await pool.end();
    }
    for (const database of createdDatabases) {
      await dropTempDatabase(admin(), database);
    }
    if (adminPool) {
      await adminPool.end();
    }
  });

  it("測定1: public に本番一式が在る DB で、専用スキーマ（mnemora_alt）へ隔離して適用できる", async () => {
    const pool = await createBlankDatabase(DB_ISOLATE);

    // 既定経路: public に本番一式。
    await runMigrations(pool);

    // 専用スキーマへ同じ一式を適用する。
    const result = await runMigrations(pool, DEFAULT_MIGRATIONS_DIR, { schema: "mnemora_alt" });

    // 期待値をハードコードしない（migrate.ts の doc: migrations/ が増えるたびに
    // 書き換える羽目になる歯にしないため）。
    expect(result.applied).toEqual(listMigrationFiles(DEFAULT_MIGRATIONS_DIR));

    const altMemoriesOid = await regclassOid(pool, qualifiedName("mnemora_alt", "memories"));
    const publicMemoriesOid = await regclassOid(pool, qualifiedName("public", "memories"));

    expect(altMemoriesOid, "mnemora_alt.memories が存在すること").not.toBeNull();
    // 🔴 public 側が無傷であることは IS NOT NULL（存在の有無）で見る。
    // to_regclass(...)::text の文字列一致にしない（冒頭 doc 参照）。
    expect(publicMemoriesOid, "public.memories が無傷であること").not.toBeNull();
    expect(altMemoriesOid, "public 側と専用スキーマ側は別の relation であること").not.toBe(
      publicMemoriesOid,
    );

    for (const table of DOMAIN_TABLES) {
      const inAlt = await regclassOid(pool, qualifiedName("mnemora_alt", table));
      const inPublic = await regclassOid(pool, qualifiedName("public", table));
      expect(inAlt, `mnemora_alt.${table} が存在すること`).not.toBeNull();
      expect(inPublic, `public.${table} が無傷であること`).not.toBeNull();
    }
  });

  it("測定2: 1つの DB に2つの専用スキーマ（mnemora_a / mnemora_b）を同居させられる", async () => {
    const pool = await createBlankDatabase(DB_TWO_SCHEMAS);

    await runMigrations(pool, DEFAULT_MIGRATIONS_DIR, { schema: "mnemora_a" });
    await runMigrations(pool, DEFAULT_MIGRATIONS_DIR, { schema: "mnemora_b" });

    for (const table of DOMAIN_TABLES) {
      const inA = await regclassOid(pool, qualifiedName("mnemora_a", table));
      const inB = await regclassOid(pool, qualifiedName("mnemora_b", table));
      expect(inA, `mnemora_a.${table} が存在すること`).not.toBeNull();
      expect(inB, `mnemora_b.${table} が存在すること`).not.toBeNull();
      expect(inA, `mnemora_a.${table} と mnemora_b.${table} は別の relation であること`).not.toBe(
        inB,
      );
    }
  });

  it("測定3: まっさらな DB でも2つ目のスキーマが壊れない（拡張は既定で public に置かれる）", async () => {
    const pool = await createBlankDatabase(DB_FRESH_EXT);

    // まっさらな DB（schema 無しの runMigrations を先に通さない）。
    await runMigrations(pool, DEFAULT_MIGRATIONS_DIR, { schema: "s1" });
    await runMigrations(pool, DEFAULT_MIGRATIONS_DIR, { schema: "s2" });

    for (const ext of ["vector", "btree_gin", "pgcrypto"] as const) {
      const namespace = await extensionNamespace(pool, ext);
      expect(namespace, `拡張 ${ext} が public に在ること（s1 に入っていないこと）`).toBe("public");
    }

    // 🔴 ここが直接の負の対照: s2 側から vector 型が解決できないと
    // registerEmbeddingSpace 自体が CREATE TABLE の時点で失敗する。
    await expect(
      registerEmbeddingSpace(pool, VECTOR_SPACE, { schema: "s2" }),
    ).resolves.toMatchObject({ lock: { waitedMs: expect.any(Number) } });

    const table = embeddingSpaceTableName(VECTOR_SPACE);
    const inS2 = await regclassOid(pool, qualifiedName("s2", table));
    expect(inS2, `s2.${table} が存在すること（vector 型が解決できた証拠）`).not.toBeNull();
  });

  it("測定4: registerEmbeddingSpace の DDL がスキーマへ入る", async () => {
    const pool = await createBlankDatabase(DB_VECTOR_SPACE);
    await runMigrations(pool, DEFAULT_MIGRATIONS_DIR, { schema: "mnemora_vs" });

    await registerEmbeddingSpace(pool, VECTOR_SPACE, { schema: "mnemora_vs" });

    const table = embeddingSpaceTableName(VECTOR_SPACE);
    const index = embeddingSpaceIndexName(VECTOR_SPACE);

    const tableOid = await regclassOid(pool, qualifiedName("mnemora_vs", table));
    const indexOid = await regclassOid(pool, qualifiedName("mnemora_vs", index));
    expect(tableOid, `mnemora_vs.${table} が存在すること`).not.toBeNull();
    expect(
      indexOid,
      `mnemora_vs.${index} が存在すること（HNSW 索引もスキーマへ入ること）`,
    ).not.toBeNull();

    const fkTargets = await foreignKeyTargets(pool, "mnemora_vs", table);
    expect(
      fkTargets,
      "外部キーの参照先が mnemora_vs.memories であること（public.memories ではない）",
    ).toEqual(["mnemora_vs.memories"]);
  });

  it("測定5（端から端まで）: createPostgresClient({ schema }) で書いた行は <schema>.memories に入り、public.memories には入らない", async () => {
    const pool = await createBlankDatabase(DB_CLIENT);
    // 既定経路（public）と専用スキーマの両方を同じ DB に用意する
    // ——「DML を1行も変えずに search_path で効く」ことを見るには、
    // public 側にも同じ形の一式が在って初めて「入らなかった」ことに意味が出る。
    await runMigrations(pool);
    await runMigrations(pool, DEFAULT_MIGRATIONS_DIR, { schema: "mnemora_client" });

    const client = createPostgresClient(connectionStringFor(DB_CLIENT), {
      schema: "mnemora_client",
    });
    try {
      const store = new PostgresMemoryStore(client.db);
      const ctx: Ctx = { tenantId: "tenant-dedicated-schema-e2e" };

      const observation = await store.createObservation(ctx, buildNewObservationFixture());
      const memory = await store.createMemory(
        ctx,
        buildNewMemoryFixture({ sourceObservationId: observation.id }),
      );
      expect(memory.id).toBeTruthy();

      const inSchema = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM "mnemora_client".memories WHERE tenant_id = $1`,
        [ctx.tenantId],
      );
      expect(inSchema.rows[0]!.n, "mnemora_client.memories に行が入っていること").toBe("1");

      const inPublic = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM public.memories WHERE tenant_id = $1`,
        [ctx.tenantId],
      );
      expect(inPublic.rows[0]!.n, "public.memories には入っていないこと").toBe("0");
    } finally {
      await closePostgresClient(client);
    }
  });

  it("測定6: schema 未指定なら既定の経路は今日どおり通り、public に一式が出来る", async () => {
    const pool = await createBlankDatabase(DB_DEFAULT);

    const result = await runMigrations(pool);
    expect(result.applied).toEqual(listMigrationFiles(DEFAULT_MIGRATIONS_DIR));

    for (const table of DOMAIN_TABLES) {
      const oid = await regclassOid(pool, qualifiedName("public", table));
      expect(oid, `public.${table} が存在すること`).not.toBeNull();
    }
  });
});

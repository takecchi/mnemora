import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import type { ClaimKey, Ctx, EmbeddingSpaceId } from "@mnemora/core";
import {
  buildNewMemoryEventFixture,
  buildNewMemoryFixture,
  buildNewObservationFixture,
  buildProvenanceFixture,
} from "@mnemora/testkit";
import { DEFAULT_MIGRATIONS_DIR, listMigrationFiles, runMigrations } from "../migrate.js";
import { registerEmbeddingSpace } from "../vector-space.js";
import { embeddingSpaceIndexName, embeddingSpaceTableName } from "../embedding-space-table.js";
import { closePostgresClient, createPostgresClient } from "../client.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { requireDatabaseUrl } from "./test-db.js";
import { dropTempDatabase } from "./temp-database.js";

/**
 * `to_regclass(...)::text` は、`search_path` から到達できるスキーマ修飾を描画時に省くので、結果の文字列は `search_path` の中身で変わる。
 * 「存在するか」を `::text` の文字列一致で問うと偽陰性/偽陽性になるので、常に `IS NOT NULL`（存在の有無）か `::oid`（同一性の比較）で問う。
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
const DB_VECTOR_STORE = "mnemora_ds_vector_store";
const DB_KIND_CONSTRAINT_SCOPE = "mnemora_ds_kind_constraint_scope";
const DB_RESERVED_WORD_SCHEMA = "mnemora_ds_reserved_word_schema";
const DB_DELETE_ACROSS_SPACES = "mnemora_ds_delete_across_spaces";
const DB_FIND_CONTESTED = "mnemora_ds_find_contested";

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

/** `qualifiedName` は `'"schema"."name"'` の形（二重引用符込み）で渡す。`to_regclass` へパラメータとして渡し、SQL 文字列へ埋め込まない。 */
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

/**
 * `schema` の `memory_events` に付いている CHECK 制約の定義文字列一覧（`pg_get_constraintdef` の出力）。
 * `nspname` を明示的にパラメータで絞る。`relname` だけで絞ると、同じ DB に同居する別スキーマの `memory_events` まで拾ってしまう。
 */
async function memoryEventsKindCheckDefs(pool: Pool, schema: string): Promise<string[]> {
  const { rows } = await pool.query<{ def: string }>(
    `SELECT pg_get_constraintdef(con.oid) AS def
       FROM pg_constraint con
       JOIN pg_class rel ON rel.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = rel.relnamespace
      WHERE rel.relname = 'memory_events' AND n.nspname = $1 AND con.contype = 'c'`,
    [schema],
  );
  return rows.map((r) => r.def);
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

    await runMigrations(pool);

    const result = await runMigrations(pool, DEFAULT_MIGRATIONS_DIR, { schema: "mnemora_alt" });

    // 期待値をハードコードしない（migrations/ が増えるたびに書き換える羽目になる歯にしないため）。
    expect(result.applied).toEqual(listMigrationFiles(DEFAULT_MIGRATIONS_DIR));

    const altMemoriesOid = await regclassOid(pool, qualifiedName("mnemora_alt", "memories"));
    const publicMemoriesOid = await regclassOid(pool, qualifiedName("public", "memories"));

    expect(altMemoriesOid, "mnemora_alt.memories が存在すること").not.toBeNull();
    // public 側が無傷であることは IS NOT NULL（存在の有無）で見る（`::text` の文字列一致にしない）。
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

    await runMigrations(pool, DEFAULT_MIGRATIONS_DIR, { schema: "s1" });
    await runMigrations(pool, DEFAULT_MIGRATIONS_DIR, { schema: "s2" });

    for (const ext of ["vector", "btree_gin", "pgcrypto"] as const) {
      const namespace = await extensionNamespace(pool, ext);
      expect(namespace, `拡張 ${ext} が public に在ること（s1 に入っていないこと）`).toBe("public");
    }

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
    // 既定経路（public）と専用スキーマの両方を同じ DB に用意する。public 側にも同じ形の一式が在って初めて「入らなかった」ことに意味が出る。
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

  it(
    "測定7: PostgresVectorStore.search が専用スキーマ経由で" +
      "「動的識別子 + JOIN + ::vector + ADR 0056 の除外条件」を1文で通し、public 側は一切読まれない",
    async () => {
      const pool = await createBlankDatabase(DB_VECTOR_STORE);

      // 既定経路（public）と専用スキーマの両方に同じ一式（migrations + 埋め込みテーブル）を用意する。
      // 「そちらを読んでいない」ことを言うには、そちらにも読める形が在って初めて意味が出る。
      // 埋め込みテーブルも public 側に無いと、後段で public 側を件数0で確認できない（relation does not exist で落ちるだけになる）。
      await runMigrations(pool);
      await registerEmbeddingSpace(pool, VECTOR_SPACE);

      const schema = "mnemora_vstore";
      await runMigrations(pool, DEFAULT_MIGRATIONS_DIR, { schema });
      await registerEmbeddingSpace(pool, VECTOR_SPACE, { schema });

      const client = createPostgresClient(connectionStringFor(DB_VECTOR_STORE), { schema });
      try {
        const memoryStore = new PostgresMemoryStore(client.db);
        const vectorStore = new PostgresVectorStore(client.db);
        const ctx: Ctx = { tenantId: "tenant-dedicated-schema-vector-store" };

        // provenanceKind は 'imported'（残す側）と 'consolidated'（除外する側）を使う。
        // 'stated'/'inferred' は CHECK により実在する Observation を指す source_observation_id を要求するが、ここでは用意しない。
        const excludedMemory = await memoryStore.createMemory(
          ctx,
          buildNewMemoryFixture({
            contentHash: "fixture-hash-vector-store-excluded",
            provenance: buildProvenanceFixture("consolidated"),
          }),
        );
        const keptMemory = await memoryStore.createMemory(
          ctx,
          buildNewMemoryFixture({
            contentHash: "fixture-hash-vector-store-kept",
            provenance: buildProvenanceFixture("imported"),
          }),
        );

        await vectorStore.upsert(ctx, VECTOR_SPACE, excludedMemory.id, [1, 0, 0]);
        await vectorStore.upsert(ctx, VECTOR_SPACE, keptMemory.id, [0, 1, 0]);

        const bothHits = await vectorStore.search(ctx, VECTOR_SPACE, [1, 0, 0], {
          limit: 10,
          filter: { tenantId: ctx.tenantId },
        });
        const bothIds = bothHits.map((hit) => hit.memoryId);
        expect(bothIds, "excludeProvenanceKinds 無しなら2件とも返ること（除外側）").toContain(
          excludedMemory.id,
        );
        expect(bothIds, "excludeProvenanceKinds 無しなら2件とも返ること（残す側）").toContain(
          keptMemory.id,
        );
        expect(bothIds, "excludeProvenanceKinds 無しなら2件ちょうどであること").toHaveLength(2);

        const filteredHits = await vectorStore.search(ctx, VECTOR_SPACE, [1, 0, 0], {
          limit: 10,
          filter: { tenantId: ctx.tenantId, excludeProvenanceKinds: ["consolidated"] },
        });
        const filteredIds = filteredHits.map((hit) => hit.memoryId);
        expect(
          filteredIds,
          "excludeProvenanceKinds: ['consolidated'] なら残す側（imported）1件だけ返ること",
        ).toEqual([keptMemory.id]);

        // public 側が読まれていないことは、client ではなく生の pool で問う。pool は search_path を設定していないので常に既定の public を見る。
        // client（search_path の先頭が専用スキーマ）で書いた行が万一 public 側にも漏れていたら、同じ問いを非対称な経路で投げることでしか検出できない。
        const embeddingTable = embeddingSpaceTableName(VECTOR_SPACE);
        const publicMemories = await pool.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM public.memories WHERE tenant_id = $1`,
          [ctx.tenantId],
        );
        expect(
          publicMemories.rows[0]!.n,
          "public.memories が0件のままであること（search_path 越しに専用スキーマへしか書いていない証拠）",
        ).toBe("0");

        const publicEmbeddings = await pool.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM ${qualifiedName("public", embeddingTable)} WHERE tenant_id = $1`,
          [ctx.tenantId],
        );
        expect(
          publicEmbeddings.rows[0]!.n,
          "public 側の埋め込みテーブルも0件のままであること",
        ).toBe("0");
      } finally {
        await closePostgresClient(client);
      }
    },
  );

  // `assertSafeSchemaName` は文字種と長さしか見ないので、予約語（`user` 等）も通る。`client.ts` の起動パラメータ（`-c search_path=...`）は
  // SQL の構文解析を経ないので問題ないが、`migrate.ts` の `SET LOCAL search_path TO ...` は通常の SQL 文として解析されるので、
  // 予約語を引用符無しで埋め込むと構文エラーになる。
  it("測定8: 予約語スキーマ名（`user`）でも runMigrations / createPostgresClient / 検索が壊れない", async () => {
    const pool = await createBlankDatabase(DB_RESERVED_WORD_SCHEMA);

    const result = await runMigrations(pool, DEFAULT_MIGRATIONS_DIR, { schema: "user" });
    expect(result.applied).toEqual(listMigrationFiles(DEFAULT_MIGRATIONS_DIR));

    const memoriesOid = await regclassOid(pool, qualifiedName("user", "memories"));
    expect(memoriesOid, '"user".memories が存在すること').not.toBeNull();

    const client = createPostgresClient(connectionStringFor(DB_RESERVED_WORD_SCHEMA), {
      schema: "user",
    });
    try {
      const store = new PostgresMemoryStore(client.db);
      const ctx: Ctx = { tenantId: "tenant-reserved-word-schema" };

      const observation = await store.createObservation(ctx, buildNewObservationFixture());
      const memory = await store.createMemory(
        ctx,
        buildNewMemoryFixture({ sourceObservationId: observation.id }),
      );
      expect(memory.id).toBeTruthy();

      const inSchema = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM "user".memories WHERE tenant_id = $1`,
        [ctx.tenantId],
      );
      expect(inSchema.rows[0]!.n, '"user".memories に行が入っていること').toBe("1");
    } finally {
      await closePostgresClient(client);
    }
  });

  // 既存の測定群が移行全体の成否として間接的に捕まえていたものを、張り替えが正しいスキーマにだけ効いたことそのものとして直接測る。
  it(
    "追加: 移行0011（memory_events.kind の CHECK 制約張り替え）は、専用スキーマが" +
      "同居していても現在のスキーマの制約だけを張り替える",
    async () => {
      const pool = await createBlankDatabase(DB_KIND_CONSTRAINT_SCOPE);

      await runMigrations(pool, DEFAULT_MIGRATIONS_DIR, { schema: "mnemora_kc_a" });
      await runMigrations(pool, DEFAULT_MIGRATIONS_DIR, { schema: "mnemora_kc_b" });

      for (const schema of ["mnemora_kc_a", "mnemora_kc_b"]) {
        const defs = await memoryEventsKindCheckDefs(pool, schema);
        expect(defs, `${schema}: kind の CHECK 制約が2本であること`).toHaveLength(2);
        const restoredDefs = defs.filter((def) => def.includes("'restored'"));
        expect(
          restoredDefs,
          `${schema}: 'restored' を許す制約がちょうど1本であること（他スキーマの制約を誤って数えていないこと）`,
        ).toHaveLength(1);
      }
    },
  );

  // public 側にも同じ space・同じ tenantId の行を用意し、スキーマを取り違えたら赤になる形にする。
  it(
    "測定9: PostgresVectorStore.deleteAcrossSpaces は専用スキーマの中の全 space だけを消し、" +
      "public 側の同名テーブルの行には触らない",
    async () => {
      const pool = await createBlankDatabase(DB_DELETE_ACROSS_SPACES);
      const schema = "mnemora_das";

      await runMigrations(pool);
      await runMigrations(pool, DEFAULT_MIGRATIONS_DIR, { schema });

      // 同じ space id を public・専用スキーマの両方に登録する（space id が同じなら `embeddingSpaceTableName` が返す名前も同じになるため、スキーマ違いの「同名テーブル」を意図的に作る）。
      const spaceA: EmbeddingSpaceId = {
        provider: "test",
        model: "dedicated-schema-delete-across-a",
        dimensions: 3,
      };
      const spaceB: EmbeddingSpaceId = {
        provider: "test",
        model: "dedicated-schema-delete-across-b",
        dimensions: 3,
      };
      await registerEmbeddingSpace(pool, spaceA);
      await registerEmbeddingSpace(pool, spaceB);
      await registerEmbeddingSpace(pool, spaceA, { schema });
      await registerEmbeddingSpace(pool, spaceB, { schema });

      const dedicatedClient = createPostgresClient(connectionStringFor(DB_DELETE_ACROSS_SPACES), {
        schema,
      });
      const publicClient = createPostgresClient(connectionStringFor(DB_DELETE_ACROSS_SPACES));
      try {
        const dedicatedMemoryStore = new PostgresMemoryStore(dedicatedClient.db);
        const dedicatedVectorStore = new PostgresVectorStore(dedicatedClient.db);
        const publicMemoryStore = new PostgresMemoryStore(publicClient.db);
        const publicVectorStore = new PostgresVectorStore(publicClient.db);

        const ctx: Ctx = { tenantId: "tenant-dedicated-schema-delete-across-spaces" };

        const target = await dedicatedMemoryStore.createMemory(
          ctx,
          buildNewMemoryFixture({ contentHash: "das-target" }),
        );
        const control = await dedicatedMemoryStore.createMemory(
          ctx,
          buildNewMemoryFixture({ contentHash: "das-control" }),
        );
        await dedicatedVectorStore.upsert(ctx, spaceA, target.id, [1, 0, 0]);
        await dedicatedVectorStore.upsert(ctx, spaceB, target.id, [0, 1, 0]);
        await dedicatedVectorStore.upsert(ctx, spaceA, control.id, [0, 0, 1]);

        const publicDecoy = await publicMemoryStore.createMemory(
          ctx,
          buildNewMemoryFixture({ contentHash: "public-decoy" }),
        );
        await publicVectorStore.upsert(ctx, spaceA, publicDecoy.id, [1, 1, 1]);

        expect(await dedicatedVectorStore.getVectors(ctx, spaceA, [target.id])).toHaveLength(1);
        expect(await dedicatedVectorStore.getVectors(ctx, spaceB, [target.id])).toHaveLength(1);
        expect(await publicVectorStore.getVectors(ctx, spaceA, [publicDecoy.id])).toHaveLength(1);

        await dedicatedVectorStore.deleteAcrossSpaces(ctx, [target.id]);

        expect(
          await dedicatedVectorStore.getVectors(ctx, spaceA, [target.id]),
          "専用スキーマの space A から target が消えていること",
        ).toHaveLength(0);
        expect(
          await dedicatedVectorStore.getVectors(ctx, spaceB, [target.id]),
          "専用スキーマの space B から target が消えていること",
        ).toHaveLength(0);

        expect(
          await dedicatedVectorStore.getVectors(ctx, spaceA, [control.id]),
          "専用スキーマの control は残っていること",
        ).toHaveLength(1);

        expect(
          await publicVectorStore.getVectors(ctx, spaceA, [publicDecoy.id]),
          "public 側の同名テーブルの行は消えずに残っていること",
        ).toHaveLength(1);
      } finally {
        await closePostgresClient(dedicatedClient);
        await closePostgresClient(publicClient);
      }
    },
  );

  // `memories` は search_path 解決（未修飾の `FROM memories`）に頼っているため、public 側にも同じ claimKey の「おとり」を用意し、取り違えたら混入する形にする。
  it(
    "測定10: PostgresMemoryStore.findContestedByClaimKey は専用スキーマの中の contested な記憶だけを返し、" +
      "public 側の同名テーブルの行は返さない",
    async () => {
      const pool = await createBlankDatabase(DB_FIND_CONTESTED);
      const schema = "mnemora_fc";

      await runMigrations(pool);
      await runMigrations(pool, DEFAULT_MIGRATIONS_DIR, { schema });

      const dedicatedClient = createPostgresClient(connectionStringFor(DB_FIND_CONTESTED), {
        schema,
      });
      const publicClient = createPostgresClient(connectionStringFor(DB_FIND_CONTESTED));
      try {
        const dedicatedStore = new PostgresMemoryStore(dedicatedClient.db);
        const publicStore = new PostgresMemoryStore(publicClient.db);
        const ctx: Ctx = { tenantId: "tenant-dedicated-schema-find-contested" };
        const claimKey: ClaimKey = {
          subject: "user",
          predicate: "dedicated-schema-find-contested",
        };

        const dedicatedA = await dedicatedStore.createMemory(
          ctx,
          buildNewMemoryFixture({ contentHash: "dedicated-a", claimKey }),
        );
        const dedicatedB = await dedicatedStore.createMemory(
          ctx,
          buildNewMemoryFixture({ contentHash: "dedicated-b", claimKey }),
        );
        await dedicatedStore.markContestedPair(
          ctx,
          {
            id: dedicatedA.id,
            event: buildNewMemoryEventFixture({ memoryId: dedicatedA.id, kind: "updated" }),
          },
          {
            id: dedicatedB.id,
            event: buildNewMemoryEventFixture({ memoryId: dedicatedB.id, kind: "updated" }),
          },
        );

        const publicA = await publicStore.createMemory(
          ctx,
          buildNewMemoryFixture({ contentHash: "public-a", claimKey }),
        );
        const publicB = await publicStore.createMemory(
          ctx,
          buildNewMemoryFixture({ contentHash: "public-b", claimKey }),
        );
        await publicStore.markContestedPair(
          ctx,
          {
            id: publicA.id,
            event: buildNewMemoryEventFixture({ memoryId: publicA.id, kind: "updated" }),
          },
          {
            id: publicB.id,
            event: buildNewMemoryEventFixture({ memoryId: publicB.id, kind: "updated" }),
          },
        );

        const found = await dedicatedStore.findContestedByClaimKey(ctx, {
          subjectId: null,
          claimKey,
          excludeMemoryId: dedicatedA.id,
          contentHash: "no-such-hash",
          validFrom: null,
          validUntil: null,
        });
        const foundIds = found.map((m) => m.id);

        expect(foundIds, "専用スキーマの対抗ペアの片割れを返すこと").toContain(dedicatedB.id);
        expect(foundIds, "public 側のおとりを返さないこと（A）").not.toContain(publicA.id);
        expect(foundIds, "public 側のおとりを返さないこと（B）").not.toContain(publicB.id);
        expect(foundIds, "返る件数は専用スキーマの1件だけであること").toHaveLength(1);
      } finally {
        await closePostgresClient(dedicatedClient);
        await closePostgresClient(publicClient);
      }
    },
  );
});

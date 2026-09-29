import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Ctx, EmbeddingProvider, EmbeddingSpaceId } from "@mnemora/core";
import { createRuntime } from "@mnemora/core";
import { DeterministicEmbeddingProvider, DeterministicLLMProvider } from "@mnemora/testkit";
import {
  type Db,
  type PostgresClient,
  closePostgresClient,
  createPostgresClient,
} from "../client.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { PostgresEventStore } from "../event-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import { embeddingSpaceTableName } from "../embedding-space-table.js";
import { registerEmbeddingSpace } from "../vector-space.js";
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "../migrate.js";
import { sha256Hex } from "../content-hash.js";
import {
  closeTestClient,
  getTestClient,
  requireDatabaseUrl,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
} from "./test-db.js";
import { dropTempDatabase } from "./temp-database.js";

/**
 * Issue #1425 / ADR 0382: `Runtime.purge` は、今の `embeddingProvider.space` だけでなく、
 * この adapter が持つ**全 space**から embedding を消す（`VectorStore.deleteAcrossSpaces`）。
 *
 * このファイルは2つの層を検査する:
 *
 * 1. `Runtime.purge` を経由した振る舞い（`describe` 1つ目）——共有テストDB
 *    （`test-db.ts` の `getTestClient`）を使い、埋め込みモデルを移した後に残る旧 space の
 *    行が、purge・already_purged の再実行の両方で消えることを確かめる。
 * 2. `PostgresVectorStore.deleteAcrossSpaces` 自身のテーブル列挙（`describe` 2つ目）——
 *    専用の使い捨て DB に2つのスキーマを同居させ、(a) `current_schema()` を跨がない・
 *    (b) `memories(id)` を外部キーで参照していない利用者のテーブルを巻き込まない、
 *    という ADR 0382 決定2の2条件を直接検査する。
 */

const SECOND_EMBEDDING_SPACE: EmbeddingSpaceId = {
  provider: "test",
  model: "purge-across-spaces-second",
  dimensions: 3,
};

async function countEmbeddingRows(db: Db, table: string, memoryId: string): Promise<number> {
  // `memoryId` はこのファイルが呼ぶ `observe()`/`randomUUID()` の出力のみ
  // （利用者入力ではない）——`purge-during-embed-job.postgres.test.ts` と同じ、
  // テストコード内だけの文字列組み立て。
  const result = await db.execute(
    sql.raw(`SELECT count(*)::int AS n FROM ${table} WHERE memory_id = '${memoryId}'`),
  );
  return (result.rows[0] as unknown as { n: number }).n;
}

describe("Runtime.purge は全 space の embedding を消す（Issue #1425、本物の Postgres）", () => {
  beforeAll(async () => {
    const { pool } = await getTestClient();
    await registerEmbeddingSpace(pool, SECOND_EMBEDDING_SPACE);
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  function buildRuntime(db: Db, embeddingProvider: EmbeddingProvider) {
    return createRuntime({
      memoryStore: new PostgresMemoryStore(db),
      outboxStore: new PostgresOutboxStore(db),
      vectorStore: new PostgresVectorStore(db),
      eventStore: new PostgresEventStore(db),
      tenantSettingsStore: new PostgresTenantSettingsStore(db),
      llmProvider: new DeterministicLLMProvider(),
      embeddingProvider,
      hashContent: sha256Hex,
    });
  }

  it("purge は、今の embeddingProvider.space だけでなく旧 space に残っている embedding も消す（赤の再現・緑の確認）", async () => {
    const { db } = await getTestClient();
    const vectorStore = new PostgresVectorStore(db);
    // 今の embeddingProvider は SECOND_EMBEDDING_SPACE（=「モデルを移した後」を模す）。
    const runtime = buildRuntime(db, new DeterministicEmbeddingProvider(SECOND_EMBEDDING_SPACE));
    const ctx: Ctx = { tenantId: `tenant-purge-across-spaces-${randomUUID()}` };

    const observed = await runtime.observe(ctx, {
      kind: "utterance",
      text: "消してほしい個人的な内容",
      speaker: "u",
    });
    expect(observed.memoryIds).toHaveLength(1);
    const memoryId = observed.memoryIds[0]!;
    await runtime.tick(ctx, { leaseMs: 60_000 });
    expect(
      await countEmbeddingRows(db, embeddingSpaceTableName(SECOND_EMBEDDING_SPACE), memoryId),
    ).toBe(1);

    // 旧 space（埋め込みモデルを移す前）に残っている埋め込み行を模す——
    // 実運用では「以前の embeddingProvider で embed した後、まだ再 embed していない行」。
    await vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, memoryId, [0.1, 0.2, 0.3]);
    expect(
      await countEmbeddingRows(db, embeddingSpaceTableName(TEST_EMBEDDING_SPACE), memoryId),
    ).toBe(1);

    await runtime.forget(ctx, { memoryId });
    const purged = await runtime.purge(ctx, { memoryId });
    expect(purged.outcomes[0]?.kind).toBe("purged");

    // 🔴 この2つの assert が、直す前（vectorStore.delete のまま）だと後者が赤くなる。
    expect(
      await countEmbeddingRows(db, embeddingSpaceTableName(SECOND_EMBEDDING_SPACE), memoryId),
      "今の space の行は、直す前から既に消えていたはず",
    ).toBe(0);
    expect(
      await countEmbeddingRows(db, embeddingSpaceTableName(TEST_EMBEDDING_SPACE), memoryId),
      "🔴 旧 space の行——直す前（vectorStore.delete のまま）はここが残って赤くなる",
    ).toBe(0);
  });

  it("already_purged の再実行でも、後から見つかった旧 space の embedding をベストエフォートで消す（Issue #1425）", async () => {
    const { db } = await getTestClient();
    const vectorStore = new PostgresVectorStore(db);
    const runtime = buildRuntime(db, new DeterministicEmbeddingProvider(SECOND_EMBEDDING_SPACE));
    const ctx: Ctx = { tenantId: `tenant-purge-already-purged-${randomUUID()}` };

    const observed = await runtime.observe(ctx, {
      kind: "utterance",
      text: "もう一度 purge しても後始末したい内容",
      speaker: "u",
    });
    const memoryId = observed.memoryIds[0]!;
    await runtime.tick(ctx, { leaseMs: 60_000 });
    await runtime.forget(ctx, { memoryId });
    const first = await runtime.purge(ctx, { memoryId });
    expect(first.outcomes[0]?.kind).toBe("purged");

    // 一度 purge した後に、別の（さらに古い）space に残っていた行が後から見つかった、
    // という状況を模す（memories 行自体は purge 後も残っているので upsert は成功する）。
    await vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, memoryId, [0.4, 0.5, 0.6]);
    expect(
      await countEmbeddingRows(db, embeddingSpaceTableName(TEST_EMBEDDING_SPACE), memoryId),
    ).toBe(1);

    const second = await runtime.purge(ctx, { memoryId });
    expect(second.outcomes[0]?.kind).toBe("already_purged");
    expect(
      await countEmbeddingRows(db, embeddingSpaceTableName(TEST_EMBEDDING_SPACE), memoryId),
      "already_purged でもベストエフォートで deleteAcrossSpaces を呼ぶはず",
    ).toBe(0);
  });

  it("dryRun: true のときは、already_purged でも embedding を消さない", async () => {
    const { db } = await getTestClient();
    const vectorStore = new PostgresVectorStore(db);
    const runtime = buildRuntime(db, new DeterministicEmbeddingProvider(SECOND_EMBEDDING_SPACE));
    const ctx: Ctx = { tenantId: `tenant-purge-dry-run-${randomUUID()}` };

    const observed = await runtime.observe(ctx, {
      kind: "utterance",
      text: "dryRun では消えてほしくない内容",
      speaker: "u",
    });
    const memoryId = observed.memoryIds[0]!;
    await runtime.tick(ctx, { leaseMs: 60_000 });
    await runtime.forget(ctx, { memoryId });
    await runtime.purge(ctx, { memoryId });

    await vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, memoryId, [0.7, 0.8, 0.9]);
    expect(
      await countEmbeddingRows(db, embeddingSpaceTableName(TEST_EMBEDDING_SPACE), memoryId),
    ).toBe(1);

    const dryRunResult = await runtime.purge(ctx, { memoryId }, { dryRun: true });
    expect(dryRunResult.outcomes[0]?.kind).toBe("already_purged");
    expect(
      await countEmbeddingRows(db, embeddingSpaceTableName(TEST_EMBEDDING_SPACE), memoryId),
      "dryRun: true では deleteAcrossSpaces を呼ばないはず",
    ).toBe(1);
  });
});

describe("PostgresVectorStore.deleteAcrossSpaces のテーブル列挙（Issue #1425、ADR 0382 決定2）", () => {
  const DB_NAME = "mnemora_purge_across_spaces_enum";
  const SCHEMA_DEFAULT = "mnemora_pas_default";
  const SCHEMA_ALT = "mnemora_pas_alt";
  const ENUM_SPACE: EmbeddingSpaceId = {
    provider: "test",
    model: "purge-across-spaces-enum",
    dimensions: 3,
  };
  const ENUM_TABLE = embeddingSpaceTableName(ENUM_SPACE);
  // `SCHEMA_ALT` にだけ登録する space——`SCHEMA_DEFAULT` からは同名のテーブルが
  // 一切見えない（`SCHEMA_DEFAULT` スコープの接続の `search_path` にも無い）。
  // 条件1（`current_schema()` を跨がない）が外れると、列挙がこのテーブル名を拾って
  // しまい、`SCHEMA_DEFAULT` スコープの接続からは解決できない relation への
  // `DELETE` を発行して例外になる——「別スキーマの行を誤って消す」だけでなく
  // 「無関係な purge が突然落ちる」という、より実害の大きい壊れ方を検出できる。
  const ALT_ONLY_SPACE: EmbeddingSpaceId = {
    provider: "test",
    model: "purge-across-spaces-alt-only",
    dimensions: 3,
  };
  const ALT_ONLY_TABLE = embeddingSpaceTableName(ALT_ONLY_SPACE);

  let adminPool: Pool;
  let dbPool: Pool;
  let defaultClient: PostgresClient;
  let altClient: PostgresClient;

  function connectionStringFor(database: string): string {
    const url = new URL(requireDatabaseUrl());
    url.pathname = `/${database}`;
    return url.toString();
  }

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: requireDatabaseUrl(), max: 1 });
    await dropTempDatabase(adminPool, DB_NAME);
    await adminPool.query(`CREATE DATABASE ${DB_NAME}`);

    const dbUrl = connectionStringFor(DB_NAME);
    dbPool = new Pool({ connectionString: dbUrl, max: 5 });

    // `s_default`・`s_alt` の2つの専用スキーマを、同じ DB に同居させる
    // （`dedicated-schema.postgres.test.ts` 測定2と同じ形）。
    await runMigrations(dbPool, DEFAULT_MIGRATIONS_DIR, { schema: SCHEMA_DEFAULT });
    await runMigrations(dbPool, DEFAULT_MIGRATIONS_DIR, { schema: SCHEMA_ALT });
    await registerEmbeddingSpace(dbPool, ENUM_SPACE, { schema: SCHEMA_DEFAULT });
    await registerEmbeddingSpace(dbPool, ENUM_SPACE, { schema: SCHEMA_ALT });
    await registerEmbeddingSpace(dbPool, ALT_ONLY_SPACE, { schema: SCHEMA_ALT });

    defaultClient = createPostgresClient(dbUrl, { schema: SCHEMA_DEFAULT });
    altClient = createPostgresClient(dbUrl, { schema: SCHEMA_ALT });
  });

  afterAll(async () => {
    await closePostgresClient(defaultClient);
    await closePostgresClient(altClient);
    await dbPool.end();
    await dropTempDatabase(adminPool, DB_NAME);
    await adminPool.end();
  });

  async function insertMemory(schema: string, id: string, tenantId: string): Promise<void> {
    await dbPool.query(
      `INSERT INTO "${schema}".memories
        (id, tenant_id, content, content_hash, digest, provenance_kind, provenance, half_life_hours, decay_floor_at)
       VALUES ($1, $2, 'x', 'x', 'x', 'imported', '{"kind":"imported"}'::jsonb, 1.0, now())`,
      [id, tenantId],
    );
  }

  async function insertEmbedding(
    schema: string,
    table: string,
    tenantId: string,
    memoryId: string,
  ): Promise<void> {
    await dbPool.query(
      `INSERT INTO "${schema}".${table} (tenant_id, memory_id, embedding, model, created_at)
       VALUES ($1, $2, '[1,2,3]'::vector, 'enum-model', now())`,
      [tenantId, memoryId],
    );
  }

  async function countInSchema(schema: string, table: string, memoryId: string): Promise<number> {
    const { rows } = await dbPool.query(
      `SELECT count(*)::int AS n FROM "${schema}".${table} WHERE memory_id = $1`,
      [memoryId],
    );
    return (rows[0] as { n: number }).n;
  }

  it("条件1: current_schema() を跨がない——別スキーマの同名テーブルの行は消えない（同名フィクスチャ）", async () => {
    const tenantId = "tenant-cross-schema";
    const memoryId = randomUUID();

    await insertMemory(SCHEMA_DEFAULT, memoryId, tenantId);
    await insertMemory(SCHEMA_ALT, memoryId, tenantId);
    await insertEmbedding(SCHEMA_DEFAULT, ENUM_TABLE, tenantId, memoryId);
    await insertEmbedding(SCHEMA_ALT, ENUM_TABLE, tenantId, memoryId);

    const vectorStore = new PostgresVectorStore(defaultClient.db);
    await vectorStore.deleteAcrossSpaces({ tenantId }, [memoryId]);

    expect(await countInSchema(SCHEMA_DEFAULT, ENUM_TABLE, memoryId)).toBe(0);
    expect(
      await countInSchema(SCHEMA_ALT, ENUM_TABLE, memoryId),
      "別スキーマ（current_schema() の外）の行は触らないはず",
    ).toBe(1);
  });

  it("条件1: current_schema() を跨がない——別スキーマにしか無い space のテーブルは列挙されない（陽性対照つき、report 参照）", async () => {
    // `ENUM_TABLE`（両スキーマにある同名テーブル）だけでは、この条件を落としても
    // DELETE 文自体が search_path 経由で結局 SCHEMA_DEFAULT 側の同名テーブルに
    // 解決されるため、赤にならない（手元で確かめた——上の陽性対照の節に記録）。
    // `ALT_ONLY_TABLE`（SCHEMA_ALT にしか無い名前）を使うと、条件1を落とした列挙は
    // このテーブル名を拾ってしまい、`SCHEMA_DEFAULT` スコープの接続からは解決できない
    // relation への `DELETE` を発行して例外になる——この歯はその形で赤くなる。
    const tenantId = "tenant-cross-schema-alt-only";
    const memoryId = randomUUID();

    await insertMemory(SCHEMA_ALT, memoryId, tenantId);
    await insertEmbedding(SCHEMA_ALT, ALT_ONLY_TABLE, tenantId, memoryId);

    const vectorStore = new PostgresVectorStore(defaultClient.db);
    await expect(vectorStore.deleteAcrossSpaces({ tenantId }, [memoryId])).resolves.toBeUndefined();

    expect(
      await countInSchema(SCHEMA_ALT, ALT_ONLY_TABLE, memoryId),
      "別スキーマにしか無いテーブルの行は消えないはず",
    ).toBe(1);
  });

  it("条件3: memories(id) を外部キーで参照していない利用者のテーブルは触らない（陽性対照は手元で cp して確認済み、report参照）", async () => {
    const tenantId = "tenant-evil-table";
    const memoryId = randomUUID();
    const evilTable = "memory_embeddings_userdata_unrelated";

    // `memory_embeddings_` で始まる名前だが、`memories(id)` への外部キーを持たない
    // ——利用者が同じ命名慣習で作った無関係なテーブルを模す。
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS "${SCHEMA_DEFAULT}".${evilTable} (
        tenant_id text NOT NULL,
        memory_id uuid NOT NULL,
        note text
      )
    `);
    await dbPool.query(
      `INSERT INTO "${SCHEMA_DEFAULT}".${evilTable} (tenant_id, memory_id, note)
       VALUES ($1, $2, 'not mnemora')`,
      [tenantId, memoryId],
    );

    const vectorStore = new PostgresVectorStore(defaultClient.db);
    await vectorStore.deleteAcrossSpaces({ tenantId }, [memoryId]);

    expect(
      await countInSchema(SCHEMA_DEFAULT, evilTable, memoryId),
      "memories(id) への外部キーを持たないテーブルの行は消えないはず",
    ).toBe(1);
  });
});

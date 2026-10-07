import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx, EmbeddingSpaceId } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { closePostgresClient, createPostgresClient, type PostgresClient } from "../client.js";
import { runMigrations } from "../migrate.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { registerEmbeddingSpace } from "../vector-space.js";
import { embeddingSpaceTableName } from "../embedding-space-table.js";
import {
  INITIAL_ANALYZE_THRESHOLD,
  isGeometricAnalyzeThreshold,
  peekMemoriesWriteCounterForTesting,
  resetMemoriesWriteCounterForTesting,
} from "../memories-statistics.js";
import {
  captureClientQuery,
  explainCaptured,
  requireDatabaseUrl,
  seededRandom,
} from "./test-db.js";
import { dropTempDatabase } from "./temp-database.js";

/**
 * `PostgresVectorStore.search()` は埋め込み表を `memories` と `JOIN` してテナントで絞るので、`memories` 側の統計欠如はプランを誤らせうる。
 * この歯は、その JOIN を含む本物の `search()` の SQL を直接 EXPLAIN する（`embedding-statistics.postgres.test.ts` は埋め込み表側の統計が主題なので JOIN を含まない SQL を見る）。
 *
 * `ALTER TABLE memories SET (autovacuum_enabled = false)` を投入前に打つ。切らないと「自動発火の ANALYZE が効いた」のか「autovacuum がたまたま拾った」のか区別が付かず、
 * 拾うまでの時間が試行によって大きくばらつくので、歯として決定的でなくなる。
 * このテストファイル専用の使い捨てデータベースを使うのは、他のテストファイルが積んだ行や `ANALYZE` のノイズから隔離するため。
 */

const TEST_DATABASE = "mnemora_memories_statistics_test";
const TENANT = "memories-statistics-tenant";

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

function uniqueSpace(label: string): EmbeddingSpaceId {
  return {
    provider: "memories-statistics-test",
    model: `${label}-${randomUUID()}`,
    dimensions: 3,
  };
}

async function disableAutovacuum(pool: Pool, table: string): Promise<void> {
  await pool.query(`ALTER TABLE ${table} SET (autovacuum_enabled = false)`);
}

describe("PostgresMemoryStore.createMemory と memories の ANALYZE 自動発火(Issue #269)", () => {
  let client: PostgresClient | undefined;

  beforeAll(async () => {
    await dropTempDatabase(admin(), TEST_DATABASE);
    await admin().query(`CREATE DATABASE ${TEST_DATABASE}`);
    client = createPostgresClient(connectionStringFor(TEST_DATABASE));
    await runMigrations(client.pool);
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

  // (甲)(乙) は同じ describe・同じ DB を共有するので、`memories-statistics.ts` のモジュールスコープの書き込みカウンタも共有してしまう。
  // 宣言順どおり (甲) が先に走ると (乙) の開始時点でカウンタが既に4,000になり、(乙) が跨ぐつもりの閾値（1,000）を素通りしたまま「跨いでも ANALYZE を撃たない」が緑になる（判定ロジックが一度も走らない空振り）。
  // 各 it() の頭でカウンタを 0 に戻す。
  beforeEach(() => {
    resetMemoriesWriteCounterForTesting();
  });

  it("(甲) 新規インストール相当(memories 未 ANALYZE)で閾値を越える行数を createMemory するだけで、JOIN を含む本物の search() が HNSW 索引を選ぶ", async () => {
    const { db, pool } = client!;
    const memoryStore = new PostgresMemoryStore(db);
    const vectorStore = new PostgresVectorStore(db);
    const ctx: Ctx = { tenantId: TENANT };

    await disableAutovacuum(pool, "memories");

    const space = uniqueSpace("crossing");
    await registerEmbeddingSpace(pool, space);
    const table = embeddingSpaceTableName(space);

    // migration 0005 が新規インストール時に空の memories へ無条件で ANALYZE を打つので、ループの前の last_analyze を控えておく。
    // 「ループの後に last_analyze が非 null」だけでは、0005 の ANALYZE を見ているだけなのか、このループ中に撃ったものなのかを区別できない。
    const statBeforeLoop = await pool.query(
      `SELECT last_analyze FROM pg_stat_user_tables WHERE relname = 'memories'`,
    );
    const lastAnalyzeBeforeLoop = statBeforeLoop.rows[0]?.last_analyze;

    // ループの前後のカウンタを控え、実際に閾値ちょうどの値へ着地したことまで assert する（判定ロジックが空振りしていないことの直接の証拠）。
    const counterBeforeLoop = peekMemoriesWriteCounterForTesting();

    const rowCount = 4 * INITIAL_ANALYZE_THRESHOLD;
    const rand = seededRandom(20260917269);
    for (let i = 0; i < rowCount; i += 1) {
      const memory = await memoryStore.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: ctx.tenantId }),
      );
      const vector = [rand(), rand(), rand()];
      await vectorStore.upsert(ctx, space, memory.id, vector);
    }

    const counterAfterLoop = peekMemoriesWriteCounterForTesting();
    expect(counterAfterLoop, "1件ずつ createMemory した回数がそのままカウンタの増分").toBe(
      counterBeforeLoop + rowCount,
    );
    expect(
      isGeometricAnalyzeThreshold(counterAfterLoop),
      `カウンタが等比の閾値ちょうど（${counterAfterLoop}）に着地していること——` +
        "そうでなければ maybeAnalyzeMemoriesAfterWrite の閾値判定が一度も走っていない",
    ).toBe(true);

    // 事前条件: autovacuum を切ってあるので、last_analyze がループの前後で動いたなら、それは `maybeAnalyzeMemoriesAfterWrite` が撃った以外にありえない。
    const statResult = await pool.query(
      `SELECT last_analyze, last_autoanalyze FROM pg_stat_user_tables WHERE relname = 'memories'`,
    );
    expect(statResult.rows[0]?.last_analyze).not.toEqual(lastAnalyzeBeforeLoop);
    expect(statResult.rows[0]?.last_autoanalyze).toBeNull();

    const queryVector = [0.5, 0.5, 0.5];
    const captured = await captureClientQuery(
      (text) => text.includes(table) && /order by/i.test(text),
      () =>
        vectorStore.search(ctx, space, queryVector, {
          limit: 10,
          filter: { tenantId: TENANT },
        }),
    );
    const plan = await explainCaptured(pool, captured);
    expect(plan).toMatch(/Index Scan.*using idx_memory_embeddings_hnsw/);
    expect(plan).not.toMatch(/Seq Scan/);
  }, 180_000);

  it("(乙) 統計が既に十分な memories では、createMemory が閾値を跨いでも ANALYZE を撃たない(last_analyze が動かない)", async () => {
    const { db, pool } = client!;
    const memoryStore = new PostgresMemoryStore(db);
    const ctx: Ctx = { tenantId: TENANT };

    await disableAutovacuum(pool, "memories");

    // 事前に、このプロセスの memories カウンタを一切進めない形で行を作る（生 SQL で直接 INSERT する）。`createMemory()` を使うとカウンタが進み、「まだ書いていないのに統計だけ大きい」という状況を作れない。
    const preExistingCount = INITIAL_ANALYZE_THRESHOLD + 100; // 1,100
    for (let i = 0; i < preExistingCount; i += 1) {
      await pool.query(
        `INSERT INTO memories (
           id, tenant_id, content, content_hash, digest, digest_source,
           provenance_kind, provenance, status, tags, recorded_at,
           strength, half_life_hours, decay_floor_at, embedding_status, created_at, updated_at
         ) VALUES (
           gen_random_uuid(), $1, $2, $3, $4, 'llm', 'imported', '{"kind":"imported"}'::jsonb,
           'active', '{}'::text[], now(), 1.0, 720, now() + interval '30 days', 'ready', now(), now()
         )`,
        [TENANT, `memories-statistics 乙 filler #${i}`, `hash-${i}-${randomUUID()}`, `digest-${i}`],
      );
    }

    await pool.query(`ANALYZE memories`);
    const beforeStat = await pool.query(
      `SELECT last_analyze FROM pg_stat_user_tables WHERE relname = 'memories'`,
    );
    const lastAnalyzeBefore = beforeStat.rows[0]?.last_analyze;
    expect(lastAnalyzeBefore).not.toBeNull();

    // ちょうど `INITIAL_ANALYZE_THRESHOLD`（1,000）回だけ createMemory を呼び、閾値を跨がせる。
    // reltuples（≈1,100）はこのプロセスの累計（1,000）以上なので、guard により ANALYZE は撃たれないはずである。
    // ループの前後のカウンタを控え、実際に閾値ちょうどへ着地したことまで assert する（判定ロジックが一度も走らないまま緑になる空振りを防ぐ）。
    const counterBeforeLoop = peekMemoriesWriteCounterForTesting();
    const rand = seededRandom(20260917001);
    for (let i = 0; i < INITIAL_ANALYZE_THRESHOLD; i += 1) {
      await memoryStore.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: ctx.tenantId,
          content: `memories-statistics 乙 ${rand()}`,
        }),
      );
    }
    const counterAfterLoop = peekMemoriesWriteCounterForTesting();
    expect(counterAfterLoop, "1件ずつ createMemory した回数がそのままカウンタの増分").toBe(
      counterBeforeLoop + INITIAL_ANALYZE_THRESHOLD,
    );
    expect(
      isGeometricAnalyzeThreshold(counterAfterLoop),
      `カウンタが等比の閾値ちょうど（${counterAfterLoop}）に着地していること——` +
        "そうでなければ maybeAnalyzeMemoriesAfterWrite の閾値判定が一度も走っておらず、" +
        "下の「ANALYZE を撃たない」assertion は判定が『スキップした』ことではなく" +
        "『一度も判定していない』ことを見ているだけになる",
    ).toBe(true);

    const afterStat = await pool.query(
      `SELECT last_analyze, last_autoanalyze FROM pg_stat_user_tables WHERE relname = 'memories'`,
    );
    expect(afterStat.rows[0]?.last_autoanalyze).toBeNull();
    expect(afterStat.rows[0]?.last_analyze).toEqual(lastAnalyzeBefore);
  }, 120_000);
});

/**
 * `supersedeWithNewMemories` も `memories` へ `INSERT` するので、書き込み経路だけ `createMemory` から替えて、(甲) と同じ検査（JOIN を含む本物の `search()` の EXPLAIN）を行う。
 * 「呼ばれたか」ではなく「実際に効いたか」（プランが Seq Scan から Index Scan へ変わったか）を見る。
 * `resetMemoriesWriteCounterForTesting()` でプロセスローカルの累計カウンタを 0 へ戻してから始める。前段の書き込みが残した累計に依存すると、この歯が本当に閾値を跨いだのかが分からなくなる。
 */
describe("PostgresMemoryStore.supersedeWithNewMemories と memories の ANALYZE 自動発火(Issue #269 残経路)", () => {
  const TEST_DATABASE_SUPERSEDE = "mnemora_memories_statistics_supersede_test";
  let client: PostgresClient | undefined;

  beforeAll(async () => {
    resetMemoriesWriteCounterForTesting();
    await dropTempDatabase(admin(), TEST_DATABASE_SUPERSEDE);
    await admin().query(`CREATE DATABASE ${TEST_DATABASE_SUPERSEDE}`);
    client = createPostgresClient(connectionStringFor(TEST_DATABASE_SUPERSEDE));
    await runMigrations(client.pool);
  }, 60_000);

  afterAll(async () => {
    if (client) {
      await closePostgresClient(client);
    }
    await dropTempDatabase(admin(), TEST_DATABASE_SUPERSEDE);
    if (adminPool) {
      await adminPool.end();
      adminPool = undefined;
    }
  }, 30_000);

  it("(丙) supersedeWithNewMemories 経由で新規インストール相当の行数を書くだけで、JOIN を含む本物の search() が HNSW 索引を選ぶ", async () => {
    const { db, pool } = client!;
    const memoryStore = new PostgresMemoryStore(db);
    const vectorStore = new PostgresVectorStore(db);
    const ctx: Ctx = { tenantId: TENANT };

    await disableAutovacuum(pool, "memories");

    const space = uniqueSpace("crossing-supersede");
    await registerEmbeddingSpace(pool, space);
    const table = embeddingSpaceTableName(space);

    const statBeforeLoop = await pool.query(
      `SELECT last_analyze FROM pg_stat_user_tables WHERE relname = 'memories'`,
    );
    const lastAnalyzeBeforeLoop = statBeforeLoop.rows[0]?.last_analyze;

    const counterBeforeLoop = peekMemoriesWriteCounterForTesting();

    // `supersede` は空配列にして、news の作成だけを起こす（news 側の INSERT が ANALYZE フックを起動するかどうかだけを見る）。
    const rowCount = 4 * INITIAL_ANALYZE_THRESHOLD;
    const rand = seededRandom(20260917270);
    for (let i = 0; i < rowCount; i += 1) {
      const { created } = await memoryStore.supersedeWithNewMemories(
        ctx,
        [
          {
            input: buildNewMemoryFixture({ tenantId: ctx.tenantId }),
            jobKinds: [],
          },
        ],
        [],
      );
      const memory = created[0]!.memory;
      const vector = [rand(), rand(), rand()];
      await vectorStore.upsert(ctx, space, memory.id, vector);
    }

    const counterAfterLoop = peekMemoriesWriteCounterForTesting();
    expect(
      counterAfterLoop,
      "supersedeWithNewMemories で1件ずつ作った回数がそのままカウンタの増分",
    ).toBe(counterBeforeLoop + rowCount);
    expect(
      isGeometricAnalyzeThreshold(counterAfterLoop),
      `カウンタが等比の閾値ちょうど（${counterAfterLoop}）に着地していること——` +
        "そうでなければ maybeAnalyzeMemoriesAfterWrite の閾値判定が一度も走っていない",
    ).toBe(true);

    const statResult = await pool.query(
      `SELECT last_analyze, last_autoanalyze FROM pg_stat_user_tables WHERE relname = 'memories'`,
    );
    expect(statResult.rows[0]?.last_analyze).not.toEqual(lastAnalyzeBeforeLoop);
    expect(statResult.rows[0]?.last_autoanalyze).toBeNull();

    const queryVector = [0.5, 0.5, 0.5];
    const captured = await captureClientQuery(
      (text) => text.includes(table) && /order by/i.test(text),
      () =>
        vectorStore.search(ctx, space, queryVector, {
          limit: 10,
          filter: { tenantId: TENANT },
        }),
    );
    const plan = await explainCaptured(pool, captured);
    expect(plan).toMatch(/Index Scan.*using idx_memory_embeddings_hnsw/);
    expect(plan).not.toMatch(/Seq Scan/);
  }, 180_000);
});

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
 * Issue #269 / ADR 0221: ADR 0194 が `memory_embeddings_*` に入れた「等比の閾値越えの
 * ときだけ ANALYZE を撃つ」自動発火を、JOIN の相手側である `memories` にも足す歯。
 *
 * ## なぜこの歯が要るか(実測は Issue #269 / #418)
 *
 * `PostgresVectorStore.search()` は埋め込み表を `memories` と `JOIN` してテナントで
 * 絞る(`vector-store.ts` 参照)。ADR 0194 は埋め込み表側の統計だけを守り、
 * `memories` 側の統計欠如は「引き受けた負債」として残していた——実際に CI
 * (`pgvector/pgvector:pg17`)が、使い捨てデータベース(`memories` に一度も
 * `ANALYZE` が走らない)でこの JOIN のプランを誤らせることを実測で示した
 * (ADR 0194「CI が実際に教えたこと」)。
 *
 * この歯は、その JOIN を含む本物の `search()` の SQL を直接 EXPLAIN する
 * (`embedding-statistics.postgres.test.ts` の (甲) が CI の実測を受けて
 * 「等価クエリ」に後退させたのと逆に、本 PR はまさに `memories` 側の統計が
 * 主題なので、JOIN を含む本物の SQL を検査対象にする)。
 *
 * ## autovacuum を切る理由
 *
 * `ALTER TABLE memories SET (autovacuum_enabled = false)` を投入前に打つ。そうしないと
 * 「upsert 内蔵の ANALYZE が効いた」のか「autovacuum がたまたま拾った」のか区別が
 * 付かない(Issue #269 の実測: autovacuum は既定のままだと、初回投入中に拾うまでの
 * 時間が試行によって 7秒 〜 挿入完了(約60秒)後まで大きくばらつく——歯としては
 * 決定的でなければならない)。
 *
 * ## 使い捨てデータベースを使う理由
 *
 * このテストファイル専用の使い捨てデータベースを使う——他のテストファイルが
 * 積んだ行や `ANALYZE` のノイズから隔離するため(`embedding-statistics.postgres.test.ts`
 * / `dedicated-schema.postgres.test.ts` と同じ作法)。
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

// `captureQuery` はかつてこのファイル固有のローカル関数だったが、`Client.prototype.query`
// をパッチする版（`captureClientQuery`、ADR 0284）へ寄せて test-db.ts に集約した——
// `pool.query` をパッチする旧実装は、ADR 0284 で `db.transaction()` 経由に変わった
// `PostgresVectorStore.search()` のクエリを「観測されなかった」で捕まえ損ねる
// （`pool.connect()` が返す生の `pg.Client` の上で発行されるため）。

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

  // Issue #1419: (甲)(乙) は同じ describe・同じ DB を共有するので、`memories-statistics.ts`
  // モジュールスコープの書き込みカウンタも共有してしまう——`--sequence.shuffle` で
  // (甲) が先に走ると (乙) の開始時点でカウンタが既に4,000になり、(乙) が跨ぐつもりの
  // 閾値（1,000）を素通りしたまま「跨いでも ANALYZE を撃たない」が緑になる（判定
  // ロジック自体が一度も走らない空振り）。各 it() の頭でカウンタを 0 に戻し、
  // どちらが先に走っても「このプロセスの memories カウンタは0から始まる」という
  // 各 it() 自身の前提を実際に保証する（丙側の describe は元から自分の `beforeAll` で
  // 同じことをしている——ここでも揃える）。
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
    // 埋め込み表側は ADR 0194 の仕組みに任せる(この歯が検査したいのは memories 側のみ)。

    // migration 0005（`0005_analyze_memories.sql`）が新規インストール時に空の
    // memories へ無条件で ANALYZE を打つため、ここで一度控えておく——「ループの後に
    // last_analyze が非nullである」だけでは、それが 0005 の ANALYZE を見ているだけなのか
    // このループ中に本 PR のコードが実際に撃ったものなのかを区別できない（後述）。
    const statBeforeLoop = await pool.query(
      `SELECT last_analyze FROM pg_stat_user_tables WHERE relname = 'memories'`,
    );
    const lastAnalyzeBeforeLoop = statBeforeLoop.rows[0]?.last_analyze;

    // Issue #1419: beforeEach でカウンタが0から始まることは保証したが、それだけでは
    // 「ループの間に本当に閾値（1,000/2,000/4,000）を跨いだか」までは分からない
    // （たとえば rowCount を先々誰かが閾値未満へ減らしても、この歯は気付かず緑のまま
    // になりうる）。ループの前後のカウンタを控え、実際に閾値ちょうどの値へ着地した
    // ことまで assert する——判定ロジックが空振りしていないことの直接の証拠。
    const counterBeforeLoop = peekMemoriesWriteCounterForTesting();

    // 4,000 = 4 * INITIAL_ANALYZE_THRESHOLD(等比の閾値ちょうど)。
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

    // 事前条件の確認: autovacuum を切ってあるので、last_analyze がループの前後で
    // 動いたなら、それは本 PR のコード（maybeAnalyzeMemoriesAfterWrite）が撃った
    // 以外にありえない（migration 0005 の ANALYZE は beforeAll の時点で1回だけ
    // 起き、ループ中には起きない）。
    const statResult = await pool.query(
      `SELECT last_analyze, last_autoanalyze FROM pg_stat_user_tables WHERE relname = 'memories'`,
    );
    expect(statResult.rows[0]?.last_analyze).not.toEqual(lastAnalyzeBeforeLoop);
    expect(statResult.rows[0]?.last_autoanalyze).toBeNull();

    // JOIN を含む本物の search() SQL を捕まえて EXPLAIN する(#418/ADR 0194 が壊れると
    // 実測した、まさにその形)。
    const queryVector = [0.5, 0.5, 0.5];
    const captured = await captureClientQuery(
      (text) => text.includes(table) && /order by/i.test(text),
      () =>
        vectorStore.search(ctx, space, queryVector, {
          limit: 10,
          filter: { tenantId: TENANT },
        }),
    );
    // 本番と同じ transaction の文脈（ADR 0284 の SET LOCAL）で EXPLAIN する
    // （test-db.ts の explainCaptured の doc コメント参照）。
    const plan = await explainCaptured(pool, captured);
    expect(plan).toMatch(/Index Scan.*using idx_memory_embeddings_hnsw/);
    expect(plan).not.toMatch(/Seq Scan/);
  }, 180_000);

  it("(乙) 統計が既に十分な memories では、createMemory が閾値を跨いでも ANALYZE を撃たない(last_analyze が動かない)", async () => {
    const { db, pool } = client!;
    const memoryStore = new PostgresMemoryStore(db);
    const ctx: Ctx = { tenantId: TENANT };

    await disableAutovacuum(pool, "memories");

    // 事前に、このプロセスの memories カウンタを一切進めない形で行を作る
    // (生 SQL で直接 INSERT する——createMemory() を使うとカウンタが進んでしまい、
    // 「まだ createMemory していないのに統計だけ大きい」という(乙)が検査したい
    // 状況を作れない)。
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

    // ここで初めて、テスト側が明示的に ANALYZE を撃つ((乙) の前提条件そのもの)。
    await pool.query(`ANALYZE memories`);
    const beforeStat = await pool.query(
      `SELECT last_analyze FROM pg_stat_user_tables WHERE relname = 'memories'`,
    );
    const lastAnalyzeBefore = beforeStat.rows[0]?.last_analyze;
    expect(lastAnalyzeBefore).not.toBeNull();

    // このプロセスの memories カウンタは、上の beforeEach で0にリセット済み
    // ——ちょうど INITIAL_ANALYZE_THRESHOLD (1,000)回だけ createMemory を呼び、
    // 閾値を跨がせる。reltuples(≈1,100、上のテーブル全行数と一致)はこのプロセスの
    // 累計(1,000)以上なので、guard により ANALYZE は撃たれないはずである。
    //
    // Issue #1419: 「カウンタが0から始まる」を beforeEach に任せるだけでは、
    // 万一 beforeEach が効かなかった場合に閾値そのものを跨がず判定ロジックが
    // 一度も走らないまま緑になる、という空振りが再発しうる。ループの前後の
    // カウンタを控え、実際に閾値ちょうどへ着地したことまで assert する。
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
 * Issue #269 の 2026-09-17T09:11:04Z コメント: `supersedeWithNewMemories` も
 * `memories` へ `INSERT` するが、ADR 0221 が入れたフック
 * (`maybeAnalyzeMemoriesAfterWrite`)を呼んでいなかった——`createMemory` /
 * `createMemoryWithOutbox` の2箇所しか呼んでいなかった残りの1経路。
 *
 * この歯は上の (甲) と同じ検査(JOIN を含む本物の search() の EXPLAIN)を、
 * 書き込み経路だけ `createMemory` から `supersedeWithNewMemories` に替えて行う——
 * 「呼ばれたか」ではなく「実際に効いたか」(プランが Seq Scan から Index Scan へ
 * 変わったか)を見る、上の2本と同じ形。
 *
 * `resetMemoriesWriteCounterForTesting()` でプロセスローカルの累計カウンタを
 * 0へ戻してから始める——このカウンタは `memories-statistics.ts` のモジュール
 * スコープに persist するため、同一ファイル内で先に走る (甲)/(乙) の書き込みが
 * 残した累計に依存すると、この歯が本当に閾値を跨いだのか、それとも
 * たまたま前段の残りで跨いだだけなのかが分からなくなる。専用の使い捨て
 * データベースも (甲) と同じ理由(他のテストの行や ANALYZE のノイズからの隔離)で使う。
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

    // (甲) と同じ理由（migration 0005 が新規インストール時に空の memories へ
    // 無条件で ANALYZE を打つため）で、ループの前の last_analyze を控えておく。
    const statBeforeLoop = await pool.query(
      `SELECT last_analyze FROM pg_stat_user_tables WHERE relname = 'memories'`,
    );
    const lastAnalyzeBeforeLoop = statBeforeLoop.rows[0]?.last_analyze;

    // Issue #1419: (甲)/(乙) と同じ保険——beforeAll の resetMemoriesWriteCounterForTesting()
    // が効いていること自体を、ループの前後のカウンタで確かめる。
    const counterBeforeLoop = peekMemoriesWriteCounterForTesting();

    // 4,000 = 4 * INITIAL_ANALYZE_THRESHOLD(等比の閾値ちょうど)。(甲) と同じ行数だが、
    // 書き込み経路だけ supersedeWithNewMemories にする——`supersede` は空配列にして
    // news の作成だけを起こす(この歯が検査したいのは news 側の INSERT が
    // ANALYZE フックを起動するかどうかだけである)。
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

    // 事前条件の確認: autovacuum を切ってあるので、last_analyze がループの前後で
    // 動いたなら、それは本 PR のコードが撃った以外にありえない((甲) と同じ検査)。
    const statResult = await pool.query(
      `SELECT last_analyze, last_autoanalyze FROM pg_stat_user_tables WHERE relname = 'memories'`,
    );
    expect(statResult.rows[0]?.last_analyze).not.toEqual(lastAnalyzeBeforeLoop);
    expect(statResult.rows[0]?.last_autoanalyze).toBeNull();

    // JOIN を含む本物の search() SQL を捕まえて EXPLAIN する((甲) と同じ検査)。
    const queryVector = [0.5, 0.5, 0.5];
    const captured = await captureClientQuery(
      (text) => text.includes(table) && /order by/i.test(text),
      () =>
        vectorStore.search(ctx, space, queryVector, {
          limit: 10,
          filter: { tenantId: TENANT },
        }),
    );
    // 本番と同じ transaction の文脈（ADR 0284 の SET LOCAL）で EXPLAIN する
    // （test-db.ts の explainCaptured の doc コメント参照）。
    const plan = await explainCaptured(pool, captured);
    expect(plan).toMatch(/Index Scan.*using idx_memory_embeddings_hnsw/);
    expect(plan).not.toMatch(/Seq Scan/);
  }, 180_000);
});

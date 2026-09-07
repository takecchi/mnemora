import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_MIGRATIONS_DIR } from "../migrate.js";
import { requireDatabaseUrl } from "./test-db.js";
import { dropTempDatabase } from "./temp-database.js";

/**
 * 🔬 **段1の測定用の探針である。実装の歯ではない。**
 *
 * 「共有 DB の中に mnemora 専用のスキーマを切って隔離する」形が本当に成立するかを、
 * **本物の PostgreSQL + pgvector に対して**測るためだけに置いてある。設計判断が
 * 済んで実装が入ったら、ここで測った性質は本物の適合テストへ移し、このファイルは
 * 消す（残しておくと「探針」と「契約」の区別が付かなくなる）。
 *
 * ## なぜ探針が必要か
 *
 * `migrate-ledger-handover.test.ts` の doc は「共有 DB の中に専用スキーマを切って
 * `search_path` を `<schema>,public` に向ける形では隔離できない」と書いている。
 * **しかしその文には条件節が付いている**——「CI は本番の台帳を `public` に作った状態で
 * テストへ入る」。これは*測定環境の事情*であって*製品の性質*ではない。
 * 判定を `to_regclass('<schema>._mnemora_migrations')` と**スキーマ修飾して**問えば
 * `search_path` に頼らずに済むはずだが、**それは誰も測っていない。**
 *
 * ## 測ること
 *
 * 1. 修飾すれば台帳を隔離できるか（`public` に本番の台帳が在る状態で）
 * 2. `search_path` に `public` を**残したまま**（btree_gin の operator class が解ける状態で）
 *    それが成り立つか
 * 3. `public` を search_path から外すと本当に落ちるか（doc の主張の裏取り＝負の対照）
 * 4. テーブル名・索引名・制約名が、同名で2つのスキーマに同居できるか
 * 5. `ALTER TABLE ... SET SCHEMA` で既存環境を後から移せるか
 * 6. `CREATE EXTENSION IF NOT EXISTS` が `search_path` の先頭スキーマへ入ってしまうか、
 *    および `WITH SCHEMA public` を付けたときの挙動
 *
 * **アサーションは、落ちても情報になるものだけに絞ってある。**確信が無い点は
 * `console.log("PROBE: ...")` で観測値をそのまま出す——探針が赤くなると測定自体が
 * 途中で止まるため、「測る」ことを「決め打つ」ことより優先する。
 *
 * **前提**: 接続ロールが `CREATE SCHEMA` / `CREATE DATABASE` / `CREATE EXTENSION` を
 * 行えること（CI の service container は superuser で接続する）。
 */

const PROBE_SCHEMA = "mnemora_probe_qualified";
const PROBE_SCHEMA_NO_PUBLIC = "mnemora_probe_no_public";
const DB_SET_SCHEMA = "mnemora_probe_set_schema";
const DB_EXT_FRESH = "mnemora_probe_ext_fresh";
const DB_EXT_ELSEWHERE = "mnemora_probe_ext_elsewhere";

const INIT_SQL = readFileSync(join(DEFAULT_MIGRATIONS_DIR, "0001_init.sql"), "utf8");

/** `0001_init.sql` が作るテーブル（裸の名前）。 */
const DOMAIN_TABLES = [
  "observations",
  "memories",
  "memory_events",
  "recalls",
  "recall_usages",
  "outbox",
  "tenant_settings",
];

const pools: Pool[] = [];
const createdDatabases: string[] = [];
let adminPool: Pool | undefined;

function admin(): Pool {
  adminPool ??= new Pool({ connectionString: requireDatabaseUrl(), max: 1 });
  return adminPool;
}

/** 探針専用の Pool（共有プールの session 状態を汚さないため、自前で持つ）。 */
function probePool(): Pool {
  const pool = new Pool({ connectionString: requireDatabaseUrl(), max: 2 });
  pools.push(pool);
  return pool;
}

function connectionStringFor(database: string): string {
  const url = new URL(requireDatabaseUrl());
  url.pathname = `/${database}`;
  return url.toString();
}

async function createBlankDatabase(database: string): Promise<Pool> {
  await dropTempDatabase(admin(), database);
  await admin().query(`CREATE DATABASE ${database}`);
  createdDatabases.push(database);
  const pool = new Pool({ connectionString: connectionStringFor(database), max: 2 });
  pools.push(pool);
  return pool;
}

function log(label: string, value: unknown): void {
  console.log(`PROBE: ${label} = ${JSON.stringify(value)}`);
}

/** `relname` がどのスキーマに在るかを全部挙げる（同名の同居を見るため）。 */
async function relationNamespaces(pool: Pool, relnames: string[]): Promise<string[]> {
  const { rows } = await pool.query<{ loc: string }>(
    `SELECT n.nspname || '.' || c.relname || ':' || c.relkind AS loc
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relname = ANY($1::text[])
      ORDER BY 1`,
    [relnames],
  );
  return rows.map((r) => r.loc);
}

async function constraintNamespaces(pool: Pool, table: string): Promise<string[]> {
  const { rows } = await pool.query<{ loc: string }>(
    `SELECT n.nspname || '.' || con.conname || ':' || con.contype AS loc
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = con.connamespace
      WHERE c.relname = $1
      ORDER BY 1`,
    [table],
  );
  return rows.map((r) => r.loc);
}

async function extensionSchemas(pool: Pool): Promise<string[]> {
  const { rows } = await pool.query<{ loc: string }>(
    `SELECT e.extname || '@' || n.nspname AS loc
       FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
      ORDER BY 1`,
  );
  return rows.map((r) => r.loc);
}

function errorText(err: unknown): string {
  const e = err as { message?: string; code?: string };
  return `${e.code ?? "(no code)"}: ${e.message ?? String(err)}`;
}

describe("🔬 段1: 共有 DB の中に専用スキーマを切って隔離できるか（探針）", () => {
  afterAll(async () => {
    const cleanup = probePool();
    for (const schema of [PROBE_SCHEMA, PROBE_SCHEMA_NO_PUBLIC]) {
      await cleanup.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    }
    for (const pool of pools) {
      await pool.end();
    }
    for (const database of createdDatabases) {
      await dropTempDatabase(admin(), database);
    }
    if (adminPool) {
      await adminPool.end();
    }
  });

  // 測定1・2・4: 本番の台帳と本番のテーブルが public に在る共有 DB の中で、
  // 専用スキーマ側だけを見られるか。`search_path` に public を残したまま。
  it("測定1・2・4: public に本番一式が在る状態で、専用スキーマへ 0001_init.sql を通す", async () => {
    const pool = probePool();

    // --- 前提の記録: この DB が「共有 DB」の条件を満たしていること ---
    const before = await pool.query<{
      ledger: string | null;
      memories: string | null;
      search_path: string;
      version: string;
    }>(
      `SELECT to_regclass('public._mnemora_migrations')::text AS ledger,
              to_regclass('public.memories')::text            AS memories,
              current_setting('search_path')                  AS search_path,
              version()                                       AS version`,
    );
    log("precondition", before.rows[0]);
    log("extensions", await extensionSchemas(pool));

    // CI のワークフローはテストの前に `run migrate` する。この探針が測りたい条件
    // （本番の台帳が public に在る）が実際に成り立っていることを、まず確かめる。
    expect(before.rows[0]!.ledger).toBe("public._mnemora_migrations");
    expect(before.rows[0]!.memories).toBe("public.memories");

    await pool.query(`DROP SCHEMA IF EXISTS ${PROBE_SCHEMA} CASCADE`);
    await pool.query(`CREATE SCHEMA ${PROBE_SCHEMA}`);

    const client = await pool.connect();
    try {
      // 製品が採ろうとしている形: 専用スキーマを先頭に置き、public は残す。
      await client.query(`SET search_path TO ${PROBE_SCHEMA}, public`);
      log(
        "search_path in session",
        (await client.query("SELECT current_setting('search_path') AS v")).rows[0],
      );

      // 🔴 測定1の芯: 裸で問うと public の台帳を拾う（= doc が書いていた罠）。
      const unqualified = await client.query<{ v: string | null }>(
        "SELECT to_regclass('_mnemora_migrations')::text AS v",
      );
      log("to_regclass('_mnemora_migrations') under schema-first search_path", unqualified.rows[0]);

      // 🔴 測定1の解: スキーマ修飾して問うと、専用スキーマ側だけを見る。
      const qualified = await client.query<{ v: string | null }>(
        `SELECT to_regclass('${PROBE_SCHEMA}._mnemora_migrations')::text AS v`,
      );
      log("to_regclass('<schema>._mnemora_migrations') before creating it", qualified.rows[0]);

      // 測定2: public を残したまま 0001_init.sql を専用スキーマへ適用する。
      // btree_gin の operator class が public に在るので、これが通れば
      // 「修飾で台帳を解けば public を外す必要が無くなる」が成立する。
      const extBefore = await extensionSchemas(pool);
      await client.query("BEGIN");
      try {
        await client.query(`SET LOCAL search_path TO ${PROBE_SCHEMA}, public`);
        await client.query(INIT_SQL);
        await client.query(
          `CREATE TABLE IF NOT EXISTS ${PROBE_SCHEMA}._mnemora_migrations (
             name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
        );
        await client.query("COMMIT");
        log("0001_init.sql under <schema>,public", "APPLIED");
      } catch (err) {
        await client.query("ROLLBACK");
        log("0001_init.sql under <schema>,public FAILED", errorText(err));
        throw err;
      }
      log("extensions before/after", { before: extBefore, after: await extensionSchemas(pool) });
    } finally {
      // session を汚したまま pool へ返さない。
      await client.query("RESET search_path").catch(() => {});
      client.release();
    }

    // 測定4: テーブル・索引・制約が、同名で public と専用スキーマに同居しているか。
    log("tables", await relationNamespaces(pool, DOMAIN_TABLES));
    log(
      "indexes",
      await relationNamespaces(pool, [
        "idx_memories_tags",
        "idx_memories_recall_gate",
        "uq_memories_extraction",
        "idx_outbox_pending",
      ]),
    );
    log("constraints on memories", await constraintNamespaces(pool, "memories"));
    log("ledgers", await relationNamespaces(pool, ["_mnemora_migrations"]));

    // gin 索引が専用スキーマ側にも実在すること（= operator class が解けた証拠）。
    const gin = await pool.query<{ v: string | null }>(
      `SELECT to_regclass('${PROBE_SCHEMA}.idx_memories_tags')::text AS v`,
    );
    log("gin index in probe schema", gin.rows[0]);

    // 修飾した台帳の判定が、public 側と独立に動くこと。
    const both = await pool.query<{ pub: string | null; probe: string | null }>(
      `SELECT to_regclass('public._mnemora_migrations')::text AS pub,
              to_regclass('${PROBE_SCHEMA}._mnemora_migrations')::text AS probe`,
    );
    log("qualified ledgers", both.rows[0]);

    // public 側の本番テーブルに手が入っていないこと（探針が共有 DB を壊していない）。
    const publicIntact = await pool.query<{ v: string | null }>(
      "SELECT to_regclass('public.memories')::text AS v",
    );
    expect(publicIntact.rows[0]!.v).toBe("public.memories");
  });

  // 測定3（負の対照）: doc の2つ目の主張——public を外すと gin の operator class が解けない。
  it("測定3: search_path から public を外すと 0001_init.sql は落ちるか", async () => {
    const pool = probePool();
    await pool.query(`DROP SCHEMA IF EXISTS ${PROBE_SCHEMA_NO_PUBLIC} CASCADE`);
    await pool.query(`CREATE SCHEMA ${PROBE_SCHEMA_NO_PUBLIC}`);

    const client = await pool.connect();
    let outcome = "APPLIED（落ちなかった）";
    try {
      await client.query("BEGIN");
      try {
        await client.query(`SET LOCAL search_path TO ${PROBE_SCHEMA_NO_PUBLIC}`);
        await client.query(INIT_SQL);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        outcome = errorText(err);
      }
    } finally {
      await client.query("RESET search_path").catch(() => {});
      client.release();
    }
    log("0001_init.sql under <schema> only (no public)", outcome);
  });

  // 測定5: ALTER TABLE ... SET SCHEMA で既存環境を後から移せるか。
  // **共有 DB の public を動かすと後続のテストが壊れる**ので、使い捨ての DB で測る。
  it("測定5: ALTER TABLE ... SET SCHEMA で既存の一式を後から移せるか", async () => {
    const pool = await createBlankDatabase(DB_SET_SCHEMA);
    await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
    await pool.query("CREATE EXTENSION IF NOT EXISTS btree_gin");
    await pool.query("CREATE EXTENSION IF NOT EXISTS pgcrypto");
    await pool.query(INIT_SQL);
    await pool.query(
      `CREATE TABLE _mnemora_migrations (name text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    await pool.query("INSERT INTO _mnemora_migrations (name) VALUES ('0001_init.sql')");

    // 中身のある既存環境にする（移動でデータが失われないことを見るため）。
    await pool.query(
      `INSERT INTO memories
         (tenant_id, content, content_hash, digest, digest_source, provenance_kind, provenance,
          source_observation_id, half_life_hours, decay_floor_at)
       VALUES ('t1', 'c', 'h', 'd', 'llm', 'consolidated', '{}'::jsonb, NULL, 720, now())`,
    );
    const rowsBefore = await pool.query<{ n: string }>("SELECT count(*)::text AS n FROM memories");

    // 空間ごとのテーブルも一緒に測る（vector-space.ts が作る形）。
    await pool.query(
      `CREATE TABLE memory_embeddings_probe (
         tenant_id text NOT NULL,
         memory_id uuid NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
         embedding vector(3) NOT NULL,
         model text NOT NULL,
         created_at timestamptz NOT NULL DEFAULT now(),
         PRIMARY KEY (tenant_id, memory_id))`,
    );
    await pool.query(
      "CREATE INDEX idx_probe_hnsw ON memory_embeddings_probe USING hnsw (embedding vector_cosine_ops)",
    );

    const movable = [...DOMAIN_TABLES, "memory_embeddings_probe", "_mnemora_migrations"];
    await pool.query("CREATE SCHEMA moved");
    let outcome = "MOVED";
    try {
      for (const table of movable) {
        await pool.query(`ALTER TABLE public.${table} SET SCHEMA moved`);
      }
    } catch (err) {
      outcome = errorText(err);
    }
    log("ALTER TABLE ... SET SCHEMA outcome", outcome);
    log("tables after move", await relationNamespaces(pool, movable));
    log(
      "indexes after move",
      await relationNamespaces(pool, [
        "idx_memories_tags",
        "idx_memories_recall_gate",
        "uq_memories_extraction",
        "idx_probe_hnsw",
      ]),
    );
    log("constraints on memories after move", await constraintNamespaces(pool, "memories"));

    // 移した先で、行と外部キーが生きているか。
    const client = await pool.connect();
    try {
      await client.query("SET search_path TO moved, public");
      const rowsAfter = await client.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM memories",
      );
      log("memories rows before/after", {
        before: rowsBefore.rows[0]!.n,
        after: rowsAfter.rows[0]!.n,
      });

      // 外部キーが「移動後のテーブル」を指しているか（CASCADE 先を含む）。
      const fk = await client.query<{ loc: string }>(
        `SELECT n.nspname || '.' || cf.relname AS loc
           FROM pg_constraint con
           JOIN pg_class c ON c.oid = con.conrelid
           JOIN pg_class cf ON cf.oid = con.confrelid
           JOIN pg_namespace n ON n.oid = cf.relnamespace
          WHERE c.relname = 'memory_embeddings_probe' AND con.contype = 'f'`,
      );
      log(
        "fk target of memory_embeddings_probe after move",
        fk.rows.map((r) => r.loc),
      );

      // 移動後に書き込めるか（gin/hnsw 索引つきのテーブルへ）。
      let writeOutcome = "OK";
      try {
        await client.query(
          `INSERT INTO memories
             (tenant_id, content, content_hash, digest, digest_source, provenance_kind, provenance,
              source_observation_id, half_life_hours, decay_floor_at, tags)
           VALUES ('t2', 'c2', 'h2', 'd2', 'llm', 'consolidated', '{}'::jsonb, NULL, 720, now(),
                   ARRAY['a','b'])`,
        );
        await client.query(
          `INSERT INTO memory_embeddings_probe (tenant_id, memory_id, embedding, model)
             SELECT tenant_id, id, '[1,2,3]'::vector, 'm' FROM memories WHERE tenant_id = 't2'`,
        );
      } catch (err) {
        writeOutcome = errorText(err);
      }
      log("write after move", writeOutcome);

      // public 側に何も残っていないか。
      log("public leftovers", await relationNamespaces(pool, movable));
    } finally {
      await client.query("RESET search_path").catch(() => {});
      client.release();
    }
  });

  // 測定6a: まっさらな DB で search_path が専用スキーマ先頭のとき、
  // `CREATE EXTENSION IF NOT EXISTS` はどのスキーマへ入るか。
  it("測定6a: CREATE EXTENSION IF NOT EXISTS は search_path 先頭のスキーマへ入るか", async () => {
    const pool = await createBlankDatabase(DB_EXT_FRESH);
    await pool.query("CREATE SCHEMA s1");
    const client = await pool.connect();
    try {
      await client.query("SET search_path TO s1, public");
      await client.query("CREATE EXTENSION IF NOT EXISTS vector");
      await client.query("CREATE EXTENSION IF NOT EXISTS btree_gin");
    } finally {
      await client.query("RESET search_path").catch(() => {});
      client.release();
    }
    log("extensions on fresh db with schema-first search_path", await extensionSchemas(pool));

    // 2つ目のスキーマから、1つ目のスキーマに入った vector 型が解けるか
    // （= 同じ DB に2つ置いたときに壊れるか）。
    await pool.query("CREATE SCHEMA s2");
    const c2 = await pool.connect();
    let outcome = "OK";
    try {
      await c2.query("SET search_path TO s2, public");
      await c2.query("CREATE EXTENSION IF NOT EXISTS vector");
      await c2.query("CREATE TABLE t (v vector(3))");
    } catch (err) {
      outcome = errorText(err);
    } finally {
      await c2.query("RESET search_path").catch(() => {});
      c2.release();
    }
    log("second schema resolving vector type", outcome);
  });

  // 測定6b: 既に別スキーマに在る拡張へ `WITH SCHEMA public` を付けて
  // `CREATE EXTENSION IF NOT EXISTS` を撃つと、エラーになるか黙って skip するか。
  it("測定6b: CREATE EXTENSION IF NOT EXISTS ... WITH SCHEMA public は既存の拡張で落ちるか", async () => {
    const pool = await createBlankDatabase(DB_EXT_ELSEWHERE);
    await pool.query("CREATE SCHEMA ext");
    await pool.query("CREATE EXTENSION vector WITH SCHEMA ext");
    log("extensions before", await extensionSchemas(pool));

    let outcome = "SKIPPED（落ちなかった）";
    try {
      await pool.query("CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public");
    } catch (err) {
      outcome = errorText(err);
    }
    log("CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public (already in ext)", outcome);
    log("extensions after", await extensionSchemas(pool));

    // まっさらな側: WITH SCHEMA public が実際に public へ入れるか。
    let freshOutcome = "OK";
    try {
      await pool.query("CREATE EXTENSION IF NOT EXISTS btree_gin WITH SCHEMA public");
    } catch (err) {
      freshOutcome = errorText(err);
    }
    log("CREATE EXTENSION ... WITH SCHEMA public (fresh)", freshOutcome);
    log("extensions final", await extensionSchemas(pool));
  });
});

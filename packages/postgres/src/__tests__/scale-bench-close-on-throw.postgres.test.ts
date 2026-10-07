import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { requireDatabaseUrl } from "./test-db.js";

// `scale-bench.ts` はモジュールの末尾で `main()`（本物のベンチ全体、既定で 10k/100k/1M 行の投入を含む）を無条件に呼ぶ。
// 他の `bench/*.ts`（`cli.ts` も含め）と同じ、CLI から `tsx` で直接実行される前提のスクリプトの作法である（`src/bench/scale-bench.ts` の末尾のゲート参照）。
// static import はトップレベルの他の文より先に評価されるため、先に環境変数を立ててから dynamic import する
// （テストから安全に `createScaleDatabase` だけを呼ぶための、このファイル固有の手当て）。
process.env.MNEMORA_SCALE_BENCH_SKIP_MAIN = "1";
const { createScaleDatabase, teardownScaleDatabase } = await import("../bench/scale-bench.js");

/**
 * `createScaleDatabase`（`scale-bench.ts`）は `admin`/`pool` という2本の `Pool` を作った後、`ScaleDatabase`（両方を含む）を返す前に、
 * 失敗しうる `await`（`CREATE DATABASE` / `runMigrations`）を複数段挟んでいる。
 * 呼び出し元（`runSubjectSizeBench` / `main`）はどちらも `const handle = await createScaleDatabase(...); try { ... } finally { await teardownScaleDatabase(handle); }` という形で、
 * `await createScaleDatabase(...)` 自体は `try` の外にある。ここで reject すると `handle` を受け取れず、`teardownScaleDatabase` を呼びようがない。
 * `CREATE DATABASE` が成功した後に `runMigrations` が失敗すると、`Pool` 2本のリークに加え、一時データベース自体も `DROP` されずに残る。
 *
 * ## 失敗の注入口
 *
 * `createScaleDatabase` は、本番の呼び出しでは省略される任意の第3引数 `migrationsDir` を受ける（既定は `runMigrations` 自身の既定にそのまま委譲）。
 * 存在しないディレクトリを渡すと、`Pool` を作り一時データベースも作った後の `runMigrations` が実際に（モックではなく）失敗する。
 * `runMigrations` 自体は冪等な `IF NOT EXISTS` 系なので、正常なディレクトリを渡す限り再実行で失敗させる方法が無く、
 * `CREATE DATABASE` が成功した後に何かが失敗する経路を `Pool`/接続を模倣せずに再現する唯一の現実的な注入口である。
 */
describe("packages/postgres: createScaleDatabase は Pool 構築後の失敗で Pool と一時 DB を残す（本物の Postgres）", () => {
  const baseUrl = requireDatabaseUrl();
  const database = "mnemora_scale_bench_close_on_throw_test";
  let admin: Pool | undefined;

  afterAll(async () => {
    if (admin) {
      await admin.end();
    }
  });

  const countConnections = async (checkAdmin: Pool, db: string): Promise<number> => {
    const { rows } = await checkAdmin.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM pg_stat_activity WHERE datname = $1",
      [db],
    );
    return Number(rows[0]?.n ?? "0");
  };

  const databaseExists = async (checkAdmin: Pool, db: string): Promise<boolean> => {
    const { rows } = await checkAdmin.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS exists",
      [db],
    );
    return rows[0]?.exists ?? false;
  };

  it("runMigrations 失敗で reject しても、Pool 2本が Postgres 側に残らず、一時 DB も残らない", async () => {
    admin = new Pool({ connectionString: baseUrl, max: 1 });

    await expect(
      createScaleDatabase(baseUrl, database, "/nonexistent/mnemora-scale-bench-migrations-dir"),
    ).rejects.toThrow();

    // 失敗直後、`admin`/`pool` どちらのコネクションも新規使い捨て DB 側に残っていない。
    // `pg_stat_activity` の `datname` 列を見れば新しい `database` に居ないことが分かる。
    const remaining = await countConnections(admin, database);
    expect(remaining).toBe(0);

    const exists = await databaseExists(admin, database);
    expect(exists).toBe(false);
  });

  it("正常系は無破壊——migrationsDir を省略すると今日どおり成功し、teardownScaleDatabase で片付く", async () => {
    admin = new Pool({ connectionString: baseUrl, max: 1 });
    const successDatabase = "mnemora_scale_bench_close_on_throw_success_test";

    const handle = await createScaleDatabase(baseUrl, successDatabase);
    try {
      expect(handle.database).toBe(successDatabase);
      expect(await databaseExists(admin, successDatabase)).toBe(true);
    } finally {
      await teardownScaleDatabase(handle);
    }

    expect(await databaseExists(admin, successDatabase)).toBe(false);
  });
});

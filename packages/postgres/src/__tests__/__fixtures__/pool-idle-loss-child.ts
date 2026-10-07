// `readme-unbound-promises.postgres.test.ts` が子プロセスとして起動する。
//
// pool に待機中の接続を1本置き、別の接続からそれを切り、500ms 待ってから次の問い合わせを打つ。引数で経路を切り替える:
//
// - 引数無し（既定）: `onPoolError` も `pool.on("error", …)` も付けない。`createPostgresClient` が付ける既定のリスナーが名乗るだけで、プロセスは落ちない。
// - `onPoolError`: `config.onPoolError` を渡す。それだけが呼ばれ、既定の警告は出ない。
// - `listen-before`: `client.pool.on("error", …)` を、接続を張る前（`createPostgresClient` の直後）に付ける。既定の警告は出ない。
// - `listen-after`: 同じリスナーを、接続を張ってから（`SELECT pg_backend_pid()` の後）・切る前に付ける。既定の警告は出ない。付けた順番に依らないことを確かめる側。
// - `raw`: 陽性対照。`createPostgresClient` を経由しない素の `pg.Pool`（`error` リスナー無し）を使い、
//   `pg_terminate_backend` が本当に `Pool` の `error` を発火させ、リスナーが無ければプロセスが落ちることを示す。
import { Pool } from "pg";
import { createPostgresClient } from "../../client.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL が設定されていません。");

const mode = process.argv[2];

if (mode === "raw") {
  const pool = new Pool({ connectionString: url, max: 1 });
  const admin = new Pool({ connectionString: url, max: 1 });
  const { rows } = await pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  await admin.query("SELECT pg_terminate_backend($1)", [rows[0]!.pid]);
  await admin.end();
  await new Promise((resolve) => setTimeout(resolve, 500));
  const next = await pool.query<{ ok: number }>("SELECT 1 AS ok");
  console.log(`next query: ${next.rows[0]!.ok}`);
  await pool.end();
  process.exit(0);
}

const onPoolError =
  mode === "onPoolError"
    ? (error: Error) => console.log(`onPoolError: ${error.message}`)
    : undefined;

const client = createPostgresClient(url, { max: 1, onPoolError });

if (mode === "listen-before") {
  client.pool.on("error", (error) => console.log(`listener: ${error.message}`));
}

const admin = createPostgresClient(url, { max: 1 });

const { rows } = await client.pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");

if (mode === "listen-after") {
  client.pool.on("error", (error) => console.log(`listener: ${error.message}`));
}

await admin.pool.query("SELECT pg_terminate_backend($1)", [rows[0]!.pid]);
await admin.pool.end();
await new Promise((resolve) => setTimeout(resolve, 500));
const next = await client.pool.query<{ ok: number }>("SELECT 1 AS ok");
console.log(`next query: ${next.rows[0]!.ok}`);
await client.pool.end();

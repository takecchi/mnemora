// `migrate-cli-pool-idle-loss.test.ts` が子プロセスとして起動する。
//
// `mnemora-postgres-migrate` が使う Pool（`createMigrateCliPool`）に待機中の接続を1本置き、別の接続からそれを切り、500ms 待ってから次の問い合わせを打つ。
// - 引数無し: CLI の Pool を使う。
// - `raw`: 陽性対照。error リスナー無しの素の `pg.Pool` を使い、切断が本当に Pool の `error` を発火させ、
//   リスナーが無ければプロセスが落ちることを示す。
import { Pool } from "pg";
import { createMigrateCliPool } from "../../bin/cli-pool.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL が設定されていません。");

const pool =
  process.argv[2] === "raw" ? new Pool({ connectionString: url }) : createMigrateCliPool(url);
const admin = new Pool({ connectionString: url, max: 1 });
const { rows } = await pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
await admin.query("SELECT pg_terminate_backend($1)", [rows[0]!.pid]);
await admin.end();
await new Promise((resolve) => setTimeout(resolve, 500));
const next = await pool.query<{ ok: number }>("SELECT 1 AS ok");
console.log(`next query: ${next.rows[0]!.ok}`);
await pool.end();
process.exit(0);

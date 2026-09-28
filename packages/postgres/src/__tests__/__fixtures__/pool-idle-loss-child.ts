// `readme-unbound-promises.postgres.test.ts` が子プロセスとして起動する（README「⚠ 接続の `error` リスナーは、利用者が付ける」）。
// 引数 `listen` を渡したときだけ、利用者の側で `client.pool.on("error", …)` を付ける。
// pool に待機中の接続を1本置き、別の接続からそれを切り、500ms 待ってから次の問い合わせを打つ。
// リスナーが無ければ、切られた時点で pool の `error` イベントがプロセスを落とす（exit ≠ 0）。
import { createPostgresClient } from "../../client.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL が設定されていません。");

const client = createPostgresClient(url, { max: 1 });
if (process.argv[2] === "listen") {
  client.pool.on("error", (error) => {
    console.log(`listener: ${error.message}`);
  });
}
const admin = createPostgresClient(url, { max: 1 });

const { rows } = await client.pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
await admin.pool.query("SELECT pg_terminate_backend($1)", [rows[0]!.pid]);
await admin.pool.end();
await new Promise((resolve) => setTimeout(resolve, 500));
const next = await client.pool.query<{ ok: number }>("SELECT 1 AS ok");
console.log(`next query: ${next.rows[0]!.ok}`);
await client.pool.end();

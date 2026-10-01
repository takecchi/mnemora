import { Pool } from "pg";
import { POOL_ERROR_WARNING_HEAD } from "../pool-error-warning.js";

/**
 * `mnemora-postgres-migrate`（`./migrate.ts`）が使う `Pool` を作る（ADR 0448）。
 *
 * pg の `Pool` は、待機中の接続が DB 側から切られると `error` を出し、リスナーが無ければ Node のプロセスごと
 * 落ちる。CLI の Pool は待機中の接続を持つ時間が短い（`runMigrations` が接続を返してから
 * `runAnalyzeMemories`・`pool.end()` までの間）が、その間に当たると終了コードも報告も無しに落ちる。
 * そこで `createPostgresClient` と同じく、`error` を名乗って（`console.warn`）続行する。切れた接続は
 * pool が捨て、次の問い合わせは新しい接続で通る。ロックを持つ接続（`runMigrations` が借り切るもの）の
 * 切断は別の経路で、そちらは `advisory-lock.ts` がリスナーを付けて呼び出しの失敗として返す（#1212）。
 *
 * 公開しない（`src/index.ts` から再輸出しない）。`./migrate.ts` とテストだけが使う。
 */
export function createMigrateCliPool(connectionString: string): Pool {
  const pool = new Pool({ connectionString });
  pool.on("error", (error: Error) => {
    console.warn(`${POOL_ERROR_WARNING_HEAD}: ${error.message}`);
  });
  return pool;
}

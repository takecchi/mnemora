import { Pool } from "pg";
import { POOL_ERROR_WARNING_HEAD } from "../pool-error-warning.js";

/**
 * `mnemora-postgres-migrate` が使う `Pool` を作る（ADR 0448）。公開しない（`src/index.ts` から再輸出しない）。
 *
 * pg の `Pool` は待機中の接続が DB 側から切られると `error` を出し、リスナーが無ければプロセスごと落ちる。
 * CLI の Pool は待機中の接続を持つ時間が短いが、その間に当たると終了コードも報告も無しに落ちる。
 * そこで `createPostgresClient` と同じく `error` を名乗って（`console.warn`）続行する。
 * ロックを持つ接続（`runMigrations` が借り切るもの）の切断は別の経路で、`advisory-lock.ts` が受ける。
 */
export function createMigrateCliPool(connectionString: string): Pool {
  const pool = new Pool({ connectionString });
  pool.on("error", (error: Error) => {
    console.warn(`${POOL_ERROR_WARNING_HEAD}: ${error.message}`);
  });
  return pool;
}

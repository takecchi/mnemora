import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { closePostgresClient, createPostgresClient } from "../client.js";
import { requireDatabaseUrl } from "./test-db.js";

/**
 * ADR 0340 決定2: `createPostgresClient` が `drizzle()` に渡す先（`db.transaction()` が
 * 借りる checked-out client への `error` リスナー付け外し）は、**公開する
 * `PostgresClient.pool` とは別の、専用の薄い包み**に対してだけ効く。
 *
 * **公開する `pool` 自身は一切書き換えない**——利用者が自分で `client.pool.connect()` を
 * 呼んで借りたクライアントは、素の `new Pool(...)` を直接 `connect()` した場合と
 * 見分けが付かないはずである（付いている `error` リスナーの数が同じ）。
 *
 * これは PR #863 の初稿（`createPostgresClient` の中で公開する `pool` インスタンス
 * 自身の `connect` を直接差し替えていた版）に対しては赤になる——あちらは
 * `client.pool.connect()` で借りたクライアントにも mnemora の no-op `error` リスナーが
 * 付いてしまっていた（「約束の意味を新しく決める」側に寄っていた、というやり直しの理由
 * そのもの）。
 */
describe("createPostgresClient: 公開する pool は書き換えない", () => {
  it("client.pool.connect() で借りたクライアントの error リスナー数は、素の new Pool(...) と同じ", async () => {
    const databaseUrl = requireDatabaseUrl();
    const client = createPostgresClient(databaseUrl);
    const rawPool = new Pool({ connectionString: databaseUrl });
    try {
      const fromPublicPool = await client.pool.connect();
      const fromRawPool = await rawPool.connect();
      try {
        expect(fromPublicPool.listenerCount("error")).toBe(fromRawPool.listenerCount("error"));
        // ⚠ 「同じ」だけでは、両方に mnemora のリスナーが付いた場合にも green になってしまう
        // ため、具体的な期待値（0 = 何も付いていない）まで固定する。
        expect(fromPublicPool.listenerCount("error")).toBe(0);
      } finally {
        fromPublicPool.release();
        fromRawPool.release();
      }
    } finally {
      await closePostgresClient(client);
      await rawPool.end();
    }
  });
});

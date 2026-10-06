import { describe, expect, it } from "vitest";
import { closePostgresClient, createPostgresClient } from "../client.js";
import { requireDatabaseUrl } from "./test-db.js";

/**
 * #941 の確かめ直し（#1774）。`client-close-idempotent.postgres.test.ts` は、2回目以降の呼び出し
 * （と、`pool.end()` を直接呼んだ後の呼び出し）が reject しないことを見ている。**最初の**
 * `closePostgresClient` の呼び出しが、`pool.end()` が終わる（借りられている接続が返されて
 * `pool.ended` になる）まで resolve しないことは、どの歯も見ていなかった（`pool.end()` を待たずに即 resolve
 * する実装は全部緑だった）。呼び出し側（`close()` を `finally` で `await` する各所）は、これが返った時点で
 * 接続が閉じていることを前提にしている。
 */
describe("closePostgresClient: 最初の呼び出しは pool が終わるまで resolve しない（本物の Postgres）", () => {
  it("借りられたままの接続があるあいだは resolve せず、返されて pool が終わったら resolve する", async () => {
    const client = createPostgresClient(requireDatabaseUrl());
    const borrowed = await client.pool.connect();

    let settled = false;
    const closing = closePostgresClient(client).then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(client.pool.ended).toBe(false);
    expect(settled, "終わっていない pool に対して、待たずに resolve した").toBe(false);

    borrowed.release();
    await closing;
    expect(client.pool.ended).toBe(true);
  });

  it("resolve した時点で pool は終わっている", async () => {
    const client = createPostgresClient(requireDatabaseUrl());
    await client.pool.query("SELECT 1");
    await closePostgresClient(client);
    expect(client.pool.ended).toBe(true);
  });
});

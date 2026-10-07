import { describe, expect, it } from "vitest";
import { closePostgresClient, createPostgresClient } from "../client.js";
import { requireDatabaseUrl } from "./test-db.js";

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

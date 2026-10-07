import { describe, expect, it } from "vitest";
import { closePostgresClient, createPostgresClient } from "../client.js";
import { requireDatabaseUrl } from "./test-db.js";

describe("closePostgresClient は冪等（本物の Postgres）", () => {
  it("同じ client に対して2回呼んでも reject しない", async () => {
    const client = createPostgresClient(requireDatabaseUrl());

    await closePostgresClient(client);
    await expect(closePostgresClient(client)).resolves.toBeUndefined();
  });

  it("同じ client に対して並行に2回呼んでも、どちらも reject しない", async () => {
    const client = createPostgresClient(requireDatabaseUrl());

    await expect(
      Promise.all([closePostgresClient(client), closePostgresClient(client)]),
    ).resolves.toBeDefined();
  });

  it("pool.end() が既に直接呼ばれて終わっていても、closePostgresClient は reject しない", async () => {
    const client = createPostgresClient(requireDatabaseUrl());
    await client.pool.end();
    expect(client.pool.ended).toBe(true);

    await expect(closePostgresClient(client)).resolves.toBeUndefined();
    await expect(closePostgresClient(client)).resolves.toBeUndefined();
  });

  it("pool.end() を待たずに呼んだ直後（終わる途中）でも、closePostgresClient は reject せず、終わるのを待つ", async () => {
    const client = createPostgresClient(requireDatabaseUrl());
    await client.pool.query("SELECT 1");
    const ending = client.pool.end();
    expect(client.pool.ending).toBe(true);

    await expect(closePostgresClient(client)).resolves.toBeUndefined();
    expect(client.pool.ended).toBe(true);
    await ending;
  });

  it("借りられたままの接続があって pool.end() が終わらないあいだは、closePostgresClient も resolve せず、返されて終わったら resolve する", async () => {
    const client = createPostgresClient(requireDatabaseUrl());
    const borrowed = await client.pool.connect();
    const ending = client.pool.end();
    expect(client.pool.ending).toBe(true);

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
    await ending;
  });
});

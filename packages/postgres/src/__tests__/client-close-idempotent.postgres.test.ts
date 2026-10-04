import { describe, expect, it } from "vitest";
import { closePostgresClient, createPostgresClient } from "../client.js";
import { requireDatabaseUrl } from "./test-db.js";

/**
 * Issue #935: `closePostgresClient` に、2回目以降の呼び出しがどうなるかの約束が
 * 一切無かった。`node-postgres`（`pg`）の `Pool.end()` は、既に `end()` 済みの
 * `Pool` に対してもう一度呼ぶと reject する（`Called end on pool more than once`）。
 *
 * **決定（この歯が縛る契約）**: `closePostgresClient` は冪等——2回目以降の呼び出しは
 * 何もせずに resolve する。`PostgresClient` という公開の型そのものは変えていない
 * （`WeakMap` で client → Promise を覚える形で実現、`client.ts` の doc コメント参照）。
 */
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

  /**
   * ADR 0444 BH(c): 上の冪等は `closePostgresClient` を通った呼び出しだけを覚えている。
   * 利用者が `client.pool.end()` を**直接**呼んでいた場合（`db.$client.end()` も同じ）、
   * そのあとの `closePostgresClient` は `pool.end()` をもう一度呼んで
   * `Called end on pool more than once` で reject していた。pool 自身の `ending`/`ended` を見る。
   */
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

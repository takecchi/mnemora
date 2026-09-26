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
});

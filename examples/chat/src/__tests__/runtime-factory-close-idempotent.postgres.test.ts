import { afterAll, describe, expect, it } from "vitest";
import { createExampleRuntime } from "../runtime-factory.js";
import { closeTestClient, requireDatabaseUrl } from "./test-db.js";

/**
 * Issue #935: `ExampleRuntimeHandle.close()`（`close: () => closePostgresClient(client)`）
 * は `closePostgresClient` の薄いラッパーであり、`closePostgresClient` 自体に
 * 2回目の呼び出しがどうなるかの約束が無かった。`node-postgres` の `Pool.end()` は
 * 既に `end()` 済みの `Pool` にもう一度呼ぶと reject する
 * （`Called end on pool more than once`）。
 *
 * **決定**: `close()` は冪等——2回目以降は何もせずに resolve する。
 * `closePostgresClient`（`packages/postgres`）側を冪等にしたことで、それを薄く
 * 委譲しているだけのこの `close()` も自動的に冪等になる（`runtime-factory.ts` を
 * 変更していないことを確認する歯）。
 */
describe("examples/chat: ExampleRuntimeHandle.close() は冪等（本物の Postgres）", () => {
  afterAll(async () => {
    await closeTestClient();
  });

  it("同じ handle に対して close() を2回呼んでも reject しない", async () => {
    const handle = await createExampleRuntime(requireDatabaseUrl(), {});

    await handle.close();
    await expect(handle.close()).resolves.toBeUndefined();
  });
});

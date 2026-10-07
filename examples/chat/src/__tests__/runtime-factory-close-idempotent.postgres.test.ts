import { afterAll, describe, expect, it } from "vitest";
import { createExampleRuntime } from "../runtime-factory.js";
import { closeTestClient, requireDatabaseUrl } from "./test-db.js";

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

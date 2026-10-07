import { afterAll, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

describe("abortIfForgotten — forgotten の記憶だけを理由に打ち切る", () => {
  afterAll(async () => {
    await closeTestClient();
  });

  it.each(["archived"] as const)(
    "createMemoryWithOutbox: status が %s の id を渡しても、SourceMemoryForgottenError にならず書ける",
    async (status) => {
      await resetTestDatabase();
      const { db } = await getTestClient();
      const store = new PostgresMemoryStore(db);
      const ctx: Ctx = { tenantId: `abort-if-forgotten-only-forgotten-${status}` };

      const source = await store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: `source-${status}` }),
      );
      await store.updateStatus(ctx, source.id, status);

      const { memory, created } = await store.createMemoryWithOutbox(
        ctx,
        buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: `new-${status}` }),
        [],
        { abortIfForgotten: [source.id] },
      );

      expect(created).toBe(true);
      expect(memory.status).toBe("active");
    },
  );
});

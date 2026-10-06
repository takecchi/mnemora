import { afterAll, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * `opts.abortIfForgotten` が打ち切るのは、`"forgotten"` の記憶が混ざっているときだけである。
 * `archived` など、forgotten でない記憶は理由にしない（`SourceMemoryForgottenError` を投げず、
 * 今日どおり書く）。`superseded` の扱いは別の口（`abortIfSuperseded`）の領分で、`abortIfForgotten` は断らない。
 *
 * 「forgotten だった」と誤って名乗ると、呼び出し側（`consolidate`/`reflect`）は `outcome: 'aborted_source_forgotten'` と
 * `forgotten_before_write` を返し、実際に起きたこと（別の状態への遷移）と食い違う。
 */
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

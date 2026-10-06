import { afterAll, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * `opts.abortIfForgotten`（`createMemoryWithOutbox`・`supersedeWithNewMemories`・
 * `createMemoriesWithOutboxAndEvents`）の見直しは、呼び出しの `ctx.tenantId` の記憶だけを見る
 * （`assertNotForgottenForUpdate` の doc:「`tenant_id` の絞り込みも同じ `WHERE` に含める——
 * 他テナントの同じ id を誤って見ない」）。
 *
 * 別のテナントの forgotten な記憶の id が混ざっていても、それを理由に自分のテナントの書き込みを打ち切らない
 * （他のテナントの状態が、このテナントの書き込みの成否に漏れない）。
 */
describe("abortIfForgotten — 見直しは自分のテナントの行だけを見る", () => {
  afterAll(async () => {
    await closeTestClient();
  });

  it("createMemoryWithOutbox: 別のテナントの forgotten な id を渡しても、SourceMemoryForgottenError にならず書ける", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const ctxA: Ctx = { tenantId: "abort-if-forgotten-tenant-a" };
    const ctxB: Ctx = { tenantId: "abort-if-forgotten-tenant-b" };

    const otherTenantMemory = await store.createMemory(
      ctxB,
      buildNewMemoryFixture({ tenantId: ctxB.tenantId, contentHash: "other-tenant-forgotten" }),
    );
    await store.updateStatus(ctxB, otherTenantMemory.id, "forgotten");

    const { memory, created } = await store.createMemoryWithOutbox(
      ctxA,
      buildNewMemoryFixture({ tenantId: ctxA.tenantId, contentHash: "tenant-a-new" }),
      [],
      { abortIfForgotten: [otherTenantMemory.id] },
    );

    expect(created).toBe(true);
    expect(memory.tenantId).toBe(ctxA.tenantId);
  });
});

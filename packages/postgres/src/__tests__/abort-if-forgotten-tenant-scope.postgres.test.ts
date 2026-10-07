import { afterAll, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

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

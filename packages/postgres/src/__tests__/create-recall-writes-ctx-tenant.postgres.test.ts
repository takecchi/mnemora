import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

const ctx: Ctx = { tenantId: "tenant-recall-owner" };
const other: Ctx = { tenantId: "tenant-recall-other" };

describe("PostgresMemoryStore.createRecall は、record.tenantId ではなく ctx のテナントの記録として書く", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });
  afterAll(async () => {
    await closeTestClient();
  });

  it("record.tenantId が ctx と違っても、ctx のテナントから読め、record.tenantId のテナントからは読めない", async () => {
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const recallId = await store.createRecall(ctx, {
      tenantId: other.tenantId,
      query: {},
      omitted: [],
      usage: {} as never,
      indexBand: {} as never,
      explain: { stages: [] },
      returnedMemories: [],
    });

    expect((await store.getRecall(ctx, recallId))?.tenantId).toBe(ctx.tenantId);
    expect(await store.getRecall(other, recallId)).toBeNull();
  });
});

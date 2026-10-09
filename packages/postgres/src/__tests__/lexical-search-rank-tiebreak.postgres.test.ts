import type { Ctx } from "@mnemora/core";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresLexicalStore } from "../lexical-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

const TENANT = "lexical-rank-tiebreak-tenant";

describe("PostgresLexicalStore.search — coverage と rank が同じなら recorded_at の新しい方が先", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("content の文字数が違っても、recorded_at が新しい方を先に返す", async () => {
    const { db } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const lexicalStore = new PostgresLexicalStore(db);
    const ctx: Ctx = { tenantId: TENANT };

    // rank の正規化は語の数で割るので、語の数と語の位置を揃え、綴りの長さだけを変える。
    const shorter = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        content: "alpha beta",
        recordedAt: new Date("2026-01-01T00:00:00.000Z"),
      }),
    );
    const longer = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        content: "alpha betalongerword",
        recordedAt: new Date("2026-01-02T00:00:00.000Z"),
      }),
    );

    const hits = await lexicalStore.search(ctx, "alpha", {
      limit: 10,
      filter: { tenantId: TENANT, status: ["active", "contested"] },
    });

    expect(hits).toHaveLength(2);
    expect(hits[0]!.coverage).toBe(hits[1]!.coverage);
    expect(hits[0]!.rank).toBe(hits[1]!.rank);
    expect(hits.map((h) => h.memoryId)).toEqual([longer.id, shorter.id]);
  });
});

import type { Ctx } from "@mnemora/core";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PostgresVectorStore } from "../vector-store.js";
import { PostgresLexicalStore } from "../lexical-store.js";
import {
  closeTestClient,
  getTestClient,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
} from "./test-db.js";

/**
 * testkit の InMemory 側の歯（`in-memory-search-ctx-tenant-boundary.test.ts` の3件目）が「Postgres と揃える」と言っている、基準の側:
 * `ctx.tenantId` と `filter.tenantId` が食い違っていても、`limit` の検査は先に効く（食い違いを理由に「空」を先に返さない）。
 * Postgres は SQL の `LIMIT` に不正な値を渡して例外になる。この歯がないと、Postgres が食い違いで先に空を返す形になっても、InMemory の歯だけが「揃えた」つもりで緑のままになる。
 */

const ctxB: Ctx = { tenantId: "search-boundary-limit-b" };
const filterA = { tenantId: "search-boundary-limit-a" };

describe("食い違った ctx と filter でも、不正な limit は例外になる（Issue #1050 / ADR 0007）", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("PostgresVectorStore.search", async () => {
    const { db } = await getTestClient();
    await expect(
      new PostgresVectorStore(db).search(ctxB, TEST_EMBEDDING_SPACE, [1, 0, 0], {
        limit: -1,
        filter: filterA,
      }),
    ).rejects.toThrow();
  });

  it("PostgresLexicalStore.search", async () => {
    const { db } = await getTestClient();
    await expect(
      new PostgresLexicalStore(db).search(ctxB, "boundary probe token", {
        limit: -1,
        filter: filterA,
      }),
    ).rejects.toThrow();
  });
});

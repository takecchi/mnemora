import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * `requeueEmbedJobs` は、対象が `limit` より多いとき **`updatedAt` の古い順、同着は `id` の昇順**で選ぶ（interface の doc）。
 * 既存の試験はこの並びを索引の使い方（EXPLAIN）からしか見ておらず、`embeddingStatus` で先に並べ替える形は、結果を見る試験では捕まらなかった。
 */

const ctx: Ctx = { tenantId: "requeue-embed-jobs-order-ignores-embedding-status" };

describe("requeueEmbedJobs は、embeddingStatus にかかわらず updatedAt の古い行から選ぶ", () => {
  let store: PostgresMemoryStore;
  let pool: Awaited<ReturnType<typeof getTestClient>>["pool"];

  beforeEach(async () => {
    await resetTestDatabase();
    const client = await getTestClient();
    store = new PostgresMemoryStore(client.db);
    pool = client.pool;
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("updatedAt の古い pending が、新しい failed より先に選ばれる", async () => {
    const pending = await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: "h-pending",
        embeddingStatus: "pending",
      }),
    );
    const failed = await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: "h-failed",
        embeddingStatus: "failed",
      }),
    );
    await pool.query("UPDATE memories SET updated_at = $2 WHERE id = $1", [
      pending.id,
      "2026-01-01T00:00:00.000Z",
    ]);
    await pool.query("UPDATE memories SET updated_at = $2 WHERE id = $1", [
      failed.id,
      "2026-01-02T00:00:00.000Z",
    ]);

    const first = await store.requeueEmbedJobs(ctx, { statuses: ["pending", "failed"], limit: 1 });
    expect(first.memoryIds).toEqual([pending.id]);
  });
});

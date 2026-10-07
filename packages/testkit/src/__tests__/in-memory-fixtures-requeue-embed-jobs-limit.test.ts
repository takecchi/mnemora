import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "../test-data.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";

const ctx: Ctx = { tenantId: "tenant-1" };

async function seedFailedMemories(store: InMemoryMemoryStore, count: number) {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const memory = await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: `h-${i}`,
        embeddingStatus: "failed",
      }),
    );
    ids.push(memory.id);
  }
  return ids;
}

describe("InMemoryMemoryStore.requeueEmbedJobs: 壊れた limit を渡すと Postgres と同じく例外を投げ、1件も積み直さない", () => {
  for (const limit of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, 2 ** 63, 1e21]) {
    it(`limit=${limit} は例外を投げ、embeddingStatus も outbox も変えない`, async () => {
      const store = new InMemoryMemoryStore();
      const ids = await seedFailedMemories(store, 3);
      const jobsBefore = store.outboxJobs.length;

      await expect(store.requeueEmbedJobs(ctx, { statuses: ["failed"], limit })).rejects.toThrow(
        /limit must (be an integer|not be negative|fit in a Postgres bigint)/,
      );

      for (const id of ids) {
        expect((await store.get(ctx, id))?.embeddingStatus).toBe("failed");
      }
      expect(store.outboxJobs.length).toBe(jobsBefore);
    });
  }

  for (const [limit, expected] of [
    [0, 0],
    [1, 1],
    [3, 3],
    [4, 3],
    [2 ** 62, 3],
  ] as const) {
    it(`limit=${limit} は ${expected} 件を積み直す（回帰確認）`, async () => {
      const store = new InMemoryMemoryStore();
      await seedFailedMemories(store, 3);
      const result = await store.requeueEmbedJobs(ctx, { statuses: ["failed"], limit });
      expect(result.requeued).toBe(expected);
      expect(result.memoryIds).toHaveLength(expected);
    });
  }
});

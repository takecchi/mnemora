// 非整数を先に、次に負数を見る。-1.5 は「must be an integer」で断る。順序を入れ替える変異は文言が変わるだけで例外は投げ続けるので、文言まで見る。

import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "../test-data.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";

const ctx: Ctx = { tenantId: "tenant-1" };

describe("InMemoryMemoryStore.requeueEmbedJobs: limit のガードは非整数を先に見る", () => {
  it("limit=-1.5 は「must be an integer」で断り、何も積み直さない", async () => {
    const store = new InMemoryMemoryStore();
    const memory = await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: "h-order",
        embeddingStatus: "failed",
      }),
    );
    const jobsBefore = store.outboxJobs.length;

    await expect(
      store.requeueEmbedJobs(ctx, { statuses: ["failed"], limit: -1.5 }),
    ).rejects.toThrow(/requeueEmbedJobs: limit must be an integer \(got -1\.5\)/);

    expect((await store.get(ctx, memory.id))?.embeddingStatus).toBe("failed");
    expect(store.outboxJobs.length).toBe(jobsBefore);
  });

  it("limit=-1 は「must not be negative」で断る（整数の負数）", async () => {
    const store = new InMemoryMemoryStore();
    await expect(store.requeueEmbedJobs(ctx, { statuses: ["failed"], limit: -1 })).rejects.toThrow(
      /requeueEmbedJobs: limit must not be negative \(got -1\)/,
    );
  });
});

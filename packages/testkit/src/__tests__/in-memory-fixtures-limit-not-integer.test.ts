import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { InMemoryEventStore } from "../__fixtures__/in-memory-event-store.js";
import { InMemoryLexicalStore } from "../__fixtures__/in-memory-lexical-store.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { InMemoryOutboxStore } from "../__fixtures__/in-memory-outbox-store.js";
import { InMemoryVectorStore } from "../__fixtures__/in-memory-vector-store.js";

const ctx: Ctx = { tenantId: "tenant-1" };

describe("in-memory Fake: NaN/Infinity/非整数の limit を渡すと Postgres と同じく例外を投げる", () => {
  for (const limit of [NaN, Infinity, 1.5]) {
    it(`InMemoryOutboxStore.claimBatch は limit=${limit} のとき、ジョブを claim せずに例外を投げる`, async () => {
      const store = new InMemoryOutboxStore([]);
      await expect(
        store.claimBatch(ctx, {
          limit,
          now: new Date("2026-01-01T00:00:00.000Z"),
          claimedBy: "test-worker",
          leaseMs: 60_000,
        }),
      ).rejects.toThrow(/limit must be an integer/);
    });

    it(`InMemoryVectorStore.search は limit=${limit} のとき例外を投げる`, async () => {
      const memoryStore = new InMemoryMemoryStore();
      const vectorStore = new InMemoryVectorStore(memoryStore);
      await expect(
        vectorStore.search(ctx, { provider: "test", model: "test", dimensions: 3 }, [0, 0, 0], {
          limit,
          filter: { tenantId: ctx.tenantId },
        }),
      ).rejects.toThrow(/limit must be an integer/);
    });

    it(`InMemoryLexicalStore.search は limit=${limit} のとき例外を投げる`, async () => {
      const memoryStore = new InMemoryMemoryStore();
      const lexicalStore = new InMemoryLexicalStore(memoryStore);
      await expect(
        lexicalStore.search(ctx, "テスト", {
          limit,
          filter: { tenantId: ctx.tenantId },
        }),
      ).rejects.toThrow(/limit must be an integer/);
    });

    it(`InMemoryEventStore.list は filter.limit=${limit} のとき例外を投げる`, async () => {
      const memoryStore = new InMemoryMemoryStore();
      const eventStore = new InMemoryEventStore(memoryStore);
      await expect(eventStore.list(ctx, { limit })).rejects.toThrow(/limit must be an integer/);
    });

    it(`InMemoryMemoryStore.purgeExpiredEvents は limit=${limit} のとき例外を投げ、1行も消さない`, async () => {
      const memoryStore = new InMemoryMemoryStore();
      await expect(
        memoryStore.purgeExpiredEvents?.(ctx, {
          olderThan: new Date("2026-06-01T00:00:00.000Z"),
          limit,
        }),
      ).rejects.toThrow(/limit must be an integer/);
    });

    it(`InMemoryMemoryStore.aggregateScope の digestBand: limit=${limit} のとき例外を投げる`, async () => {
      const memoryStore = new InMemoryMemoryStore();
      await expect(
        memoryStore.aggregateScope(ctx, {}, { digestBand: { limit, excludeMemoryIds: [] } }),
      ).rejects.toThrow(/digestBand\.limit must be an integer/);
    });
  }
});

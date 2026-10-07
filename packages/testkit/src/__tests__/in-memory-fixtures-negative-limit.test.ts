import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { InMemoryEventStore } from "../__fixtures__/in-memory-event-store.js";
import { InMemoryLexicalStore } from "../__fixtures__/in-memory-lexical-store.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { InMemoryOutboxStore } from "../__fixtures__/in-memory-outbox-store.js";
import { InMemoryVectorStore } from "../__fixtures__/in-memory-vector-store.js";

const ctx: Ctx = { tenantId: "tenant-1" };

describe("in-memory Fake: 負数の limit を渡すと Postgres と同じく例外を投げる", () => {
  it("InMemoryOutboxStore.claimBatch は limit が負数のとき、ジョブを claim せずに例外を投げる", async () => {
    const store = new InMemoryOutboxStore([]);
    await expect(
      store.claimBatch(ctx, {
        limit: -1,
        now: new Date("2026-01-01T00:00:00.000Z"),
        claimedBy: "test-worker",
        leaseMs: 60_000,
      }),
    ).rejects.toThrow(/limit must not be negative/);
  });

  it("InMemoryVectorStore.search は limit が負数のとき例外を投げる", async () => {
    const memoryStore = new InMemoryMemoryStore();
    const vectorStore = new InMemoryVectorStore(memoryStore);
    await expect(
      vectorStore.search(ctx, { provider: "test", model: "test", dimensions: 3 }, [0, 0, 0], {
        limit: -1,
        filter: { tenantId: ctx.tenantId },
      }),
    ).rejects.toThrow(/limit must not be negative/);
  });

  it("InMemoryLexicalStore.search は limit が負数のとき例外を投げる", async () => {
    const memoryStore = new InMemoryMemoryStore();
    const lexicalStore = new InMemoryLexicalStore(memoryStore);
    await expect(
      lexicalStore.search(ctx, "テスト", {
        limit: -1,
        filter: { tenantId: ctx.tenantId },
      }),
    ).rejects.toThrow(/limit must not be negative/);
  });

  it("InMemoryEventStore.list は filter.limit が負数のとき例外を投げる", async () => {
    const memoryStore = new InMemoryMemoryStore();
    const eventStore = new InMemoryEventStore(memoryStore);
    await expect(eventStore.list(ctx, { limit: -1 })).rejects.toThrow(/limit must not be negative/);
  });

  it("InMemoryMemoryStore.purgeExpiredEvents は limit が負数（-2）のとき例外を投げ、1行も消さない", async () => {
    // -1 は使わない。Postgres 実装は `LIMIT opts.limit + 1` と組むため、`opts.limit === -1` のときだけ `LIMIT 0` になり、例外を投げずに `purged: 0` を返す。Fake は負数を一様に拒むので、両者が一致する -2 を使う。
    const memoryStore = new InMemoryMemoryStore();
    await expect(
      memoryStore.purgeExpiredEvents?.(ctx, {
        olderThan: new Date("2026-06-01T00:00:00.000Z"),
        limit: -2,
      }),
    ).rejects.toThrow(/limit must not be negative/);
  });

  it("InMemoryMemoryStore.aggregateScope の digestBand: limit が負数のとき例外を投げる", async () => {
    const memoryStore = new InMemoryMemoryStore();
    await expect(
      memoryStore.aggregateScope(ctx, {}, { digestBand: { limit: -1, excludeMemoryIds: [] } }),
    ).rejects.toThrow(/digestBand.limit must not be negative/);
  });
});

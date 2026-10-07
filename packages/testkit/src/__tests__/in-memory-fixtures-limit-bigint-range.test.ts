import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "../test-data.js";
import { InMemoryEventStore } from "../__fixtures__/in-memory-event-store.js";
import { InMemoryLexicalStore } from "../__fixtures__/in-memory-lexical-store.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { InMemoryOutboxStore } from "../__fixtures__/in-memory-outbox-store.js";
import { InMemoryVectorStore } from "../__fixtures__/in-memory-vector-store.js";

const ctx: Ctx = { tenantId: "tenant-1" };
const NOW = new Date("2026-06-01T00:00:00.000Z");
const SPACE = { provider: "test", model: "test", dimensions: 3 };
const TOO_LARGE = [2 ** 63, 1e21];
const LARGEST_BELOW = 2 ** 63 - 1024;

const CALLS: [name: string, call: (limit: number) => Promise<unknown>][] = [
  [
    "InMemoryOutboxStore.claimBatch",
    (limit) =>
      new InMemoryOutboxStore([]).claimBatch(ctx, {
        limit,
        now: NOW,
        claimedBy: "test-worker",
        leaseMs: 60_000,
      }),
  ],
  [
    "InMemoryVectorStore.search",
    (limit) =>
      new InMemoryVectorStore(new InMemoryMemoryStore()).search(ctx, SPACE, [1, 0, 0], {
        limit,
        filter: { tenantId: ctx.tenantId },
      }),
  ],
  [
    "InMemoryLexicalStore.search",
    (limit) =>
      new InMemoryLexicalStore(new InMemoryMemoryStore()).search(ctx, "テスト", {
        limit,
        filter: { tenantId: ctx.tenantId },
      }),
  ],
  [
    "InMemoryEventStore.list",
    (limit) => new InMemoryEventStore(new InMemoryMemoryStore()).list(ctx, { limit }),
  ],
  [
    "InMemoryMemoryStore.purgeExpiredEvents",
    (limit) => new InMemoryMemoryStore().purgeExpiredEvents(ctx, { olderThan: NOW, limit }),
  ],
  [
    "InMemoryMemoryStore.aggregateScope（digestBand.limit）",
    (limit) =>
      new InMemoryMemoryStore().aggregateScope(
        ctx,
        {},
        { digestBand: { limit, excludeMemoryIds: [] } },
      ),
  ],
  [
    "InMemoryMemoryStore.archiveDecayed",
    (limit) => new InMemoryMemoryStore().archiveDecayed(ctx, { now: NOW, limit }),
  ],
];

describe("in-memory Fake: bigint に収まらない limit（2^63 以上）を渡すと Postgres と同じく例外を投げる", () => {
  for (const [name, call] of CALLS) {
    for (const limit of TOO_LARGE) {
      it(`${name} は limit=${limit} のとき例外を投げる`, async () => {
        await expect(call(limit)).rejects.toThrow(/limit must fit in a Postgres bigint/);
      });
    }
    it(`${name} は limit=2^63-1024（2^63 未満で最大の double）では例外を投げない（回帰確認）`, async () => {
      await expect(call(LARGEST_BELOW)).resolves.toBeDefined();
    });
  }

  it("InMemoryOutboxStore.claimBatch は limit=2^63 のとき、ジョブを claim しない", async () => {
    const job = {
      id: "job-1",
      tenantId: ctx.tenantId,
      kind: "extract",
      payload: {},
      availableAt: new Date("2026-01-01T00:00:00.000Z"),
      claimedAt: null,
      attempts: 0,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    };
    const store = new InMemoryOutboxStore([job]);
    await expect(
      store.claimBatch(ctx, { limit: 2 ** 63, now: NOW, claimedBy: "w", leaseMs: 60_000 }),
    ).rejects.toThrow(/limit must fit in a Postgres bigint/);
    expect(job.attempts).toBe(0);
    expect(job.claimedAt).toBeNull();
  });

  it("InMemoryMemoryStore.archiveDecayed は limit=2^63 のとき、対象を archived にしない", async () => {
    const store = new InMemoryMemoryStore();
    const memory = await store.createMemory(ctx, buildNewMemoryFixture({ tenantId: ctx.tenantId }));
    await expect(store.archiveDecayed(ctx, { now: NOW, limit: 2 ** 63 })).rejects.toThrow(
      /limit must fit in a Postgres bigint/,
    );
    expect((await store.get(ctx, memory.id))?.status).toBe("active");
  });
});

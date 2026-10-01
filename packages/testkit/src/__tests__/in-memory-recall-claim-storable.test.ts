import { describe, expect, it } from "vitest";
import type { Ctx, NewRecallRecord } from "@mnemora/core";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { InMemoryOutboxStore } from "../__fixtures__/in-memory-outbox-store.js";
import { InMemoryTenantSettingsStore } from "../__fixtures__/in-memory-tenant-settings-store.js";
import { buildNewMemoryFixture } from "../test-data.js";

/**
 * `createRecall` と `claimBatch` に、Postgres が行を書けずに拒む入力を渡すと、testkit の fixture も拒み、
 * 何も書かない。`recalls.subject_id`・`outbox.claimed_by` は `text` 列（NUL を拒む）、`recalls` の
 * `query` などは `NOT NULL` の `jsonb` 列（NUL を拒み、JSON にならない値は NULL になって拒む）。
 * 2実装を並べた歯は `packages/postgres/src/__tests__/store-boundary-diff.postgres.test.ts`（DB が要る）。
 */

const ctx: Ctx = { tenantId: "recall-claim-storable" };

function record(override: Partial<NewRecallRecord> = {}): NewRecallRecord {
  return {
    tenantId: ctx.tenantId,
    subjectId: null,
    query: { text: "q" },
    budget: null,
    omitted: [],
    usage: {
      chars: 0,
      estimatedTokens: 0,
      counter: "heuristic",
      byTier: { full: 0, digest: 0, index: 0 },
      indexChars: 0,
    },
    indexBand: { groups: [], totalInScope: 0, countKind: "exact" },
    explain: { stages: [] },
    returnedMemories: [],
    advanceActivityClock: true,
    ...override,
  };
}

describe("testkit の fixture は createRecall で Postgres が書けない記録を拒む", () => {
  const cases: Array<[string, Partial<NewRecallRecord>, RegExp]> = [
    ["subjectId に NUL", { subjectId: "s\u0000" }, /^record\.subjectId contains a NUL character/],
    ["query に NUL", { query: { text: "q\u0000" } }, /^createRecall: query must not contain NUL/],
    ["query が undefined", { query: undefined }, /^createRecall: query must be JSON-serializable/],
    [
      "explain に NUL",
      { explain: { stages: [{ stage: "s\u0000" } as never] } },
      /^createRecall: explain must not contain NUL/,
    ],
    [
      "budget に NUL",
      { budget: { chars: 1, x: "\u0000" } as never },
      /^createRecall: budget must not contain NUL/,
    ],
  ];
  it.each(cases)("%s は拒み、記録も活動時計も進めない", async (_name, override, message) => {
    const memoryStore = new InMemoryMemoryStore();
    const settings = new InMemoryTenantSettingsStore(memoryStore.activitySeq);
    await expect(memoryStore.createRecall(ctx, record(override))).rejects.toThrow(message);
    expect(await settings.getActivitySeq(ctx)).toBe(0);
  });

  it("文字どおりの \\u0000（バックスラッシュ + u0000）と、budget の省略は受け付ける（陽性対照）", async () => {
    const memoryStore = new InMemoryMemoryStore();
    const id = await memoryStore.createRecall(
      ctx,
      record({ query: { text: "q\\u0000" }, budget: undefined }),
    );
    expect((await memoryStore.getRecall(ctx, id))?.query).toEqual({ text: "q\\u0000" });
  });
});

describe("testkit の fixture は claimBatch で NUL を含む claimedBy を拒む", () => {
  it("拒み、ジョブを claim しない", async () => {
    const memoryStore = new InMemoryMemoryStore();
    const outbox = new InMemoryOutboxStore(memoryStore.outboxJobs);
    await memoryStore.createMemoryWithOutbox(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "claim" }),
      ["embed"],
    );
    const opts = { limit: 10, now: new Date(Date.now() + 60_000), leaseMs: 60_000 };
    await expect(outbox.claimBatch(ctx, { ...opts, claimedBy: "w\u0000" })).rejects.toThrow(
      /^claimBatch: claimedBy must not contain NUL characters \(U\+0000\)$/,
    );
    const claimed = await outbox.claimBatch(ctx, { ...opts, claimedBy: "w" });
    expect(claimed.map((j) => [j.kind, j.attempts, j.claimedBy])).toEqual([["embed", 1, "w"]]);
  });
});

describe("testkit の fixture は createRecall で Invalid Date の createdAt を拒む（ADR 0480）", () => {
  it("拒み、記録も活動時計も進めない。有効な日付は受ける（陽性対照）", async () => {
    const memoryStore = new InMemoryMemoryStore();
    const settings = new InMemoryTenantSettingsStore(memoryStore.activitySeq);
    await expect(
      memoryStore.createRecall(ctx, record({ createdAt: new Date(Number.NaN) })),
    ).rejects.toThrow(/^createRecall: createdAt must be a valid Date \(got Invalid Date\)/);
    expect(await settings.getActivitySeq(ctx)).toBe(0);
    const id = await memoryStore.createRecall(
      ctx,
      record({ createdAt: new Date("2026-01-01T00:00:00.000Z") }),
    );
    expect(await memoryStore.getRecall(ctx, id)).not.toBeNull();
  });
});

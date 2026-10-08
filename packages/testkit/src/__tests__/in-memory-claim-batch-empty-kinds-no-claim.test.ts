import { describe, expect, it } from "vitest";
import type { Ctx, OutboxJobRecord } from "@mnemora/core";
import { InMemoryOutboxStore } from "../__fixtures__/in-memory-outbox-store.js";

/**
 * `ClaimOutboxJobsOptions.kinds` は「この種別のジョブだけを取る」。空配列は「どの種別も取らない」であって、「絞らない」（省略）ではない。
 * claim 可能なジョブを2件入れる。空配列を「絞らない」に倒す実装は、2件を claim して `attempts`・`claimedAt` を書き換える。
 * `@mnemora/core` の `tick-zero-limit-empty-kinds` と、`@mnemora/postgres` の `store-boundary-diff`（`claimBatch(kinds:[])`）と同じ約束を、
 * InMemory 単独で縛る。
 */

const ctx: Ctx = { tenantId: "tenant-1" };
const NOW = new Date("2026-01-01T00:00:00.000Z");
const SEEDED_AVAILABLE_AT = new Date("2025-12-30T00:00:00.000Z");

function job(id: string): OutboxJobRecord {
  return {
    id,
    tenantId: ctx.tenantId,
    kind: "extract",
    payload: {},
    availableAt: new Date(SEEDED_AVAILABLE_AT),
    claimedAt: null,
    claimedBy: null,
    attempts: 0,
    completedAt: null,
    failedAt: null,
    createdAt: new Date("2025-12-30T00:00:00.000Z"),
  };
}

describe("InMemoryOutboxStore.claimBatch: kinds が空配列なら何も claim せず、ジョブに触れない", () => {
  it("kinds: [] は空の配列を返し、積んだジョブの attempts・claimedAt・claimedBy・availableAt は変わらない", async () => {
    const jobs = [job("job-1"), job("job-2")];
    const store = new InMemoryOutboxStore(jobs);

    const claimed = await store.claimBatch(ctx, {
      kinds: [],
      limit: 10,
      now: NOW,
      claimedBy: "test-worker",
      leaseMs: 60_000,
    });

    expect(claimed).toEqual([]);
    for (const j of jobs) {
      expect(j.attempts).toBe(0);
      expect(j.claimedAt ?? null).toBeNull();
      expect(j.claimedBy ?? null).toBeNull();
      expect(j.availableAt).toEqual(SEEDED_AVAILABLE_AT);
    }
  });

  it("対照: kinds を省略すれば、同じ2件を claim できる（空配列が省略と同じ扱いでないことの前提）", async () => {
    const jobs = [job("job-1"), job("job-2")];
    const store = new InMemoryOutboxStore(jobs);

    await store.claimBatch(ctx, {
      kinds: [],
      limit: 10,
      now: NOW,
      claimedBy: "test-worker",
      leaseMs: 60_000,
    });
    const claimed = await store.claimBatch(ctx, {
      limit: 10,
      now: NOW,
      claimedBy: "test-worker",
      leaseMs: 60_000,
    });

    expect(claimed.map((j) => j.id).sort()).toEqual(["job-1", "job-2"]);
    expect(claimed.map((j) => j.attempts)).toEqual([1, 1]);
  });
});

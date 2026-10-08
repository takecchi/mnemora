import { describe, expect, it } from "vitest";
import type { Ctx, OutboxJobRecord } from "@mnemora/core";
import { InMemoryOutboxStore } from "../__fixtures__/in-memory-outbox-store.js";

/**
 * `ClaimOutboxJobsOptions.limit` は「0以上の整数を渡す前提」なので、0 は正当な入力である。
 * `@mnemora/postgres` は `LIMIT 0` で0件を返し、行に触れない（実測）。fixture も拒まずに同じ結果を返す。
 * claim 可能なジョブを2件入れる: 空の store では、0 を拒む実装も拒まない実装も同じ空配列になる。
 */

const ctx: Ctx = { tenantId: "tenant-1" };
const NOW = new Date("2026-01-01T00:00:00.000Z");

function job(id: string): OutboxJobRecord {
  return {
    id,
    tenantId: ctx.tenantId,
    kind: "extract",
    payload: {},
    availableAt: new Date("2025-12-30T00:00:00.000Z"),
    claimedAt: null,
    claimedBy: null,
    attempts: 0,
    completedAt: null,
    failedAt: null,
    createdAt: new Date("2025-12-30T00:00:00.000Z"),
  };
}

describe("InMemoryOutboxStore.claimBatch: limit 0 は拒まずに空配列を返し、ジョブに触れない", () => {
  it("claim できるジョブが在っても、limit: 0 は [] を返し、claimedAt・claimedBy・attempts は変わらない", async () => {
    const jobs = [job("job-1"), job("job-2")];
    const store = new InMemoryOutboxStore(jobs);

    const claimed = await store.claimBatch(ctx, {
      limit: 0,
      now: NOW,
      claimedBy: "test-worker",
      leaseMs: 60_000,
    });

    expect(claimed).toEqual([]);
    for (const j of jobs) {
      expect(j.claimedAt ?? null).toBeNull();
      expect(j.claimedBy ?? null).toBeNull();
      expect(j.attempts).toBe(0);
    }
  });
});

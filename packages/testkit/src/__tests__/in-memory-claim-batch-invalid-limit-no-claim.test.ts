import { describe, expect, it } from "vitest";
import type { Ctx, OutboxJobRecord } from "@mnemora/core";
import { InMemoryOutboxStore } from "../__fixtures__/in-memory-outbox-store.js";

/** claim 可能なジョブを2件入れる。空の store では検査が claim の前でも後ろでも同じ結果になる。`slice(0, -1)`・`slice(0, 1.5)` は1件を返すので、検査が claim の後ろへ動けば1件が claim 済みになる。 */

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

describe("InMemoryOutboxStore.claimBatch: 不正な limit は claim の前に拒み、ジョブに触れない", () => {
  it.each([-1, 1.5])(
    "limit: %j で拒んだあと、ジョブは claimedAt 未設定・attempts 0 のまま",
    async (limit) => {
      const jobs = [job("job-1"), job("job-2")];
      const store = new InMemoryOutboxStore(jobs);

      await expect(
        store.claimBatch(ctx, { limit, now: NOW, claimedBy: "test-worker", leaseMs: 60_000 }),
      ).rejects.toThrow(/limit must/);

      for (const j of jobs) {
        expect(j.claimedAt ?? null).toBeNull();
        expect(j.claimedBy ?? null).toBeNull();
        expect(j.attempts).toBe(0);
      }

      const claimed = await store.claimBatch(ctx, {
        limit: 2,
        now: NOW,
        claimedBy: "test-worker",
        leaseMs: 60_000,
      });
      expect(claimed).toHaveLength(2);
    },
  );
});

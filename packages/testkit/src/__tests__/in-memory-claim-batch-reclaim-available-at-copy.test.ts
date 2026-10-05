import { describe, expect, it } from "vitest";
import type { Ctx, OutboxJobRecord } from "@mnemora/core";
import { InMemoryOutboxStore } from "../__fixtures__/in-memory-outbox-store.js";

/**
 * `InMemoryOutboxStore.claimBatch` は取り直し（更新前の `claimedAt` が在る行）で `availableAt` を
 * `opts.now` に書き直す。書くのは呼び手が渡した `Date` そのものではなく、その写し。
 * `PostgresOutboxStore` は値を列へ書くので、呼び手があとで自分の `now` を書き換えても保存した行は動かない。
 * 同じ `Date` を保存すると、呼び手の書き換えが取り直された job の `availableAt` に漏れる。
 */

const ctx: Ctx = { tenantId: "tenant-1" };

describe("InMemoryOutboxStore.claimBatch: 取り直しで書く availableAt は opts.now の写し", () => {
  it("claim したあとで呼び手が now を書き換えても、保存した availableAt は動かない", async () => {
    const claimedBefore = new Date("2025-12-31T00:00:00.000Z");
    const job: OutboxJobRecord = {
      id: "job-1",
      tenantId: ctx.tenantId,
      kind: "extract",
      payload: {},
      availableAt: new Date("2025-12-30T00:00:00.000Z"),
      claimedAt: claimedBefore,
      claimedBy: "dead-worker",
      attempts: 1,
      completedAt: null,
      failedAt: null,
      createdAt: new Date("2025-12-30T00:00:00.000Z"),
    };
    const store = new InMemoryOutboxStore([job]);
    const now = new Date("2026-01-01T00:00:00.000Z");
    const nowAtCall = now.getTime();

    const claimed = await store.claimBatch(ctx, {
      limit: 1,
      now,
      claimedBy: "w",
      leaseMs: 60_000,
    });
    expect(claimed).toHaveLength(1);
    expect(job.availableAt.getTime()).toBe(nowAtCall);

    now.setTime(0);

    expect(job.availableAt.getTime()).toBe(nowAtCall);
    expect(job.claimedAt?.getTime()).toBe(nowAtCall);
  });
});

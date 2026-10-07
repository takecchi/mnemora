import { describe, expect, it } from "vitest";
import type { Ctx, OutboxJobRecord } from "@mnemora/core";
import { OutboxLeaseConflictError } from "@mnemora/core";
import { InMemoryOutboxStore } from "../__fixtures__/in-memory-outbox-store.js";

const ctx: Ctx = { tenantId: "tenant-1" };
const T1 = new Date("2026-02-01T00:00:00.000Z");
const T2 = new Date("2026-03-01T00:00:00.000Z");

function makeJob(overrides: Partial<OutboxJobRecord> = {}): OutboxJobRecord {
  return {
    id: "job-1",
    tenantId: ctx.tenantId,
    kind: "extract",
    payload: {},
    availableAt: new Date("2026-01-01T00:00:00.000Z"),
    attempts: 1,
    claimedAt: new Date("2026-01-01T00:00:00.000Z"),
    claimedBy: "worker-1",
    completedAt: null,
    failedAt: null,
    lastError: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("InMemoryOutboxStore.complete/fail — 先勝ち（ADR 0440）", () => {
  it("complete → complete: completedAt は1回目のまま、戻り値は undefined", async () => {
    const job = makeJob();
    const store = new InMemoryOutboxStore([job]);
    await store.complete(ctx, job.id, 1, { at: T1 });
    await expect(store.complete(ctx, job.id, 1, { at: T2 })).resolves.toBeUndefined();
    expect(job.completedAt).toEqual(T1);
    expect(job.failedAt).toBeNull();
    expect(job.lastError).toBeNull();
  });

  it("fail → fail: failedAt と lastError は1回目のまま、戻り値は undefined", async () => {
    const job = makeJob();
    const store = new InMemoryOutboxStore([job]);
    await store.fail(ctx, job.id, "first", 1, { at: T1 });
    await expect(store.fail(ctx, job.id, "second", 1, { at: T2 })).resolves.toBeUndefined();
    expect(job.failedAt).toEqual(T1);
    expect(job.lastError).toBe("first");
    expect(job.completedAt).toBeNull();
  });

  it("complete → fail: completed のまま（値は1回目）", async () => {
    const job = makeJob();
    const store = new InMemoryOutboxStore([job]);
    await store.complete(ctx, job.id, 1, { at: T1 });
    await expect(store.fail(ctx, job.id, "late", 1, { at: T2 })).resolves.toBeUndefined();
    expect(job.completedAt).toEqual(T1);
    expect(job.failedAt).toBeNull();
    expect(job.lastError).toBeNull();
  });

  it("fail → complete: failed のまま（値は1回目）", async () => {
    const job = makeJob();
    const store = new InMemoryOutboxStore([job]);
    await store.fail(ctx, job.id, "first", 1, { at: T1 });
    await expect(store.complete(ctx, job.id, 1, { at: T2 })).resolves.toBeUndefined();
    expect(job.failedAt).toEqual(T1);
    expect(job.lastError).toBe("first");
    expect(job.completedAt).toBeNull();
  });

  it("purgeCompletedJobs の境界は1回目の completedAt で決まる（T1 < olderThan < T2）", async () => {
    const job = makeJob();
    const store = new InMemoryOutboxStore([job]);
    await store.complete(ctx, job.id, 1, { at: T1 });
    await store.complete(ctx, job.id, 1, { at: T2 });
    const olderThan = new Date("2026-02-15T00:00:00.000Z");
    const dry = await store.purgeCompletedJobs(ctx, { olderThan, limit: 10, dryRun: true });
    expect(dry.purged).toBe(1);
    expect(dry.oldestPurgedAt).toEqual(T1);
    const boundary = await store.purgeCompletedJobs(ctx, {
      olderThan: T1,
      limit: 10,
      dryRun: true,
    });
    expect(boundary.purged).toBe(0);
    const real = await store.purgeCompletedJobs(ctx, { olderThan, limit: 10 });
    expect(real).toMatchObject({ purged: 1, oldestPurgedAt: T1, newestPurgedAt: T1 });
  });

  it("終端後の claimBatch は0件（直す前と同じ）", async () => {
    const job = makeJob();
    const store = new InMemoryOutboxStore([job]);
    await store.complete(ctx, job.id, 1, { at: T1 });
    await store.complete(ctx, job.id, 1, { at: T2 });
    const claimed = await store.claimBatch(ctx, {
      limit: 10,
      now: new Date("2027-01-01T00:00:00.000Z"),
      claimedBy: "w2",
      leaseMs: 1,
    });
    expect(claimed).toHaveLength(0);
  });

  it("例外は直す前と同じ: attempts 不一致は終端後でも OutboxLeaseConflictError、行が無ければ no-op", async () => {
    const job = makeJob({ attempts: 2 });
    const store = new InMemoryOutboxStore([job]);
    await store.complete(ctx, job.id, 2, { at: T1 });
    await expect(store.complete(ctx, job.id, 1, { at: T2 })).rejects.toBeInstanceOf(
      OutboxLeaseConflictError,
    );
    await expect(store.fail(ctx, job.id, "x", 1, { at: T2 })).rejects.toBeInstanceOf(
      OutboxLeaseConflictError,
    );
    expect(job.completedAt).toEqual(T1);
    await expect(store.complete(ctx, "nope", 0)).resolves.toBeUndefined();
    await expect(store.fail(ctx, "nope", "x", 0)).resolves.toBeUndefined();
  });

  it("最初の終端は今までどおり付く（at 省略で壁時計、NUL は置換）", async () => {
    const job = makeJob();
    const store = new InMemoryOutboxStore([job]);
    await store.fail(ctx, job.id, "a\u0000b", 1);
    expect(job.failedAt).toBeInstanceOf(Date);
    expect(job.lastError).toBe("a\\u0000b");
    const job2 = makeJob({ id: "job-2" });
    const store2 = new InMemoryOutboxStore([job2]);
    await store2.complete(ctx, job2.id, 1);
    expect(job2.completedAt).toBeInstanceOf(Date);
  });
});

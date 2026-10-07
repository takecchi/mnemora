import { describe, expect, it } from "vitest";
import type { Ctx, OutboxJobRecord } from "@mnemora/core";
import { OutboxLeaseConflictError } from "@mnemora/core";
import { InMemoryOutboxStore } from "../__fixtures__/in-memory-outbox-store.js";

const ctx: Ctx = { tenantId: "tenant-1" };

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

describe("InMemoryOutboxStore.complete/fail — 相手側の終端が既に付いていたら、後から来た呼び出しは行を変えない（Issue #826）", () => {
  it("逐次: complete → fail（同じ attempts）— completed のまま、failedAt/lastError は null", async () => {
    const job = makeJob();
    const store = new InMemoryOutboxStore([job]);

    await store.complete(ctx, job.id, job.attempts);
    await expect(
      store.fail(ctx, job.id, "should-not-be-recorded", job.attempts),
    ).resolves.not.toThrow();

    expect(job.completedAt).not.toBeNull();
    expect(job.failedAt).toBeNull();
    expect(job.lastError).toBeNull();
  });

  it("逐次: fail → complete（同じ attempts）— failed のまま、completedAt は null", async () => {
    const job = makeJob();
    const store = new InMemoryOutboxStore([job]);

    await store.fail(ctx, job.id, "boom", job.attempts);
    await expect(store.complete(ctx, job.id, job.attempts)).resolves.not.toThrow();

    expect(job.failedAt).not.toBeNull();
    expect(job.lastError).toBe("boom");
    expect(job.completedAt).toBeNull();
  });

  it("同種の再呼び出し（complete → complete）は例外にならず、completedAt は1回目のまま（先勝ち、ADR 0440）", async () => {
    const job = makeJob();
    const store = new InMemoryOutboxStore([job]);
    const first = new Date("2026-02-01T00:00:00.000Z");

    await store.complete(ctx, job.id, job.attempts, { at: first });
    await expect(
      store.complete(ctx, job.id, job.attempts, { at: new Date("2026-03-01T00:00:00.000Z") }),
    ).resolves.not.toThrow();

    expect(job.completedAt).toEqual(first);
    expect(job.failedAt).toBeNull();
  });

  it("同種の再呼び出し（fail → fail）は例外にならず、failedAt と lastError は1回目のまま（先勝ち、ADR 0440）", async () => {
    const job = makeJob();
    const store = new InMemoryOutboxStore([job]);
    const first = new Date("2026-02-01T00:00:00.000Z");

    await store.fail(ctx, job.id, "first-error", job.attempts, { at: first });
    await expect(
      store.fail(ctx, job.id, "second-error", job.attempts, {
        at: new Date("2026-03-01T00:00:00.000Z"),
      }),
    ).resolves.not.toThrow();

    expect(job.failedAt).toEqual(first);
    expect(job.completedAt).toBeNull();
    expect(job.lastError).toBe("first-error");
  });

  it("取り直した後（attempts が2以上）の正当な complete・fail は、終端を付ける（黙って返さない）", async () => {
    const at = new Date("2026-02-01T00:00:00.000Z");
    const completing = makeJob({ attempts: 2 });
    const failing = makeJob({ id: "job-2", attempts: 3 });
    const store = new InMemoryOutboxStore([completing, failing]);

    await store.complete(ctx, completing.id, 2, { at });
    expect(completing.completedAt).toEqual(at);
    expect(completing.failedAt).toBeNull();

    await store.fail(ctx, failing.id, "second-claim-error", 3, { at });
    expect(failing.failedAt).toEqual(at);
    expect(failing.lastError).toBe("second-claim-error");
    expect(failing.completedAt).toBeNull();
  });

  it("attempts が不一致なら、相手側の終端の有無に関わらず OutboxLeaseConflictError を投げる（既存契約）", async () => {
    const job = makeJob({ attempts: 2 });
    const store = new InMemoryOutboxStore([job]);

    await expect(store.complete(ctx, job.id, 1)).rejects.toBeInstanceOf(OutboxLeaseConflictError);
    expect(job.completedAt).toBeNull();

    await expect(store.fail(ctx, job.id, "boom", 1)).rejects.toBeInstanceOf(
      OutboxLeaseConflictError,
    );
    expect(job.failedAt).toBeNull();
  });

  it("行が無いジョブ id は no-op のまま（既存契約）", async () => {
    const store = new InMemoryOutboxStore([]);
    await expect(store.complete(ctx, "does-not-exist", 0)).resolves.not.toThrow();
    await expect(store.fail(ctx, "does-not-exist", "boom", 0)).resolves.not.toThrow();
  });
});

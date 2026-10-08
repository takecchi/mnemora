import { describe, expect, it } from "vitest";
import type { Ctx, OutboxJobRecord } from "@mnemora/core";
import { InMemoryOutboxStore } from "../__fixtures__/in-memory-outbox-store.js";

/**
 * ADR 0521: `complete`・`fail` に大文字の jobId を渡しても、`@mnemora/postgres`（uuid 型の列で比べる）と同じく
 * その行に終端が付く。fixture が綴りどおりに引くと、終端が付かずにリースが切れたあと再 claim される。
 */

const ctx: Ctx = { tenantId: "tenant-1" };
const JOB_ID = "0f6b8a2c-3d4e-4f50-8a1b-2c3d4e5f6a7b";
const NOW = new Date("2026-01-01T00:00:00.000Z");
const LEASE_MS = 60_000;

function job(): OutboxJobRecord {
  return {
    id: JOB_ID,
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

async function claimOne(store: InMemoryOutboxStore, now: Date): Promise<OutboxJobRecord[]> {
  return store.claimBatch(ctx, { limit: 10, now, claimedBy: "test-worker", leaseMs: LEASE_MS });
}

describe("InMemoryOutboxStore.complete/fail: 大文字の jobId でも終端が付き、リースが切れても再 claim されない", () => {
  it("complete(大文字の jobId) で completedAt が付く", async () => {
    const jobs = [job()];
    const store = new InMemoryOutboxStore(jobs);
    const [claimed] = await claimOne(store, NOW);

    await store.complete(ctx, JOB_ID.toUpperCase(), claimed!.attempts, { at: NOW });

    expect(jobs[0]!.completedAt).toEqual(NOW);
    expect(jobs[0]!.failedAt ?? null).toBeNull();
    expect(await claimOne(store, new Date(NOW.getTime() + LEASE_MS))).toEqual([]);
  });

  it("fail(大文字の jobId) で failedAt と lastError が付く", async () => {
    const jobs = [job()];
    const store = new InMemoryOutboxStore(jobs);
    const [claimed] = await claimOne(store, NOW);

    await store.fail(ctx, JOB_ID.toUpperCase(), "boom", claimed!.attempts, { at: NOW });

    expect(jobs[0]!.failedAt).toEqual(NOW);
    expect(jobs[0]!.lastError).toBe("boom");
    expect(jobs[0]!.completedAt ?? null).toBeNull();
    expect(await claimOne(store, new Date(NOW.getTime() + LEASE_MS))).toEqual([]);
  });
});

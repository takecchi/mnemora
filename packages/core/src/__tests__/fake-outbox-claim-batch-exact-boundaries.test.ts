import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { OutboxJobRecord } from "../outbox.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * `FakeOutboxStore.claimBatch` が、`OutboxStore` の TSDoc の境界をちょうどの時刻で守ることを縛る。
 * 振る舞いは変えていない。
 *
 * - `available_at <= now` のものに限る——**`available_at == now` の行は取れる**。
 * - リースの切れた（`claimed_at <= now - leaseMs`）行も返す——**リースがちょうど切れた瞬間の行は取れる**。
 *
 * postgres と testkit の fixture は `outbox-store-conformance.ts` の「リースが切れた claim 済みの行は再び claim
 * される」がこの2点を当てている。core の Fake は適合試験を走らないので、ここで同じ2点を当てる。
 */

const ctx: Ctx = { tenantId: "tenant-1" };
const BASE = new Date("2026-01-01T00:00:00.000Z");
const LEASE_MS = 1000;

async function seed(): Promise<{
  outboxStore: ReturnType<typeof createFakeRuntimeStores>["outboxStore"];
  jobId: string;
}> {
  const { memoryStore, outboxStore } = createFakeRuntimeStores();
  const { jobs } = await memoryStore.createObservationWithOutbox(
    ctx,
    {
      tenantId: ctx.tenantId,
      subjectId: null,
      externalId: null,
      kind: "utterance",
      payload: { text: "x" },
    },
    ["extract"],
  );
  const backing = (outboxStore as unknown as { backing: { outboxJobs: OutboxJobRecord[] } })
    .backing;
  const job = backing.outboxJobs.find((j) => j.id === jobs[0]!.id)!;
  job.availableAt = BASE;
  return { outboxStore, jobId: job.id };
}

describe("FakeOutboxStore.claimBatch: 境界ちょうどの時刻", () => {
  it("available_at == now の行は claim できる", async () => {
    const { outboxStore, jobId } = await seed();

    const claimed = await outboxStore.claimBatch(ctx, {
      limit: 10,
      now: BASE,
      claimedBy: "worker-1",
      leaseMs: LEASE_MS,
    });

    expect(claimed.map((j) => j.id)).toEqual([jobId]);
  });

  it("リースがちょうど切れた瞬間（claimed_at == now - leaseMs）の行は再び claim でき、1ms 手前では取れない", async () => {
    const { outboxStore, jobId } = await seed();
    await outboxStore.claimBatch(ctx, {
      limit: 10,
      now: BASE,
      claimedBy: "worker-1",
      leaseMs: LEASE_MS,
    });

    const beforeExpiry = await outboxStore.claimBatch(ctx, {
      limit: 10,
      now: new Date(BASE.getTime() + LEASE_MS - 1),
      claimedBy: "worker-2",
      leaseMs: LEASE_MS,
    });
    const atExpiry = await outboxStore.claimBatch(ctx, {
      limit: 10,
      now: new Date(BASE.getTime() + LEASE_MS),
      claimedBy: "worker-2",
      leaseMs: LEASE_MS,
    });

    expect({
      beforeExpiry: beforeExpiry.map((j) => j.id),
      atExpiry: atExpiry.map((j) => ({ id: j.id, attempts: j.attempts })),
    }).toEqual({
      beforeExpiry: [],
      atExpiry: [{ id: jobId, attempts: 2 }],
    });
  });
});

import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import { OutboxLeaseConflictError } from "../interfaces/outbox-store.js";
import type { NewMemory } from "../memory.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

const ctx: Ctx = { tenantId: "tenant-1" };
const otherCtx: Ctx = { tenantId: "tenant-2" };
const AT = new Date("2026-02-01T00:00:00.000Z");

function newMemory(n: number): NewMemory {
  return {
    tenantId: ctx.tenantId,
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: `本文${n}`,
    contentHash: `hash-${n}`,
    digest: "digest",
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: [],
    occurredAt: null,
    recordedAt: new Date("2020-01-01T00:00:00.000Z"),
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 720,
    decayFloorAt: new Date("2030-01-01T00:00:00.000Z"),
    embeddingStatus: "pending",
  };
}

async function seedClaimedJobs(count: number) {
  const stores = createFakeRuntimeStores();
  for (let i = 0; i < count; i++) {
    await stores.memoryStore.createMemoryWithOutbox(ctx, newMemory(i), ["embed"]);
  }
  const jobs = await stores.outboxStore.claimBatch(ctx, {
    limit: count,
    now: new Date(Date.now() + 10_000_000),
    claimedBy: "w",
    leaseMs: 60_000,
  });
  return { outboxStore: stores.outboxStore, jobs };
}

type Store = Awaited<ReturnType<typeof seedClaimedJobs>>["outboxStore"];
type Terminate = (store: Store, c: Ctx, id: string, attempts: number) => Promise<void>;
const TERMINATES: [string, Terminate][] = [
  ["complete", (store, c, id, attempts) => store.complete(c, id, attempts, { at: AT })],
  ["fail", (store, c, id, attempts) => store.fail(c, id, "boom", attempts, { at: AT })],
];

describe("FakeOutboxStore.complete/fail — CAS で弾いたとき・通したときに、触れる行と列", () => {
  for (const [how, terminate] of TERMINATES) {
    for (const [label, delta] of [
      ["小さい", -1],
      ["大きい", 1],
    ] as const) {
      it(`${how}: expectedAttempts が行の attempts より${label}と OutboxLeaseConflictError を投げ、行は1列も変わらない`, async () => {
        const { outboxStore, jobs } = await seedClaimedJobs(1);
        const job = jobs[0]!;
        const before = outboxStore.listJobs(ctx);

        await expect(
          terminate(outboxStore, ctx, job.id, job.attempts + delta),
        ).rejects.toBeInstanceOf(OutboxLeaseConflictError);

        expect(outboxStore.listJobs(ctx)).toEqual(before);
      });
    }

    it(`${how}: 別テナントの ctx からは、同じ id・同じ attempts でも行に触れず、例外も投げない`, async () => {
      const { outboxStore, jobs } = await seedClaimedJobs(1);
      const job = jobs[0]!;
      const before = outboxStore.listJobs(ctx);

      await expect(terminate(outboxStore, otherCtx, job.id, job.attempts)).resolves.toBeUndefined();
      await expect(
        terminate(outboxStore, otherCtx, job.id, job.attempts + 1),
      ).resolves.toBeUndefined();

      expect(outboxStore.listJobs(ctx)).toEqual(before);
    });

    it(`${how}: 同じテナントの、同じ attempts の別のジョブには終端を付けない`, async () => {
      const { outboxStore, jobs } = await seedClaimedJobs(2);
      const [other, target] = jobs as [(typeof jobs)[number], (typeof jobs)[number]];
      expect(other.attempts).toBe(target.attempts);

      await terminate(outboxStore, ctx, target.id, target.attempts);

      const otherAfter = outboxStore.listJobs(ctx).find((j) => j.id === other.id)!;
      expect(otherAfter.completedAt).toBeNull();
      expect(otherAfter.failedAt).toBeNull();
    });
  }

  it("終端が付いた行に attempts 違いで complete/fail を呼ぶと、complete 済みでも fail 済みでも OutboxLeaseConflictError を投げる", async () => {
    for (const [first, second] of [
      [TERMINATES[0]!, TERMINATES[1]!],
      [TERMINATES[1]!, TERMINATES[0]!],
    ] as const) {
      const { outboxStore, jobs } = await seedClaimedJobs(1);
      const job = jobs[0]!;
      await first[1](outboxStore, ctx, job.id, job.attempts);
      const before = outboxStore.listJobs(ctx);

      await expect(second[1](outboxStore, ctx, job.id, job.attempts + 1)).rejects.toBeInstanceOf(
        OutboxLeaseConflictError,
      );

      expect(outboxStore.listJobs(ctx)).toEqual(before);
    }
  });
});

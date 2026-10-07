import { describe, expect, it } from "vitest";
import type { Ctx, OutboxJobRecord } from "@mnemora/core";
import { OutboxLeaseConflictError } from "@mnemora/core";
import { InMemoryOutboxStore } from "../__fixtures__/in-memory-outbox-store.js";

const ctx: Ctx = { tenantId: "tenant-1" };
const AT = new Date("2026-02-01T00:00:00.000Z");

function makeJob(overrides: Partial<OutboxJobRecord> = {}): OutboxJobRecord {
  return {
    id: "job-1",
    tenantId: ctx.tenantId,
    kind: "extract",
    payload: { observationId: "obs-1" },
    availableAt: new Date("2026-01-01T00:00:00.000Z"),
    attempts: 2,
    claimedAt: new Date("2026-01-01T00:00:00.000Z"),
    claimedBy: "worker-1",
    completedAt: null,
    failedAt: null,
    lastError: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

type Terminate = (store: InMemoryOutboxStore, id: string, attempts: number) => Promise<void>;
const TERMINATES: [string, Terminate][] = [
  ["complete", (store, id, attempts) => store.complete(ctx, id, attempts, { at: AT })],
  ["fail", (store, id, attempts) => store.fail(ctx, id, "boom", attempts, { at: AT })],
];

describe("InMemoryOutboxStore.complete/fail — CAS で弾いたとき・通したときに、触れる行と列", () => {
  for (const [how, terminate] of TERMINATES) {
    for (const [label, wrongAttempts] of [
      ["行より小さい", 1],
      ["行より大きい", 3],
    ] as const) {
      it(`${how}: expectedAttempts が行の attempts より${label}と OutboxLeaseConflictError を投げ、行は1列も変わらない`, async () => {
        const job = makeJob();
        const before = structuredClone(job);
        const store = new InMemoryOutboxStore([job]);

        await expect(terminate(store, job.id, wrongAttempts)).rejects.toBeInstanceOf(
          OutboxLeaseConflictError,
        );

        expect(job).toEqual(before);
      });
    }

    it(`${how}: 同じテナントの、同じ attempts の別のジョブには終端を付けない`, async () => {
      const other = makeJob({ id: "job-1" });
      const target = makeJob({ id: "job-2" });
      const otherBefore = structuredClone(other);
      const store = new InMemoryOutboxStore([other, target]);

      await terminate(store, target.id, target.attempts);

      expect(other).toEqual(otherBefore);
    });
  }

  it("complete は completedAt だけを書き、ほかの列は変えない", async () => {
    const job = makeJob();
    const before = structuredClone(job);
    const store = new InMemoryOutboxStore([job]);

    await store.complete(ctx, job.id, job.attempts, { at: AT });

    expect(job).toEqual({ ...before, completedAt: AT });
  });

  it("fail は failedAt と lastError だけを書き、ほかの列は変えない", async () => {
    const job = makeJob();
    const before = structuredClone(job);
    const store = new InMemoryOutboxStore([job]);

    await store.fail(ctx, job.id, "boom", job.attempts, { at: AT });

    expect(job).toEqual({ ...before, failedAt: AT, lastError: "boom" });
  });
});

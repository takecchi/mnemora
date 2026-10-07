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

  // 再確かめ（2026-10-07 マージ分、#1885）。#1885 は「ほかの列は変えない」の歯を、約束ではないとして外した。
  // ただし `OutboxStore.fail` の doc は「available_at の再計算はしない」と約束している。その1列だけを縛る。
  it("fail は availableAt を再計算しない（interface の doc の約束）", async () => {
    const job = makeJob();
    const before = new Date(job.availableAt);
    const store = new InMemoryOutboxStore([job]);

    await store.fail(ctx, job.id, "boom", job.attempts, { at: AT });

    expect(job.failedAt).toEqual(AT);
    expect(job.availableAt).toEqual(before);
  });
});

import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemory } from "../memory.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

const ctx: Ctx = { tenantId: "tenant-1" };
const FLOOR_MS = Date.UTC(-4713, 10, 24);
const BELOW = new Date(FLOOR_MS - 1);
const FLOOR = new Date(FLOOR_MS);
const ABSENT = "11111111-1111-4111-8111-111111111111";

function newMemory(): NewMemory {
  return {
    tenantId: ctx.tenantId,
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: "本文",
    contentHash: "hash-floor",
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

async function seedClaimedJob() {
  const stores = createFakeRuntimeStores();
  await stores.memoryStore.createMemoryWithOutbox(ctx, newMemory(), ["embed"]);
  const [job] = await stores.outboxStore.claimBatch(ctx, {
    limit: 1,
    now: new Date(Date.now() + 10_000_000),
    claimedBy: "w",
    leaseMs: 60_000,
  });
  return { outboxStore: stores.outboxStore, job: job! };
}

describe("FakeOutboxStore.complete・fail: opts.at が timestamptz の下限より前なら RangeError で断る", () => {
  for (const how of ["complete", "fail"] as const) {
    for (const [label, jobId] of [
      ["形の崩れた jobId", "does-not-exist"],
      ["uuid の形だが存在しない jobId", ABSENT],
      ["実在の jobId", undefined],
    ] as const) {
      it(`${how}: ${label} でも断り、行に触れない`, async () => {
        const { outboxStore, job } = await seedClaimedJob();
        const id = jobId ?? job.id;

        const call =
          how === "complete"
            ? outboxStore.complete(ctx, id, job.attempts, { at: BELOW })
            : outboxStore.fail(ctx, id, "boom", job.attempts, { at: BELOW });
        await expect(call).rejects.toThrow(RangeError);
        await expect(call).rejects.toThrow(
          `${how}: opts.at must not be earlier than 4714-11-24 BC (the lower bound of a Postgres timestamptz)`,
        );

        const [after] = await outboxStore.listJobs(ctx);
        expect(after?.completedAt ?? null).toBeNull();
        expect(after?.failedAt ?? null).toBeNull();
      });
    }

    it(`${how}: 下限ちょうどは通り、その値を書く（対照）`, async () => {
      const { outboxStore, job } = await seedClaimedJob();

      await (how === "complete"
        ? outboxStore.complete(ctx, job.id, job.attempts, { at: FLOOR })
        : outboxStore.fail(ctx, job.id, "boom", job.attempts, { at: FLOOR }));

      const [after] = await outboxStore.listJobs(ctx);
      expect(how === "complete" ? after?.completedAt : after?.failedAt).toEqual(FLOOR);
    });

    // 下限ちょうどの1点だけでは、断りすぎる実装を縛れない。紀元前でも西暦9999年より後でも通ることを見る。
    for (const [label, at] of [
      ["紀元前100年", new Date(Date.UTC(-99, 0, 1))],
      ["西暦10000年", new Date(Date.UTC(10000, 0, 1))],
    ] as const) {
      it(`${how}: ${label}（timestamptz の範囲内）は通り、その値を書く`, async () => {
        const { outboxStore, job } = await seedClaimedJob();

        await (how === "complete"
          ? outboxStore.complete(ctx, job.id, job.attempts, { at })
          : outboxStore.fail(ctx, job.id, "boom", job.attempts, { at }));

        const [after] = await outboxStore.listJobs(ctx);
        expect(how === "complete" ? after?.completedAt : after?.failedAt).toEqual(at);
      });
    }
  }
});

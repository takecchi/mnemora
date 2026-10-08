import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import { OutboxLeaseConflictError } from "../interfaces/outbox-store.js";
import type { NewMemory } from "../memory.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

// `OutboxStore.complete` の doc: UUID 形式の `jobId` は大文字小文字を区別しない。`fail` も同じ。
// conformance suite の同じ歯は jobId が UUID 形式でない adapter では skip するので、Fake の jobId（`job-N`）を
// Postgres が発行する形（小文字の UUID）に置き換えてから測る。

const ctx: Ctx = { tenantId: "tenant-1" };
const AT = new Date("2026-02-01T00:00:00.000Z");

const newMemory: NewMemory = {
  tenantId: ctx.tenantId,
  subjectId: null,
  sourceObservationId: null,
  extractorVersion: null,
  content: "本文",
  contentHash: "hash-uuid-upper",
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

async function seedClaimedUuidJob() {
  const stores = createFakeRuntimeStores();
  await stores.memoryStore.createMemoryWithOutbox(ctx, newMemory, ["embed"]);
  const outboxJobs = (
    stores.outboxStore as unknown as { backing: { outboxJobs: { id: string }[] } }
  ).backing.outboxJobs;
  const uuid = randomUUID();
  outboxJobs[0]!.id = uuid;
  const [job] = await stores.outboxStore.claimBatch(ctx, {
    limit: 1,
    now: new Date(Date.now() + 10_000_000),
    claimedBy: "w",
    leaseMs: 60_000,
  });
  expect(job?.id).toBe(uuid);
  return { outboxStore: stores.outboxStore, job: job! };
}

type Store = Awaited<ReturnType<typeof seedClaimedUuidJob>>["outboxStore"];
type Terminate = (store: Store, id: string, attempts: number) => Promise<void>;
const TERMINATES: [string, Terminate][] = [
  ["complete", (store, id, attempts) => store.complete(ctx, id, attempts, { at: AT })],
  ["fail", (store, id, attempts) => store.fail(ctx, id, "boom", attempts, { at: AT })],
];

describe("FakeOutboxStore.complete/fail — UUID 形式の jobId は大文字で渡しても同じジョブに当たる", () => {
  for (const [how, terminate] of TERMINATES) {
    it(`${how}: 大文字の jobId でも、同じジョブの attempts を見て CAS し、終端を付ける`, async () => {
      const { outboxStore, job } = await seedClaimedUuidJob();
      const upperId = job.id.toUpperCase();

      await expect(terminate(outboxStore, upperId, job.attempts - 1)).rejects.toBeInstanceOf(
        OutboxLeaseConflictError,
      );

      await terminate(outboxStore, upperId, job.attempts);

      const [row] = outboxStore.listJobs(ctx);
      expect(row?.id).toBe(job.id);
      expect(how === "complete" ? row?.completedAt : row?.failedAt).toEqual(AT);
    });
  }
});

import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import type { NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

const ctx: Ctx = { tenantId: "tenant-1" };
const T0 = Date.now() + 60_000;
const LEASE_MS = 1000;
const CUSTOM_KIND = "gurumi-chan:notify-slack";

const notUsedLlm: LLMProvider = {
  complete: async () => {
    throw new Error("not used");
  },
  completeStructured: async () => {
    throw new Error("not used");
  },
};

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
    recordedAt: new Date(T0),
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 24,
    decayFloorAt: new Date("2100-01-01T00:00:00.000Z"),
    embeddingStatus: "pending",
  };
}

/**
 * 1本目は一度 claim されてリースが切れている（attempts 2 で再 claim される）。2本目は初めての claim（attempts 1）。
 * 同じ tick が両方を1バッチで取るので、2本の `attempts` が違う。
 */
async function setup(kind: "embed" | typeof CUSTOM_KIND) {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: notUsedLlm,
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => new Date(T0 + LEASE_MS) },
  });
  for (let i = 0; i < 2; i++) {
    if (kind === "embed") {
      await stores.memoryStore.createMemoryWithOutbox(ctx, newMemory(i), ["embed"]);
    } else {
      await stores.memoryStore.createObservationWithOutbox(
        ctx,
        {
          tenantId: ctx.tenantId,
          subjectId: null,
          externalId: null,
          kind: "utterance",
          payload: {},
        },
        [kind],
      );
    }
  }
  await stores.outboxStore.claimBatch(ctx, {
    limit: 1,
    now: new Date(T0),
    claimedBy: "earlier-worker",
    leaseMs: LEASE_MS,
  });
  return { runtime, stores };
}

describe("tick — complete/fail には、そのジョブ自身の claim の attempts を渡す", () => {
  it("バッチの中に attempts の違うジョブが混ざっていても、全部 complete され、leaseConflicts は空", async () => {
    const { runtime, stores } = await setup("embed");

    const result = await runtime.tick(ctx, { leaseMs: LEASE_MS, claimedBy: "w" });

    expect(result).toEqual({ processed: 2, failed: 0, unsupported: [], leaseConflicts: [] });
    const jobs = stores.outboxStore.listJobs(ctx);
    expect(jobs.map((j) => j.attempts).sort()).toEqual([1, 2]);
    expect(jobs.every((j) => j.completedAt !== null && j.failedAt === null)).toBe(true);
  });

  it("handler が失敗したジョブも、attempts の違うジョブが混ざっていて全部 fail され、leaseConflicts は空", async () => {
    const { runtime, stores } = await setup("embed");
    stores.embeddingProvider.shouldFail = true;

    const result = await runtime.tick(ctx, { leaseMs: LEASE_MS, claimedBy: "w" });

    expect(result).toEqual({ processed: 0, failed: 2, unsupported: [], leaseConflicts: [] });
    const jobs = stores.outboxStore.listJobs(ctx);
    expect(jobs.map((j) => j.attempts).sort()).toEqual([1, 2]);
    expect(jobs.every((j) => j.failedAt !== null && j.completedAt === null)).toBe(true);
  });

  it("対応していない kind のジョブも、attempts の違うジョブが混ざっていて全部 fail され、leaseConflicts は空", async () => {
    const { runtime, stores } = await setup(CUSTOM_KIND);

    const result = await runtime.tick(ctx, {
      kinds: [CUSTOM_KIND],
      leaseMs: LEASE_MS,
      claimedBy: "w",
    });

    expect(result.unsupported.map((u) => u.kind)).toEqual([CUSTOM_KIND, CUSTOM_KIND]);
    expect(result.failed).toBe(2);
    expect(result.leaseConflicts).toEqual([]);
    const jobs = stores.outboxStore.listJobs(ctx);
    expect(jobs.map((j) => j.attempts).sort()).toEqual([1, 2]);
    expect(jobs.every((j) => j.failedAt !== null)).toBe(true);
  });
});

describe("tick — リース競合ではない fail() の例外は握らず、呼び出し側へ投げる", () => {
  it("対応していない kind のジョブを fail() しようとして DB が落ちたら、tick は reject し、leaseConflicts に載せない", async () => {
    const { runtime, stores } = await setup(CUSTOM_KIND);
    stores.outboxStore.fail = async () => {
      throw new Error("db down");
    };

    await expect(
      runtime.tick(ctx, { kinds: [CUSTOM_KIND], leaseMs: LEASE_MS, claimedBy: "w" }),
    ).rejects.toThrow("db down");
  });
});

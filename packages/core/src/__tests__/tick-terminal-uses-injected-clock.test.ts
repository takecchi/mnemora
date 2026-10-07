import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import type { NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

// 壁時計と違う時刻の時計を注入して見分ける（省くと store が壁時計で埋めるため）。
// 失敗の終端は2か所ある（handler が投げた失敗と、対応していない kind）。どちらも見る。

const ctx: Ctx = { tenantId: "tenant-1" };
/** 壁時計（いま）より十分に未来。claim の対象（`availableAt <= now`）にはなる。 */
const CLOCK_AT = new Date("2041-03-04T05:06:07.000Z");

const notUsedLlm: LLMProvider = {
  complete: async () => {
    throw new Error("not used");
  },
  completeStructured: async () => {
    throw new Error("not used");
  },
};

function newMemory(): NewMemory {
  const recordedAt = CLOCK_AT;
  return {
    tenantId: "tenant-1",
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: "本文",
    contentHash: "hash-1",
    digest: "digest",
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: [],
    occurredAt: null,
    recordedAt,
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 24,
    decayFloorAt: defaultDecayStrategy.floorAt({
      recordedAt,
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours: 24,
    }),
    embeddingStatus: "pending",
  };
}

function build() {
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
    clock: { now: () => CLOCK_AT },
  });
  return { stores, runtime };
}

describe("runtime が outbox に書く時刻は、注入した時計の値（tick の終端・reembed の積み直し）", () => {
  it("handler が成功したジョブの completedAt", async () => {
    const { stores, runtime } = build();
    await stores.memoryStore.createMemoryWithOutbox(ctx, newMemory(), ["embed"]);

    const result = await runtime.tick(ctx, { leaseMs: 60_000 });

    expect(result.processed).toBe(1);
    const [job] = stores.outboxStore.listJobs(ctx);
    expect(job?.completedAt).toEqual(CLOCK_AT);
  });

  it("handler が投げて失敗したジョブの failedAt", async () => {
    const { stores, runtime } = build();
    await stores.memoryStore.createMemoryWithOutbox(ctx, newMemory(), ["embed"]);
    stores.memoryStore.setEmbeddingStatus = async () => {
      throw new Error("transient: connection reset");
    };

    const result = await runtime.tick(ctx, { leaseMs: 60_000 });

    expect(result).toMatchObject({ processed: 0, failed: 1 });
    const [job] = stores.outboxStore.listJobs(ctx);
    expect(job?.failedAt).toEqual(CLOCK_AT);
  });

  it("reembed が積み直した embed ジョブの availableAt・createdAt（終端ではなく、同じ時計の別の口）", async () => {
    const { stores, runtime } = build();
    const { memory } = await stores.memoryStore.createMemoryWithOutbox(ctx, newMemory(), ["embed"]);
    await stores.memoryStore.setEmbeddingStatus(ctx, memory.id, "failed");
    const before = stores.outboxStore.listJobs(ctx).length;

    const result = await runtime.reembed(ctx, { statuses: ["failed"], limit: 10 });

    expect(result.requeued).toBe(1);
    const jobs = stores.outboxStore.listJobs(ctx);
    expect(jobs).toHaveLength(before + 1);
    const atClock = jobs.filter((job) => job.availableAt.getTime() === CLOCK_AT.getTime());
    expect(atClock).toHaveLength(1);
    expect(atClock[0]?.createdAt).toEqual(CLOCK_AT);
  });

  it("対応していない kind のジョブの failedAt", async () => {
    const { stores, runtime } = build();
    const kind = "gurumi-chan:notify-slack";
    await stores.memoryStore.createObservationWithOutbox(
      ctx,
      { tenantId: "tenant-1", subjectId: null, externalId: null, kind: "utterance", payload: {} },
      [kind],
    );

    const result = await runtime.tick(ctx, { kinds: [kind], leaseMs: 60_000 });

    expect(result.unsupported).toHaveLength(1);
    const [job] = stores.outboxStore.listJobs(ctx);
    expect(job?.failedAt).toEqual(CLOCK_AT);
  });
});

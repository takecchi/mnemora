import { describe, expect, it, vi } from "vitest";
import type { Ctx } from "../ctx.js";
import type { EmbeddingProvider } from "../interfaces/embedding-provider.js";
import type { LLMProvider, StructuredRequest } from "../interfaces/llm-provider.js";
import type { NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/** 既存の歯は Fake の次元（2）の上で、次元違いは「長い側（+1）」だけ、非有限の値は「末尾」だけを与えていたので、検査が `>` になっても、走査が先頭を飛ばしても赤にならなかった。ここでは次元を4にして、短い側・空・長い側と、先頭・中間・末尾の非有限値を与える。 */
const ctx: Ctx = { tenantId: "tenant-1" };
const NOW = new Date("2026-06-01T00:00:00.000Z");
const DIMS = 4;

function newMemory(): NewMemory {
  const halfLifeHours = 24 * 365 * 10;
  return {
    tenantId: "tenant-1",
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: "本文",
    contentHash: `hash-${Math.random()}`,
    digest: "digest",
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: [],
    occurredAt: null,
    recordedAt: NOW,
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours,
    decayFloorAt: defaultDecayStrategy.floorAt({
      recordedAt: NOW,
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours,
    }),
    embeddingStatus: "pending",
  };
}

const notUsedLlm: LLMProvider = {
  complete: async () => {
    throw new Error("not used");
  },
  completeStructured: async <T>(_ctx: Ctx, _req: StructuredRequest<T>): Promise<T> => {
    throw new Error("not used");
  },
};

async function runEmbedJob(vector: number[]) {
  const stores = createFakeRuntimeStores();
  const provider: EmbeddingProvider = {
    space: { ...stores.embeddingProvider.space, dimensions: DIMS },
    embed: async () => [vector],
  };
  const upsert = vi.spyOn(stores.vectorStore, "upsert");
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: notUsedLlm,
    embeddingProvider: provider,
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => new Date() },
  });
  const { memory } = await stores.memoryStore.createMemoryWithOutbox(ctx, newMemory(), ["embed"]);
  const result = await runtime.tick(ctx, { kinds: ["embed"], leaseMs: 60_000 });
  const [job] = stores.outboxStore.listJobs(ctx);
  return {
    result,
    upsert,
    status: (await stores.memoryStore.get(ctx, memory.id))?.embeddingStatus,
    lastError: job?.lastError ?? "",
  };
}

describe("tick の embed ジョブ：次元違い・非有限の値の位置に依らず失敗にする（#1463 E4・E9）", () => {
  it.each([
    ["1つ短い", DIMS - 1],
    ["空", 0],
    ["1つ長い", DIMS + 1],
  ])("%sベクトルは failed になり、upsert されない", async (_label, length) => {
    const { result, upsert, status, lastError } = await runEmbedJob(
      new Array<number>(length).fill(0.5),
    );
    expect(result.failed).toBe(1);
    expect(result.processed).toBe(0);
    expect(status).toBe("failed");
    expect(upsert).not.toHaveBeenCalled();
    expect(lastError).toContain(`expected ${DIMS} dimensions`);
    expect(lastError).toContain(`got ${length}`);
  });

  it.each([
    ["先頭", 0],
    ["中間", 2],
    ["末尾", DIMS - 1],
  ])(
    "非有限の値が%sにあっても failed になり、メッセージにその位置が出る",
    async (_label, index) => {
      const vector = new Array<number>(DIMS).fill(0.5);
      vector[index] = Number.NaN;
      const { result, upsert, status, lastError } = await runEmbedJob(vector);
      expect(result.failed).toBe(1);
      expect(status).toBe("failed");
      expect(upsert).not.toHaveBeenCalled();
      expect(lastError).toContain(`index ${index} (NaN)`);
    },
  );

  it("対照: 次元が合い、すべて有限なら ready になり、upsert される", async () => {
    const { result, upsert, status } = await runEmbedJob(new Array<number>(DIMS).fill(0.5));
    expect(result.processed).toBe(1);
    expect(result.failed).toBe(0);
    expect(status).toBe("ready");
    expect(upsert).toHaveBeenCalledTimes(1);
  });
});

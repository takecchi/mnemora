import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { MemoryId } from "../ids.js";
import type { LLMProvider, StructuredRequest } from "../interfaces/llm-provider.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

const ctx: Ctx = { tenantId: "tenant-1" };

let extractedContents: string[] = [];

const llm: LLMProvider = {
  complete: async () => {
    throw new Error("not used");
  },
  completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> => {
    for (const value of [
      {
        memories: extractedContents.map((content) => ({
          content,
          digest: "要旨",
          provenanceKind: "stated",
        })),
      },
      { outcome: "reflected", content: "内省の本文" },
      { content: "統合後の本文" },
    ]) {
      const parsed = req.schema.safeParse(value);
      if (parsed.success) return parsed.data as T;
    }
    throw new Error("unexpected schema");
  },
};

function neighborMemory(): NewMemory {
  const recordedAt = new Date();
  const halfLifeHours = 24 * 365 * 10;
  return {
    tenantId: ctx.tenantId,
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: "近傍の本文",
    contentHash: "neighbor-hash",
    digest: "近傍",
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: [],
    occurredAt: null,
    recordedAt,
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours,
    decayFloorAt: defaultDecayStrategy.floorAt({
      recordedAt,
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours,
    }),
    embeddingStatus: "ready",
  };
}

type Adapter = "supersedeWithNewMemories あり" | "supersedeWithNewMemories なし";
const ADAPTERS: Adapter[] = ["supersedeWithNewMemories あり", "supersedeWithNewMemories なし"];

function makeKit(adapter: Adapter) {
  const stores = createFakeRuntimeStores();
  if (adapter === "supersedeWithNewMemories なし") {
    (stores.memoryStore as { supersedeWithNewMemories?: unknown }).supersedeWithNewMemories =
      undefined;
  }
  const runtime = createRuntime({
    ...stores,
    llmProvider: llm,
    hashContent: (content: string) => `sha256(${content})`,
    config: { autoQueueConsolidateReflectOnExtract: true },
  });
  const jobKindsOf = (memoryId: MemoryId) =>
    stores.outboxStore
      .listJobs(ctx)
      .filter((job) => job.payload.memoryId === memoryId)
      .map((job) => job.kind)
      .sort();
  return { stores, runtime, jobKindsOf };
}

describe("autoQueueConsolidateReflectOnExtract: 種として積まれるのは抽出で生まれた記憶だけ", () => {
  it.each(ADAPTERS)(
    "consolidate・reflect が作った記憶には embed のジョブだけが積まれる（%s）",
    async (adapter) => {
      const { stores, runtime, jobKindsOf } = makeKit(adapter);
      extractedContents = ["抽出された事実"];
      const observed = await runtime.observe(ctx, { kind: "utterance", text: "発話" });
      const seedId = observed.memoryIds[0]!;
      expect(jobKindsOf(seedId)).toEqual(["consolidate", "embed", "reflect"]);
      const neighbor = await stores.memoryStore.createMemory(ctx, neighborMemory());
      await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, neighbor.id, [8, 0]);

      const reflectTick = await runtime.tick(ctx, { kinds: ["reflect"], leaseMs: 60_000 });
      const consolidateTick = await runtime.tick(ctx, { kinds: ["consolidate"], leaseMs: 60_000 });
      expect(reflectTick.processed).toBe(1);
      expect(consolidateTick.processed).toBe(1);

      const derivedIds = stores.eventStore.events
        .filter((e) => e.kind === "created" && e.memoryId !== seedId)
        .map((e) => e.memoryId!);
      expect(derivedIds).toHaveLength(2);
      for (const derivedId of derivedIds) {
        expect(jobKindsOf(derivedId)).toEqual(["embed"]);
      }
    },
  );

  it.each(ADAPTERS)(
    "reextract が作った記憶には embed のジョブだけが積まれる（%s）",
    async (adapter) => {
      const { runtime, jobKindsOf } = makeKit(adapter);
      extractedContents = ["旧い事実"];
      const observed = await runtime.observe(ctx, { kind: "utterance", text: "発話" });
      extractedContents = ["新しい事実"];

      const reextracted = await runtime.reextract(ctx, observed.observationId);

      expect(reextracted.memoryIds).toHaveLength(1);
      expect(jobKindsOf(reextracted.memoryIds[0]!)).toEqual(["embed"]);
    },
  );
});

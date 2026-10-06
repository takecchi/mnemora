import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider, StructuredRequest } from "../interfaces/llm-provider.js";
import type { NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * `tick()` が駆動する consolidate・reflect のジョブは、`actor` も `reason` も渡さない。
 * ⟹ そのジョブが積む統合先・内省の `created`（と統合元の `superseded`）は、actor が
 * `{ type: "system" }` のままで、`meta.note` が付かない（直接呼んだときに `actor`・`reason` を
 * 渡した場合だけ、それらが入る）。
 */

const ctx: Ctx = { tenantId: "tick-consolidate-reflect-job-event-actor" };
const NOW = new Date("2026-06-01T00:00:00.000Z");

function newMemory(content: string): NewMemory {
  return {
    tenantId: ctx.tenantId,
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content,
    contentHash: `hash-${content}`,
    digest: "same digest",
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: [],
    occurredAt: null,
    // 実時刻（tick の時計は注入していない）。過去に固定すると、減衰で近傍の近さが閾値を割る。
    recordedAt: new Date(),
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 24 * 365 * 10,
    decayFloorAt: new Date(NOW.getTime() + 1e12),
    embeddingStatus: "ready",
  };
}

const llm: LLMProvider = {
  complete: async () => {
    throw new Error("not used");
  },
  completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> =>
    // consolidate の schema は `outcome` を無視し、reflect の schema は `outcome: "reflected"` を要る。
    req.schema.parse({ outcome: "reflected", content: "まとめた本文" }) as T,
};

async function runJob(kind: "consolidate" | "reflect") {
  const stores = createFakeRuntimeStores();
  const space = { provider: "fake", model: "fake-model", dimensions: 3 };
  const runtime = createRuntime({
    ...stores,
    llmProvider: llm,
    embeddingProvider: { space, embed: async (_c, texts) => texts.map(() => [1, 0, 0]) },
    hashContent: (content: string) => `h(${content})`,
  });
  const { memory: seed } = await stores.memoryStore.createMemoryWithOutbox(ctx, newMemory("seed"), [
    kind,
  ]);
  await stores.vectorStore.upsert(ctx, space, seed.id, [1, 0, 0]);
  const neighbor = await stores.memoryStore.createMemory(ctx, newMemory("neighbor"));
  await stores.vectorStore.upsert(ctx, space, neighbor.id, [1, 0, 0]);

  const tick = await runtime.tick(ctx, { kinds: [kind], leaseMs: 60_000 });
  expect(tick).toEqual({ processed: 1, failed: 0, unsupported: [], leaseConflicts: [] });
  return { stores, seed, neighbor };
}

describe("tick が駆動する consolidate・reflect のジョブのイベントは、actor が system で note が付かない", () => {
  it("consolidate: 統合先の created も統合元の superseded も", async () => {
    const { stores, seed, neighbor } = await runJob("consolidate");
    const created = stores.eventStore.events.filter((e) => e.kind === "created");
    expect(created).toHaveLength(1);
    expect(created[0]!.actor).toEqual({ type: "system" });
    expect(created[0]!.meta).not.toHaveProperty("note");
    const superseded = stores.eventStore.events.filter((e) => e.kind === "superseded");
    expect(superseded.map((e) => e.memoryId).sort()).toEqual([seed.id, neighbor.id].sort());
    for (const e of superseded) {
      expect(e.actor).toEqual({ type: "system" });
      expect(e.meta).not.toHaveProperty("note");
    }
  });

  it("reflect: 内省の created", async () => {
    const { stores } = await runJob("reflect");
    const created = stores.eventStore.events.filter((e) => e.kind === "created");
    expect(created).toHaveLength(1);
    expect(created[0]!.actor).toEqual({ type: "system" });
    expect(created[0]!.meta).not.toHaveProperty("note");
  });
});

describe("observe → tick（抽出・埋め込み・consolidate/reflect）が積む全イベントの actor は system（EventActor の doc。Issue #1775 の #764）", () => {
  it("本番の経路は actor.type が 'human'・'clone' のイベントを1件も作らない", async () => {
    const stores = createFakeRuntimeStores();
    const space = { provider: "fake", model: "fake-model", dimensions: 3 };
    const smartLlm: LLMProvider = {
      complete: async () => {
        throw new Error("not used");
      },
      completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> => {
        const extraction = req.schema.safeParse({
          memories: [
            { content: "抽出された記憶A", provenanceKind: "stated" },
            { content: "抽出された記憶B", provenanceKind: "stated" },
          ],
        });
        if (extraction.success) return extraction.data as T;
        return req.schema.parse({ outcome: "reflected", content: "まとめた本文" }) as T;
      },
    };
    const runtime = createRuntime({
      ...stores,
      llmProvider: smartLlm,
      embeddingProvider: { space, embed: async (_c, texts) => texts.map(() => [1, 0, 0]) },
      hashContent: (content: string) => `h(${content})`,
      config: { autoQueueConsolidateReflectOnExtract: true },
    });

    await runtime.observe(ctx, { kind: "utterance", text: "AとBの話をしました" });
    for (let i = 0; i < 6; i++) {
      const tick = await runtime.tick(ctx, { leaseMs: 60_000 });
      if (tick.processed === 0 && tick.failed === 0) break;
    }

    const kinds = new Set(stores.eventStore.events.map((e) => e.kind));
    // 抽出の created は必ず在る。consolidate・reflect まで届いていれば superseded も在る。
    expect(kinds.has("created")).toBe(true);
    expect(stores.eventStore.events.length).toBeGreaterThan(2);
    for (const e of stores.eventStore.events) {
      expect(e.actor).toEqual({ type: "system" });
    }
  });
});

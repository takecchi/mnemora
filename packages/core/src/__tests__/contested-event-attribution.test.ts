import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import type { NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

const ctx: Ctx = { tenantId: "tenant-1" };
const NOW = new Date("2026-06-01T00:00:00.000Z");

function newMemory(digest: string): NewMemory {
  const strength = 1;
  const halfLifeHours = 24 * 365 * 10;
  return {
    tenantId: "tenant-1",
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: `本文 ${digest}`,
    contentHash: `hash-${digest}`,
    digest,
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: [],
    occurredAt: null,
    recordedAt: NOW,
    lastReinforcedAt: null,
    strength,
    halfLifeHours,
    decayFloorAt: defaultDecayStrategy.floorAt({
      recordedAt: NOW,
      lastReinforcedAt: null,
      strength,
      halfLifeHours,
    }),
    embeddingStatus: "pending",
  };
}

const notUsedLlm: LLMProvider = {
  complete: async () => {
    throw new Error("not used");
  },
  completeStructured: async () => {
    throw new Error("not used");
  },
};

function buildRuntime() {
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
    clock: { now: () => NOW },
  });
  return { runtime, stores };
}

async function createTwo() {
  const { runtime, stores } = buildRuntime();
  const a = await stores.memoryStore.createMemory(ctx, newMemory("要旨A"));
  const b = await stores.memoryStore.createMemory(ctx, newMemory("要旨B"));
  const eventsOf = (id: string) => stores.eventStore.events.filter((e) => e.memoryId === id);
  return { runtime, stores, a, b, eventsOf };
}

describe("markContested が積むイベント", () => {
  it("actor を省略すると、両側のイベントの actor は system", async () => {
    const { runtime, a, b, eventsOf } = await createTwo();

    await runtime.markContested(ctx, a.id, b.id);

    expect(eventsOf(a.id).at(-1)?.actor).toEqual({ type: "system" });
    expect(eventsOf(b.id).at(-1)?.actor).toEqual({ type: "system" });
  });

  it("それぞれのイベントの digestSnapshot は、その側の記憶の digest である", async () => {
    const { runtime, a, b, eventsOf } = await createTwo();

    await runtime.markContested(ctx, a.id, b.id);

    expect(eventsOf(a.id).at(-1)?.digestSnapshot).toBe("要旨A");
    expect(eventsOf(b.id).at(-1)?.digestSnapshot).toBe("要旨B");
  });
});

describe("resolveContested が積むイベント", () => {
  it("both_active でも supersede でも、actor を省略すると両側のイベントの actor は system", async () => {
    for (const resolution of ["both_active", "supersede"] as const) {
      const { runtime, a, b, eventsOf } = await createTwo();
      await runtime.markContested(ctx, a.id, b.id);

      await runtime.resolveContested(
        ctx,
        a.id,
        b.id,
        resolution === "supersede"
          ? { kind: "supersede", winnerId: a.id }
          : { kind: "both_active" },
      );

      expect(eventsOf(a.id).at(-1)?.actor).toEqual({ type: "system" });
      expect(eventsOf(b.id).at(-1)?.actor).toEqual({ type: "system" });
    }
  });

  it("両側のイベントの at は、呼び出し時点の時計の now である", async () => {
    const { runtime, a, b, eventsOf } = await createTwo();
    await runtime.markContested(ctx, a.id, b.id);

    await runtime.resolveContested(ctx, a.id, b.id, { kind: "supersede", winnerId: b.id });

    expect(eventsOf(a.id).at(-1)?.at).toEqual(NOW);
    expect(eventsOf(b.id).at(-1)?.at).toEqual(NOW);
  });

  it("それぞれのイベントの digestSnapshot は、その側の記憶の digest である", async () => {
    const { runtime, a, b, eventsOf } = await createTwo();
    await runtime.markContested(ctx, a.id, b.id);

    await runtime.resolveContested(ctx, a.id, b.id, { kind: "supersede", winnerId: a.id });

    expect(eventsOf(a.id).at(-1)?.digestSnapshot).toBe("要旨A");
    expect(eventsOf(b.id).at(-1)?.digestSnapshot).toBe("要旨B");
  });
});

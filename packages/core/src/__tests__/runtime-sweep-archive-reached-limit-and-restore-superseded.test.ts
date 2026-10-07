import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import type { NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

const ctx: Ctx = { tenantId: "tenant-1" };
const NOW = new Date("2026-06-01T00:00:00.000Z");
let hashCounter = 0;

function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  hashCounter += 1;
  return {
    tenantId: ctx.tenantId,
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: `本文 ${hashCounter}`,
    contentHash: `runtime-round3-${hashCounter}`,
    digest: `要旨 ${hashCounter}`,
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "runtime-round3" },
    tags: [],
    occurredAt: null,
    recordedAt: NOW,
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 24 * 365 * 10,
    decayFloorAt: new Date("2100-01-01T00:00:00.000Z"),
    embeddingStatus: "pending",
    ...overrides,
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

const DECAYED = new Date(NOW.getTime() - 1_000);

describe("runtime.sweepArchive — observe() からも走らず、reachedLimit をそのまま運ぶ", () => {
  it("observe() を呼んでも、減衰しきった active な Memory は archived にならない", async () => {
    const { runtime, stores } = buildRuntime();
    const decayed = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ decayFloorAt: DECAYED }),
    );

    await runtime.observe(ctx, { kind: "utterance", text: "こんにちは", extract: "deferred" });

    expect({
      status: (await stores.memoryStore.get(ctx, decayed.id))?.status,
      archivedEvents: stores.eventStore.events.filter((e) => e.kind === "archived").length,
    }).toEqual({ status: "active", archivedEvents: 0 });
  });

  it("対象がちょうど limit 件なら reachedLimit: true が届く", async () => {
    const { runtime, stores } = buildRuntime();
    await stores.memoryStore.createMemory(ctx, newMemory({ decayFloorAt: DECAYED }));
    await stores.memoryStore.createMemory(ctx, newMemory({ decayFloorAt: DECAYED }));

    const result = await runtime.sweepArchive(ctx, { now: NOW, limit: 2 });

    expect({
      supported: result.supported,
      archived: result.archived.length,
      reachedLimit: result.reachedLimit,
    }).toEqual({ supported: true, archived: 2, reachedLimit: true });
  });
});

describe("runtime.restoreSuperseded — supported と decayFloorAt の細部", () => {
  it("dryRun: true なら、restoreSupersededBy が無くても previewRestoreSupersededBy が在れば supported: true で下見できる", async () => {
    const { runtime, stores } = buildRuntime();
    const anchor = await stores.memoryStore.createMemory(ctx, newMemory());
    const source = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ status: "superseded", supersededById: anchor.id }),
    );
    Object.defineProperty(stores.memoryStore, "restoreSupersededBy", {
      value: undefined,
      configurable: true,
    });

    const result = await runtime.restoreSuperseded(
      ctx,
      { supersededById: anchor.id },
      { dryRun: true },
    );

    expect(result).toEqual({
      supported: true,
      supersedingMemoryId: anchor.id,
      outcomes: [
        {
          memoryId: source.id,
          kind: "would_restore",
          previousStatus: "superseded",
          supersededReason: null,
        },
      ],
    });
  });

  it("restored の decayFloorAt は、reinforce が成功すればその結果、失敗すれば復帰直後の値", async () => {
    const { runtime, stores } = buildRuntime();
    const anchor = await stores.memoryStore.createMemory(ctx, newMemory());
    const originalFloor = new Date("2026-06-15T00:00:00.000Z");
    // reinforce は at が recordedAt・lastReinforcedAt より後のときだけ床を引き直すので、recordedAt を前にする。
    const superseded = {
      status: "superseded" as const,
      supersededById: anchor.id,
      decayFloorAt: originalFloor,
      recordedAt: new Date("2026-01-01T00:00:00.000Z"),
    };
    const reinforced = await stores.memoryStore.createMemory(ctx, newMemory(superseded));
    const failing = await stores.memoryStore.createMemory(ctx, newMemory(superseded));
    // 群の一括の口を外し、1件ずつの reinforce だけにする（片方だけを失敗させるため）。
    Object.defineProperty(stores.memoryStore, "reinforceMany", {
      value: undefined,
      configurable: true,
    });
    const originalReinforce = stores.memoryStore.reinforce.bind(stores.memoryStore);
    stores.memoryStore.reinforce = async (c, id, at, opts) => {
      if (id === failing.id) {
        throw new Error("simulated reinforce failure");
      }
      return originalReinforce(c, id, at, opts);
    };

    const result = await runtime.restoreSuperseded(ctx, { supersededById: anchor.id });

    const byId = new Map(result.outcomes.map((o) => [o.memoryId, o]));
    const afterReinforce = await stores.memoryStore.get(ctx, reinforced.id);
    expect(afterReinforce?.decayFloorAt.getTime()).not.toBe(originalFloor.getTime());
    expect({
      reinforced: byId.get(reinforced.id),
      failing: byId.get(failing.id),
    }).toEqual({
      reinforced: {
        memoryId: reinforced.id,
        kind: "restored",
        previousStatus: "superseded",
        decayFloorAt: afterReinforce?.decayFloorAt,
      },
      failing: {
        memoryId: failing.id,
        kind: "restored",
        previousStatus: "superseded",
        decayFloorAt: originalFloor,
        reinforceError: "simulated reinforce failure",
      },
    });
  });
});

describe("runtime.purge — dryRun でも、同じ id を2回渡せば結果にも2回出る", () => {
  it("[x, x] は [would_purge, would_purge] で、書き込みは起きない", async () => {
    const { runtime, stores } = buildRuntime();
    const target = await stores.memoryStore.createMemory(ctx, newMemory({ status: "forgotten" }));

    const result = await runtime.purge(
      ctx,
      { memoryIds: [target.id, target.id] },
      { dryRun: true },
    );

    expect(result).toEqual({
      supported: true,
      outcomes: [
        { memoryId: target.id, kind: "would_purge", previousStatus: "forgotten" },
        { memoryId: target.id, kind: "would_purge", previousStatus: "forgotten" },
      ],
    });
    expect({
      purgedAt: (await stores.memoryStore.get(ctx, target.id))?.purgedAt ?? null,
      events: stores.eventStore.events.length,
    }).toEqual({ purgedAt: null, events: 0 });
  });
});

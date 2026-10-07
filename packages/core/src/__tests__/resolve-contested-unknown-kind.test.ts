import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import type { ContestedResolution } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

const ctx: Ctx = { tenantId: "tenant-unknown-kind" };
const NOW = new Date("2026-06-01T00:00:00.000Z");

function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  const recordedAt = NOW;
  const strength = 1;
  const halfLifeHours = 24 * 365 * 10;
  return {
    tenantId: ctx.tenantId,
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
    recordedAt,
    lastReinforcedAt: null,
    strength,
    halfLifeHours,
    decayFloorAt: defaultDecayStrategy.floorAt({
      recordedAt,
      lastReinforcedAt: null,
      strength,
      halfLifeHours,
    }),
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
    relationStore: stores.relationStore,
  });
  return { runtime, stores };
}

type Stores = ReturnType<typeof buildRuntime>["stores"];

async function snapshot(stores: Stores, ids: string[]) {
  const out: Array<[string | undefined, string | null | undefined]> = [];
  for (const id of ids) {
    const m = await stores.memoryStore.get(ctx, id as never);
    out.push([m?.status, m?.supersededById]);
  }
  return { memories: out, events: stores.eventStore.events.length };
}

const UNKNOWN_KINDS: unknown[] = [
  { kind: "weird" },
  { kind: "SUPERSEDE", winnerId: "x" },
  { kind: "" },
  { kind: undefined },
  { winnerId: "x" },
  { kind: "__proto__" },
];

describe("resolveContested（2者版）: 未知の resolution.kind は書き込む前に RangeError", () => {
  it.each(UNKNOWN_KINDS.map((r, i) => [i, r] as const))(
    "不正な resolution #%i は RangeError、status も event も変わらない",
    async (_i, resolution) => {
      const { runtime, stores } = buildRuntime();
      const a = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "A" }));
      const b = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "B" }));
      await runtime.markContested(ctx, a.id, b.id);
      const before = await snapshot(stores, [a.id, b.id]);
      expect(before.memories).toEqual([
        ["contested", null],
        ["contested", null],
      ]);

      await expect(
        runtime.resolveContested(ctx, a.id, b.id, resolution as ContestedResolution),
      ).rejects.toThrow(RangeError);
      await expect(
        runtime.resolveContested(ctx, a.id, b.id, resolution as ContestedResolution),
      ).rejects.toThrow(/resolution\.kind/);

      expect(await snapshot(stores, [a.id, b.id])).toEqual(before);
    },
  );

  it("陽性対照: supersede・both_active は今までどおり通る", async () => {
    const { runtime, stores } = buildRuntime();
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "B" }));
    await runtime.markContested(ctx, a.id, b.id);
    const r1 = await runtime.resolveContested(ctx, a.id, b.id, { kind: "both_active" });
    expect(r1.outcome.kind).toBe("resolved");

    await runtime.markContested(ctx, a.id, b.id);
    const r2 = await runtime.resolveContested(ctx, a.id, b.id, {
      kind: "supersede",
      winnerId: a.id,
    });
    expect(r2.outcome.kind).toBe("resolved");
    expect((await stores.memoryStore.get(ctx, b.id))?.status).toBe("superseded");
  });
});

describe("resolveContestedGroup（群版）: 未知の resolution.kind は書き込む前に RangeError", () => {
  it.each(UNKNOWN_KINDS.map((r, i) => [i, r] as const))(
    "不正な resolution #%i は RangeError、status も event も変わらない",
    async (_i, resolution) => {
      const { runtime, stores } = buildRuntime();
      const a = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "A" }));
      const b = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "B" }));
      const c = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "C" }));
      await runtime.markContestedGroup!(ctx, [a.id, b.id, c.id]);
      const before = await snapshot(stores, [a.id, b.id, c.id]);
      expect(before.memories.map((m) => m[0])).toEqual(["contested", "contested", "contested"]);

      await expect(
        runtime.resolveContestedGroup!(ctx, [a.id, b.id, c.id], resolution as ContestedResolution),
      ).rejects.toThrow(RangeError);
      await expect(
        runtime.resolveContestedGroup!(ctx, [a.id, b.id, c.id], resolution as ContestedResolution),
      ).rejects.toThrow(/resolution\.kind/);

      expect(await snapshot(stores, [a.id, b.id, c.id])).toEqual(before);
    },
  );

  it("陽性対照: both_active・supersede は今までどおり通る", async () => {
    const { runtime, stores } = buildRuntime();
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "B" }));
    const c = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "C" }));
    await runtime.markContestedGroup!(ctx, [a.id, b.id, c.id]);
    const r = await runtime.resolveContestedGroup!(ctx, [a.id, b.id, c.id], {
      kind: "supersede",
      winnerId: a.id,
    });
    expect(r.outcome.kind).toBe("resolved");
    expect((await stores.memoryStore.get(ctx, b.id))?.status).toBe("superseded");
  });
});

describe("applyCorrection: 未知の resolution.kind は markContested の前に RangeError（何も書かない）", () => {
  it("contested の印も event も書かれない", async () => {
    const { runtime, stores } = buildRuntime();
    const target = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ digest: "対象", embeddingStatus: "ready" }),
    );
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, target.id, [8, 0]);
    const correcting = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ digest: "訂正", embeddingStatus: "ready" }),
    );
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, correcting.id, [1, 0]);
    const discovery = await runtime.findCorrectionCandidates(ctx, {
      text: "seed",
      excludeMemoryIds: [correcting.id],
    });
    expect(discovery.candidates.map((c) => c.memoryId)).toContain(target.id);
    const before = await snapshot(stores, [target.id, correcting.id]);

    await expect(
      runtime.applyCorrection(ctx, {
        discovery,
        correctedId: target.id,
        correctingId: correcting.id,
        resolution: { kind: "weird" } as unknown as ContestedResolution,
      }),
    ).rejects.toThrow(RangeError);

    expect(await snapshot(stores, [target.id, correcting.id])).toEqual(before);
    expect(before.events).toBe(0);
  });
});

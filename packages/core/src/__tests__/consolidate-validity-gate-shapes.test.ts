import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider, StructuredRequest } from "../interfaces/llm-provider.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

const ctx: Ctx = { tenantId: "consolidate-validity-gate-shapes" };
const NOW = new Date("2026-06-01T00:00:00.000Z");
const PAST = new Date("2026-01-01T00:00:00.000Z");
const FUTURE = new Date("2027-01-01T00:00:00.000Z");

function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  const recordedAt = new Date("2025-06-01T00:00:00.000Z");
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
    strength: 1,
    halfLifeHours,
    decayFloorAt: defaultDecayStrategy.floorAt({
      recordedAt,
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours,
    }),
    embeddingStatus: "pending",
    ...overrides,
  };
}

const consolidatingLlm: LLMProvider = {
  complete: async () => {
    throw new Error("not used");
  },
  completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> =>
    req.schema.parse({ content: "統合後" }) as T,
};

function buildRuntime() {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    ...stores,
    llmProvider: consolidatingLlm,
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => NOW },
  });
  return { runtime, stores };
}

async function createEmbedded(
  stores: ReturnType<typeof createFakeRuntimeStores>,
  vector: number[],
  overrides: Partial<NewMemory>,
) {
  const memory = await stores.memoryStore.createMemory(
    ctx,
    newMemory({ embeddingStatus: "ready", ...overrides }),
  );
  await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, memory.id, vector);
  return memory;
}

describe("consolidate の期間の判定は status の判定より後（forgotten 以外の status でも）", () => {
  it.each(["archived", "superseded", "contested", "forgotten"] as const)(
    "期限切れの %s な記憶は expired ではなく status_not_active で名指しする",
    async (status) => {
      const { runtime, stores } = buildRuntime();
      const withdrawn = await stores.memoryStore.createMemory(
        ctx,
        newMemory({ status, validUntil: PAST }),
      );
      const a = await stores.memoryStore.createMemory(ctx, newMemory());
      const b = await stores.memoryStore.createMemory(ctx, newMemory());

      const result = await runtime.consolidate(ctx, {
        target: { memoryIds: [withdrawn.id, a.id, b.id] },
        dryRun: true,
      });

      expect(result.sources).toEqual([
        { memoryId: withdrawn.id, kind: "status_not_active", status },
        { memoryId: a.id, kind: "eligible" },
        { memoryId: b.id, kind: "eligible" },
      ]);
    },
  );
});

describe("consolidate の期間の判定は、対象の形によらず同じである", () => {
  it("{ seedMemoryId }: 未到来の種は not_yet_valid で名指しし、近傍どうしは統合元に残る", async () => {
    const { runtime, stores } = buildRuntime();
    const seed = await createEmbedded(stores, [4, 0], { digest: "seed", validFrom: FUTURE });
    const n1 = await createEmbedded(stores, [8, 0], { digest: "n-1" });
    const n2 = await createEmbedded(stores, [12, 0], { digest: "n-2" });

    const result = await runtime.consolidate(ctx, {
      target: { seedMemoryId: seed.id, minAffinity: 0 },
      dryRun: true,
    });

    expect(result.sources).toEqual([
      { memoryId: seed.id, kind: "not_yet_valid", validFrom: FUTURE },
      { memoryId: n1.id, kind: "eligible" },
      { memoryId: n2.id, kind: "eligible" },
    ]);
  });

  it("{ query }: includeOutsideValidity で集めた未到来の記憶も not_yet_valid で名指しする", async () => {
    const { runtime, stores } = buildRuntime();
    const future = await createEmbedded(stores, [4, 0], { validFrom: FUTURE });
    const current = await createEmbedded(stores, [4, 1], {});

    const result = await runtime.consolidate(ctx, {
      target: {
        query: { vector: [4, 0], limit: 5, association: null, includeOutsideValidity: true },
      },
      dryRun: true,
    });

    expect(result.sources).toEqual([
      { memoryId: future.id, kind: "not_yet_valid", validFrom: FUTURE },
      { memoryId: current.id, kind: "not_attempted" },
    ]);
  });

  it("{ query }: 過去の validAt で集めた記憶も、いまの時点で期限切れなら expired、未到来なら not_yet_valid", async () => {
    const { runtime, stores } = buildRuntime();
    const endedSince = await createEmbedded(stores, [4, 0], {
      validUntil: new Date("2026-03-01T00:00:00.000Z"),
    });
    const current = await createEmbedded(stores, [4, 1], {});

    const viaPast = await runtime.consolidate(ctx, {
      target: {
        query: {
          vector: [4, 0],
          limit: 5,
          association: null,
          validAt: new Date("2026-02-01T00:00:00.000Z"),
        },
      },
      dryRun: true,
    });
    expect(viaPast.sources).toEqual([
      {
        memoryId: endedSince.id,
        kind: "expired",
        validUntil: new Date("2026-03-01T00:00:00.000Z"),
      },
      { memoryId: current.id, kind: "not_attempted" },
    ]);

    const startsLater = await createEmbedded(stores, [4, 0.5], {
      validFrom: new Date("2026-09-01T00:00:00.000Z"),
    });
    const viaFuture = await runtime.consolidate(ctx, {
      target: {
        query: {
          vector: [4, 0.5],
          limit: 5,
          association: null,
          validAt: new Date("2026-10-01T00:00:00.000Z"),
        },
      },
      dryRun: true,
    });
    expect(viaFuture.sources).toContainEqual({
      memoryId: startsLater.id,
      kind: "not_yet_valid",
      validFrom: new Date("2026-09-01T00:00:00.000Z"),
    });
  });
});

import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { Memory, NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/** `@mnemora/testkit` には依存しない: 他の `recall-*.test.ts` と同型の足場を独立に持つ。 */

const ctx: Ctx = { tenantId: "tenant-1" };
const NOW = new Date("2026-06-01T00:00:00.000Z");

function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  const recordedAt = overrides.recordedAt ?? NOW;
  const strength = overrides.strength ?? 1;
  const halfLifeHours = overrides.halfLifeHours ?? 24 * 365 * 10;
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

function buildRuntime() {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: {
      complete: async () => {
        throw new Error("not used");
      },
      completeStructured: async () => {
        throw new Error("not used");
      },
    },
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => NOW },
    relationStore: stores.relationStore,
  });
  return { runtime, stores };
}

async function createEmbeddedMemory(
  stores: ReturnType<typeof createFakeRuntimeStores>,
  vector: number[],
  overrides: Partial<NewMemory> = {},
): Promise<Memory> {
  const memory = await stores.memoryStore.createMemory(
    ctx,
    newMemory({ embeddingStatus: "ready", ...overrides }),
  );
  await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, memory.id, vector);
  return memory;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const PERIOD_START = new Date("2026-03-01T00:00:00.000Z");
const PERIOD_END = new Date("2026-04-01T00:00:00.000Z");
const MIDDLE = new Date("2026-03-15T00:00:00.000Z");

/**
 * アンカー（クエリに当たる記憶）は期間の内側に置く。連想の候補はアンカーに近いがクエリの席（limit: 1）には入らない向きに置く
 * ——連想枠だけが拾う記憶の実効時刻を、期間の端にぴったり合わせて動かす。
 */
async function recallAssociatedAt(
  effectiveAt: Date,
  period: { occurredAfter?: Date; occurredBefore?: Date },
) {
  const { runtime, stores } = buildRuntime();
  const anchor = await createEmbeddedMemory(stores, [1, 0], {
    digest: "anchor",
    occurredAt: MIDDLE,
  });
  const candidate = await createEmbeddedMemory(stores, [0.8, 0.6], {
    digest: "candidate",
    occurredAt: effectiveAt,
  });

  const result = await runtime.recall(ctx, {
    vector: [1, 0],
    limit: 1,
    association: { maxCount: 5, anchorCount: 1, minSimilarity: 0 },
    ...period,
  });
  return { result, anchor, candidate };
}

describe("recall() — 連想枠（段3.5）の期間の境界は両端とも含む", () => {
  it("実効時刻がちょうど occurredAfter の連想候補は連想枠から返り、1ミリ秒前なら返らない", async () => {
    const atStart = await recallAssociatedAt(PERIOD_START, { occurredAfter: PERIOD_START });
    expect(atStart.result.memories.map((m) => m.memoryId)).toContain(atStart.anchor.id);
    expect(atStart.result.memories).toContainEqual(
      expect.objectContaining({
        memoryId: atStart.candidate.id,
        retrievedVia: "association",
        associationOf: atStart.anchor.id,
      }),
    );

    const justBefore = await recallAssociatedAt(new Date(PERIOD_START.getTime() - 1), {
      occurredAfter: PERIOD_START,
    });
    expect(justBefore.result.memories.map((m) => m.memoryId)).toContain(justBefore.anchor.id);
    expect(justBefore.result.memories.map((m) => m.memoryId)).not.toContain(
      justBefore.candidate.id,
    );
  });

  it("実効時刻がちょうど occurredBefore の連想候補は連想枠から返り、1ミリ秒後なら返らない", async () => {
    const atEnd = await recallAssociatedAt(PERIOD_END, { occurredBefore: PERIOD_END });
    expect(atEnd.result.memories.map((m) => m.memoryId)).toContain(atEnd.anchor.id);
    expect(atEnd.result.memories).toContainEqual(
      expect.objectContaining({
        memoryId: atEnd.candidate.id,
        retrievedVia: "association",
        associationOf: atEnd.anchor.id,
      }),
    );

    const justAfter = await recallAssociatedAt(new Date(PERIOD_END.getTime() + 1), {
      occurredBefore: PERIOD_END,
    });
    expect(justAfter.result.memories.map((m) => m.memoryId)).toContain(justAfter.anchor.id);
    expect(justAfter.result.memories.map((m) => m.memoryId)).not.toContain(justAfter.candidate.id);
  });

  it("期間の内側（両端から1日ずつ離れた実効時刻）の連想候補は返る（対照）", async () => {
    const inside = await recallAssociatedAt(new Date(PERIOD_START.getTime() + DAY_MS), {
      occurredAfter: PERIOD_START,
      occurredBefore: PERIOD_END,
    });
    expect(inside.result.memories).toContainEqual(
      expect.objectContaining({ memoryId: inside.candidate.id, retrievedVia: "association" }),
    );
  });
});

import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { NewMemory } from "../memory.js";
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

describe("recall() — 多者間の contested 群の単位の中の順（起点が先頭、残りは validFrom の新しい順→id の順）", () => {
  it("起点の validFrom が他のメンバーより古くても先頭に置き、残りは validFrom の新しい順に続く", async () => {
    const { runtime, stores } = buildRuntime();
    // 起点（クエリに当たる記憶）は、群の中でいちばん古い。
    const origin = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ digest: "origin", validFrom: new Date("2020-01-01T00:00:00.000Z") }),
    );
    const older = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ digest: "older", validFrom: new Date("2021-01-01T00:00:00.000Z") }),
    );
    const newest = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ digest: "newest", validFrom: new Date("2023-01-01T00:00:00.000Z") }),
    );
    const middle = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ digest: "middle", validFrom: new Date("2022-01-01T00:00:00.000Z") }),
    );
    await runtime.markContestedGroup!(ctx, [origin.id, older.id, newest.id, middle.id]);
    // origin だけを候補生成（ANN）で拾えるようにする——残りは段3の同伴取得だけが経路になる。
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, origin.id, [1, 0]);

    const result = await runtime.recall(ctx, { vector: [1, 0], association: null });

    expect(result.memories.map((m) => m.memoryId)).toEqual([
      origin.id,
      newest.id,
      middle.id,
      older.id,
    ]);
    expect(result.memories[0]?.retrievedVia).toBe("ann");
    expect(result.memories.slice(1).every((m) => m.retrievedVia === "mandatory_companion")).toBe(
      true,
    );
  });
});

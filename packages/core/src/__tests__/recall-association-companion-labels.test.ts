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

describe("recall() — 連想枠（段3.5）が選んだ contested にも、段3と同じ必須の同伴取得をかける", () => {
  it("labels を指定しても、連想枠が選んだ contested の対向が labels に一致しないだけでは落ちず、同伴として隣接して返る", async () => {
    const { runtime, stores } = buildRuntime();
    const anchor = await createEmbeddedMemory(stores, [1, 0], {
      digest: "anchor",
      tags: ["alpha"],
    });
    const owner = await createEmbeddedMemory(stores, [0.8, 0.6], {
      digest: "owner",
      tags: ["alpha"],
    });
    // 対向: embedding を持たず labels にも一致しない——クエリにもアンカーにも当たらず、必須の同伴取得だけが引ける。
    const opponent = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ digest: "opponent", tags: ["beta"] }),
    );
    const marked = await runtime.markContested(ctx, owner.id, opponent.id);
    expect(marked.outcome.kind).toBe("contested");

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 1,
      labels: ["alpha"],
      association: { maxCount: 5, anchorCount: 1, minSimilarity: 0 },
    });

    const ids = result.memories.map((m) => m.memoryId);
    expect(ids).toContain(anchor.id);
    const ownerResult = result.memories.find((m) => m.memoryId === owner.id);
    const opponentResult = result.memories.find((m) => m.memoryId === opponent.id);
    expect(ownerResult?.retrievedVia).toBe("association");
    expect(opponentResult?.retrievedVia).toBe("mandatory_companion");
    expect(opponentResult?.companionOf).toBe(owner.id);
    expect(Math.abs(ids.indexOf(owner.id) - ids.indexOf(opponent.id))).toBe(1);
    expect(result.omitted.some((o) => o.kind === "unit_assembly_dropped")).toBe(false);
  });
});

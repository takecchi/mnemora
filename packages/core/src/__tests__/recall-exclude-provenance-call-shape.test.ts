import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemory } from "../memory.js";
import type { Provenance } from "../provenance.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/** 除外の指定が無いとき、`aggregateScope` の第3引数に `excludeProvenanceKinds` のキーを足さない。受け取る3実装は undefined と `[]` をどちらも no-op にするので、結果を見る歯では捕まらず、引数の形を見る。 */

const ctx: Ctx = { tenantId: "tenant-1" };
const NOW = new Date("2026-06-01T00:00:00.000Z");
const consolidated: Provenance = { kind: "consolidated", sources: ["a", "b"] };

function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
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
    halfLifeHours: 24 * 365 * 10,
    decayFloorAt: new Date("2100-01-01T00:00:00.000Z"),
    embeddingStatus: "ready",
    ...overrides,
  };
}

async function seed() {
  const stores = createFakeRuntimeStores();
  for (const overrides of [
    {},
    {},
    {},
    { provenance: consolidated },
    { provenance: consolidated },
  ] satisfies Partial<NewMemory>[]) {
    const memory = await stores.memoryStore.createMemory(ctx, newMemory(overrides));
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, memory.id, [1, 0]);
  }
  return stores;
}

function buildRuntime(stores: Awaited<ReturnType<typeof seed>>, memoryStore = stores.memoryStore) {
  return createRuntime({
    memoryStore,
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
  });
}

/** `aggregateScope` の第3引数を記録する Proxy（結果は素通し）。 */
function recordAggregateScopeOptions(stores: Awaited<ReturnType<typeof seed>>) {
  const calls: Record<string, unknown>[] = [];
  const memoryStore = new Proxy(stores.memoryStore, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (prop === "aggregateScope" && typeof value === "function") {
        return (...args: unknown[]) => {
          calls.push((args[2] ?? {}) as Record<string, unknown>);
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { memoryStore, calls };
}

describe("recall() × excludeProvenanceKinds — aggregateScope の呼び出しの形と、索引の件数の意味（Issue #1734 / PR #1458 のすり抜け）", () => {
  it.each([
    ["省略", {}],
    ["空配列", { excludeProvenanceKinds: [] as never[] }],
  ])(
    "除外の指定が%sのとき、aggregateScope の第3引数に excludeProvenanceKinds のキーを足さない",
    async (_label, extra) => {
      const stores = await seed();
      const { memoryStore, calls } = recordAggregateScopeOptions(stores);
      await buildRuntime(stores, memoryStore).recall(ctx, { vector: [1, 0], ...extra });

      expect(calls).toHaveLength(1);
      expect("excludeProvenanceKinds" in calls[0]!).toBe(false);
    },
  );

  it("対照: 除外を指定したときは、そのまま第3引数に渡す", async () => {
    const stores = await seed();
    const { memoryStore, calls } = recordAggregateScopeOptions(stores);
    await buildRuntime(stores, memoryStore).recall(ctx, {
      vector: [1, 0],
      excludeProvenanceKinds: ["consolidated"],
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.excludeProvenanceKinds).toEqual(["consolidated"]);
  });

  it("除外を指定しても、index.totalInScope・groups は除外なしの recall と同じ（除外した行もスコープ内に数える）", async () => {
    const stores = await seed();
    const runtime = buildRuntime(stores);
    const without = await runtime.recall(ctx, { vector: [1, 0] });
    const withExclude = await runtime.recall(ctx, {
      vector: [1, 0],
      excludeProvenanceKinds: ["consolidated"],
    });

    // 前提（対照）: 除外は効いていて、返る記憶は減る。スコープ内は5件のまま。
    expect(without.memories).toHaveLength(5);
    expect(withExclude.memories).toHaveLength(3);
    expect(without.index.totalInScope).toBe(5);
    expect(withExclude.index.totalInScope).toBe(without.index.totalInScope);
    expect(withExclude.index.groups).toEqual(without.index.groups);
  });
});

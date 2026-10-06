import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { Memory, NewMemory } from "../memory.js";
import type { VectorFilter, VectorStore } from "../interfaces/vector-store.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores, withSearchMany } from "./runtime-fakes.js";

/**
 * #932 の確かめ直し（#1774）。`recall-association-search-many.test.ts` が見ていない3つ：
 *
 * 1. 束ねる経路（`searchMany`）に渡す `limit`・`filter` は、search に戻る経路でアンカーごとに渡すものと同じ。
 *    （既存の歯は「`recall()` の結果が一致する」だけで、絞り込みの無いシナリオなので、filter を絞っても
 *    limit を1つ増やしても結果が変わらず通る）。
 * 2. `searchMany` が、渡した key を Map に返さなくても（契約の違反を `?? []` で受ける多層防御）、`recall()` は落ちない。
 * 3. 連想の起点になるアンカーが1つも `getVectors` で引けなければ、`searchMany` を呼ばない
 *    （空のクエリ列で往復を撃たない）。
 */

const T0 = new Date("2026-06-01T00:00:00.000Z");
const ctx: Ctx = { tenantId: "tenant-1", subjectId: "subject-1" };

function newMemory(digest: string): NewMemory {
  return {
    tenantId: "tenant-1",
    subjectId: "subject-1",
    sourceObservationId: null,
    extractorVersion: null,
    content: digest,
    contentHash: `hash-${digest}`,
    digest,
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: [],
    attributes: { team: "x" },
    occurredAt: null,
    recordedAt: T0,
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 24 * 365 * 10,
    decayFloorAt: defaultDecayStrategy.floorAt({
      recordedAt: T0,
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours: 24 * 365 * 10,
    }),
    embeddingStatus: "ready",
  };
}

type SearchOpts = { limit: number; filter: VectorFilter };

async function scenario(mode: "bundled" | "fallback" | "bundled-empty-map" | "bundled-no-vectors") {
  const stores = createFakeRuntimeStores();
  const wrapped = withSearchMany(stores.vectorStore);
  const searchOpts: SearchOpts[] = [];
  const base: VectorStore = {
    ...wrapped,
    search: (c, s, q, o) => {
      searchOpts.push(o);
      return wrapped.search(c, s, q, o);
    },
  };
  let vectorStore: VectorStore = base;
  if (mode === "fallback") vectorStore = { ...base, searchMany: undefined };
  if (mode === "bundled-empty-map") vectorStore = { ...base, searchMany: async () => new Map() };
  if (mode === "bundled-no-vectors") vectorStore = { ...base, getVectors: async () => [] };
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore,
    lexicalStore: stores.lexicalStore,
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
    clock: { now: () => T0 },
  });
  const put = async (digest: string, vector: number[]): Promise<Memory> => {
    const memory = await stores.memoryStore.createMemory(ctx, newMemory(digest));
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, memory.id, vector);
    return memory;
  };
  await put("アンカーY", [0.8, 0.6, 0]);
  await put("アンカーZ", [0.8, 0, 0.6]);
  await put("Yの近傍", [0, 1, 0]);
  await put("Zの近傍", [0, 0, 1]);
  const result = await runtime.recall(ctx, {
    vector: [1, 0, 0],
    limit: 2,
    attributes: { team: "x" },
    association: { maxCount: 5, anchorCount: 2 },
  });
  return { result, wrapped, searchOpts };
}

describe("recall() 段3.5 — searchMany に渡す limit・filter は、search に戻る経路と同じ（#932）", () => {
  it("束ねる経路が渡す opts は、戻る経路でアンカーごとに渡す opts と同じ（subjectId・attributes・status を含む）", async () => {
    const bundled = await scenario("bundled");
    const fallback = await scenario("fallback");
    expect(bundled.wrapped.searchManyCalls).toHaveLength(1);
    const manyOpts = bundled.wrapped.searchManyCalls[0]!.opts;

    // 前提：絞り込みが実際に載っている
    expect(manyOpts.filter.tenantId).toBe("tenant-1");
    expect(manyOpts.filter.subjectId).toBe("subject-1");
    expect(manyOpts.filter.attributes).toEqual({ team: "x" });
    expect(manyOpts.filter.status).toEqual(["active", "contested"]);

    // 戻る経路の search()（段1の1回を除いた、アンカーごとの2回）と同じ opts
    const perAnchor = fallback.searchOpts.slice(-2);
    expect(perAnchor).toHaveLength(2);
    for (const opts of perAnchor) {
      expect(opts).toEqual(manyOpts);
    }
  });

  it("searchMany が渡した key を Map に返さなくても recall() は落ちず、連想枠が空になる", async () => {
    const { result } = await scenario("bundled-empty-map");
    expect(result.memories.map((m) => m.retrievedVia)).not.toContain("association");
  });

  it("アンカーのベクトルが1つも引けなければ、searchMany を呼ばない", async () => {
    const { wrapped } = await scenario("bundled-no-vectors");
    expect(wrapped.searchManyCalls).toHaveLength(0);
  });
});

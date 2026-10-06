import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { Memory, NewMemory } from "../memory.js";
import { compareScoredCandidates } from "../recall-runtime.js";
import type { ScoreBreakdown } from "../recall.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * 段2の並べ替え（`compareScoredCandidates`）で `total` が `NaN` の候補が有限の候補より
 * 後ろに回ること、と、段3.5（連想枠）の2つの並べ替えの歯。
 *
 * - アンカー類似度の降順（`associationHits.sort`）: 同点のとき、`recall-runtime.ts` 自身は
 *   `memoryId` などで並べ直さず、vectorStore が返した順をそのまま保つ。
 * - 順位キー（`rankKey = similarity × score.total`）の降順（`rankedCandidates.sort`）:
 *   `total` が `NaN` の候補は、有限の候補より後ろに回る。
 *
 * `score-sort-nan.test.ts` は段3.5の2箇所を、非 export の比較関数の複製で確かめている。
 * 本物の `recall-runtime.ts` の2か所は、ここで `runtime.recall()` を通して確かめる。
 */

const T0 = new Date("2026-06-01T00:00:00.000Z");
const ctx: Ctx = { tenantId: "tenant-1" };
const HALF_LIFE_HOURS = 24 * 365 * 10;

const QUERY_VECTOR = [1, 0, 0];
const ANCHOR_VECTOR = [0.8, 0.6, 0];
const CANDIDATE_VECTOR = [0, 1, 0];

function buildRuntime(reverseTies: boolean) {
  const stores = createFakeRuntimeStores();
  if (reverseTies) {
    // 距離が同点のとき、`memoryId` の降順で返す vectorStore（Fake の既定は昇順）。
    // 距離そのものの順序は変えない。
    const reorder = <T extends { memoryId: string; distance: number }>(hits: T[]): T[] =>
      [...hits].sort(
        (a, b) =>
          a.distance - b.distance ||
          (a.memoryId < b.memoryId ? 1 : a.memoryId > b.memoryId ? -1 : 0),
      );
    const store = stores.vectorStore;
    const search = store.search.bind(store);
    store.search = async (...args: Parameters<typeof search>) => reorder(await search(...args));
  }
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
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
  return { runtime, stores };
}

function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  const strength = overrides.strength ?? 1;
  const halfLifeHours = overrides.halfLifeHours ?? HALF_LIFE_HOURS;
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
    recordedAt: T0,
    lastReinforcedAt: null,
    strength,
    halfLifeHours,
    decayFloorAt:
      overrides.decayFloorAt ??
      defaultDecayStrategy.floorAt({
        recordedAt: T0,
        lastReinforcedAt: null,
        strength,
        halfLifeHours,
      }),
    embeddingStatus: "ready",
    ...overrides,
  };
}

async function createEmbeddedMemory(
  stores: ReturnType<typeof createFakeRuntimeStores>,
  vector: number[],
  overrides: Partial<NewMemory> = {},
): Promise<Memory> {
  const memory = await stores.memoryStore.createMemory(ctx, newMemory(overrides));
  await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, memory.id, vector);
  return memory;
}

describe("compareScoredCandidates — total が NaN の候補は有限の候補より後ろ（段2）", () => {
  function scored(id: string, total: number) {
    return {
      memory: { id, recordedAt: T0, occurredAt: null } as unknown as Memory,
      retrievedVia: "ann" as const,
      score: { total } as unknown as ScoreBreakdown,
    };
  }

  it("NaN が先頭・途中・末尾のどこにあっても、並べ替えると最後尾に来る", () => {
    const finite = [scored("A", 0.9), scored("B", 0.8), scored("C", 0.1)];
    const nan = scored("N", Number.NaN);
    for (const position of [0, 1, 2, 3]) {
      const input = [...finite];
      input.splice(position, 0, nan);
      const sorted = [...input].sort(compareScoredCandidates);
      expect(sorted.map((c) => c.memory.id)).toEqual(["A", "B", "C", "N"]);
    }
  });

  it("2つを直接比べると、NaN のほうが後ろ（どちらの引数に来ても）", () => {
    expect(compareScoredCandidates(scored("N", Number.NaN), scored("A", 0.5))).toBeGreaterThan(0);
    expect(compareScoredCandidates(scored("A", 0.5), scored("N", Number.NaN))).toBeLessThan(0);
  });
});

describe("recall() — 連想枠の並べ替え（段3.5）", () => {
  it("アンカー類似度が同点の候補は、vectorStore が返した順のまま席に着く（memoryId で並べ直さない）", async () => {
    const { runtime, stores } = buildRuntime(true);
    await createEmbeddedMemory(stores, ANCHOR_VECTOR, { digest: "アンカー" });
    const created: Memory[] = [];
    for (const digest of ["A", "B", "C"]) {
      created.push(await createEmbeddedMemory(stores, CANDIDATE_VECTOR, { digest }));
    }
    // vectorStore は同点を memoryId の降順で返す。席の先頭に着くのは最大の memoryId。
    const idsDescending = created.map((m) => m.id).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));

    const result = await runtime.recall(ctx, {
      vector: QUERY_VECTOR,
      association: { maxCount: 1, anchorCount: 1 },
    });
    const associated = result.memories
      .filter((m) => m.retrievedVia === "association")
      .map((m) => m.memoryId);
    expect(associated).toEqual([idsDescending[0]]);
  });

  it("対照条件: vectorStore が同点を memoryId の昇順で返せば、席に着くのは最小の memoryId", async () => {
    const { runtime, stores } = buildRuntime(false);
    await createEmbeddedMemory(stores, ANCHOR_VECTOR, { digest: "アンカー" });
    const created: Memory[] = [];
    for (const digest of ["A", "B", "C"]) {
      created.push(await createEmbeddedMemory(stores, CANDIDATE_VECTOR, { digest }));
    }
    const idsAscending = created.map((m) => m.id).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    const result = await runtime.recall(ctx, {
      vector: QUERY_VECTOR,
      association: { maxCount: 1, anchorCount: 1 },
    });
    const associated = result.memories
      .filter((m) => m.retrievedVia === "association")
      .map((m) => m.memoryId);
    expect(associated).toEqual([idsAscending[0]]);
  });

  it("順位キーが NaN になる候補（記憶の strength が NaN）は、有限の候補に席を譲る", async () => {
    const { runtime, stores } = buildRuntime(false);
    // 先に作った（同点なら先に並ぶ）ほうを NaN にする。NaN の扱いが順位を動かさないなら、
    // 先に作った NaN の候補が席を取ってしまう。
    // store の検証（strength は (0, 1]）は通せないので、読み出しのときだけ差し替える。
    await createEmbeddedMemory(stores, ANCHOR_VECTOR, { digest: "アンカー" });
    const nan = await createEmbeddedMemory(stores, CANDIDATE_VECTOR, { digest: "NaN" });
    const ok = await createEmbeddedMemory(stores, CANDIDATE_VECTOR, { digest: "OK" });
    const getMany = stores.memoryStore.getMany.bind(stores.memoryStore);
    stores.memoryStore.getMany = async (...args: Parameters<typeof getMany>) =>
      (await getMany(...args)).map((m) => (m.id === nan.id ? { ...m, strength: Number.NaN } : m));
    const result = await runtime.recall(ctx, {
      vector: QUERY_VECTOR,
      association: { maxCount: 1, anchorCount: 1 },
    });
    expect(
      result.memories.filter((m) => m.retrievedVia === "association").map((m) => m.memoryId),
    ).toEqual([ok.id]);
  });
});

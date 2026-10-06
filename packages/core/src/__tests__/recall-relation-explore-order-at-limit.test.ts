import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { MemoryId } from "../ids.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import type { Relation } from "../interfaces/relation-store.js";
import type { NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * Issue #1734（2026-09-30 マージ分の確かめ直し）の #1467 のすり抜け R1（ADR 0381 の 2026-09-30 追記・約束1）。
 * 段3の BFS は、`listRelated` の結果（`related`）を `memoryId` の昇順に並べてから処理する
 * （`listRelated` の返す順は契約が規定しない）。この並べ替えだけを外しても、`companionOf` は変わらない
 * （同じ親から出る子どうしは発見元が同じ）ので、既存の歯は赤にならなかった。
 * 観測できるのは、探索が安全弁（訪れた数の上限）で打ち切られるとき、どの id が先に切り捨てられるかだけ。
 * ここでは、群が安全弁より大きく、`listRelated` が id の降順（昇順の逆）で返す store を使い、
 * 打ち切り後に残る id が「id の小さいほう」から決まることを見る。
 */
const ctx: Ctx = { tenantId: "tenant-explore-order" };
const NOW = new Date("2026-06-01T00:00:00.000Z");
const GROUP_SIZE = 40;
// relationMaxCount: 1 → 安全弁は 10（owner を含む）。owner 以外に9件を訪れて止まる。
const RELATION_MAX_COUNT = 1;
const VISITED_LIMIT = RELATION_MAX_COUNT * 10;

function newMemory(i: number): NewMemory {
  const halfLifeHours = 24 * 365 * 10;
  return {
    tenantId: ctx.tenantId,
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: "本文",
    contentHash: `hash-${Math.random()}`,
    digest: `m${String(i).padStart(3, "0")}`,
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: [],
    occurredAt: null,
    recordedAt: NOW,
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours,
    decayFloorAt: defaultDecayStrategy.floorAt({
      recordedAt: NOW,
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours,
    }),
    embeddingStatus: "pending",
    // 添字が大きいほど新しい（残る同伴は validFrom の新しい順）。
    validFrom: new Date(Date.UTC(2020, 0, 1 + i)),
    validUntil: null,
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

const byIdDesc = (a: Relation, b: Relation): number =>
  a.memoryId < b.memoryId ? 1 : a.memoryId > b.memoryId ? -1 : 0;

async function recallWith(mode: "listRelated" | "listRelatedMany") {
  const stores = createFakeRuntimeStores();
  const relationStore = stores.relationStore;
  const innerListRelated = relationStore.listRelated.bind(relationStore);
  // どちらの口も、相手側を id の降順で返す（契約は順を規定しない）。
  relationStore.listRelated = async (c, id, kind) =>
    (await innerListRelated(c, id, kind)).sort(byIdDesc);
  if (mode === "listRelatedMany") {
    relationStore.listRelatedMany = async (c, ids, kind) =>
      Promise.all(ids.map(async (id) => (await innerListRelated(c, id, kind)).sort(byIdDesc)));
  }
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
    relationStore,
  });
  const ids: MemoryId[] = [];
  for (let i = 0; i < GROUP_SIZE; i++) {
    ids.push((await stores.memoryStore.createMemory(ctx, newMemory(i))).id);
  }
  await runtime.markContestedGroup!(ctx, ids);
  await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, ids[0]!, [1, 0]);
  const result = await runtime.recall(ctx, {
    vector: [1, 0],
    relationMaxCount: RELATION_MAX_COUNT,
  });
  return { ids, result };
}

describe("段3の探索が安全弁で打ち切られるとき、id の小さいほうから訪れる（#1467 R1）", () => {
  it.each([["listRelated"], ["listRelatedMany"]] as const)(
    "%s が id の降順で返しても、残る同伴は id の昇順で先に訪れた記憶から決まる",
    async (mode) => {
      const { ids, result } = await recallWith(mode);
      const owner = ids[0]!;
      const others = ids.slice(1);
      // 訪れるのは owner 以外の id の昇順で先頭の (安全弁 - 1) 件。そのうち validFrom が最も新しい1件が残る。
      const ascending = [...others].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const visited = ascending.slice(0, VISITED_LIMIT - 1);
      const newest = (xs: MemoryId[]) =>
        xs.reduce((a, b) => (ids.indexOf(a) > ids.indexOf(b) ? a : b));
      const expected = newest(visited);
      // 区別できる場面であること（降順で訪れた場合に残る1件は、別の記憶になる）。
      const wrongVisited = [...ascending].reverse().slice(0, VISITED_LIMIT - 1);
      expect(newest(wrongVisited)).not.toBe(expected);

      const companions = result.memories.filter((m) => m.retrievedVia === "mandatory_companion");
      expect(companions.map((c) => c.memoryId)).toEqual([expected]);
      expect(companions.map((c) => c.memoryId)).not.toContain(owner);
      // 安全弁で止まったので lower_bound、切った件数は訪れた (安全弁 - 1) 件 - 残した1件。
      expect(result.omitted).toContainEqual({
        kind: "over_limit",
        stage: "relation",
        count: VISITED_LIMIT - 1 - RELATION_MAX_COUNT,
        countKind: "lower_bound",
      });
    },
  );
});

// 期待値は、同じ内容を本物の `PostgresLexicalStore.search`（Postgres 17、UTF8 / C.UTF-8）で引いて得た値。
// 「ASCII」は 0x00–0x7F（`[[:ascii:]]`）まで。Latin-1 の `ï`（U+00EF）は ASCII ではない。

import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemory } from "../memory.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

const ctx: Ctx = { tenantId: "fake-lexical-non-ascii-run-boundary-tenant" };
const NOW = new Date("2026-06-01T00:00:00.000Z");

const TANAKA = "田";
const I_DIAERESIS = "ï";

function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
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
    recordedAt: NOW,
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 24 * 365 * 10,
    decayFloorAt: new Date(NOW.getTime() + 1000 * 60 * 60 * 24 * 365 * 5),
    embeddingStatus: "pending",
    ...overrides,
  };
}

/** `rank` の尺度は adapter ごとに違ってよい（`LexicalHit.rank` の契約）ので、`memoryId` と `coverage` だけを見る。 */
async function search(stores: ReturnType<typeof createFakeRuntimeStores>, query: string) {
  const hits = await stores.lexicalStore.search(ctx, query, {
    limit: 10,
    filter: { tenantId: ctx.tenantId },
  });
  return hits.map((hit) => ({ memoryId: hit.memoryId, coverage: hit.coverage }));
}

describe("FakeLexicalStore.search — 非 ASCII の連なりの境目（Postgres に実測で揃える）", () => {
  it("クエリ側: 非 ASCII の連なりは空白に落ちて前後の語を分ける（foo と bar の2語。つなげて foobar にしない）", async () => {
    const stores = createFakeRuntimeStores();
    const foo = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: "foo", contentHash: "run-foo" }),
    );

    expect(await search(stores, `foo${TANAKA}bar`)).toEqual([{ memoryId: foo.id, coverage: 0.5 }]);

    // 対照: つなげた1語は何にも当たらない（Postgres も0件）。
    expect(await search(stores, "foobar")).toEqual([]);
  });

  it("本文側: ASCII でない Latin-1 の文字（ï）の前後で割れる（naïve は na・ï・ve。クエリ ve が当たる）", async () => {
    const stores = createFakeRuntimeStores();
    const naive = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: `na${I_DIAERESIS}ve`, contentHash: "run-naive" }),
    );

    expect(await search(stores, "ve")).toEqual([{ memoryId: naive.id, coverage: 1 }]);
    expect(await search(stores, "na")).toEqual([{ memoryId: naive.id, coverage: 1 }]);
  });

  it("クエリ側: ASCII でない Latin-1 の文字（ï）も落として2語にする（na ve に当たる。na・ï・ve のフレーズにしない）", async () => {
    const stores = createFakeRuntimeStores();
    const spaced = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: "na ve", contentHash: "run-na-ve" }),
    );

    expect(await search(stores, `na${I_DIAERESIS}ve`)).toEqual([
      { memoryId: spaced.id, coverage: 1 },
    ]);
  });
});

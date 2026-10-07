// 期待値は、同じ内容を本物の `PostgresLexicalStore.search` で引いて得た値。

import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemory } from "../memory.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

const ctx: Ctx = { tenantId: "fake-lexical-postgres-alignment-tenant" };
const NOW = new Date("2026-06-01T00:00:00.000Z");

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

describe("FakeLexicalStore.search — 非ASCIIだけのクエリ・ASCII境界の分割を PostgresLexicalStore に揃える（Issue #951）", () => {
  it("ギリシャ語（語末までギリシャ文字）を書いて、同じ語・小文字化した語のどちらで探しても0件（実測: 本物の Postgres は両方とも0件）", async () => {
    const stores = createFakeRuntimeStores();
    await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: "ΟΔΟΣ", contentHash: "greek-exact" }),
    );

    const sameCase = await stores.lexicalStore.search(ctx, "ΟΔΟΣ", {
      limit: 10,
      filter: { tenantId: ctx.tenantId },
    });
    const lowerFinalSigma = await stores.lexicalStore.search(ctx, "οδος", {
      limit: 10,
      filter: { tenantId: ctx.tenantId },
    });

    expect(sameCase).toEqual([]);
    expect(lowerFinalSigma).toEqual([]);
  });

  it("本文が「100」+ ケルビン記号(U+212A)のとき、クエリ「100k」は一致しない（実測: 本物の Postgres は両 regime とも0件）", async () => {
    const stores = createFakeRuntimeStores();
    await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: `100K`, contentHash: "kelvin-100k" }),
    );

    const hits = await stores.lexicalStore.search(ctx, "100k", {
      limit: 10,
      filter: { tenantId: ctx.tenantId },
    });

    expect(hits).toEqual([]);
  });

  it("同じ本文で、クエリ「100」（ASCII の連なりだけ）は一致する（実測: 本物の Postgres は両 regime とも1件）", async () => {
    const stores = createFakeRuntimeStores();
    const memory = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: `100K`, contentHash: "kelvin-100-alone" }),
    );

    const hits = await stores.lexicalStore.search(ctx, "100", {
      limit: 10,
      filter: { tenantId: ctx.tenantId },
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.memoryId).toBe(memory.id);
    expect(hits[0]?.coverage).toBe(1);
  });

  // 「k」単独のクエリは Postgres の regime に依存する（UTF8 + en_US.UTF-8 は1件、SQL_ASCII + C は0件）。
  // `FakeLexicalStore` は `toLowerCase()`（ロケール非依存）なので UTF8 側と一致する。SQL_ASCII 側との差は Postgres 自身の regime 間の差で、この歯の対象外。
  it("同じ本文で、クエリ「k」単独は一致する（実測: UTF8 + en_US.UTF-8 regime。SQL_ASCII + C は0件——regime 依存、確かめていないことの節参照）", async () => {
    const stores = createFakeRuntimeStores();
    const memory = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: `100K`, contentHash: "kelvin-k-alone" }),
    );

    const hits = await stores.lexicalStore.search(ctx, "k", {
      limit: 10,
      filter: { tenantId: ctx.tenantId },
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.memoryId).toBe(memory.id);
  });

  it("非ASCIIだけのクエリ（日本語）は0件を返す（実測: 本物の Postgres は両 regime とも0件）", async () => {
    const stores = createFakeRuntimeStores();
    await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: "田中さんのメモ", contentHash: "japanese-only-content" }),
    );

    const hits = await stores.lexicalStore.search(ctx, "田中", {
      limit: 10,
      filter: { tenantId: ctx.tenantId },
    });

    expect(hits).toEqual([]);
  });
});

describe("FakeLexicalStore.search — 回帰しないこと（Issue #951 の修正が既存の約束を壊していないか）", () => {
  it("PROJ-1234 は大文字小文字を区別せず引ける（実測: 本物の Postgres は両 regime とも1件。以前は FakeLexicalStore に大文字小文字の区別が残っていた）", async () => {
    const stores = createFakeRuntimeStores();
    const memory = await stores.memoryStore.createMemory(
      ctx,
      newMemory({
        content: "PROJ-1234 の障害対応メモ。対応者は鈴木。",
        contentHash: "proj-1234-case",
      }),
    );

    const sameCase = await stores.lexicalStore.search(ctx, "PROJ-1234", {
      limit: 10,
      filter: { tenantId: ctx.tenantId },
    });
    const lowerCase = await stores.lexicalStore.search(ctx, "proj-1234", {
      limit: 10,
      filter: { tenantId: ctx.tenantId },
    });

    expect(sameCase).toHaveLength(1);
    expect(sameCase[0]?.memoryId).toBe(memory.id);
    expect(lowerCase).toHaveLength(1);
    expect(lowerCase[0]?.memoryId).toBe(memory.id);
  });

  it("日本語文中の ASCII 識別子（PROJ-1234の納期、間に空白なし）が引ける（実測: 本物の Postgres は1件）", async () => {
    const stores = createFakeRuntimeStores();
    const memory = await stores.memoryStore.createMemory(
      ctx,
      newMemory({
        content: "四半期レビューでPROJ-1234の納期が来週まで延びました",
        contentHash: "proj-1234-embedded",
      }),
    );

    const hits = await stores.lexicalStore.search(ctx, "PROJ-1234", {
      limit: 10,
      filter: { tenantId: ctx.tenantId },
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.memoryId).toBe(memory.id);
    expect(hits[0]?.coverage).toBe(1);
  });

  it("偽陽性の点検: 似た接頭辞の識別子（PROJ-5678）は誤爆しない（実測: 本物の Postgres も一致しない。websearch_to_tsquery のフレーズ隣接演算子と同じ結果——FakeLexicalStore はクエリを空白区切りの1語のまま部分文字列一致するため、たまたま同じ結果になる）", async () => {
    const stores = createFakeRuntimeStores();
    const gold = await stores.memoryStore.createMemory(
      ctx,
      newMemory({
        content: "PROJ-1234 の障害対応メモ。対応者は鈴木。",
        contentHash: "proj-1234-gold",
      }),
    );
    await stores.memoryStore.createMemory(
      ctx,
      newMemory({
        content: "PROJ-5678 の障害対応メモ。対応者は山田。",
        contentHash: "proj-5678-decoy",
      }),
    );

    const hits = await stores.lexicalStore.search(ctx, "PROJ-1234", {
      limit: 10,
      filter: { tenantId: ctx.tenantId },
    });

    expect(hits.map((h) => h.memoryId)).toEqual([gold.id]);
  });
});

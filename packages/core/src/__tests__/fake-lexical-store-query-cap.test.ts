// クローン miku の委譲先が書いた回帰テスト。オーナーではない。
//
// Issue #878（2026-09-26）: `PostgresLexicalStore`/`PostgresTrigramLexicalStore` に
// クエリの異なる語数・1語あたりの文字数・クエリ全体の文字数の上限を入れた。
// `FakeLexicalStore` にも同じ形の上限を入れる（`runtime-fakes.ts` の
// `LEXICAL_QUERY_MAX_DISTINCT_WORDS`/`LEXICAL_QUERY_MAX_WORD_CHARS`/
// `LEXICAL_QUERY_MAX_TOTAL_CHARS`/`capFakeLexicalQueryTerms`/
// `capFakeLexicalQueryTotalChars` の doc 参照）。
//
// **結果（一致する/しない）で見る——時間では見ない**（fake 実装は計算量の問題を
// そもそも持たないため、この歯は「postgres 側と同じ契約になっているか」だけを見る）。

import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemory } from "../memory.js";
import {
  createFakeRuntimeStores,
  LEXICAL_QUERY_MAX_DISTINCT_WORDS,
  LEXICAL_QUERY_MAX_TOTAL_CHARS,
  LEXICAL_QUERY_MAX_WORD_CHARS,
} from "./runtime-fakes.js";

const ctx: Ctx = { tenantId: "fake-lexical-query-cap-tenant" };
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

function fillerWords(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `filler${i}`);
}

describe("FakeLexicalStore.search: クエリの異なる語数・1語あたりの文字数の上限（Issue #878）", () => {
  it(`語数: 上限（${LEXICAL_QUERY_MAX_DISTINCT_WORDS}）を超える語は使われない`, async () => {
    const stores = createFakeRuntimeStores();
    const withinCap = fillerWords(LEXICAL_QUERY_MAX_DISTINCT_WORDS);
    const beyondCapWord = "onlybeyondcap";

    await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: `記憶の本文に ${beyondCapWord} という語だけを含む` }),
    );

    const query = [...withinCap, beyondCapWord].join(" ");
    const hits = await stores.lexicalStore.search(ctx, query, {
      limit: 50,
      filter: { tenantId: ctx.tenantId },
    });

    expect(hits).toHaveLength(0);
  });

  it("語数: 上限ちょうどの語数まではすべて使われる", async () => {
    const stores = createFakeRuntimeStores();
    const withinCap = fillerWords(LEXICAL_QUERY_MAX_DISTINCT_WORDS);
    const lastWord = withinCap[withinCap.length - 1]!;

    await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: `記憶の本文に ${lastWord} という語を含む` }),
    );

    const query = withinCap.join(" ");
    const hits = await stores.lexicalStore.search(ctx, query, {
      limit: 50,
      filter: { tenantId: ctx.tenantId },
    });

    expect(hits).toHaveLength(1);
  });

  it(`文字数: 上限（${LEXICAL_QUERY_MAX_WORD_CHARS}文字）を超えた語は、先頭からその文字数だけに切り詰められた形で使われる`, async () => {
    const stores = createFakeRuntimeStores();
    const wordAtCap = "z".repeat(LEXICAL_QUERY_MAX_WORD_CHARS);
    const queryWordBeyondCap = wordAtCap + "extratailbeyondcap";
    expect(queryWordBeyondCap.length).toBeGreaterThan(LEXICAL_QUERY_MAX_WORD_CHARS);

    await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: `記憶の本文に ${wordAtCap} という語だけを含む` }),
    );

    const hits = await stores.lexicalStore.search(ctx, queryWordBeyondCap, {
      limit: 50,
      filter: { tenantId: ctx.tenantId },
    });

    expect(hits).toHaveLength(1);
  });

  it(`全体の文字数: 上限（${LEXICAL_QUERY_MAX_TOTAL_CHARS}文字）を超えた後ろの部分は使われない`, async () => {
    const stores = createFakeRuntimeStores();

    // `FakeLexicalStore.search` の一致判定は（postgres/testkit のようなトークン単位の
    // 完全一致ではなく）`memory.content.includes(t)` という部分文字列一致である
    // （このファイル上、`search` の実装参照）。そのため postgres/testkit の歯のように
    // マーカー語の一部だけを上限の内側に残す形にすると、切り詰められた断片
    // （マーカー語の先頭部分）がそれ自体、本文中のマーカー語の部分文字列として
    // 一致してしまい、この歯の意図（「上限を超えた後ろの部分が使われない」）を
    // 正しく検査できない。⟹ 埋め文字だけで上限をちょうど埋め切り、マーカー語が
    // 1文字も上限の内側に残らない形にする。
    const filler = "p".repeat(LEXICAL_QUERY_MAX_TOTAL_CHARS);
    const marker = "onlybeyondtotalcap";
    const query = `${filler} ${marker}`;
    expect(query.length).toBeGreaterThan(LEXICAL_QUERY_MAX_TOTAL_CHARS);

    await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: `記憶の本文に ${marker} という語だけを含む` }),
    );

    const hits = await stores.lexicalStore.search(ctx, query, {
      limit: 50,
      filter: { tenantId: ctx.tenantId },
    });

    expect(hits).toHaveLength(0);
  });

  it("全体の文字数: 上限に触れないクエリは1バイトも変わらない（通常のクエリの挙動は変わらない）", async () => {
    const stores = createFakeRuntimeStores();

    await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: "obsidian shards glimmer in the cave" }),
    );

    const hits = await stores.lexicalStore.search(ctx, "obsidian shards", {
      limit: 50,
      filter: { tenantId: ctx.tenantId },
    });

    expect(hits).toHaveLength(1);
  });
});

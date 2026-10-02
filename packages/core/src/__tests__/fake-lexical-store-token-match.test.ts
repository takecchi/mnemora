// クローン miku の委譲先が書いた回帰テスト。オーナーではない（ADR 0513）。
//
// `FakeLexicalStore` の一致判定を、`PostgresLexicalStore`（`to_tsvector('simple', …)`）の
// 「語（token）一致」に揃える歯。以前は `normalizedContent.includes(t)` の部分文字列一致で、
// query `a` が content `alpha` に当たった（ADR 0509 の割れ 1）。
// 期待値はすべて、手元の PostgreSQL 17 で `mnemora_lexical_coverage(content, query)` を直接呼んで実測した値。
// 同じ表を testkit の `InMemoryLexicalStore` も `in-memory-lexical-store-token-match.test.ts` で通す。

import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemory } from "../memory.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

const ctx: Ctx = { tenantId: "fake-lexical-token-match-tenant" };
const NOW = new Date("2026-06-01T00:00:00.000Z");

function newMemory(content: string): NewMemory {
  return {
    tenantId: ctx.tenantId,
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content,
    contentHash: `hash-${content}`,
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
  };
}

// [content, query, 実測した coverage（null は「行が返らない」）]
const CASES: [string, string, number | null][] = [
  ["alpha", "a", null],
  ["alpha", "alp", null],
  ["alpha", "alpha", 1],
  ["PROJ-12", "PROJ-12", 1],
  ["PROJ-12", "proj", 1],
  ["proj x 12", "PROJ-12", null],
  ["gamma", "gamma PROJ-12", 0.5],
  ["PROJ-12 gamma", "gamma PROJ-12", 1],
  ["PROJ-12", "proj-12 PROJ-12", 1],
  ["x PROJ-12", "PROJ-12 x", 1],
  ["foo_bar", "bar", 1],
  ["foo_bar", "foo_bar", 1],
  ["foo bar", "foo_bar", 1],
  ["bar foo", "foo_bar", null],
  ["日本語text", "text", 1],
  ["日本語text", "日本語", null],
  ["a b", "---", null],
  ["a b", "a ---", 1],
];

describe("FakeLexicalStore.search — 語（token）一致で、query の単位は空白区切りの語（ADR 0513、Postgres に実測で揃える）", () => {
  for (const [content, query, expected] of CASES) {
    it(`content ${JSON.stringify(content)} × query ${JSON.stringify(query)} → ${expected === null ? "0件" : `coverage ${expected}`}`, async () => {
      const stores = createFakeRuntimeStores();
      await stores.memoryStore.createMemory(ctx, newMemory(content));
      const hits = await stores.lexicalStore.search(ctx, query, {
        limit: 10,
        filter: { tenantId: ctx.tenantId },
      });
      if (expected === null) {
        expect(hits).toEqual([]);
      } else {
        expect(hits).toHaveLength(1);
        expect(hits[0]?.coverage).toBe(expected);
      }
    });
  }
});

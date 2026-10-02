// クローン miku の委譲先が書いた回帰テスト。オーナーではない（ADR 0513）。
//
// `InMemoryLexicalStore` の一致判定を、`PostgresLexicalStore`（`to_tsvector('simple', …)`）に揃える歯。
// 以前は query を Unicode の英数字境界で割った語の集合として数え、`PROJ-12` を `proj`・`12` の 2 語にして
// coverage の分母が Postgres とずれた（ADR 0509 の割れ 2）。Postgres は空白区切りの 1 語を 1 単位として数え、
// その語の中の token が隣接して並ぶこと（`websearch_to_tsquery` の `"..."`）を要る。
// 期待値はすべて、手元の PostgreSQL 17 で `mnemora_lexical_coverage(content, query)` を直接呼んで実測した値
// （`FakeLexicalStore` の同じ表: `packages/core/src/__tests__/fake-lexical-store-token-match.test.ts`）。

import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "../test-data.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { InMemoryLexicalStore } from "../__fixtures__/in-memory-lexical-store.js";

const TENANT = "lexical-token-match-tenant";
const ctx: Ctx = { tenantId: TENANT };

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

describe("InMemoryLexicalStore.search — query の単位は空白区切りの語で、語の中の token は隣接を要る（ADR 0513、Postgres に実測で揃える）", () => {
  for (const [content, query, expected] of CASES) {
    it(`content ${JSON.stringify(content)} × query ${JSON.stringify(query)} → ${expected === null ? "0件" : `coverage ${expected}`}`, async () => {
      const memoryStore = new InMemoryMemoryStore();
      const lexicalStore = new InMemoryLexicalStore(memoryStore);
      await memoryStore.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: TENANT, content, contentHash: `hash-${content}` }),
      );
      const hits = await lexicalStore.search(ctx, query, {
        limit: 10,
        filter: { tenantId: TENANT },
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

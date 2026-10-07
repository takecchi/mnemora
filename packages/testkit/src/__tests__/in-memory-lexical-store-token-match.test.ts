import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "../test-data.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { InMemoryLexicalStore } from "../__fixtures__/in-memory-lexical-store.js";

const TENANT = "lexical-token-match-tenant";
const ctx: Ctx = { tenantId: TENANT };

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

import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "../test-data.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { InMemoryLexicalStore } from "../__fixtures__/in-memory-lexical-store.js";

// 定数は export されていない（公開面に漏れるため）ので値を書き写す。ずれは `packages/postgres` の `lexical-query-cap-values-match.test.ts` が見る。
const LEXICAL_QUERY_MAX_WORD_CHARS = 64;

const TENANT = "in-memory-lexical-query-char-cap-tenant";

describe("InMemoryLexicalStore.search: クエリの1語あたりの文字数の上限（Issue #878）", () => {
  it(`上限（${LEXICAL_QUERY_MAX_WORD_CHARS}文字）を超えた語は、先頭からその文字数だけに切り詰められた形で使われる`, async () => {
    const memoryStore = new InMemoryMemoryStore();
    const lexicalStore = new InMemoryLexicalStore(memoryStore);
    const ctx: Ctx = { tenantId: TENANT };

    const wordAtCap = "z".repeat(LEXICAL_QUERY_MAX_WORD_CHARS);
    const queryWordBeyondCap = wordAtCap + "extratailbeyondcap";
    expect(queryWordBeyondCap.length).toBeGreaterThan(LEXICAL_QUERY_MAX_WORD_CHARS);

    await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        content: `記憶の本文に ${wordAtCap} という語だけを含む`,
        contentHash: "in-memory-char-cap-beyond",
      }),
    );

    const hits = await lexicalStore.search(ctx, queryWordBeyondCap, {
      limit: 50,
      filter: { tenantId: ctx.tenantId },
    });

    expect(hits).toHaveLength(1);
  });
});

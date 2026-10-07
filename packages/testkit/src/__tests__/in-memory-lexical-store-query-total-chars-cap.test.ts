import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "../test-data.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { InMemoryLexicalStore } from "../__fixtures__/in-memory-lexical-store.js";

// 定数は export されていない（公開面に漏れるため）ので値を書き写す。ずれは `packages/postgres` の `lexical-query-cap-values-match.test.ts` が見る。
const TOTAL_CHARS_CAP = 600;

const TENANT = "in-memory-lexical-query-total-chars-cap-tenant";

describe("InMemoryLexicalStore.search: クエリ全体の文字数の上限（Issue #878）", () => {
  it(`上限（${TOTAL_CHARS_CAP}文字）を超えた後ろの部分は使われない`, async () => {
    const memoryStore = new InMemoryMemoryStore();
    const lexicalStore = new InMemoryLexicalStore(memoryStore);
    const ctx: Ctx = { tenantId: TENANT };

    const filler = "p".repeat(TOTAL_CHARS_CAP - 10);
    const marker = "onlybeyondtotalcap";
    const query = `${filler} ${marker}`;
    expect(query.length).toBeGreaterThan(TOTAL_CHARS_CAP);

    await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        content: `記憶の本文に ${marker} という語だけを含む`,
        contentHash: "in-memory-total-chars-cap-beyond",
      }),
    );

    const hits = await lexicalStore.search(ctx, query, {
      limit: 50,
      filter: { tenantId: ctx.tenantId },
    });

    expect(hits).toHaveLength(0);
  });

  it("上限に触れないクエリは1バイトも変わらない（通常のクエリの挙動は変わらない）", async () => {
    const memoryStore = new InMemoryMemoryStore();
    const lexicalStore = new InMemoryLexicalStore(memoryStore);
    const ctx: Ctx = { tenantId: TENANT };

    await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        content: "obsidian shards glimmer in the cave",
        contentHash: "in-memory-total-chars-cap-normal",
      }),
    );

    const hits = await lexicalStore.search(ctx, "obsidian shards", {
      limit: 50,
      filter: { tenantId: ctx.tenantId },
    });

    expect(hits).toHaveLength(1);
  });
});

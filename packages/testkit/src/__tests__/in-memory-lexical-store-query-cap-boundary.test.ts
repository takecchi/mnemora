import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "../test-data.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { InMemoryLexicalStore } from "../__fixtures__/in-memory-lexical-store.js";

// 定数は export されていない（公開面に漏れるため）ので値を書き写す。ずれは `packages/postgres` の `lexical-query-cap-values-match.test.ts` が見る。
const TOTAL_CHARS_CAP = 600;
const DISTINCT_WORDS_CAP = 32;

const TENANT = "in-memory-lexical-query-cap-boundary-tenant";
const ctx: Ctx = { tenantId: TENANT };

async function setup(content: string) {
  const memoryStore = new InMemoryMemoryStore();
  const lexicalStore = new InMemoryLexicalStore(memoryStore);
  await memoryStore.createMemory(
    ctx,
    buildNewMemoryFixture({ tenantId: TENANT, content, contentHash: "in-memory-cap-boundary" }),
  );
  return lexicalStore;
}

describe("InMemoryLexicalStore.search: クエリの上限の境界（#919）", () => {
  const marker = "boundarymarker";

  it("全体の文字数: ちょうど上限の文字数のクエリの最後の語は、1文字も欠けずに使われる", async () => {
    const lexicalStore = await setup(`本文に ${marker} を含む`);
    const filler = "p".repeat(TOTAL_CHARS_CAP - 1 - marker.length);
    const query = `${filler} ${marker}`;
    expect(query).toHaveLength(TOTAL_CHARS_CAP);
    const hits = await lexicalStore.search(ctx, query, {
      limit: 50,
      filter: { tenantId: TENANT },
    });
    expect(hits).toHaveLength(1);
  });

  it("全体の文字数: 上限を1文字超えた分（601 文字目）は使われない", async () => {
    const lexicalStore = await setup(`本文に ${marker} を含む`);
    const filler = "p".repeat(TOTAL_CHARS_CAP - 1 - marker.length);
    const query = `${filler} ${marker}z`;
    expect(query).toHaveLength(TOTAL_CHARS_CAP + 1);
    const hits = await lexicalStore.search(ctx, query, {
      limit: 50,
      filter: { tenantId: TENANT },
    });
    expect(hits).toHaveLength(1);
  });

  it("語数: 重複（大文字小文字だけが違う語を含む）は上限の語数に数えない", async () => {
    const lexicalStore = await setup("本文に tailword だけを含む");
    const distinct = Array.from({ length: DISTINCT_WORDS_CAP - 1 }, (_, i) => `filler${i}`);
    const query = [...distinct, "FILLER0", "filler0", "Filler1", "tailword"].join(" ");
    const hits = await lexicalStore.search(ctx, query, {
      limit: 50,
      filter: { tenantId: TENANT },
    });
    expect(hits).toHaveLength(1);
  });

  it("語数: token が取れない語（---）も上限の語数に数えるので、その後ろの33語目は使われない", async () => {
    const lexicalStore = await setup("本文に tailword だけを含む");
    const distinct = Array.from({ length: DISTINCT_WORDS_CAP - 1 }, (_, i) => `filler${i}`);
    const search = (words: string[]) =>
      lexicalStore.search(ctx, words.join(" "), { limit: 50, filter: { tenantId: TENANT } });
    expect(await search([...distinct.slice(1), "---", "tailword"])).toHaveLength(1);
    expect(await search([...distinct, "---", "tailword"])).toHaveLength(0);
  });
});

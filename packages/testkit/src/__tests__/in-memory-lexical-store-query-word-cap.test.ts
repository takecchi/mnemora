// クローン miku の委譲先が書いた回帰テスト。オーナーではない。
//
// Issue #878（2026-09-26）: `PostgresLexicalStore`/`PostgresTrigramLexicalStore` に
// クエリの異なる語数の上限（32）を入れた。`InMemoryLexicalStore` にも同じ形の上限を
// 入れる（`in-memory-lexical-store.ts` の `LEXICAL_QUERY_MAX_DISTINCT_WORDS`/
// `capQueryTerms` の doc 参照）。
//
// **結果（一致する/しない）で見る——時間では見ない**（in-memory 実装は計算量の問題を
// そもそも持たないため、この歯は「postgres 側と同じ契約になっているか」だけを見る）。

import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "../test-data.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { InMemoryLexicalStore } from "../__fixtures__/in-memory-lexical-store.js";

// `in-memory-lexical-store.ts` の `LEXICAL_QUERY_MAX_DISTINCT_WORDS` は export しない
// （`pnpm api:check` の公開面に漏れるため——同ファイルの doc 参照）。値を書き写す
// ——ずれていないことは `packages/postgres` 側の歯 `lexical-query-cap-values-match.test.ts`
// が3ファイルのソースを読んで検査する。
const WORD_COUNT_AT_CAP = 32;

const TENANT = "in-memory-lexical-query-word-cap-tenant";

function fillerWords(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `filler${i}`);
}

describe("InMemoryLexicalStore.search: クエリの異なる語数の上限（Issue #878）", () => {
  it(`上限（${WORD_COUNT_AT_CAP}）を超える語は使われない——上限より後ろにしかない語は一致に効かない`, async () => {
    const memoryStore = new InMemoryMemoryStore();
    const lexicalStore = new InMemoryLexicalStore(memoryStore);
    const ctx: Ctx = { tenantId: TENANT };

    const withinCap = fillerWords(WORD_COUNT_AT_CAP);
    const beyondCapWord = "onlybeyondcap";

    await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        content: `記憶の本文に ${beyondCapWord} という語だけを含む`,
        contentHash: "in-memory-char-cap-beyond",
      }),
    );

    const query = [...withinCap, beyondCapWord].join(" ");
    const hits = await lexicalStore.search(ctx, query, {
      limit: 50,
      filter: { tenantId: ctx.tenantId },
    });

    expect(hits).toHaveLength(0);
  });

  it("上限ちょうどの語数まではすべて使われる——上限内の語だけで一致する記憶は候補に残る", async () => {
    const memoryStore = new InMemoryMemoryStore();
    const lexicalStore = new InMemoryLexicalStore(memoryStore);
    const ctx: Ctx = { tenantId: TENANT };

    const withinCap = fillerWords(WORD_COUNT_AT_CAP);
    const lastWord = withinCap[withinCap.length - 1]!;

    await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        content: `記憶の本文に ${lastWord} という語を含む`,
        contentHash: "in-memory-char-cap-within",
      }),
    );

    const query = withinCap.join(" ");
    const hits = await lexicalStore.search(ctx, query, {
      limit: 50,
      filter: { tenantId: ctx.tenantId },
    });

    expect(hits).toHaveLength(1);
  });

  it("重複する語をいくら増やしても結果は変わらない（異なる語の数だけが上限に効く）", async () => {
    const memoryStore = new InMemoryMemoryStore();
    const lexicalStore = new InMemoryLexicalStore(memoryStore);
    const ctx: Ctx = { tenantId: TENANT };

    await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        content: "alpha beta gamma が本文",
        contentHash: "in-memory-dup-1",
      }),
    );
    await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        content: "alpha だけを含む、無関係な本文",
        contentHash: "in-memory-dup-2",
      }),
    );

    const withoutDuplicates = "alpha beta gamma";
    const withManyDuplicates = Array.from(
      { length: WORD_COUNT_AT_CAP * 3 },
      (_, i) => ["alpha", "beta", "gamma"][i % 3],
    ).join(" ");

    const optsFilter = { limit: 50, filter: { tenantId: ctx.tenantId } };
    const hitsWithoutDuplicates = await lexicalStore.search(ctx, withoutDuplicates, optsFilter);
    const hitsWithManyDuplicates = await lexicalStore.search(ctx, withManyDuplicates, optsFilter);

    expect(hitsWithManyDuplicates).toEqual(hitsWithoutDuplicates);
    expect(hitsWithoutDuplicates.length).toBeGreaterThan(0);
  });
});

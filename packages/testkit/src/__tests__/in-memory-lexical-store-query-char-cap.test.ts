// クローン miku の委譲先が書いた回帰テスト。オーナーではない。
//
// Issue #878（2026-09-26）: `PostgresLexicalStore`/`PostgresTrigramLexicalStore` に
// クエリの1語あたりの文字数の上限（64）を入れた。`InMemoryLexicalStore` にも同じ形の
// 上限を入れる（`in-memory-lexical-store.ts` の `LEXICAL_QUERY_MAX_WORD_CHARS`/
// `capQueryTerms` の doc 参照）。

import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "../test-data.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { InMemoryLexicalStore } from "../__fixtures__/in-memory-lexical-store.js";

// `in-memory-lexical-store.ts` の `LEXICAL_QUERY_MAX_WORD_CHARS` は export しない
// （`pnpm api:check` の公開面に漏れるため——同ファイルの doc 参照）。値を書き写す
// ——ずれていないことは `packages/postgres` 側の歯 `lexical-query-cap-values-match.test.ts`
// が3ファイルのソースを読んで検査する。
const LEXICAL_QUERY_MAX_WORD_CHARS = 64;

const TENANT = "in-memory-lexical-query-char-cap-tenant";

describe("InMemoryLexicalStore.search: クエリの1語あたりの文字数の上限（Issue #878）", () => {
  it(`上限（${LEXICAL_QUERY_MAX_WORD_CHARS}文字）を超えた語は、先頭からその文字数だけに切り詰められた形で使われる`, async () => {
    const memoryStore = new InMemoryMemoryStore();
    const lexicalStore = new InMemoryLexicalStore(memoryStore);
    const ctx: Ctx = { tenantId: TENANT };

    // 本文の語は上限「ちょうど」の文字数——クエリはそれに続けて追加の文字を足した、
    // より長い1語。切り詰めが効いていれば本文の語と完全一致し、効いていなければ
    // 本文より長い別の語のままなので一致しない。
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

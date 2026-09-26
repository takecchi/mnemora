// クローン miku の委譲先が書いた回帰テスト。オーナーではない。
//
// Issue #878（2026-09-26）: `PostgresLexicalStore`/`PostgresTrigramLexicalStore` に
// クエリ全体の文字数の上限（600）を入れた。`InMemoryLexicalStore` にも同じ形の上限を
// 入れる（`in-memory-lexical-store.ts` の `LEXICAL_QUERY_MAX_TOTAL_CHARS`/
// `capQueryTotalChars` の doc 参照）。
//
// **結果（一致する/しない）で見る——時間では見ない**（in-memory 実装は計算量の問題を
// そもそも持たないため、この歯は「postgres 側と同じ契約になっているか」だけを見る）。

import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "../test-data.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { InMemoryLexicalStore } from "../__fixtures__/in-memory-lexical-store.js";

// `in-memory-lexical-store.ts` の `LEXICAL_QUERY_MAX_TOTAL_CHARS` は export しない
// （`pnpm api:check` の公開面に漏れるため——同ファイルの doc 参照）。値を書き写す
// ——ずれていないことは `packages/postgres` 側の歯 `lexical-query-cap-values-match.test.ts`
// が3ファイルのソースを読んで検査する。
const TOTAL_CHARS_CAP = 600;

const TENANT = "in-memory-lexical-query-total-chars-cap-tenant";

describe("InMemoryLexicalStore.search: クエリ全体の文字数の上限（Issue #878）", () => {
  it(`上限（${TOTAL_CHARS_CAP}文字）を超えた後ろの部分は使われない`, async () => {
    const memoryStore = new InMemoryMemoryStore();
    const lexicalStore = new InMemoryLexicalStore(memoryStore);
    const ctx: Ctx = { tenantId: TENANT };

    // 前半を埋め文字で TOTAL_CHARS_CAP の少し手前まで埋め、そのすぐ後ろに
    // マーカー語を続ける——クエリ全体では上限を超えるが、マーカー語の一部だけが
    // 上限の内側に残る形にする。全体の切り詰めが効いていれば、本文にある
    // マーカー語「そのもの」とは一致しない（切り詰められた断片は別の文字列になる）。
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

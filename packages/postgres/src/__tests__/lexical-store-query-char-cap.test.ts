import type { Ctx } from "@mnemora/core";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresLexicalStore } from "../lexical-store.js";
import { LEXICAL_QUERY_MAX_WORD_CHARS } from "../lexical-query-cap.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * Issue #878（2026-09-26、クローン miku の判断）: `PostgresLexicalStore.search` に渡す
 * クエリの、1語（空白を含まない語）あたりの文字数に上限
 * （{@link LEXICAL_QUERY_MAX_WORD_CHARS}）を設けたことの実測。
 *
 * `lexical-store-query-word-cap.test.ts` の語**数**の上限とは別の軸——空白を1つも
 * 含まない代わりに記号だけで長くつないだ「1語」は、語数の上限では防げない
 * （`lexical-query-cap.ts` の doc 参照）。
 *
 * **結果（一致する/しない）で見る——時間では見ない**（CI の秒数のブレに揺れないため）。
 */

const TENANT = "lexical-query-char-cap-tenant";

describe("PostgresLexicalStore.search: クエリの1語あたりの文字数の上限（Issue #878）", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it(`上限（${LEXICAL_QUERY_MAX_WORD_CHARS}文字）を超えた語は、先頭からその文字数だけに切り詰められた形で使われる`, async () => {
    const { db } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const lexicalStore = new PostgresLexicalStore(db);
    const ctx: Ctx = { tenantId: TENANT };

    // 本文の語は、上限「ちょうど」の文字数——これは「クエリを上限まで切り詰めた形」と
    // 完全一致する。クエリ自身はそれより長い（空白を1つも挟まない1語）——切り詰めが
    // 実際に効いていれば一致し、効いていなければ（本文の語より長い、別の語のまま）
    // 一致しない。
    const wordAtCap = "z".repeat(LEXICAL_QUERY_MAX_WORD_CHARS);
    const queryWordBeyondCap = wordAtCap + "extratailbeyondcap";
    expect(queryWordBeyondCap.length).toBeGreaterThan(LEXICAL_QUERY_MAX_WORD_CHARS);

    await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        contentHash: "hash-char-cap-beyond",
        content: `記憶の本文に ${wordAtCap} という語だけを含む`,
      }),
    );

    const hits = await lexicalStore.search(ctx, queryWordBeyondCap, {
      limit: 50,
      filter: { tenantId: ctx.tenantId },
    });

    expect(hits).toHaveLength(1);
  });

  it("上限ちょうどの文字数の語は、そのまま（切り詰めずに）使われる", async () => {
    const { db } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const lexicalStore = new PostgresLexicalStore(db);
    const ctx: Ctx = { tenantId: TENANT };

    const wordAtCap = "y".repeat(LEXICAL_QUERY_MAX_WORD_CHARS);

    await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        contentHash: "hash-char-cap-exact",
        content: `記憶の本文に ${wordAtCap} という語を含む`,
      }),
    );

    const hits = await lexicalStore.search(ctx, wordAtCap, {
      limit: 50,
      filter: { tenantId: ctx.tenantId },
    });

    expect(hits).toHaveLength(1);
  });
});

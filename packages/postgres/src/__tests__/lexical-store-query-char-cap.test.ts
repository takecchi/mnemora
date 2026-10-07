import type { Ctx } from "@mnemora/core";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresLexicalStore } from "../lexical-store.js";
import { LEXICAL_QUERY_MAX_WORD_CHARS } from "../lexical-query-cap.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

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

    // 本文の語は上限「ちょうど」の文字数で、「クエリを上限まで切り詰めた形」と完全一致する。クエリ自身はそれより長い（空白を挟まない1語）ので、切り詰めが効いていれば一致し、効いていなければ一致しない。
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

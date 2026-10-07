import type { Ctx } from "@mnemora/core";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresLexicalStore } from "../lexical-store.js";
import { LEXICAL_QUERY_MAX_DISTINCT_WORDS } from "../lexical-query-cap.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

const TENANT = "lexical-query-word-cap-tenant";

/** `n` 個の相異なる語（`filler0 filler1 ... fillerN-1`）を返す。 */
function fillerWords(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `filler${i}`);
}

describe("PostgresLexicalStore.search: クエリの異なる語数の上限（Issue #878）", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it(`上限（${LEXICAL_QUERY_MAX_DISTINCT_WORDS}）を超える語は使われない——上限より後ろにしかない語は一致に効かない`, async () => {
    const { db } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const lexicalStore = new PostgresLexicalStore(db);
    const ctx: Ctx = { tenantId: TENANT };

    // 上限ちょうどの語数の filler に、上限を1つ超えさせる語を足す。その語だけが一致する記憶を用意する。上限が効いていればその記憶は一切候補に上がらない。
    const withinCap = fillerWords(LEXICAL_QUERY_MAX_DISTINCT_WORDS);
    const beyondCapWord = "onlybeyondcap";

    await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        contentHash: "hash-beyond-cap",
        content: `記憶の本文に ${beyondCapWord} という語だけを含む`,
      }),
    );

    const query = [...withinCap, beyondCapWord].join(" ");
    expect(query.split(" ").length).toBe(LEXICAL_QUERY_MAX_DISTINCT_WORDS + 1);

    const hits = await lexicalStore.search(ctx, query, {
      limit: 50,
      filter: { tenantId: ctx.tenantId },
    });

    expect(hits).toHaveLength(0);
  });

  it("上限ちょうどの語数まではすべて使われる——上限内の語だけで一致する記憶は候補に残る", async () => {
    const { db } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const lexicalStore = new PostgresLexicalStore(db);
    const ctx: Ctx = { tenantId: TENANT };

    const withinCap = fillerWords(LEXICAL_QUERY_MAX_DISTINCT_WORDS);
    const lastWord = withinCap[withinCap.length - 1]!;

    await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        contentHash: "hash-within-cap",
        content: `記憶の本文に ${lastWord} という語を含む`,
      }),
    );

    const query = withinCap.join(" ");
    expect(query.split(" ").length).toBe(LEXICAL_QUERY_MAX_DISTINCT_WORDS);

    const hits = await lexicalStore.search(ctx, query, {
      limit: 50,
      filter: { tenantId: ctx.tenantId },
    });

    expect(hits).toHaveLength(1);
  });

  it("重複する語をいくら増やしても結果は変わらない（異なる語の数だけが上限に効く）", async () => {
    const { db } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const lexicalStore = new PostgresLexicalStore(db);
    const ctx: Ctx = { tenantId: TENANT };

    await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        contentHash: "hash-dup-1",
        content: "alpha beta gamma が本文",
      }),
    );
    await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        contentHash: "hash-dup-2",
        content: "alpha だけを含む、無関係な本文",
      }),
    );

    const withoutDuplicates = "alpha beta gamma";
    // 異なる語は3つのままだが、生の語数は上限をはるかに超える。重複をまとめる処理が、異なる語の数だけを見ていることの確認。
    const withManyDuplicates = Array.from(
      { length: LEXICAL_QUERY_MAX_DISTINCT_WORDS * 3 },
      (_, i) => ["alpha", "beta", "gamma"][i % 3],
    ).join(" ");

    const optsFilter = { limit: 50, filter: { tenantId: ctx.tenantId } };
    const hitsWithoutDuplicates = await lexicalStore.search(ctx, withoutDuplicates, optsFilter);
    const hitsWithManyDuplicates = await lexicalStore.search(ctx, withManyDuplicates, optsFilter);

    expect(hitsWithManyDuplicates).toEqual(hitsWithoutDuplicates);
    expect(hitsWithoutDuplicates.length).toBeGreaterThan(0);
  });

  it("coverage の分母も上限までの語数である（上限を超えた語は分母にも数えない）", async () => {
    const { db } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const lexicalStore = new PostgresLexicalStore(db);
    const ctx: Ctx = { tenantId: TENANT };

    await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        contentHash: "hash-coverage-denominator",
        content: "記憶の本文に filler0 という語だけを含む",
      }),
    );
    const query = [...fillerWords(LEXICAL_QUERY_MAX_DISTINCT_WORDS), "onlybeyondcap"].join(" ");

    const hits = await lexicalStore.search(ctx, query, {
      limit: 50,
      filter: { tenantId: ctx.tenantId },
    });

    expect(hits).toHaveLength(1);
    // 使われる語は上限の32語。一致は1語なので 1/32。上限を超えた語まで分母に入れると 1/33 になる。
    expect(hits[0]!.coverage).toBeCloseTo(1 / LEXICAL_QUERY_MAX_DISTINCT_WORDS, 10);
  });
});

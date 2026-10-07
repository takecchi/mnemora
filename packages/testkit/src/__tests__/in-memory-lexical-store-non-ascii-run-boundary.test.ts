import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "../test-data.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { InMemoryLexicalStore } from "../__fixtures__/in-memory-lexical-store.js";

const TENANT = "lexical-non-ascii-run-boundary-tenant";
const ctx: Ctx = { tenantId: TENANT };

const TANAKA = "田";
const I_DIAERESIS = "ï";

function makeStore() {
  const memoryStore = new InMemoryMemoryStore();
  const lexicalStore = new InMemoryLexicalStore(memoryStore);
  return { memoryStore, lexicalStore };
}

/** `rank` の尺度は adapter ごとに違ってよい（`LexicalHit.rank` の契約）ので、`memoryId` と `coverage` だけを見る。 */
async function search(lexicalStore: InMemoryLexicalStore, query: string) {
  const hits = await lexicalStore.search(ctx, query, {
    limit: 10,
    filter: { tenantId: TENANT },
  });
  return hits.map((hit) => ({ memoryId: hit.memoryId, coverage: hit.coverage }));
}

describe("InMemoryLexicalStore.search — 非 ASCII の連なりの境目（Postgres に実測で揃える）", () => {
  it("クエリ側: 非 ASCII の連なりは空白に落ちて前後の語を分ける（foo と bar の2語。つなげて foobar にしない）", async () => {
    const { memoryStore, lexicalStore } = makeStore();
    const foo = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: TENANT, content: "foo", contentHash: "run-foo" }),
    );

    const split = await search(lexicalStore, `foo${TANAKA}bar`);
    expect(split).toEqual([{ memoryId: foo.id, coverage: 0.5 }]);

    expect(await search(lexicalStore, "foobar")).toEqual([]);
  });

  it("本文側: ASCII でない Latin-1 の文字（ï）の前後で割れる（naïve は na・ï・ve。クエリ ve が当たる）", async () => {
    const { memoryStore, lexicalStore } = makeStore();
    const naive = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        content: `na${I_DIAERESIS}ve`,
        contentHash: "run-naive",
      }),
    );

    expect(await search(lexicalStore, "ve")).toEqual([{ memoryId: naive.id, coverage: 1 }]);
    expect(await search(lexicalStore, "na")).toEqual([{ memoryId: naive.id, coverage: 1 }]);
  });

  it("クエリ側: ASCII でない Latin-1 の文字（ï）も落として2語にする（na ve に当たる。na・ï・ve のフレーズにしない）", async () => {
    const { memoryStore, lexicalStore } = makeStore();
    const spaced = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: TENANT, content: "na ve", contentHash: "run-na-ve" }),
    );

    expect(await search(lexicalStore, `na${I_DIAERESIS}ve`)).toEqual([
      { memoryId: spaced.id, coverage: 1 },
    ]);
  });
});

import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "../test-data.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { InMemoryLexicalStore } from "../__fixtures__/in-memory-lexical-store.js";

/**
 * `InMemoryLexicalStore.search` の `filter.attributes` は複数キーで AND の等値（ADR 0312 決定5。
 * `vector-store-conformance.ts` に「複数キーは AND」の歯がある）。語彙チャンネルの歯は1キーだけだった
 * （Issue #1775 の #724 の変異33）。条件の `every` を `some` にすると、条件の一部だけを持つ記憶が混ざる。
 * Postgres 側は `packages/postgres` の `lexical-store-attributes-and.postgres.test.ts`
 * （InMemory 固有。公開の適合テストには足さない）。
 */

const TENANT = "lexical-attributes-and-tenant";
const QUERY = "obsidian shards";
const CONTENT = "obsidian shards glimmer in the cave";

describe("InMemoryLexicalStore.search — filter.attributes は複数キーで AND（ADR 0312 決定5）", () => {
  async function setup() {
    const memoryStore = new InMemoryMemoryStore();
    const lexicalStore = new InMemoryLexicalStore(memoryStore);
    const ctx: Ctx = { tenantId: TENANT };
    const make = async (label: string, attributes: Record<string, string>) =>
      (
        await memoryStore.createMemory(
          ctx,
          buildNewMemoryFixture({
            tenantId: TENANT,
            contentHash: `hash-attrs-and-${label}`,
            content: CONTENT,
            attributes,
          }),
        )
      ).id;
    return { ctx, lexicalStore, make };
  }

  it("複数キーの条件は、全キーが一致する記憶だけを返す", async () => {
    const { ctx, lexicalStore, make } = await setup();
    const both = await make("both", { a: "1", b: "2" });
    const bothPlusExtra = await make("both-extra", { a: "1", b: "2", c: "3" });
    const onlyA = await make("only-a", { a: "1" });
    const wrongB = await make("wrong-b", { a: "1", b: "9" });
    const empty = await make("empty", {});

    const hits = await lexicalStore.search(ctx, QUERY, {
      limit: 10,
      filter: { tenantId: TENANT, attributes: { a: "1", b: "2" } },
    });
    const ids = hits.map((h) => h.memoryId).sort();

    expect(ids).toEqual([both, bothPlusExtra].sort());
    for (const excluded of [onlyA, wrongB, empty]) {
      expect(ids).not.toContain(excluded);
    }
  });

  it("属性が {} の記憶は、条件が1キーでもあれば返らない", async () => {
    const { ctx, lexicalStore, make } = await setup();
    const matching = await make("matching", { a: "1" });
    const empty = await make("empty-single", {});

    const hits = await lexicalStore.search(ctx, QUERY, {
      limit: 10,
      filter: { tenantId: TENANT, attributes: { a: "1" } },
    });
    const ids = hits.map((h) => h.memoryId);

    expect(ids).toContain(matching);
    expect(ids).not.toContain(empty);
  });
});

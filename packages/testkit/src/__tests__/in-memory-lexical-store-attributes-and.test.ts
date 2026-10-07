import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "../test-data.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { InMemoryLexicalStore } from "../__fixtures__/in-memory-lexical-store.js";

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

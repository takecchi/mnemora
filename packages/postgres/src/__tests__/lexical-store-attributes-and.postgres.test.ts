import type { Ctx } from "@mnemora/core";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresLexicalStore } from "../lexical-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * `LexicalFilter.attributes` は複数キーのとき AND の等値（ADR 0312 決定5「AND 等値」。
 * `vector-store-conformance.ts` に「複数キーは AND」の歯がある）。語彙チャンネル側の歯は1キーだけだった
 * （Issue #1775 の #724 の変異28）。
 *
 * - `@>`（記憶の属性が条件を含む）を `<@`（条件が記憶の属性に含まれる）へ向き違いにすると、1キーの記憶
 *   では同じ答えになる。複数キーの条件では、条件の一部しか持たない記憶が混ざる。
 * - 属性が `{}` の記憶は、`{} <@ x` が常に真なので、`<@` では条件が何であっても通ってしまう。
 *
 * `recall()` の後置フィルタ（`survivesAttributesFilter`）が混入を止めるので、結果には出ない——ここは
 * adapter 単体の契約を縛る（公開の適合テストには足さない。Postgres 固有）。
 */

const TENANT = "lexical-attributes-and-tenant";
const QUERY = "obsidian shards";
const CONTENT = "obsidian shards glimmer in the cave";

describe("PostgresLexicalStore.search — filter.attributes は複数キーで AND（ADR 0312 決定5）", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  async function setup() {
    const { db } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const lexicalStore = new PostgresLexicalStore(db);
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

  it("複数キーの条件は、全キーが一致する記憶だけを返す（条件の一部しか持たない記憶・値が違う記憶・余分なキーを持つ記憶の扱い）", async () => {
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

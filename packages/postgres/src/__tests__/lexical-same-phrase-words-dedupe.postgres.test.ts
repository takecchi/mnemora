// `foo_bar` と `foo__bar` は別の綴りだが、どちらも tsquery `foo <-> bar` なので分母は 1 つ（Postgres の `array_agg(DISTINCT tsquery)`）。
// 既存の歯は綴りの大文字小文字違いしか見ておらず、fixture の phrase の重複除去を外しても赤にならない。Postgres を基準に、fixture が同じ coverage を返すことを縛る。
import { afterAll, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { InMemoryLexicalStore, InMemoryMemoryStore } from "@mnemora/testkit/fixtures";
import { PostgresLexicalStore } from "../lexical-store.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

const ctx: Ctx = { tenantId: "lexical-phrase-dedupe" };

afterAll(async () => {
  await closeTestClient();
});

const kits: Array<
  [
    string,
    () => Promise<{
      memory: PostgresMemoryStore | InMemoryMemoryStore;
      lex: PostgresLexicalStore | InMemoryLexicalStore;
    }>,
  ]
> = [
  [
    "postgres",
    async () => {
      await resetTestDatabase();
      const { db } = await getTestClient();
      return { memory: new PostgresMemoryStore(db), lex: new PostgresLexicalStore(db) };
    },
  ],
  [
    "testkit の fixture",
    async () => {
      const memory = new InMemoryMemoryStore();
      return { memory, lex: new InMemoryLexicalStore(memory) };
    },
  ],
];

describe.each(kits)("同じ token 列になる語は分母で1つ: %s", (_n, build) => {
  it("foo_bar と foo__bar は1語として数える（coverage 1/2）", async () => {
    const { memory, lex } = await build();
    await memory.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "dd-1", content: "foo bar" }),
    );
    const hits = await lex.search(ctx, "foo_bar foo__bar baz", {
      limit: 5,
      filter: { tenantId: ctx.tenantId },
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.coverage).toBeCloseTo(0.5, 6);
  });
});

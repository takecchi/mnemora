import { afterAll, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { InMemoryLexicalStore, InMemoryMemoryStore } from "@mnemora/testkit/fixtures";
import { PostgresLexicalStore } from "../lexical-store.js";
import { PostgresMemoryStore } from "../memory-store.js";
import {
  PostgresTrigramLexicalStore,
  probeTrigramLexicalSupport,
} from "../trigram-lexical-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * 穴 O-6-1（ADR 0424）の確かめ直し（Issue #1734、PR #1527）で足した歯。
 *
 * - 検索語の NUL は、**DB の生の例外ではなく**、この store 自身の明示の例外で断る。適合テストの
 *   `/query.*NUL/` は、DB の生の例外（`Failed query: … NULL …`）にも当たるので、trigram 経路で検査を外しても
 *   赤にならなかった。ここでは文面を全体で比べる。
 * - 断るのは NUL だけ。NUL 以外の制御文字（`\u0001`）は、断らず普通に検索する（Postgres も受け取る）。
 */
const ctx: Ctx = { tenantId: "lexical-query-nul-only" };
const filter = { tenantId: ctx.tenantId };

afterAll(async () => {
  await closeTestClient();
});

describe("検索語の NUL（Postgres）", () => {
  it("tsvector 経路：この store の明示の例外で断り、NUL 以外の制御文字は断らない", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    await new PostgresMemoryStore(db).createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, content: "obsidian shards glimmer" }),
    );
    const store = new PostgresLexicalStore(db);
    await expect(store.search(ctx, "obsi\u0000dian", { limit: 10, filter })).rejects.toThrow(
      /^PostgresLexicalStore\.search: query must not contain NUL characters \(U\+0000\)$/,
    );
    await expect(store.search(ctx, "obsi\u0001dian", { limit: 10, filter })).resolves.toEqual([]);
  });

  it("trigram 経路：この store の明示の例外で断り、NUL 以外の制御文字は断らない", async (context) => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    if (!(await probeTrigramLexicalSupport(db)).ok) context.skip();
    const store = await PostgresTrigramLexicalStore.create(db);
    await expect(store.search(ctx, "obsi\u0000dian", { limit: 10, filter })).rejects.toThrow(
      /^PostgresTrigramLexicalStore\.search: query must not contain NUL characters \(U\+0000\)$/,
    );
    await expect(store.search(ctx, "obsi\u0001dian", { limit: 10, filter })).resolves.toBeDefined();
  });
});

describe("検索語の NUL（testkit の InMemory）", () => {
  it("NUL は断り、NUL 以外の制御文字は断らない", async () => {
    const memoryStore = new InMemoryMemoryStore();
    const store = new InMemoryLexicalStore(memoryStore);
    await expect(store.search(ctx, "obsi\u0000dian", { limit: 10, filter })).rejects.toThrow(
      /query must not contain NUL characters \(U\+0000\)/,
    );
    await expect(store.search(ctx, "obsi\u0001dian", { limit: 10, filter })).resolves.toEqual([]);
  });
});

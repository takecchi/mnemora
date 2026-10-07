import type { Ctx } from "@mnemora/core";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresLexicalStore } from "../lexical-store.js";
import { LEXICAL_QUERY_MAX_TOTAL_CHARS } from "../lexical-query-cap.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

const TENANT = "lexical-query-total-chars-cap-tenant";

describe("PostgresLexicalStore.search: クエリ全体の文字数の上限（Issue #878）", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it(`上限（${LEXICAL_QUERY_MAX_TOTAL_CHARS}文字）を超えた後ろの部分は使われない`, async () => {
    const { db } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const lexicalStore = new PostgresLexicalStore(db);
    const ctx: Ctx = { tenantId: TENANT };

    // 前半を埋め文字で上限の少し手前まで埋め、すぐ後ろにマーカー語を続ける。クエリ全体では上限を超えるが、マーカー語の一部だけが上限の内側に残る形にする。
    // 全体の切り詰めが効いていれば、本文にあるマーカー語そのものとは一致しない（切り詰められた断片は別の文字列になる）。
    const filler = "p".repeat(LEXICAL_QUERY_MAX_TOTAL_CHARS - 10);
    const marker = "onlybeyondtotalcap";
    const query = `${filler} ${marker}`;
    expect(query.length).toBeGreaterThan(LEXICAL_QUERY_MAX_TOTAL_CHARS);

    await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        contentHash: "hash-total-chars-cap-beyond",
        content: `記憶の本文に ${marker} という語だけを含む`,
      }),
    );

    const hits = await lexicalStore.search(ctx, query, {
      limit: 50,
      filter: { tenantId: ctx.tenantId },
    });

    expect(hits).toHaveLength(0);
  });

  it("上限に触れないクエリは1バイトも変わらない（通常のクエリの挙動は変わらない）", async () => {
    const { db } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const lexicalStore = new PostgresLexicalStore(db);
    const ctx: Ctx = { tenantId: TENANT };

    await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        contentHash: "hash-total-chars-cap-normal",
        content: "obsidian shards glimmer in the cave",
      }),
    );

    const hits = await lexicalStore.search(ctx, "obsidian shards", {
      limit: 50,
      filter: { tenantId: ctx.tenantId },
    });

    expect(hits).toHaveLength(1);
  });
});

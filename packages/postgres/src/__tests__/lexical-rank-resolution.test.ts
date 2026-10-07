import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresLexicalStore } from "../lexical-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/** `ts_rank_cd` に渡すクエリ語がどちらも一致箇所で隣接するとき、周囲の文脈量に関わらず cover density が同じ値になる。短く焦点の合った文と、同じ2語を含む長く散漫な文とで、`rank` が割れることを検査する。 */

const TENANT = "lexical-rank-resolution-tenant";

async function createMemory(
  memoryStore: PostgresMemoryStore,
  ctx: Ctx,
  contentHash: string,
  content: string,
) {
  return memoryStore.createMemory(
    ctx,
    buildNewMemoryFixture({ tenantId: TENANT, contentHash, content }),
  );
}

describe("PostgresLexicalStore.search — rank に内容由来の分解能を持たせる（Issue #394, ADR 0308）", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("被覆率が同じ短文と長文散漫な文の rank が割れる — 直す前は完全同点だった", async () => {
    const { db } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const lexicalStore = new PostgresLexicalStore(db);
    const ctx: Ctx = { tenantId: TENANT };

    const focused = await createMemory(memoryStore, ctx, "hash-focused", "obsidian shards");
    const diffuse = await createMemory(
      memoryStore,
      ctx,
      "hash-diffuse",
      "Yesterday we spent a long time discussing many unrelated topics such as weather " +
        "patterns, quarterly budgets, travel plans, and eventually someone mentioned " +
        "obsidian shards briefly before moving on to talk about lunch plans and other " +
        "matters entirely unrelated to the original subject at hand.",
    );

    const hits = await lexicalStore.search(ctx, "obsidian shards", {
      limit: 10,
      filter: { tenantId: TENANT },
    });
    const focusedHit = hits.find((h) => h.memoryId === focused.id);
    const diffuseHit = hits.find((h) => h.memoryId === diffuse.id);
    expect(focusedHit).toBeDefined();
    expect(diffuseHit).toBeDefined();

    expect(focusedHit!.coverage).toBe(1);
    expect(diffuseHit!.coverage).toBe(1);

    expect(focusedHit!.rank).not.toBe(diffuseHit!.rank);
    expect(focusedHit!.rank).toBeGreaterThan(diffuseHit!.rank);
  });

  it("内容が真に同一な行どうしは、直した後も完全に同点のまま — ADR 0175 の tie-break 契約を壊さない", async () => {
    const { db } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const lexicalStore = new PostgresLexicalStore(db);
    const ctx: Ctx = { tenantId: TENANT };

    const content = "widget alpha bravo tie-break resolution content";
    await createMemory(memoryStore, ctx, "hash-dup-a", content);
    await createMemory(memoryStore, ctx, "hash-dup-b", content);

    const hits = await lexicalStore.search(ctx, "widget", {
      limit: 10,
      filter: { tenantId: TENANT },
    });

    expect(hits.length).toBe(2);
    // 文書長も語の並びも完全に同一 —— 分解能を足しても、真に同一な内容は今も同点。
    expect(hits[0]!.coverage).toBe(hits[1]!.coverage);
    expect(hits[0]!.rank).toBe(hits[1]!.rank);
  });

  it("末尾の整数だけが違うテンプレート文（20,000行 seed と同じ構造）は、直した後も同点のまま — 語数(lexeme 数)が変わらないため", async () => {
    const { db } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const lexicalStore = new PostgresLexicalStore(db);
    const ctx: Ctx = { tenantId: TENANT };

    // `lexical-store-index.test.ts` の `seedManyMemories` と同じテンプレートで、末尾の桁数が1〜5桁と揺れる点まで再現する。
    const suffixes = [0, 7, 50, 999, 19_950];
    for (const i of suffixes) {
      await createMemory(
        memoryStore,
        ctx,
        `hash-template-${i}`,
        `obsidian shards glimmer in seed content ${i}`,
      );
    }

    const hits = await lexicalStore.search(ctx, "obsidian shards", {
      limit: 10,
      filter: { tenantId: TENANT },
    });

    expect(hits.length).toBe(suffixes.length);
    const [first, ...rest] = hits;
    // ⚠ これは「直っていない」ことを主張する歯である。⛔ 直そうとしていない。
    // `to_tsvector` は末尾の整数を桁数に関わらず1語彙として数えるので、文書長（lexeme 数）は5行とも同じ7語のまま変わらず、文書長由来の normalization を足しても割れない。
    for (const hit of rest) {
      expect(hit.coverage).toBe(first!.coverage);
      expect(hit.rank).toBe(first!.rank);
    }
  });
});

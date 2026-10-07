import type { Ctx } from "@mnemora/core";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import {
  PostgresTrigramLexicalStore,
  probeTrigramLexicalSupport,
} from "../trigram-lexical-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * `PostgresTrigramLexicalStore.search` の `filter.labels` は、`VectorFilter.labels` と
 * 同じ欄・同じ意味——名前は**文字列の完全一致**で比べる。
 * 大文字小文字・前後の空白は同じものとして扱わない。UTF8 の `server_encoding` を前提とする。
 */

const TENANT = "trigram-labels-exact-tenant";
const QUERY = "分類絞り込みプローブ";

describe("PostgresTrigramLexicalStore.search: filter.labels は完全一致（Issue #953）", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("大文字小文字・前後の空白だけが違う名前には一致しない（同じ綴りには一致する）", async () => {
    const { db } = await getTestClient();
    const probe = await probeTrigramLexicalSupport(db);
    if (!probe.ok) return;

    const memoryStore = new PostgresMemoryStore(db);
    const ctx: Ctx = { tenantId: TENANT };
    const make = (hash: string, tags: string[]) =>
      memoryStore.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: TENANT, contentHash: hash, tags, content: QUERY }),
      );
    const exact = await make("exact", ["project"]);
    await make("upper", ["Project"]);
    const padded = await make("padded", [" project"]);
    await make("trailing", ["project "]);

    const trigramStore = await PostgresTrigramLexicalStore.create(db);
    const hits = await trigramStore.search(ctx, QUERY, {
      limit: 50,
      filter: { tenantId: TENANT, labels: ["project"] },
    });
    expect(hits.map((h) => h.memoryId)).toEqual([exact.id]);

    const upperHits = await trigramStore.search(ctx, QUERY, {
      limit: 50,
      filter: { tenantId: TENANT, labels: ["PROJECT"] },
    });
    expect(upperHits).toEqual([]);
    const paddedHits = await trigramStore.search(ctx, QUERY, {
      limit: 50,
      filter: { tenantId: TENANT, labels: [" project"] },
    });
    expect(paddedHits).toHaveLength(1);
    expect(paddedHits[0]!.memoryId).toBe(padded.id);
  });
});

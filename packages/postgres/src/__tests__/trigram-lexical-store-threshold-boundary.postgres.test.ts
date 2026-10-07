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
 * `PostgresTrigramLexicalStore` に渡した `threshold` は、**渡した値のまま**効く
 * （小数第2位の値が、近い刻みの値に丸められて絞られない）。
 *
 * `trigram-lexical-store-threshold-param.postgres.test.ts` は、パラメータの文字列が渡した値と等しいことを見る。
 * ここは、**検索の結果**で見る。`word_similarity('東京タワー', '東京ワー')` は 0.375 で、
 * 0.37 と 0.38 の間にある。0.37 を 0.4 に丸める実装なら、この行は当たらなくなる。
 *
 * 閾値は2か所で使われる。`content %> $ja`（`pg_trgm.word_similarity_threshold`）で行を絞る側と、
 * `coverage` の 1/0 を決める側（`word_similarity(...) >= threshold`）である。前者だけ丸めれば行が消え、
 * 後者だけ丸めれば行は残って `coverage` が 0 になる。どちらも見えるように、`coverage` まで確かめる。
 *
 * SQL_ASCII の leg では `create()` が拒むので、その leg では `create()` の拒否だけを確かめる。
 */

const TENANT = "trigram-threshold-boundary";
const ctx: Ctx = { tenantId: TENANT };
const filter = { tenantId: TENANT };
const QUERY = "東京タワー";
/** `word_similarity(QUERY, この本文)` が 0.375。 */
const CONTENT = "東京ワー";

afterAll(async () => {
  await closeTestClient();
});

beforeEach(async () => {
  await resetTestDatabase();
});

describe("PostgresTrigramLexicalStore: threshold は渡した値のまま効く", () => {
  it("類似度 0.375 の行は、threshold 0.37 では当たり（coverage 1）、0.38 では当たらない", async () => {
    const { db } = await getTestClient();
    const probe = await probeTrigramLexicalSupport(db);
    if (!probe.ok) {
      await expect(PostgresTrigramLexicalStore.create(db, { threshold: 0.37 })).rejects.toThrow();
      return;
    }
    const memoryStore = new PostgresMemoryStore(db);
    const memory = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: TENANT, contentHash: "hash-boundary", content: CONTENT }),
    );

    const atBelow = await PostgresTrigramLexicalStore.create(db, { threshold: 0.37 });
    const hitsBelow = await atBelow.search(ctx, QUERY, { limit: 5, filter });
    expect(hitsBelow.map((h) => h.memoryId)).toEqual([memory.id]);
    expect(hitsBelow[0]?.coverage).toBe(1);

    const atAbove = await PostgresTrigramLexicalStore.create(db, { threshold: 0.38 });
    const hitsAbove = await atAbove.search(ctx, QUERY, { limit: 5, filter });
    expect(hitsAbove).toEqual([]);
  });
});

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
 * `PostgresTrigramLexicalStore.search` が `filter.labels` を実際に適用することの実測。
 *
 * 約束: `LexicalFilter.labels` の doc「`VectorFilter.labels` と同じ欄・同じ意味」（渡した名前のいずれかを
 * `tags` に持つ Memory だけを通す OR の集合絞り込み）。
 *
 * recall の後置フィルタ（`survivesLabelsFilter`）が最終結果からは落とすが、押し下げが
 * 無いと `limit`（recall では over-fetch 済みの kPrime）の窓を絞りの外の候補が占め、
 * 絞りの内側の候補が窓から押し出される——2本目の歯がその形を固定する。
 *
 * **⚠ この歯は UTF8 の `server_encoding` を前提とする。**
 */

const TENANT = "trigram-labels-tenant";
const QUERY = "分類絞り込みプローブ";

async function make(
  memoryStore: PostgresMemoryStore,
  ctx: Ctx,
  contentHash: string,
  tags: string[],
  suffix = "",
) {
  return memoryStore.createMemory(
    ctx,
    buildNewMemoryFixture({
      tenantId: TENANT,
      contentHash,
      tags,
      content: `${QUERY}${suffix}`,
    }),
  );
}

describe("PostgresTrigramLexicalStore.search: filter.labels（ADR 0323）", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("渡した名前のいずれかを tags に持つ Memory だけが返る（別の名前・名前なしは返らない）", async () => {
    const { db } = await getTestClient();
    const probe = await probeTrigramLexicalSupport(db);
    if (!probe.ok) return;

    const memoryStore = new PostgresMemoryStore(db);
    const ctx: Ctx = { tenantId: TENANT };
    const alpha = await make(memoryStore, ctx, "trigram-labels-alpha", ["alpha"]);
    const beta = await make(memoryStore, ctx, "trigram-labels-beta", ["beta"]);
    const gamma = await make(memoryStore, ctx, "trigram-labels-gamma", ["gamma"]);
    const untagged = await make(memoryStore, ctx, "trigram-labels-untagged", []);

    const trigramStore = await PostgresTrigramLexicalStore.create(db);
    const hits = await trigramStore.search(ctx, QUERY, {
      limit: 50,
      filter: { tenantId: TENANT, labels: ["alpha", "beta"] },
    });
    const ids = hits.map((h) => h.memoryId);
    expect(ids.sort()).toEqual([alpha.id, beta.id].sort());
    expect(ids).not.toContain(gamma.id);
    expect(ids).not.toContain(untagged.id);
  });

  it("絞りの外の候補が limit の窓を占めず、絞りの内側の候補が返る", async () => {
    const { db } = await getTestClient();
    const probe = await probeTrigramLexicalSupport(db);
    if (!probe.ok) return;

    const memoryStore = new PostgresMemoryStore(db);
    const ctx: Ctx = { tenantId: TENANT };
    // 絞りの外の候補はクエリと完全一致させ、絞りの内側の候補には余計な語を足して
    // 類似度を下げる——押し下げが無ければ、limit の窓は絞りの外の候補で埋まる。
    for (let i = 0; i < 3; i += 1) {
      await make(memoryStore, ctx, `trigram-labels-decoy-${i}`, ["other"]);
    }
    const target = await make(
      memoryStore,
      ctx,
      "trigram-labels-target",
      ["alpha"],
      "（窓の外へ押し出されうる、類似度の低い候補）",
    );

    const trigramStore = await PostgresTrigramLexicalStore.create(db);
    const hits = await trigramStore.search(ctx, QUERY, {
      limit: 2,
      filter: { tenantId: TENANT, labels: ["alpha"] },
    });
    expect(hits.map((h) => h.memoryId)).toEqual([target.id]);
  });
});

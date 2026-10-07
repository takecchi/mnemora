import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemory } from "../memory.js";
import { createFakeRuntimeStores, LEXICAL_QUERY_MAX_TOTAL_CHARS } from "./runtime-fakes.js";

const ctx: Ctx = { tenantId: "fake-lexical-query-total-cap-grapheme-tenant" };
const NOW = new Date("2026-06-01T00:00:00.000Z");

function newMemory(content: string): NewMemory {
  return {
    tenantId: ctx.tenantId,
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content,
    contentHash: `hash-${content}`,
    digest: "digest",
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: [],
    occurredAt: null,
    recordedAt: NOW,
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 24 * 365 * 10,
    decayFloorAt: new Date(NOW.getTime() + 1000 * 60 * 60 * 24 * 365 * 5),
    embeddingStatus: "pending",
  };
}

async function search(content: string, query: string) {
  const stores = createFakeRuntimeStores();
  await stores.memoryStore.createMemory(ctx, newMemory(content));
  return stores.lexicalStore.search(ctx, query, { limit: 50, filter: { tenantId: ctx.tenantId } });
}

const STEM = "shardton";
const COMBINING_ACUTE = "́";

function queryWithCombinedEAt(endIndex: number): string {
  const filler = "p".repeat(endIndex - 1 - STEM.length);
  return `${filler} ${STEM}e${COMBINING_ACUTE} tail`;
}

describe("FakeLexicalStore.search: クエリ全体の上限の境目にある書記素は、割らずに丸ごと落とす", () => {
  // ASCII の基底文字に結合記号が付いた書記素だけを選ぶのは、非 ASCII の連なりは後段で語の区切りに
  // 置き換わるので、絵文字やサロゲートペアが割れても検索の結果には現れないため。
  it("境目をまたぐ `e` + 結合記号は基底の `e` ごと落ち、手前の語幹だけが語になる", async () => {
    const query = queryWithCombinedEAt(LEXICAL_QUERY_MAX_TOTAL_CHARS - 1);
    expect(query.slice(0, LEXICAL_QUERY_MAX_TOTAL_CHARS).endsWith(`${STEM}e`)).toBe(true);
    expect(await search(`本文に ${STEM} を含む`, query)).toHaveLength(1);
  });

  it("境目をまたぐ書記素の基底の `e` だけを残した語は作らない", async () => {
    const query = queryWithCombinedEAt(LEXICAL_QUERY_MAX_TOTAL_CHARS - 1);
    expect(await search(`本文に ${STEM}e を含む`, query)).toHaveLength(0);
  });

  it("境目の内側で終わる `e` + 結合記号は、そのまま語に残る", async () => {
    const query = queryWithCombinedEAt(LEXICAL_QUERY_MAX_TOTAL_CHARS - 2);
    expect(await search(`本文に ${STEM}e を含む`, query)).toHaveLength(1);
  });
});

// 再確かめ（2026-10-07 マージ分、#1870）。先頭の書記素だけで上限を超えるときは、割った断片（`e` だけ）を
// 語として残さず、クエリごと空になる。
describe("FakeLexicalStore.search: 先頭の書記素だけで上限を超えるクエリ", () => {
  it("書記素を割った断片の `e` を語として残さない", async () => {
    const query = `e${COMBINING_ACUTE.repeat(LEXICAL_QUERY_MAX_TOTAL_CHARS + 50)} tail`;
    expect(await search("本文に e を含む", query)).toHaveLength(0);
  });
});

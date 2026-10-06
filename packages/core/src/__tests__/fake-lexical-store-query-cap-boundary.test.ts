// #919 の確かめ直し（#1774）。`FakeLexicalStore.search` のクエリの上限の、既存の歯が見ていなかった境界。
//
// 1. クエリ全体の文字数の上限は「ちょうど 600 文字目まで」使う（601 文字目は使わない・600 文字目は使う）。
// 2. 異なる語数の上限は、重複（大文字小文字だけが違う語を含む）を数えない。
//
// 結果（一致する/しない）で見る。

import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemory } from "../memory.js";
import {
  createFakeRuntimeStores,
  LEXICAL_QUERY_MAX_DISTINCT_WORDS,
  LEXICAL_QUERY_MAX_TOTAL_CHARS,
} from "./runtime-fakes.js";

const ctx: Ctx = { tenantId: "fake-lexical-query-cap-boundary-tenant" };
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

describe("FakeLexicalStore.search: クエリの上限の境界（#919）", () => {
  const marker = "boundarymarker";

  it("全体の文字数: ちょうど上限の文字数のクエリの最後の語は、1文字も欠けずに使われる", async () => {
    const filler = "p".repeat(LEXICAL_QUERY_MAX_TOTAL_CHARS - 1 - marker.length);
    const query = `${filler} ${marker}`;
    expect(query).toHaveLength(LEXICAL_QUERY_MAX_TOTAL_CHARS);
    expect(await search(`本文に ${marker} を含む`, query)).toHaveLength(1);
  });

  it("全体の文字数: 上限を1文字超えた分（601 文字目）は使われない", async () => {
    const filler = "p".repeat(LEXICAL_QUERY_MAX_TOTAL_CHARS - 1 - marker.length);
    // 601 文字目の `z` が使われると、最後の語は `${marker}z` になり本文の語と一致しない
    const query = `${filler} ${marker}z`;
    expect(query).toHaveLength(LEXICAL_QUERY_MAX_TOTAL_CHARS + 1);
    expect(await search(`本文に ${marker} を含む`, query)).toHaveLength(1);
  });

  it("語数: 重複（大文字小文字だけが違う語を含む）は上限の語数に数えない", async () => {
    const distinct = Array.from(
      { length: LEXICAL_QUERY_MAX_DISTINCT_WORDS - 1 },
      (_, i) => `filler${i}`,
    );
    // 異なる語は 31 + tailword = 32（ちょうど上限）。重複を前に挟んでも tailword は押し出されない
    const query = [...distinct, "FILLER0", "filler0", "Filler1", "tailword"].join(" ");
    expect(await search("本文に tailword だけを含む", query)).toHaveLength(1);
  });
});

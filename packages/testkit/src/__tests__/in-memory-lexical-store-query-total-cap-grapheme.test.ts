import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "../test-data.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { InMemoryLexicalStore } from "../__fixtures__/in-memory-lexical-store.js";

// 定数は export されていない（公開面に漏れるため）ので値を書き写す。ずれは `packages/postgres` の `lexical-query-cap-values-match.test.ts` が見る。
const TOTAL_CHARS_CAP = 600;

const TENANT = "in-memory-lexical-query-total-cap-grapheme-tenant";
const STEM = "shardton";
const COMBINING_ACUTE = "́";

function queryWithCombinedEAt(endIndex: number): string {
  const filler = "p".repeat(endIndex - 1 - STEM.length);
  return `${filler} ${STEM}e${COMBINING_ACUTE} tail`;
}

async function search(content: string, query: string) {
  const memoryStore = new InMemoryMemoryStore();
  const lexicalStore = new InMemoryLexicalStore(memoryStore);
  const ctx: Ctx = { tenantId: TENANT };
  await memoryStore.createMemory(
    ctx,
    buildNewMemoryFixture({ tenantId: TENANT, content, contentHash: `hash-${content}` }),
  );
  return lexicalStore.search(ctx, query, { limit: 50, filter: { tenantId: ctx.tenantId } });
}

describe("InMemoryLexicalStore.search: クエリ全体の上限の境目にある書記素は、割らずに丸ごと落とす", () => {
  // ASCII の基底文字に結合記号が付いた書記素だけを選ぶのは、非 ASCII の連なりは後段で語の区切りに
  // 置き換わるので、絵文字やサロゲートペアが割れても検索の結果には現れないため。
  it("境目をまたぐ `e` + 結合記号は基底の `e` ごと落ち、手前の語幹だけが語になる", async () => {
    const query = queryWithCombinedEAt(TOTAL_CHARS_CAP - 1);
    expect(query.slice(0, TOTAL_CHARS_CAP).endsWith(`${STEM}e`)).toBe(true);
    expect(await search(`記憶の本文に ${STEM} を含む`, query)).toHaveLength(1);
  });

  it("境目をまたぐ書記素の基底の `e` だけを残した語は作らない", async () => {
    const query = queryWithCombinedEAt(TOTAL_CHARS_CAP - 1);
    expect(await search(`記憶の本文に ${STEM}e を含む`, query)).toHaveLength(0);
  });

  it("境目の内側で終わる `e` + 結合記号は、そのまま語に残る", async () => {
    const query = queryWithCombinedEAt(TOTAL_CHARS_CAP - 2);
    expect(await search(`記憶の本文に ${STEM}e を含む`, query)).toHaveLength(1);
  });
});

// 再確かめ（2026-10-07 マージ分、#1870）。先頭の書記素だけで上限を超えるときは、割った断片（`e` だけ）を
// 語として残さず、クエリごと空になる。
describe("InMemoryLexicalStore.search: 先頭の書記素だけで上限を超えるクエリ", () => {
  it("書記素を割った断片の `e` を語として残さない", async () => {
    const query = `e${COMBINING_ACUTE.repeat(TOTAL_CHARS_CAP + 50)} tail`;
    expect(await search("本文に e を含む", query)).toHaveLength(0);
  });
});

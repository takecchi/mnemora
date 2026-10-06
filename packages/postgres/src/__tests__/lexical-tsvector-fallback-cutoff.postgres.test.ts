import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { closeTestClient, getTestClient } from "./test-db.js";

/**
 * `mnemora_lexical_tsvector` は、tsvector が1MBを超える本文だけ、本文の先頭150,000文字で作り直す。
 * 縮退したあとの語彙の対象は「先頭150,000文字」であり、それより短くも長くもならない。
 *
 * - 先頭150,000文字の内側の語は引ける（縮退が短すぎない）。
 * - 150,000文字より後ろの語は引けない（縮退が長すぎない。全文は `memories.content` に残るが、
 *   語彙の索引は先頭だけを見る）。
 *
 * 本文は、重複の無い12桁の16進の語を空白で区切って作る（13文字で1語。語の位置から文字位置が決まる）。
 * 語彙検索（`to_tsquery('simple', …)`）の対象の語は、この16進の語と重ならない文字列を使う。
 */

const WORD_CHARS = 13;
const TOTAL_WORDS = 120_000; // 156万文字。旧式の tsvector は1MBを超える。
const INSIDE_WORD_INDEX = 11_000; // 文字位置 143,000（150,000の内側）
const OUTSIDE_WORD_INDEX = 11_700; // 文字位置 152,100（150,000の外側）
const INSIDE_MARKER = "zqxinsidemarker";
const OUTSIDE_MARKER = "zqxoutsidemarker";

function buildContent(): string {
  const words: string[] = [];
  for (let i = 0; i < TOTAL_WORDS; i += 1) {
    if (i === INSIDE_WORD_INDEX) {
      words.push(INSIDE_MARKER.padEnd(WORD_CHARS - 1, "x"));
    } else if (i === OUTSIDE_WORD_INDEX) {
      words.push(OUTSIDE_MARKER.padEnd(WORD_CHARS - 1, "x"));
    } else {
      words.push(i.toString(16).padStart(WORD_CHARS - 1, "0"));
    }
  }
  return words.join(" ");
}

describe("mnemora_lexical_tsvector: 縮退したときの語彙の対象は先頭150,000文字", () => {
  afterAll(async () => {
    await closeTestClient();
  });

  it("旧式は例外になる本文で、先頭150,000文字の内側の語は引け、外側の語は引けない", async () => {
    const { db } = await getTestClient();
    const content = buildContent();
    // 文字位置の前提（マーカーが 150,000 文字の内側・外側に在る）。
    expect(content.indexOf(INSIDE_MARKER)).toBeLessThan(150_000);
    expect(content.indexOf(OUTSIDE_MARKER)).toBeGreaterThan(150_000);

    // 旧式のままでは落ちる本文である（縮退の経路を通っていることの確認）。
    // （失敗の文面に本文が入るので、`expect(...).rejects` ではなく原因の文面だけを取り出す。）
    let thrown: unknown;
    try {
      await db.execute(sql`SELECT to_tsvector('simple', mnemora_lexical_normalize(${content}))`);
    } catch (err) {
      thrown = err;
    }
    expect((thrown as { cause?: { message?: string } } | undefined)?.cause?.message).toContain(
      "too long for tsvector",
    );

    const result = await db.execute(sql`
      SELECT
        mnemora_lexical_tsvector(${content}) @@ to_tsquery('simple', ${INSIDE_MARKER.padEnd(WORD_CHARS - 1, "x")}) AS inside,
        mnemora_lexical_tsvector(${content}) @@ to_tsquery('simple', ${OUTSIDE_MARKER.padEnd(WORD_CHARS - 1, "x")}) AS outside
    `);
    expect(result.rows[0]).toEqual({ inside: true, outside: false });
  });
});

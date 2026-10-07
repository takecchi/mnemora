import { describe, expect, it } from "vitest";
import { embeddingSpaceIndexName, embeddingSpaceTableName } from "@mnemora/postgres";
import { LocalEmbeddingProvider } from "../local-embedding-provider.js";

/** `byteLength <= 63` だけでは歯にならない。導出関数は 63 バイトを超える名前を切り詰めてハッシュ片を足すので、どんな `model` でも真になる。固定したいのは名前が化けていないことで、切り詰めが起きると `dimensions`（3つ組の最後）が末尾から消えるので `endsWith(`_${dimensions}`)` を見る。切り詰め形の最後の `_` の後ろは16進8文字なので、これは切り詰め形では成立しえない。 */

/** 逐語で持つ。`@mnemora/postgres` の `MAX_IDENTIFIER_BYTES` から組み立てない。import すると、その定数を書き換える変異とこの歯が自己整合して素通りする（63 は PostgreSQL の `NAMEDATALEN - 1` で、外の世界が決めた値）。 */
const POSTGRES_MAX_IDENTIFIER_BYTES = 63;

/** 定数を並べ直さず、実物から取る。 */
const space = new LocalEmbeddingProvider().space;

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

describe("packages/local-embedding の EmbeddingSpaceId から導かれる Postgres 識別子", () => {
  it("テーブル名が 63 バイトに収まる", () => {
    const table = embeddingSpaceTableName(space);
    expect(byteLength(table)).toBeLessThanOrEqual(POSTGRES_MAX_IDENTIFIER_BYTES);
  });

  it("HNSW 索引名が 63 バイトに収まる", () => {
    const index = embeddingSpaceIndexName(space);
    expect(byteLength(index)).toBeLessThanOrEqual(POSTGRES_MAX_IDENTIFIER_BYTES);
  });

  it("テーブル名が切り詰められていない（末尾に dimensions が残っている）", () => {
    const table = embeddingSpaceTableName(space);
    expect(table.endsWith(`_${String(space.dimensions)}`)).toBe(true);
  });

  it("HNSW 索引名が切り詰められていない（末尾に dimensions が残っている）", () => {
    const index = embeddingSpaceIndexName(space);
    expect(index.endsWith(`_${String(space.dimensions)}`)).toBe(true);
  });

  /** 索引名のほうが先に溢れる（接頭辞 `idx_memory_embeddings_hnsw_` は27バイトで、テーブル名の `memory_embeddings_` の18バイトより9バイト長い）。テーブル名だけを見る歯は、索引名が化けている状態を緑で通す。 */
  it("索引名はテーブル名より長い（＝先に溢れるのは索引名のほう。テーブル名だけ見ても足りない）", () => {
    expect(byteLength(embeddingSpaceIndexName(space))).toBeGreaterThan(
      byteLength(embeddingSpaceTableName(space)),
    );
  });
});

describe("長すぎる model では導出名が切り詰められ末尾の dimensions が消える（上の「末尾に dimensions が残っている」検査が、切り詰めを検出できることの確認）", () => {
  /** `model` を長くして実際に化かして確かめる。これが無いと、上の `endsWith` が「たまたま通っている」のか「切り詰めを検出できる」のかが区別できない。 */
  const tooLong = {
    provider: space.provider,
    model: "x".repeat(64),
    dimensions: space.dimensions,
  };

  it("長すぎる model は切り詰められ、末尾の dimensions が消える（テーブル名）", () => {
    const table = embeddingSpaceTableName(tooLong);
    expect(byteLength(table)).toBe(POSTGRES_MAX_IDENTIFIER_BYTES);
    expect(table.endsWith(`_${String(tooLong.dimensions)}`)).toBe(false);
  });

  it("長すぎる model は切り詰められ、末尾の dimensions が消える（HNSW 索引名）", () => {
    const index = embeddingSpaceIndexName(tooLong);
    expect(byteLength(index)).toBe(POSTGRES_MAX_IDENTIFIER_BYTES);
    expect(index.endsWith(`_${String(tooLong.dimensions)}`)).toBe(false);
  });
});

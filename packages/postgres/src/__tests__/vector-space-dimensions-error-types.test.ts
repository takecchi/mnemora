import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { registerEmbeddingSpace } from "../vector-space.js";

/**
 * `registerEmbeddingSpace` の `space.dimensions` の検査の例外の型。
 * 数でなければ `TypeError`、数として不正（正の整数でない・hnsw の上限超）なら `RangeError`。
 *
 * 検査は pool を使う前にあるので、DB は要らない。pool は、触られたら落ちる偽物にする
 * （検査より後ろに進んだら、型の違いではなく「pool に触った」で赤になる）。
 */

const untouchablePool = new Proxy(
  {},
  {
    get() {
      throw new Error("pool was touched before the dimensions check");
    },
  },
) as unknown as Pool;

function spaceWith(dimensions: unknown) {
  return { provider: "test", model: "dims-type", dimensions: dimensions as number };
}

describe("registerEmbeddingSpace の dimensions の例外の型（ADR 0525）", () => {
  it.each([
    ["文字列", "4"],
    ["null", null],
    ["undefined", undefined],
    ["bigint", 4n],
    ["オブジェクト", {}],
  ])("数でない（%s）は TypeError（RangeError ではない）", async (_name, value) => {
    const call = () => registerEmbeddingSpace(untouchablePool, spaceWith(value));
    await expect(call()).rejects.toThrow(TypeError);
    await expect(call()).rejects.not.toThrow(RangeError);
    await expect(call()).rejects.toThrow(/invalid embedding space dimensions: /);
  });

  it.each([
    ["0", 0],
    ["負", -1],
    ["小数", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("正の整数でない数（%s）は RangeError（TypeError ではない）", async (_name, value) => {
    const call = () => registerEmbeddingSpace(untouchablePool, spaceWith(value));
    await expect(call()).rejects.toThrow(RangeError);
    await expect(call()).rejects.not.toThrow(TypeError);
    await expect(call()).rejects.toThrow(/正の整数である必要がある/);
  });

  it("hnsw の上限超は RangeError（TypeError ではない）で、message は従来のまま", async () => {
    const over = 2001; // pgvector hnsw の上限 2000 の次
    const call = () => registerEmbeddingSpace(untouchablePool, spaceWith(over));
    await expect(call()).rejects.toThrow(RangeError);
    await expect(call()).rejects.not.toThrow(TypeError);
    await expect(call()).rejects.toThrow(
      new RegExp(`invalid embedding space dimensions: ${over} \\(pgvector の hnsw 索引は`),
    );
  });
});

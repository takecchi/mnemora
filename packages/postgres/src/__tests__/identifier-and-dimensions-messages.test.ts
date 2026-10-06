import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { assertSafeIdentifier } from "../embedding-space-table.js";
import { registerEmbeddingSpace } from "../vector-space.js";

/**
 * 拒否の文面。どちらも「受け付けない値」を名乗り、「受け付ける値」を書く（DB は要らない）。
 *
 * - `assertSafeIdentifier`: 渡された識別子と、使える形（英小文字・数字・`_`、先頭は英小文字か `_`）。
 *   例外の種類は素の `Error` のまま（文字列の形式の誤りは `TypeError`/`RangeError` にしない）。
 * - `registerEmbeddingSpace` の次元: 渡された値と、正の整数が要ること、テーブルを作っていないこと。
 *   種類は数でなければ `TypeError`・数として不正なら `RangeError`（`vector-space-dimensions-error-types.test.ts`）。
 */

const untouchablePool = new Proxy(
  {},
  {
    get() {
      throw new Error("pool was touched before the dimensions check");
    },
  },
) as unknown as Pool;

function caught(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  return expect.fail("例外が投げられなかった");
}

async function caughtAsync(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    return error as Error;
  }
  return expect.fail("例外が投げられなかった");
}

describe("assertSafeIdentifier の拒否の文面", () => {
  it.each(["Upper", "1abc", "has space", "semi;colon", "ハイフン-"])(
    "拒んだ識別子（%s）を名乗り、使える形を書く",
    (identifier) => {
      const error = caught(() => assertSafeIdentifier(identifier));

      expect(error.message).toContain(`unsafe SQL identifier: ${identifier} `);
      expect(error.message).toContain("英小文字・数字・_");
      expect(error.message).toContain("先頭は英小文字か _");
      expect(error.message).toContain("/^[a-z_][a-z0-9_]*$/");
    },
  );

  it("例外の種類は素の Error のまま（TypeError・RangeError にしない）", () => {
    const error = caught(() => assertSafeIdentifier("Upper"));

    expect(error.constructor).toBe(Error);
    expect(error.name).toBe("Error");
  });

  it("使える形の識別子は拒まない", () => {
    expect(() => assertSafeIdentifier("memory_embeddings_a1")).not.toThrow();
    expect(() => assertSafeIdentifier("_x")).not.toThrow();
  });
});

describe("registerEmbeddingSpace の次元の拒否の文面", () => {
  function spaceWith(dimensions: unknown) {
    return { provider: "test", model: "dims-message", dimensions: dimensions as number };
  }

  it.each([
    ["0", 0],
    ["負", -3],
    ["小数", 1.5],
  ])(
    "正の整数でない数（%s）: 渡された値と、正の整数が要ること、テーブルを作っていないことを書く",
    async (_n, value) => {
      const error = await caughtAsync(() =>
        registerEmbeddingSpace(untouchablePool, spaceWith(value)),
      );

      expect(error).toBeInstanceOf(RangeError);
      expect(error.message).toContain(`invalid embedding space dimensions: ${value} `);
      expect(error.message).toContain("正の整数である必要がある");
      expect(error.message).toContain("テーブルは作成していない");
    },
  );

  it("数でない値: 渡された値と、正の整数が要ること、テーブルを作っていないことを書く", async () => {
    const error = await caughtAsync(() =>
      registerEmbeddingSpace(untouchablePool, spaceWith("abc")),
    );

    expect(error).toBeInstanceOf(TypeError);
    expect(error.message).toContain("invalid embedding space dimensions: abc ");
    expect(error.message).toContain("正の整数である必要がある");
    expect(error.message).toContain("テーブルは作成していない");
  });

  it("hnsw の上限超: 渡された値と、上限の値と、テーブルを作っていないことを書く", async () => {
    const error = await caughtAsync(() => registerEmbeddingSpace(untouchablePool, spaceWith(2001)));

    expect(error).toBeInstanceOf(RangeError);
    expect(error.message).toContain("invalid embedding space dimensions: 2001 ");
    expect(error.message).toContain("最大 2000 次元");
    expect(error.message).toContain("テーブルは作成していない");
  });
});

import { describe, expect, it } from "vitest";
import { LocalEmbeddingProvider } from "../local-embedding-provider.js";

// `retry.attempts` の扱い（Issue #1785）。
// 有限でない数（±Infinity）は構築時に RangeError で拒む。NaN・0以下は1回に丸め、小数は
// `<=` 比較で実質切り捨てる（今までどおり）。`new` はモデルを読まないので、ネットワークは要らない。

async function attemptsMade(attempts: number | undefined): Promise<number> {
  let calls = 0;
  const provider = new LocalEmbeddingProvider({
    createPipeline: async () => {
      calls += 1;
      throw new Error("取得できない");
    },
    retry: { attempts, delayMs: () => 0 },
    sleep: async () => {},
  });
  await provider.warmup().then(
    () => expect.fail("例外が投げられなかった"),
    () => undefined,
  );
  return calls;
}

describe("LocalEmbeddingProvider: retry.attempts が有限でない数なら構築時に投げる", () => {
  it.each([
    ["Infinity", Infinity],
    ["-Infinity", -Infinity],
  ])("%s は RangeError で、message に option 名と値が入る", (_l, value) => {
    expect(() => new LocalEmbeddingProvider({ retry: { attempts: value } })).toThrow(RangeError);
    expect(() => new LocalEmbeddingProvider({ retry: { attempts: value } })).toThrow(
      new RegExp(`LocalEmbeddingProvider: retry\\.attempts must not be infinite, got ${value}`),
    );
  });
});

describe("LocalEmbeddingProvider: retry.attempts の丸めは変えない", () => {
  it.each([
    ["NaN", 1, Number.NaN],
    ["0", 1, 0],
    ["-1", 1, -1],
    ["0.5", 1, 0.5],
    ["1", 1, 1],
    ["2.5", 2, 2.5],
    ["3", 3, 3],
    ["未指定", 3, undefined],
  ])(
    "attempts が %s のとき、createPipeline の呼び出しは合計 %s 回",
    async (_label, expected, value) => {
      expect(await attemptsMade(value)).toBe(expected);
    },
  );
});

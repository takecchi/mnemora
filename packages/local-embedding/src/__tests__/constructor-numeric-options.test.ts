import { describe, expect, it } from "vitest";
import { LocalEmbeddingProvider } from "../local-embedding-provider.js";

// ADR 0498: dimensions・numThreads は構築時に検査する（正の安全な整数）。省略時の既定は変えない。
// `new` はモデルを読まない（読むのは最初の embed()）ので、ここはネットワークも要らない。

const bad: [string, unknown][] = [
  ["0", 0],
  ["負", -1],
  ["小数 1.5", 1.5],
  ["NaN", Number.NaN],
  ["Infinity", Infinity],
  ["MAX_SAFE_INTEGER + 1", Number.MAX_SAFE_INTEGER + 1],
  ["文字列 '4'", "4"],
  ["null", null],
];

describe("LocalEmbeddingProvider: dimensions・numThreads を構築時に検査する（ADR 0498）", () => {
  it.each(bad)("numThreads が %s なら構築時に投げる", (_l, value) => {
    expect(() => new LocalEmbeddingProvider({ numThreads: value as never })).toThrow(
      /LocalEmbeddingProvider: numThreads must be a positive safe integer/,
    );
  });

  it.each(bad)("dimensions が %s なら構築時に投げる", (_l, value) => {
    expect(() => new LocalEmbeddingProvider({ dimensions: value as never })).toThrow(
      /LocalEmbeddingProvider: dimensions must be a positive safe integer/,
    );
  });

  it("型が違うと TypeError、数として不正だと RangeError、message に値が入る", () => {
    expect(() => new LocalEmbeddingProvider({ numThreads: "4" as never })).toThrow(TypeError);
    expect(() => new LocalEmbeddingProvider({ numThreads: 0 })).toThrow(RangeError);
    expect(() => new LocalEmbeddingProvider({ dimensions: -7 })).toThrow(/got -7/);
  });

  it.each([
    ["1（下限）", 1],
    ["4", 4],
    ["MAX_SAFE_INTEGER（上限）", Number.MAX_SAFE_INTEGER],
  ])("numThreads・dimensions が %s なら通る", (_l, value) => {
    expect(() => new LocalEmbeddingProvider({ numThreads: value })).not.toThrow();
    expect(new LocalEmbeddingProvider({ dimensions: value }).space.dimensions).toBe(value);
  });

  it("省略（既定）は通り、既定の次元（256）のまま", () => {
    expect(new LocalEmbeddingProvider().space.dimensions).toBe(256);
    expect(() => new LocalEmbeddingProvider({ numThreads: undefined })).not.toThrow();
  });
});

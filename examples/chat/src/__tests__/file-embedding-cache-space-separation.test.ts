import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EmbeddingSpaceId } from "@mnemora/core";
import { FileEmbeddingCache } from "../bench/embedding-cache.js";

const opened: FileEmbeddingCache[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const cache of opened.splice(0)) {
    cache.close();
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function open(dir: string, space: EmbeddingSpaceId): FileEmbeddingCache {
  const cache = new FileEmbeddingCache(dir, space);
  opened.push(cache);
  return cache;
}

// 1つの cacheDir に複数の空間のキャッシュを置ける（1インスタンス = 1空間）。次元が違えば `put` が次元不一致で断るが、
// provider か model だけが違う空間は次元が同じなので、ファイルを取り違えると別のモデルのベクトルが黙って返る。
describe("FileEmbeddingCache: 同じ cacheDir の、次元だけでは見分けられない空間を混ぜない", () => {
  const base: EmbeddingSpaceId = { provider: "fixture", model: "model-a", dimensions: 3 };

  it.each([
    ["model", { ...base, model: "model-b" }],
    ["provider", { ...base, provider: "fixture-b" }],
  ] as const)("%s だけが違う空間からは、もう片方が put したベクトルが見えない", (_label, other) => {
    const dir = mkdtempSync(join(tmpdir(), "file-embedding-cache-space-"));
    dirs.push(dir);
    const cacheA = open(dir, base);
    cacheA.put("いちじく", [1, 0, 0]);

    const cacheOther = open(dir, other);

    expect(cacheOther.get("いちじく")).toBeUndefined();
    expect(open(dir, base).get("いちじく")).toEqual([1, 0, 0]);
  });
});

// ファイル名は provider・model・dimensions から作る。記号を潰したり、区切りの `_` が名前の中の `_` と見分けられなかったり
// すると、別の空間が同じファイルを指す（Issue #1940）。
describe("FileEmbeddingCache: 記号や `_` の位置だけが違う空間を混ぜない", () => {
  it.each([
    [
      "model の `:` と `_`",
      { provider: "fixture", model: "x:y", dimensions: 3 },
      { provider: "fixture", model: "x_y", dimensions: 3 },
    ],
    [
      "provider と model の境目の `_`",
      { provider: "a_b", model: "c", dimensions: 3 },
      { provider: "a", model: "b_c", dimensions: 3 },
    ],
  ] as const)("%s: 片方が put したベクトルが、もう片方からは見えない", (_label, space, other) => {
    const dir = mkdtempSync(join(tmpdir(), "file-embedding-cache-space-"));
    dirs.push(dir);
    open(dir, space).put("いちじく", [1, 0, 0]);

    expect(open(dir, other).get("いちじく")).toBeUndefined();
    expect(open(dir, space).get("いちじく")).toEqual([1, 0, 0]);
  });
});

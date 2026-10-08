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

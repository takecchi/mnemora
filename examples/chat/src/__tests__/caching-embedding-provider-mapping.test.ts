import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { DeterministicEmbeddingProvider } from "@mnemora/testkit";
import { CachingEmbeddingProvider, FileEmbeddingCache } from "../bench/embedding-cache.js";

const ctx: Ctx = { tenantId: "caching-embedding-mapping" };

async function expectedVector(text: string): Promise<number[]> {
  const [vector] = await new DeterministicEmbeddingProvider().embed(ctx, [text]);
  return vector!;
}

const opened: { cache: FileEmbeddingCache; dir: string }[] = [];

afterEach(() => {
  for (const { cache, dir } of opened.splice(0)) {
    cache.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("CachingEmbeddingProvider: 取り逃したテキストとベクトルの対応（Issue #1000）", () => {
  it("一部がキャッシュ済みの入力でも、各テキストに正しいベクトルが返り、同じ対応でキャッシュされる", async () => {
    const inner = new DeterministicEmbeddingProvider();
    const dir = mkdtempSync(join(tmpdir(), "caching-embedding-mapping-"));
    const cache = new FileEmbeddingCache(dir, inner.space);
    opened.push({ cache, dir });
    const provider = new CachingEmbeddingProvider(inner, cache);
    await provider.embed(ctx, ["いちじく"]);
    const texts = ["なつめ", "いちじく", "ざくろ", "びわ"];

    const vectors = await provider.embed(ctx, texts);

    for (const [i, text] of texts.entries()) {
      const expected = await expectedVector(text);
      expect(vectors[i]).toEqual(expected);
      expect(cache.get(text)).toEqual(expected);
    }
  });

  it("ファイルから開き直したキャッシュでも、各テキストに正しいベクトルが対応している", async () => {
    const inner = new DeterministicEmbeddingProvider();
    const dir = mkdtempSync(join(tmpdir(), "caching-embedding-mapping-"));
    const first = new FileEmbeddingCache(dir, inner.space);
    const texts = ["なつめ", "いちじく", "ざくろ"];
    await new CachingEmbeddingProvider(inner, first).embed(ctx, texts);
    first.close();

    const reopened = new FileEmbeddingCache(dir, inner.space);
    opened.push({ cache: reopened, dir });
    for (const text of texts) {
      expect(reopened.get(text)).toEqual(await expectedVector(text));
    }
  });
});

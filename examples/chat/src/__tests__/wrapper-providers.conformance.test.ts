import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, vi } from "vitest";
import { ExtractionResultSchema, type LLMProvider } from "@mnemora/core";
import {
  DeterministicEmbeddingProvider,
  DeterministicLLMProvider,
  describeEmbeddingProviderConformance,
  describeLLMProviderConformance,
} from "@mnemora/testkit";
import { CountingEmbeddingProvider, CountingLLMProvider } from "../answer-bench.js";
import { CachingEmbeddingProvider, FileEmbeddingCache } from "../bench/embedding-cache.js";

// 適合テスト一式には要件を1つも足さない。包まれる側には Deterministic* を使う。

// examples/chat は zod に直接依存しないので、schema は core が公開する ExtractionResultSchema を使う。
const structuredSchema = ExtractionResultSchema;

describeLLMProviderConformance({
  name: "CountingLLMProvider",
  createProvider: () => new CountingLLMProvider(new DeterministicLLMProvider()),
  deterministic: true,
  prompt: { messages: [{ role: "user", content: "決定的な入力" }] },
  structured: {
    prompt: { messages: [{ role: "user", content: "決定的な構造化入力" }] },
    schema: structuredSchema,
  },
  createFailing: (error) => {
    const complete = vi.fn().mockRejectedValue(error);
    const completeStructured = vi.fn().mockRejectedValue(error);
    const inner: LLMProvider = { complete, completeStructured };
    return {
      provider: new CountingLLMProvider(inner),
      callCount: () => complete.mock.calls.length + completeStructured.mock.calls.length,
    };
  },
});

const embeddingTexts = { a: "赤", b: "青", c: "緑" };

describeEmbeddingProviderConformance({
  name: "CountingEmbeddingProvider",
  createProvider: () => new CountingEmbeddingProvider(new DeterministicEmbeddingProvider()),
  deterministic: true,
  texts: embeddingTexts,
});

// キャッシュは createProvider のたびに空の新しいディレクトリで作る。前の it のキャッシュを持ち越さない。
const createdCaches: { cache: FileEmbeddingCache; dir: string }[] = [];

afterAll(() => {
  for (const { cache, dir } of createdCaches) {
    cache.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

describeEmbeddingProviderConformance({
  name: "CachingEmbeddingProvider",
  createProvider: () => {
    const inner = new DeterministicEmbeddingProvider();
    const dir = mkdtempSync(join(tmpdir(), "caching-embedding-conformance-"));
    const cache = new FileEmbeddingCache(dir, inner.space);
    createdCaches.push({ cache, dir });
    return new CachingEmbeddingProvider(inner, cache);
  },
  deterministic: true,
  texts: embeddingTexts,
});

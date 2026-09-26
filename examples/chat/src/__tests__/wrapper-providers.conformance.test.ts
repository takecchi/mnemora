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

/**
 * `examples/chat` が持つ包み型の provider（`CountingLLMProvider`/`CountingEmbeddingProvider`、
 * `CachingEmbeddingProvider`）に、`@mnemora/testkit` の適合テスト一式をそのまま当てる。
 * **一式には要件を1つも足さない。** 包まれる側には `Deterministic*` を使う。
 *
 * `createFailing`: 包み型は下層の SDK client を持たないが、包まれる側が下層にあたる
 * ——必ず失敗する `LLMProvider` を包ませ、その呼び出し回数を数える。
 */

// examples/chat は zod に直接依存しないので、構造化の schema には core が公開している
// `ExtractionResultSchema`（runtime が実際に `completeStructured` へ渡す形）を使う。
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

// `FileEmbeddingCache` はファイルを開いたまま持つ——作ったものを覚えておき、最後に閉じて
// 一時ディレクトリごと消す。キャッシュは createProvider のたびに空の新しいディレクトリで作る
// （前の it で入ったキャッシュを次の it へ持ち越さない）。
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

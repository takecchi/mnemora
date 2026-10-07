// `DeterministicEmbeddingProvider` / `RecordedEmbeddingProvider` は入力長の上限を持たず、`overLimitText` を渡しても歯が何かを検出したことにならないので、この歯専用の provider を使う。

import type { Ctx, EmbeddingProvider, EmbeddingSpaceId } from "@mnemora/core";
import { describeEmbeddingProviderConformance } from "../embedding-provider-conformance.js";

const OVER_LIMIT_MAX_CHARS = 16;

/** 文字数で判定する最小の provider。本物のモデルの上限判定（トークン）は再現しない。 */
class RejectsOverLimitEmbeddingProvider implements EmbeddingProvider {
  readonly space: EmbeddingSpaceId = {
    provider: "testkit-over-limit-fixture",
    model: "over-limit-fixture",
    dimensions: 4,
  };

  async embed(_ctx: Ctx, texts: string[]): Promise<number[][]> {
    const tooLong = texts.find((text) => text.length > OVER_LIMIT_MAX_CHARS);
    if (tooLong !== undefined) {
      throw new Error(
        `RejectsOverLimitEmbeddingProvider: input exceeds ${String(OVER_LIMIT_MAX_CHARS)} chars`,
      );
    }
    return texts.map((text) => [text.length, 0, 0, 0]);
  }
}

describeEmbeddingProviderConformance({
  name: "RejectsOverLimitEmbeddingProvider（overLimitText の陽性対照）",
  createProvider: () => new RejectsOverLimitEmbeddingProvider(),
  deterministic: true,
  texts: { a: "赤", b: "青", c: "緑" },
  overLimitText: "x".repeat(OVER_LIMIT_MAX_CHARS + 1),
});

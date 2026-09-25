// Issue #449 / ADR 0304: `EmbeddingProviderConformanceOptions.overLimitText` の陽性対照。
//
// `describeEmbeddingProviderConformance` に足した「上限超過は reject する」歯そのものが
// 実際に何かを捕まえることを、ここで先に示す（AGENTS.md「⚠ 『出なかった』を、事象が
// 無いことの証明にしない」——先に陽性対照を示す）。
//
// `packages/testkit/src/__tests__/embedding-provider-fixtures.conformance.test.ts` が当てている
// `DeterministicEmbeddingProvider` / `RecordedEmbeddingProvider` はどちらも入力長の上限を
// 持たない（前者は文字コードの機械的な変換、後者は記録の再生）。そちらに `overLimitText` を
// 渡しても、この歯が「実際に何かを検出した」ことにはならない——渡していない理由は
// `embedding-provider-fixtures.conformance.test.ts` 冒頭コメントの対象外区分と同じである。
//
// ここでは、この歯のためだけの最小の provider を用意する: 一定の文字数を超えたら reject する
// ——本物の実装ではない（トークンではなく文字数で判定している。ADR 0090 が「字数はトークンの
// 代わりにならない」と釘を刺しているとおり、これは本物の上限モデルではない）。目的は
// 「歯が実際に reject を検出できること」だけを示すことであり、どのモデルの上限を再現するかは
// 問うていない。

import type { Ctx, EmbeddingProvider, EmbeddingSpaceId } from "@mnemora/core";
import { describeEmbeddingProviderConformance } from "../embedding-provider-conformance.js";

const OVER_LIMIT_MAX_CHARS = 16;

/**
 * `OVER_LIMIT_MAX_CHARS` 文字を超える入力を reject する、この歯専用の最小 provider。
 * ⛔ 本物のモデルの上限判定を再現してはいない（上記コメント参照）。
 */
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
  // `OVER_LIMIT_MAX_CHARS`（16）を確実に超える。
  overLimitText: "x".repeat(OVER_LIMIT_MAX_CHARS + 1),
});

import { describe, expect, it } from "vitest";
import { deriveClaimKeys } from "../claim-key.js";
import { describeExtractionFailure } from "../extraction.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";

/**
 * `describeClaimKeyFailure` は `describeExtractionFailure` の意図的な複製で、出力が同じであることだけが
 * 両者を結ぶ。メッセージが空の Error・Error の派生・メッセージを持つ素のオブジェクト・Symbol・BigInt も、
 * 同じ記述になる。
 */

class KindedError extends Error {
  readonly kind = "rate_limit";
}

const INPUTS: Array<[string, unknown]> = [
  ["メッセージが空の Error", new Error("")],
  ["kind を持つ Error の派生", new KindedError("boom")],
  ["message を持つが Error でないオブジェクト", { message: "boom" }],
  ["Symbol", Symbol("boom")],
  ["BigInt", 10n],
  ["空文字", ""],
  ["kind が空白だけの Error", Object.assign(new Error("x"), { kind: " " })],
];

describe("deriveClaimKeys の失敗の記述は、追加の入力でも describeExtractionFailure と同じ", () => {
  it.each(INPUTS)("%s", async (_label, thrown) => {
    const provider: LLMProvider = {
      complete: async () => {
        throw new Error("not used");
      },
      completeStructured: async () => {
        throw thrown;
      },
    };
    const result = await deriveClaimKeys(provider, { tenantId: "t" }, ["発話"]);
    expect(result.failure).toEqual(describeExtractionFailure(thrown));
  });
});

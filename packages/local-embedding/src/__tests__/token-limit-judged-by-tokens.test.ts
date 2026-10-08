import { describe, expect, it } from "vitest";
import { buildLocalEmbeddingPipeline } from "../pipeline.js";
import type { LocalEmbeddingExtractor } from "../pipeline.js";

/** 偽 extractor は手書きで、モデルは取得しない。ここが測るのは、超過の判定が文字数ではなくトークン数で行われることだけ。 */

/** 1文字を 1トークン未満に畳む（2文字で1トークン）。文字数がトークン数より多くなる形。 */
function fakeExtractor(modelMaxLength: number, dimensions = 4) {
  let calls = 0;
  const extractor = Object.assign(
    async (texts: string[]) => {
      calls += 1;
      return texts.map(() => Array.from({ length: dimensions }, () => 0.1));
    },
    {
      tokenizer: {
        model_max_length: modelMaxLength,
        encode: (text: string) => Array.from({ length: Math.ceil(text.length / 2) }, (_, i) => i),
      },
    },
  ) as unknown as LocalEmbeddingExtractor;
  return { extractor, calls: () => calls };
}

describe("buildLocalEmbeddingPipeline: 上限はトークン数で判定する", () => {
  /** `characters` は参考値で、判定は tokens と maxInputTokens の比較で行う（TSDoc）。 */
  it("文字数が model_max_length を超えても、トークン数が上限以下なら input_too_long にせず埋め込む", async () => {
    const handle = fakeExtractor(10);
    const pipeline = buildLocalEmbeddingPipeline(handle.extractor);
    const text = "あ".repeat(20); // 20 文字 = 10 トークン（上限ちょうど）

    const vectors = await pipeline.embed([text]);

    expect(vectors).toHaveLength(1);
    expect(handle.calls()).toBe(1);
  });
});

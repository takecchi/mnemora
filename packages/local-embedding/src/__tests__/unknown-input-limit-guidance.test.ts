import { describe, expect, it } from "vitest";
import { buildLocalEmbeddingPipeline } from "../pipeline.js";
import type { LocalEmbeddingExtractor } from "../pipeline.js";

function extractorWithoutDeclaredLimit(): LocalEmbeddingExtractor {
  return Object.assign(async (texts: string[]) => texts.map(() => [0.1]), {
    tokenizer: {
      model_max_length: Infinity,
      encode: (text: string) => Array.from({ length: text.length }, (_, i) => i),
    },
  }) as unknown as LocalEmbeddingExtractor;
}

describe("上限を宣言していないモデルの失敗の案内", () => {
  it("repo を差し替えるなら modelId も渡すことを案内する（repo だけを差し替えると構築時に例外になるため）", () => {
    let message = "";
    try {
      buildLocalEmbeddingPipeline(extractorWithoutDeclaredLimit());
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("options.repo");
    expect(message).toContain("options.modelId");
    expect(message).toContain("options.createPipeline");
  });
});

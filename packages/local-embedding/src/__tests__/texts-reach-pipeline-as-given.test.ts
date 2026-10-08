import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { LocalEmbeddingProvider } from "../local-embedding-provider.js";
import type { CreateLocalEmbeddingPipeline } from "../pipeline.js";

/** 偽 pipeline は受け取った配列を記録するだけで、モデルは取得しない。ここが測るのは「provider が pipeline へ何を・何回に分けて渡すか」だけ。 */
const ctx: Ctx = { tenantId: "texts-reach-pipeline-test" };

/** 既定の次元数（256）に合わせる。provider 側の次元検査に引っかからないようにするため。 */
function createRecordingPipeline() {
  const embeddedBatches: string[][] = [];
  const createPipeline: CreateLocalEmbeddingPipeline = async () => ({
    maxInputTokens: Number.MAX_SAFE_INTEGER,
    countTokens: (texts: string[]) => texts.map(() => 0),
    embed: async (texts: string[]) => {
      embeddedBatches.push([...texts]);
      return texts.map(() => Array.from({ length: 256 }, () => 0.1));
    },
  });
  return { createPipeline, embeddedBatches };
}

describe("LocalEmbeddingProvider.embed: バッチの分け方", () => {
  /** TSDoc の約束は「maxBatchSize を超えたときだけ分ける」。ちょうどの件数は1回で推論する。 */
  it("件数がちょうど maxBatchSize なら、pipeline.embed は1回だけ、全件で呼ばれる", async () => {
    const recorder = createRecordingPipeline();
    const provider = new LocalEmbeddingProvider({
      createPipeline: recorder.createPipeline,
      maxBatchSize: 3,
    });
    const texts = ["あ", "い", "う"];

    const vectors = await provider.embed(ctx, texts);

    expect(recorder.embeddedBatches).toEqual([texts]);
    expect(vectors).toHaveLength(3);
  });
});

describe("LocalEmbeddingProvider.embed: prefix", () => {
  /** TSDoc の約束は「全テキストの先頭に付ける」。すでに prefix で始まっているかは見ない。 */
  it("すでに prefix で始まるテキストにも prefix を付ける", async () => {
    const recorder = createRecordingPipeline();
    const provider = new LocalEmbeddingProvider({
      createPipeline: recorder.createPipeline,
      prefix: "検索: ",
    });

    await provider.embed(ctx, ["検索: 猫", "犬"]);

    expect(recorder.embeddedBatches).toEqual([["検索: 検索: 猫", "検索: 犬"]]);
  });
});

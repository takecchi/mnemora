// 本物の `LocalEmbeddingProvider` に適合 suite を当てる。流れるベクトルは本物の ruri-v3-30m (ONNX/q8) が返したもの（`./fixtures/real-ruri-embeddings.json`）。onnxruntime の推論・トークナイザ・モデルの取得は測らない。
// 注入した pipeline は表引きでバッチの組み方に依らず同じベクトルを返すが、本物のモデルは padding を伴うバッチ処理をするのでそうとは限らない。順序の歯が本物のモデルでも成り立つかは `./live.local-embedding.test.ts`（opt-in）が問う。
// モデルの重みは一切落とさない（`createPipeline` を注入する）。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { describeEmbeddingProviderConformance } from "@mnemora/testkit";
import {
  DEFAULT_LOCAL_EMBEDDING_DIMENSIONS,
  DEFAULT_LOCAL_EMBEDDING_MODEL_ID,
  LOCAL_EMBEDDING_PROVIDER_ID,
  LocalEmbeddingProvider,
} from "../local-embedding-provider.js";
import type { CreateLocalEmbeddingPipeline } from "../pipeline.js";

interface RealRuriEmbeddings {
  space: { provider: string; model: string; dimensions: number };
  entries: { text: string; vector: number[] }[];
}

const real = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./fixtures/real-ruri-embeddings.json", import.meta.url)),
    "utf8",
  ),
) as RealRuriEmbeddings;

const byText = new Map(real.entries.map((e) => [e.text, e.vector]));
const [a, b, c] = real.entries.map((e) => e.text) as [string, string, string];

/** 空配列で呼ばれたら投げる。足場が `[]` を返すと、`embed` の早期 return を消しても「`embed(ctx, [])` は `[]` を返す」の歯が緑のままになる（偽陽性）。投げるようにして初めて、空配列でモデルを起こしていないことを測れる。記録に無い入力にも投げる（黙って作りもののベクトルへ倒れない）。 */
// この足場は上限の検査を測らない（`input-token-limit.test.ts` の役目）ので、`maxInputTokens` / `countTokens` はダミーの値で埋める。実モデルの上限値を書かないこと。
const createReplayPipeline: CreateLocalEmbeddingPipeline = async () => {
  return {
    maxInputTokens: Number.MAX_SAFE_INTEGER,
    countTokens: (texts) => texts.map(() => 0),
    async embed(texts) {
      if (texts.length === 0) {
        throw new Error(
          "再生 pipeline: 空配列で呼ばれた。LocalEmbeddingProvider は embed(ctx, []) で" +
            "モデルを起こさずに返す契約であり（early return）、ここへ到達してはならない",
        );
      }
      return texts.map((text) => {
        const vector = byText.get(text);
        if (vector === undefined) {
          throw new Error(
            "再生 pipeline: この入力は記録に無い（黙って作りもののベクトルへ倒れない）。" +
              `入力: ${JSON.stringify(text)}。記録に在るのは ${real.entries.length} 件だけである` +
              "（fixtures/real-ruri-embeddings.json）",
          );
        }
        return vector;
      });
    },
  };
};

describe("適合テストの前提", () => {
  /** 順序の歯は `embed([a,b])[0] === embed([b,a])[1]` を見る。a と b のベクトルが同じだと、対応が壊れていてもこの等式が成り立つので、互いに違うことを前提として固定する。 */
  it("記録した3本のベクトルは互いに異なる", () => {
    const [va, vb, vc] = real.entries.map((e) => e.vector);
    expect(va).not.toEqual(vb);
    expect(vb).not.toEqual(vc);
    expect(va).not.toEqual(vc);
  });

  /** fixture の `space` を本物の定数から照合する。ベタ書きの文字列どうしを比べても、既定が変わったことは検出できない。 */
  it("fixture の space は LocalEmbeddingProvider の既定と一致する（ずれていたら写しが古い）", () => {
    expect(real.space).toEqual({
      provider: LOCAL_EMBEDDING_PROVIDER_ID,
      model: DEFAULT_LOCAL_EMBEDDING_MODEL_ID,
      dimensions: DEFAULT_LOCAL_EMBEDDING_DIMENSIONS,
    });
  });
});

describeEmbeddingProviderConformance({
  name: "LocalEmbeddingProvider（本物のモデルの出力を写した pipeline の再生）",
  // `createPipeline` 以外は渡さない。既定のまま（production と同じ `space`）で測る。
  createProvider: () => new LocalEmbeddingProvider({ createPipeline: createReplayPipeline }),
  // 決定性を与えているのは再生（表引き）であって、モデルではない。本物のモデルが決定的かどうかは `./live.local-embedding.test.ts` が測る。
  deterministic: true,
  texts: { a, b, c },
  // `overLimitText` は渡さない。`maxInputTokens` はダミーで、表引きに無い入力は「記録に無い」という別の理由で reject するので、渡しても上限検査を測ったことにならない（vacuous な緑）。本物の上限検査は `./input-token-limit.test.ts` と `./live.local-embedding.test.ts` が測っている。
});

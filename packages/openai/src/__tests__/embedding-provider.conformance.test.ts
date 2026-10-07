// 本物の `OpenAIEmbeddingProvider` に適合 suite を当てる。流れるベクトルは本物の `text-embedding-3-small` が返したもの（`./fixtures/recorded-openai-embeddings.json`）で、注入した client は記録の再生であって OpenAI ではない。HTTP・認証・リトライ・レート制限・実 API 自身の振る舞いは測らない。
// 実 API に当てるのは `./live.openai.test.ts` で、二重の opt-in が要る。この2つを混同しないこと。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type OpenAI from "openai";
import { describeEmbeddingProviderConformance } from "@mnemora/testkit";
import { OpenAIEmbeddingProvider } from "../embedding-provider.js";

interface RecordedEmbeddings {
  space: { provider: string; model: string; dimensions: number };
  entries: { text: string; vector: number[] }[];
}

// JSON を `import` せずに読む。`resolveJsonModule` を有効にすると、この歯1本のためにパッケージの tsconfig を広げることになる。
const recorded = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./fixtures/recorded-openai-embeddings.json", import.meta.url)),
    "utf8",
  ),
) as RecordedEmbeddings;

const MODEL = recorded.space.model;
const DIMENSIONS = recorded.space.dimensions;

const byText = new Map(recorded.entries.map((e) => [e.text, e.vector]));
const [a, b, c] = recorded.entries.map((e) => e.text) as [string, string, string];

/**
 * 記録した実応答を再生する、`Pick<OpenAI, "embeddings">` の形をした client。
 * `data` を index の降順（逆順）で返す。入力順のまま返すと、並べ直しを消しても出力が1ビットも変わらず、並べ直しを測ったことにならない。
 * ただし逆順にするだけでは順序の歯は `.sort(...)` の除去を検出しない。つねに逆順で返す実装は、2件の入れ替え（`[a,b]` と `[b,a]`）の等式を恒等的に満たすため、適合 suite 側の順序の歯を3件の巡回（`[a,b,c]` と `[b,c,a]`）にしてある。
 * 記録に無い入力には例外を投げる。黙って作りものベクトルへ倒れると、「本物のベクトルで測った」と読める出力に意味の無い値が混ざる。
 */
function createReplayClient(): Pick<OpenAI, "embeddings"> {
  const embeddings = {
    async create(params: { model: string; input: string[]; dimensions: number }) {
      if (params.model !== MODEL) {
        throw new Error(
          `再生クライアント: model が記録と違う（受け取り: ${params.model} / 記録: ${MODEL}）`,
        );
      }
      if (params.dimensions !== DIMENSIONS) {
        throw new Error(
          `再生クライアント: dimensions が記録と違う（受け取り: ${String(params.dimensions)} / 記録: ${DIMENSIONS}）`,
        );
      }
      // 空入力で呼ばれたら投げる。足場が空入力に `data: []` を返すと、`embed` の早期 return を消しても「`embed(ctx, [])` は `[]` を返す」の歯が緑のままになる。投げるようにして初めて、空配列で API を叩いていないことを測れる。
      if (params.input.length === 0) {
        throw new Error(
          "再生クライアント: 空の input で呼ばれた。OpenAIEmbeddingProvider は " +
            "embed(ctx, []) で client を呼ばずに返す契約であり、ここへ到達してはならない",
        );
      }
      const data = params.input.map((text, index) => {
        const vector = byText.get(text);
        if (vector === undefined) {
          throw new Error(
            "再生クライアント: この入力は記録に無い（黙って作りもののベクトルへ倒れない）。" +
              `入力: ${JSON.stringify(text)}。記録に在るのは ${recorded.entries.length} 件だけである` +
              "（fixtures/recorded-openai-embeddings.json）",
          );
        }
        return { index, embedding: vector, object: "embedding" as const };
      });
      // 逆順で返す（上記の理由）。
      return {
        object: "list" as const,
        model: MODEL,
        data: data.reverse(),
        usage: { prompt_tokens: 0, total_tokens: 0 },
      };
    },
  };
  return { embeddings } as unknown as Pick<OpenAI, "embeddings">;
}

/** 順序の歯は `embed([a,b])[0] === embed([b,a])[1]` を見る。a と b のベクトルが同じだと、並べ直しが壊れていてもこの等式が成り立つので、3本が互いに違うことを前提として固定する。 */
describe("適合テストの前提: 記録した3本のベクトルは互いに異なる", () => {
  it("a / b / c のベクトルは、どの2本を取っても一致しない", () => {
    const [va, vb, vc] = recorded.entries.map((e) => e.vector);
    expect(va).not.toEqual(vb);
    expect(vb).not.toEqual(vc);
    expect(va).not.toEqual(vc);
  });
});

describeEmbeddingProviderConformance({
  name: "OpenAIEmbeddingProvider（記録した実応答の再生）",
  createProvider: () =>
    new OpenAIEmbeddingProvider({
      model: MODEL,
      dimensions: DIMENSIONS,
      client: createReplayClient(),
    }),
  // 決定性を与えているのは再生であって、実 API ではない。実 API が決定的かどうかは測っておらず、`./live.openai.test.ts` は `deterministic: false` を宣言している。
  deterministic: true,
  texts: { a, b, c },
  // `overLimitText` は渡さない。`createReplayClient` は `byText` の表引きで上限の概念を持たず、渡しても上限検査を測ったことにならない（vacuous な緑）。サーバ拒否の伝播は `../embedding-provider.test.ts` の偽 client（400 相当のエラーを投げる）で測っている。
});

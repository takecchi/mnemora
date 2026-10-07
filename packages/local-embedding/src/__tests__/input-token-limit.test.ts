import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildLocalEmbeddingPipeline } from "../pipeline.js";
import type { LocalEmbeddingExtractor } from "../pipeline.js";
import { isLocalEmbeddingProviderError } from "../errors.js";
import type { LocalEmbeddingProviderError } from "../errors.js";
import { LocalEmbeddingProvider } from "../local-embedding-provider.js";

/**
 * `sirasagi62/ruri-v3-30m-ONNX` は 8192 トークンで黙って切り捨てる（例外もログも戻り値の変化も無い）。切り捨てそのものは直せないので、起きたことが分かるようにする。
 * 8192 という数字は測らない（モデルが持つ事実で、本物のモデルを落とさないと確かめられない。固定するのは `live.local-embedding.test.ts`）。ここが測るのは、上限をどう受け取り超過をどう名乗るかという、このパッケージ自身のロジックだけ。
 */

const ctx: Ctx = { tenantId: "t1" };

interface FakeExtractorHandle {
  readonly extractor: LocalEmbeddingExtractor;
  readonly calls: () => number;
}

/** トークン数は「1文字1トークン」と決めてある。本物のトークナイザの比率を真似ても意味が無く、測りたいのは上限との比較だけ。 */
function fakeExtractor(modelMaxLength: number, dimensions = 256): FakeExtractorHandle {
  let calls = 0;
  const extractor = Object.assign(
    async (texts: string[]) => {
      calls += 1;
      return texts.map(() => Array.from({ length: dimensions }, () => 0.1));
    },
    {
      tokenizer: {
        model_max_length: modelMaxLength,
        encode: (text: string) => Array.from({ length: text.length }, (_, i) => i),
      },
    },
  ) as unknown as LocalEmbeddingExtractor;
  return { extractor, calls: () => calls };
}

describe("buildLocalEmbeddingPipeline: 上限の受け取り", () => {
  /** `Infinity` は「上限が無い」ではなく「宣言されていない」。transformers.js の `get model_max_length()` は宣言が無いとき `Infinity` を返すので、そのまま通すと上限が分からないまま切り捨てが黙って起きる。 */
  it("model_max_length が Infinity（＝宣言されていない）なら、組み立て自体が失敗する", () => {
    expect(() => buildLocalEmbeddingPipeline(fakeExtractor(Infinity).extractor)).toThrow(
      /上限を宣言していない/,
    );
  });

  it("その失敗は kind: 'unknown_input_limit' を名乗る", () => {
    try {
      buildLocalEmbeddingPipeline(fakeExtractor(Infinity).extractor);
      expect.unreachable("組み立ては失敗しなければならない");
    } catch (error) {
      expect(isLocalEmbeddingProviderError(error)).toBe(true);
      expect((error as LocalEmbeddingProviderError).kind).toBe("unknown_input_limit");
    }
  });

  it.each([
    ["NaN", Number.NaN],
    ["0", 0],
    ["負の数", -1],
    ["小数", 512.5],
  ])("model_max_length が %s でも組み立てが失敗する", (_label, value) => {
    expect(() => buildLocalEmbeddingPipeline(fakeExtractor(value).extractor)).toThrow(
      /上限を宣言していない/,
    );
  });
});

describe("buildLocalEmbeddingPipeline: 上限の境界", () => {
  /** 境界は `>`。transformers.js の `tokenization_utils.js` は `encodedTokens[i].input_ids.length > max_length` で初めて切り詰めるので、`>=` で落とすと切り捨てられていない入力を拒否する。 */
  it("上限ちょうど（10トークン / 上限10）は通る", async () => {
    const handle = fakeExtractor(10);
    const pipeline = buildLocalEmbeddingPipeline(handle.extractor);
    const vectors = await pipeline.embed(["あ".repeat(10)]);
    expect(vectors).toHaveLength(1);
    expect(handle.calls()).toBe(1);
  });

  it("上限を1トークン超える（11トークン / 上限10）と落ちる", async () => {
    const handle = fakeExtractor(10);
    const pipeline = buildLocalEmbeddingPipeline(handle.extractor);
    await expect(pipeline.embed(["あ".repeat(11)])).rejects.toThrow(/上限を超えている/);
  });

  /** 超過が確定している入力に、36MB のモデルを回す費用を払わせない。この歯が無いと、落ちる前に推論している形を緑で通す。 */
  it("落ちるとき、extractor（推論）は一度も呼ばれない", async () => {
    const handle = fakeExtractor(10);
    const pipeline = buildLocalEmbeddingPipeline(handle.extractor);
    await expect(pipeline.embed(["あ".repeat(11)])).rejects.toThrow();
    expect(handle.calls()).toBe(0);
  });
});

describe("buildLocalEmbeddingPipeline: 超過の名乗り方", () => {
  it("kind: 'input_too_long' と、原因を追える欄を持つ", async () => {
    const handle = fakeExtractor(10);
    const pipeline = buildLocalEmbeddingPipeline(handle.extractor);
    const error = await pipeline.embed(["あ".repeat(25)]).then(
      () => null,
      (reason: unknown) => reason,
    );

    expect(isLocalEmbeddingProviderError(error)).toBe(true);
    const typed = error as LocalEmbeddingProviderError;
    expect(typed.kind).toBe("input_too_long");
    expect(typed.detail).toEqual({
      index: 0,
      tokens: 25,
      maxInputTokens: 10,
      characters: 25,
    });
  });

  it("複数件のうち何番目が長すぎたのかを名乗る", async () => {
    const handle = fakeExtractor(10);
    const pipeline = buildLocalEmbeddingPipeline(handle.extractor);
    const error = await pipeline.embed(["短い", "あ".repeat(30), "これも短い"]).then(
      () => null,
      (reason: unknown) => reason,
    );
    expect((error as LocalEmbeddingProviderError).detail?.index).toBe(1);
    expect((error as LocalEmbeddingProviderError).detail?.tokens).toBe(30);
  });

  /** 文字数は「参考」であって「判定に使った値」ではない。トークン数と文字数の比は文章によって変わるので、両方が欄として残り混同されていないことを固定する。 */
  it("トークン数と文字数を、別の欄として残す", async () => {
    const handle = fakeExtractor(10);
    const pipeline = buildLocalEmbeddingPipeline(handle.extractor);
    const error = await pipeline.embed(["x".repeat(12)]).then(
      () => null,
      (reason: unknown) => reason,
    );
    const detail = (error as LocalEmbeddingProviderError).detail;
    expect(detail?.tokens).toBe(12);
    expect(detail?.characters).toBe(12);
    expect(detail?.maxInputTokens).toBe(10);
  });
});

describe("LocalEmbeddingProvider 越しに見たとき", () => {
  it("上限を超えた入力で embed() が reject する", async () => {
    const provider = new LocalEmbeddingProvider({
      createPipeline: async () => buildLocalEmbeddingPipeline(fakeExtractor(10).extractor),
    });
    await expect(provider.embed(ctx, ["あ".repeat(11)])).rejects.toThrow(/上限を超えている/);
  });

  it("prefix を足したぶんも数える（prefix で上限を超えたら落ちる）", async () => {
    const provider = new LocalEmbeddingProvider({
      prefix: "検索文書: ",
      createPipeline: async () => buildLocalEmbeddingPipeline(fakeExtractor(10).extractor),
    });
    await expect(provider.embed(ctx, ["あいうえお"])).rejects.toThrow(/上限を超えている/);
  });

  it("detail の characters と tokens は、prefix を付けた後の文字列で数える", async () => {
    const provider = new LocalEmbeddingProvider({
      prefix: "検索文書: ",
      createPipeline: async () => buildLocalEmbeddingPipeline(fakeExtractor(10).extractor),
    });
    const error = await provider.embed(ctx, ["あいうえお"]).then(
      () => expect.fail("例外が投げられなかった"),
      (reason: unknown) => reason as LocalEmbeddingProviderError,
    );
    expect(error.detail?.characters).toBe(11);
    expect(error.detail?.tokens).toBe(11);
  });

  /** `#startLoad` は `createPipeline` の失敗を「モデルを読み込めなかった（repo が消えたなら再変換できる）」で包む。`unknown_input_limit` をそれで包むと、repo は取得できていて再変換しても上限は宣言されないので、嘘の助言になる。 */
  it("unknown_input_limit は「モデルを読み込めなかった」で包まれない", async () => {
    const provider = new LocalEmbeddingProvider({
      createPipeline: async () => buildLocalEmbeddingPipeline(fakeExtractor(Infinity).extractor),
    });
    const error = await provider.embed(ctx, ["あ"]).then(
      () => null,
      (reason: unknown) => reason,
    );
    expect((error as Error).message).not.toMatch(/モデルを読み込めなかった/);
    expect((error as LocalEmbeddingProviderError).kind).toBe("unknown_input_limit");
  });

  it("種類の付いていない失敗は、今までどおり「モデルを読み込めなかった」で包まれる", async () => {
    const provider = new LocalEmbeddingProvider({
      createPipeline: async () => {
        throw new Error("ネットワークが落ちた");
      },
    });
    await expect(provider.embed(ctx, ["あ"])).rejects.toThrow(/モデルを読み込めなかった/);
  });
});

describe("isLocalEmbeddingProviderError", () => {
  /** `instanceof` ではなく `kind` の値で判定する。bundler がクラスを二重に読み込んでも効くことを、クラスを一切使わない値で測る。 */
  it("クラスを経由していない素のオブジェクトでも、kind が合えば真になる", () => {
    expect(isLocalEmbeddingProviderError({ kind: "input_too_long" })).toBe(true);
    expect(isLocalEmbeddingProviderError({ kind: "unknown_input_limit" })).toBe(true);
  });

  it("関係のない値には偽を返す", () => {
    expect(isLocalEmbeddingProviderError(new Error("素の Error"))).toBe(false);
    expect(isLocalEmbeddingProviderError({ kind: "something_else" })).toBe(false);
    expect(isLocalEmbeddingProviderError(null)).toBe(false);
    expect(isLocalEmbeddingProviderError("input_too_long")).toBe(false);
  });
});

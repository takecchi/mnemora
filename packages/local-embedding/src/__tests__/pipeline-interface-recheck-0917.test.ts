import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildLocalEmbeddingPipeline } from "../pipeline.js";
import type { LocalEmbeddingExtractor, LocalEmbeddingPipeline } from "../pipeline.js";
import type { LocalEmbeddingProviderError } from "../errors.js";
import { LocalEmbeddingProvider } from "../local-embedding-provider.js";

/**
 * PR #446（ADR 0205）の確かめ直し（Issue #1812 まとまり G4）で見つかったすり抜けに足した歯。
 * 本物のモデルは使わない。注入点（`createPipeline`・擬似の extractor）だけで組む。
 *
 * 対象の約束:
 * - `LocalEmbeddingPipeline` は `maxInputTokens`・`countTokens`・`embed` の宣言を型で強制する
 * - `countTokens` は切り詰めずに、入力と同じ順・同じ長さで数える
 * - `buildLocalEmbeddingPipeline` は上限の値を焼き込まず、上限以下の入力を拒まない
 * - `LocalEmbeddingProvider` は pipeline の `embed` をメソッドとして呼び、`maxInputTokens`・`countTokens` は読まない
 */

const ctx: Ctx = { tenantId: "t1" };
const DIMENSIONS = 256;

/** テキストごとの文字数をトークン数とする extractor。出力は入力ごとに違うベクトル（先頭成分に文字数）。 */
function lengthExtractor(modelMaxLength: number): {
  extractor: LocalEmbeddingExtractor;
  received: () => string[][];
} {
  const received: string[][] = [];
  const extractor = Object.assign(
    async (texts: string[]) => {
      received.push([...texts]);
      return texts.map((text) => [text.length, ...Array.from({ length: DIMENSIONS - 1 }, () => 0)]);
    },
    {
      tokenizer: {
        model_max_length: modelMaxLength,
        encode: (text: string) => Array.from({ length: text.length }, (_, i) => i),
      },
    },
  ) as unknown as LocalEmbeddingExtractor;
  return { extractor, received: () => received };
}

describe("LocalEmbeddingPipeline は宣言を型で強制する（ADR 0205）", () => {
  // `@ts-expect-error` が「誤りが無い」と判定されると tsc が落ちる。vitest は型を見ないので、
  // この歯を守るのは `pnpm run typecheck`（`tsc -p tsconfig.json`、src/__tests__ を含む）である。
  it("宣言を欠いた pipeline は、型検査で弾かれる", () => {
    const embed = async (texts: string[]): Promise<number[][]> => texts.map(() => [0]);
    const complete: LocalEmbeddingPipeline = { maxInputTokens: 1, countTokens: () => [], embed };
    // @ts-expect-error maxInputTokens が無い
    const noLimit: LocalEmbeddingPipeline = { countTokens: () => [], embed };
    // @ts-expect-error countTokens が無い
    const noCount: LocalEmbeddingPipeline = { maxInputTokens: 1, embed };
    // @ts-expect-error embed が無い
    const noEmbed: LocalEmbeddingPipeline = { maxInputTokens: 1, countTokens: () => [] };
    // @ts-expect-error 旧来の関数型（テキスト→ベクトルの関数1本）は渡せない
    const legacy: LocalEmbeddingPipeline = embed;
    expect([complete, noLimit, noCount, noEmbed, legacy]).toHaveLength(5);
  });

  it("createPipeline の戻りにも、旧来の関数型は渡せない", () => {
    const options: ConstructorParameters<typeof LocalEmbeddingProvider>[0] = {
      // @ts-expect-error 関数だけを返す createPipeline は、宣言が無いので弾かれる
      createPipeline: async () => async (texts: string[]) => texts.map(() => [0]),
    };
    expect(options).toBeDefined();
  });
});

describe("buildLocalEmbeddingPipeline: 宣言した値の運び方", () => {
  it("countTokens は、上限で丸めずに、入力と同じ順・同じ長さで数える", () => {
    const pipeline = buildLocalEmbeddingPipeline(lengthExtractor(10).extractor);
    // 上限（10）を超える 25 も、そのまま 25 と数える。
    expect(pipeline.countTokens(["あ".repeat(3), "あ".repeat(25), "あ".repeat(10), ""])).toEqual([
      3, 25, 10, 0,
    ]);
    expect(pipeline.countTokens([])).toEqual([]);
  });

  it("maxInputTokens は、tokenizer が宣言した値そのもの（焼き込んだ値ではない）", () => {
    expect(buildLocalEmbeddingPipeline(lengthExtractor(1).extractor).maxInputTokens).toBe(1);
    expect(buildLocalEmbeddingPipeline(lengthExtractor(100_000).extractor).maxInputTokens).toBe(
      100_000,
    );
  });

  it("上限が 1 でも 100000 でも組み立てられ、上限以下の入力は通る", async () => {
    const small = buildLocalEmbeddingPipeline(lengthExtractor(1).extractor);
    await expect(small.embed(["あ"])).resolves.toHaveLength(1);
    const large = buildLocalEmbeddingPipeline(lengthExtractor(100_000).extractor);
    await expect(large.embed(["あ".repeat(9000)])).resolves.toHaveLength(1);
  });

  it("空文字（0トークン）・多数件（200件）の入力は、上限以下なので拒まない", async () => {
    const pipeline = buildLocalEmbeddingPipeline(lengthExtractor(10).extractor);
    await expect(pipeline.embed([""])).resolves.toHaveLength(1);
    const many = Array.from({ length: 200 }, () => "あ");
    await expect(pipeline.embed(many)).resolves.toHaveLength(200);
  });

  it("embed は入力と同じ順で extractor へ渡し、ベクトルも同じ順で返す", async () => {
    const handle = lengthExtractor(10);
    const pipeline = buildLocalEmbeddingPipeline(handle.extractor);
    const texts = ["あ", "あああ", "ああ"];
    const vectors = await pipeline.embed(texts);
    expect(handle.received()).toEqual([texts]);
    expect(vectors.map((v) => v[0])).toEqual([1, 3, 2]);
  });

  it("上限超過の detail.characters は、トークン数とは別に文字数を数える", async () => {
    // 1文字が 2 トークンになる tokenizer。tokens と characters は一致しない。
    const extractor = Object.assign(async () => [[0]], {
      tokenizer: {
        model_max_length: 10,
        encode: (text: string) => Array.from({ length: text.length * 2 }, (_, i) => i),
      },
    }) as unknown as LocalEmbeddingExtractor;
    const pipeline = buildLocalEmbeddingPipeline(extractor);
    const error = await pipeline.embed(["あ".repeat(6)]).then(
      () => expect.fail("例外が投げられなかった"),
      (reason: unknown) => reason as LocalEmbeddingProviderError,
    );
    expect(error.kind).toBe("input_too_long");
    expect(error.detail).toEqual({ index: 0, tokens: 12, maxInputTokens: 10, characters: 6 });
  });
});

describe("LocalEmbeddingProvider は注入された pipeline を、宣言を読まずにメソッドとして呼ぶ", () => {
  /** `this` を使う pipeline（class）。メソッドを取り出して呼ぶと `this` を失って落ちる。 */
  class ClassPipeline implements LocalEmbeddingPipeline {
    readonly batches: string[][] = [];
    get maxInputTokens(): number {
      throw new Error("provider が maxInputTokens を読んだ");
    }
    countTokens(): number[] {
      throw new Error("provider が countTokens を呼んだ");
    }
    async embed(texts: string[]): Promise<number[][]> {
      this.batches.push([...texts]);
      return texts.map(() => Array.from({ length: DIMENSIONS }, () => 0.1));
    }
  }

  it("1回で済む件数でも、embed をメソッドとして呼ぶ（this が保たれる）", async () => {
    const pipeline = new ClassPipeline();
    const provider = new LocalEmbeddingProvider({ createPipeline: async () => pipeline });
    await expect(provider.embed(ctx, ["あ", "い"])).resolves.toHaveLength(2);
    expect(pipeline.batches).toEqual([["あ", "い"]]);
  });

  it("分割して呼ぶ件数でも、embed をメソッドとして呼ぶ（this が保たれる）", async () => {
    const pipeline = new ClassPipeline();
    const provider = new LocalEmbeddingProvider({
      createPipeline: async () => pipeline,
      maxBatchSize: 2,
    });
    await expect(provider.embed(ctx, ["あ", "い", "う"])).resolves.toHaveLength(3);
    expect(pipeline.batches).toEqual([["あ", "い"], ["う"]]);
  });

  it("maxInputTokens も countTokens も読まない（上限を守るのは embed の側）", async () => {
    // ClassPipeline は maxInputTokens を読むと投げ、countTokens を呼ぶと投げる。
    const pipeline = new ClassPipeline();
    const provider = new LocalEmbeddingProvider({
      prefix: "検索文書: ",
      createPipeline: async () => pipeline,
    });
    await expect(provider.embed(ctx, ["あ".repeat(50)])).resolves.toHaveLength(1);
  });
});

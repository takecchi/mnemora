import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import {
  DEFAULT_LOCAL_EMBEDDING_MAX_BATCH_SIZE,
  LocalEmbeddingProvider,
} from "../local-embedding-provider.js";
import type { CreateLocalEmbeddingPipeline, LocalEmbeddingModelSpec } from "../pipeline.js";
import { LocalEmbeddingProviderError, isLocalEmbeddingProviderError } from "../errors.js";

/**
 * `LocalEmbeddingProviderOptions.maxBatchSize`（Issue #1141）の歯。
 *
 * **本物のモデルは一切落とさない**——`createPipeline` を注入した偽 pipeline で、
 * 「件数が `maxBatchSize` 以下なら1回で・超えたら `maxBatchSize` 件ずつに分けて呼ぶ」
 * という、このクラスが**新しく持つロジックだけ**を測る。実モデルでのビット一致は
 * `live.local-embedding.test.ts`（opt-in）が別途見る。
 *
 * ⭐ **偽 pipeline の出力は「そのバッチの中の位置（row）」に依存させてある**
 * （`(row + column) / 1000`）。これにより、「1回で渡したか・複数回に分けて渡したか」が、
 * 返ってきたベクトルの値そのものにも現れる——`embeddedBatches`（何が渡ったか）と
 * 二重に確かめられる。
 */

const ctx: Ctx = { tenantId: "max-batch-size-test" };

/** 偽 pipeline が1回のバッチに対して返すベクトル（このファイルの唯一の生成規則）。 */
function expectedVectorsForBatch(batchLength: number, dimensions: number): number[][] {
  return Array.from({ length: batchLength }, (_, row) =>
    Array.from({ length: dimensions }, (_, column) => (row + column) / 1000),
  );
}

/** ベクトルの配列を Float32 のバイト列にする（「ビット一致」を実際にバイトで比べるため）。 */
function toFloat32Bytes(vectors: number[][]): Buffer {
  const flat = vectors.flat();
  const f32 = new Float32Array(flat);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

/**
 * 呼ばれた回数と、各回に渡された配列（そのままの参照ではなくコピー）を記録する偽 pipeline。
 * ⚠ 既定の次元数は `LocalEmbeddingProvider` の既定（256）に合わせてある——
 * provider 側の次元検査（`vector.length !== this.space.dimensions`）に、
 * この歯の本題ではないところで引っかからないようにするため。
 */
function createRecordingPipeline(dimensions = 256) {
  const state = {
    createCalls: 0,
    embeddedBatches: [] as string[][],
  };
  const createPipeline: CreateLocalEmbeddingPipeline = async (_spec: LocalEmbeddingModelSpec) => {
    state.createCalls += 1;
    return {
      maxInputTokens: Number.MAX_SAFE_INTEGER,
      countTokens: (texts: string[]) => texts.map(() => 0),
      embed: async (texts: string[]) => {
        state.embeddedBatches.push([...texts]);
        return expectedVectorsForBatch(texts.length, dimensions);
      },
    };
  };
  return {
    createPipeline,
    embeddedBatches: state.embeddedBatches,
    get calls(): number {
      return state.createCalls;
    },
  };
}

/**
 * 偽 pipeline のうち、**`offendingCallIndex` 回目（0始まり）の呼び出しでだけ**、
 * その呼び出しに渡された配列の**バッチ内の位置** `offendingLocalIndex` が
 * `input_too_long` として reject されるもの。本物の `buildLocalEmbeddingPipeline` が
 * 「渡された配列の何番目か」を**そのバッチの中だけ**で数えるのと同じ形
 * （`pipeline.ts` の `embed` 参照）——グローバル（`texts` 全体での）位置は知らない。
 */
function createTokenLimitPipeline(offendingCallIndex: number, offendingLocalIndex: number) {
  const embeddedBatches: string[][] = [];
  let callIndex = -1;
  const createPipeline: CreateLocalEmbeddingPipeline = async () => ({
    maxInputTokens: 999,
    countTokens: (texts: string[]) => texts.map(() => 1),
    embed: async (texts: string[]) => {
      callIndex += 1;
      embeddedBatches.push([...texts]);
      if (callIndex === offendingCallIndex) {
        throw new LocalEmbeddingProviderError(
          "input_too_long",
          `LocalEmbeddingProvider: ${offendingLocalIndex} 番目の入力が上限を超えている` +
            `（1000 トークン > 上限 999 トークン、10 文字）。` +
            `入力を分割するか短くすること——同じ入力で再試行しても永久に失敗する`,
          { index: offendingLocalIndex, tokens: 1000, maxInputTokens: 999, characters: 10 },
        );
      }
      return expectedVectorsForBatch(texts.length, 256);
    },
  });
  return { createPipeline, embeddedBatches };
}

describe("既定値の export", () => {
  it("DEFAULT_LOCAL_EMBEDDING_MAX_BATCH_SIZE は 128 である", () => {
    // ⭐ 既定値そのものを書き下す（定数を参照するだけだと既定値が変わったことを検知できない）。
    expect(DEFAULT_LOCAL_EMBEDDING_MAX_BATCH_SIZE).toBe(128);
  });
});

describe("既定値以下（1回で推論、ビット一致）", () => {
  it.each([
    ["1件", 1],
    ["3件", 3],
    ["既定値ちょうど（128件）", DEFAULT_LOCAL_EMBEDDING_MAX_BATCH_SIZE],
  ])("%s は、pipeline.embed() を1回だけ、配列を丸ごと渡して呼ぶ", async (_label, count) => {
    const recorder = createRecordingPipeline();
    const provider = new LocalEmbeddingProvider({ createPipeline: recorder.createPipeline });
    const texts = Array.from({ length: count }, (_, i) => `テキスト${i}`);

    const vectors = await provider.embed(ctx, texts);

    expect(recorder.embeddedBatches).toHaveLength(1);
    expect(recorder.embeddedBatches[0]).toEqual(texts);

    // ⭐ ビット一致: 「1回で全部渡したときに pipeline が返す値」と Float32 のバイト列で完全一致する。
    const expected = expectedVectorsForBatch(count, 256);
    expect(toFloat32Bytes(vectors)).toEqual(toFloat32Bytes(expected));
  });

  it("maxBatchSize を明示的に指定しても、件数がそれ以下なら1回のまま", async () => {
    const recorder = createRecordingPipeline();
    const provider = new LocalEmbeddingProvider({
      createPipeline: recorder.createPipeline,
      maxBatchSize: 50,
    });
    const texts = Array.from({ length: 50 }, (_, i) => `テキスト${i}`);

    await provider.embed(ctx, texts);

    expect(recorder.embeddedBatches).toHaveLength(1);
    expect(recorder.embeddedBatches[0]).toHaveLength(50);
  });
});

describe("既定値より多い件数（分割して呼ぶ）", () => {
  it("129件（既定128）は 128件・1件 の2回に分けて、順番どおりに呼ぶ", async () => {
    const recorder = createRecordingPipeline();
    const provider = new LocalEmbeddingProvider({ createPipeline: recorder.createPipeline });
    const texts = Array.from({ length: 129 }, (_, i) => `テキスト${i}`);

    const vectors = await provider.embed(ctx, texts);

    expect(recorder.embeddedBatches).toHaveLength(2);
    expect(recorder.embeddedBatches[0]).toEqual(texts.slice(0, 128));
    expect(recorder.embeddedBatches[1]).toEqual(texts.slice(128, 129));
    // 件数は保たれる。
    expect(vectors).toHaveLength(129);
    // ⚠ 分割すると、2回目のバッチは「バッチ内の位置」から数え直すため、
    // 分割しない場合の値とは食い違う（これは q8 の実モデルでベクトルが動きうることの、
    // 偽 pipeline での類比である——ADR 0358 参照）。
    const notSplit = expectedVectorsForBatch(129, 256);
    expect(toFloat32Bytes(vectors)).not.toEqual(toFloat32Bytes(notSplit));
  });

  it("257件は 128・128・1 の3回に分けて呼ぶ", async () => {
    const recorder = createRecordingPipeline();
    const provider = new LocalEmbeddingProvider({ createPipeline: recorder.createPipeline });
    const texts = Array.from({ length: 257 }, (_, i) => `テキスト${i}`);

    await provider.embed(ctx, texts);

    expect(recorder.embeddedBatches.map((b) => b.length)).toEqual([128, 128, 1]);
    expect(recorder.embeddedBatches[0]).toEqual(texts.slice(0, 128));
    expect(recorder.embeddedBatches[1]).toEqual(texts.slice(128, 256));
    expect(recorder.embeddedBatches[2]).toEqual(texts.slice(256, 257));
  });

  it("maxBatchSize を指定したとき（120件を50件ずつ）も、その値で分ける", async () => {
    const recorder = createRecordingPipeline();
    const provider = new LocalEmbeddingProvider({
      createPipeline: recorder.createPipeline,
      maxBatchSize: 50,
    });
    const texts = Array.from({ length: 120 }, (_, i) => `テキスト${i}`);

    await provider.embed(ctx, texts);

    expect(recorder.embeddedBatches.map((b) => b.length)).toEqual([50, 50, 20]);
  });

  it("分割しても、モデルの読み込み（createPipeline）は1回のまま", async () => {
    const recorder = createRecordingPipeline();
    const provider = new LocalEmbeddingProvider({ createPipeline: recorder.createPipeline });
    const texts = Array.from({ length: 300 }, (_, i) => `テキスト${i}`);

    await provider.embed(ctx, texts);

    expect(recorder.calls).toBe(1);
  });

  it("返るベクトルの件数・次元の検査は、分割後の連結全体に対して働く", async () => {
    const recorder = createRecordingPipeline(8);
    const provider = new LocalEmbeddingProvider({
      dimensions: 8,
      createPipeline: recorder.createPipeline,
    });
    const texts = Array.from({ length: 200 }, (_, i) => `テキスト${i}`);

    const vectors = await provider.embed(ctx, texts);

    expect(vectors).toHaveLength(200);
    for (const vector of vectors) {
      expect(vector).toHaveLength(8);
    }
  });

  /**
   * 上限超過（`input_too_long`）の `index` は、**渡した配列全体での位置**を名乗る
   * （`errors.ts` の `LocalEmbeddingInputTooLongDetail.index` の doc:
   * 「`embed(ctx, texts)` に渡された配列の何番目か」）。分割すると pipeline は
   * バッチ内の位置しか知らないため、provider 側でチャンクの開始位置ぶんだけ
   * 足し戻す必要がある——それを確かめる。
   */
  it("2つ目以降のチャンクで上限超過が起きても、index はチャンク内ではなく全体での位置になる", async () => {
    // maxBatchSize=2、5件 ["a","b","c","d","e"] は [a,b] [c,d] [e] の3チャンクに分かれる。
    // 2回目の呼び出し（0始まりで callIndex=1、つまり [c,d]）のバッチ内 index 1（"d"）だけが
    // 上限超過する偽 pipeline を仕込む——"d" のグローバルな位置は 3（チャンク開始位置2 + ローカル1）。
    const { createPipeline, embeddedBatches } = createTokenLimitPipeline(1, 1);
    const provider = new LocalEmbeddingProvider({ createPipeline, maxBatchSize: 2 });
    const texts = ["a", "b", "c", "d", "e"];

    const error = await provider.embed(ctx, texts).then(
      () => null,
      (reason: unknown) => reason,
    );

    expect(isLocalEmbeddingProviderError(error)).toBe(true);
    const typed = error as LocalEmbeddingProviderError;
    expect(typed.kind).toBe("input_too_long");
    // 2回目のチャンク（[c, d]、グローバル index 2,3）のバッチ内 index 1 == "d" == グローバル index 3。
    expect(typed.detail?.index).toBe(3);
    expect(typed.message).toMatch(/3 番目の入力が上限を超えている/);
    // 1回目のチャンクは超過しないので最後まで呼ばれ、2回目で落ちた後は3回目を呼ばない。
    expect(embeddedBatches).toHaveLength(2);
  });
});

describe("分割しても、prefix・順序・上限超過以外の失敗は崩れない", () => {
  it("prefix を設定していても、分割した全チャンクの全件に prefix が付いて渡る（付けるのは分割の前）", async () => {
    const recorder = createRecordingPipeline();
    const provider = new LocalEmbeddingProvider({
      createPipeline: recorder.createPipeline,
      maxBatchSize: 2,
      prefix: "文書: ",
    });
    const texts = ["a", "b", "c", "d", "e"];

    await provider.embed(ctx, texts);

    expect(recorder.embeddedBatches).toEqual([
      ["文書: a", "文書: b"],
      ["文書: c", "文書: d"],
      ["文書: e"],
    ]);
    // 呼び出し側の配列は書き換わらない。
    expect(texts).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("返るベクトルの並びは入力の並びのまま（チャンクの結果を入力の順に連結する）", async () => {
    // 各テキスト（"0"〜"6"）の数字を先頭の成分に写す偽 pipeline。どのベクトルがどの入力のものかを値で見分けられる。
    const createPipeline: CreateLocalEmbeddingPipeline = async () => ({
      maxInputTokens: Number.MAX_SAFE_INTEGER,
      countTokens: (texts: string[]) => texts.map(() => 0),
      embed: async (texts: string[]) => texts.map((text) => [Number(text), 0, 0, 0]),
    });
    const provider = new LocalEmbeddingProvider({ dimensions: 4, createPipeline, maxBatchSize: 3 });
    const texts = ["0", "1", "2", "3", "4", "5", "6"];

    const vectors = await provider.embed(ctx, texts);

    expect(vectors.map((vector) => vector[0])).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("index を持たない失敗（素の Error・unknown_input_limit）は、チャンクが2つ目以降でも包み直さずそのまま投げる", async () => {
    const plain = new Error("network down");
    const unknownLimit = new LocalEmbeddingProviderError(
      "unknown_input_limit",
      "LocalEmbeddingProvider: 上限が分からない",
      null,
    );
    for (const failure of [plain, unknownLimit]) {
      let callIndex = -1;
      const createPipeline: CreateLocalEmbeddingPipeline = async () => ({
        maxInputTokens: 999,
        countTokens: (texts: string[]) => texts.map(() => 1),
        embed: async (texts: string[]) => {
          callIndex += 1;
          if (callIndex === 1) {
            throw failure;
          }
          return expectedVectorsForBatch(texts.length, 256);
        },
      });
      const provider = new LocalEmbeddingProvider({ createPipeline, maxBatchSize: 2 });

      const error = await provider.embed(ctx, ["a", "b", "c", "d", "e"]).then(
        () => null,
        (reason: unknown) => reason,
      );

      expect(error).toBe(failure);
    }
  });
});

describe("不正な maxBatchSize", () => {
  /**
   * `retry.attempts`（`local-embedding-provider.ts` のコンストラクタ）と同じ流儀で、
   * 分割ループが前進できることを構造的に保証するため、0以下・NaN は 1 に丸める
   * （投げない）。`maxBatchSize` はループの刻み幅・`Array.prototype.slice` の引数に
   * 直接使われるため、素通しすると無限ループや `slice(i, i+NaN)` による静かな
   * 空バッチ（テキストの消失）を起こしうる——`retry.attempts` より一段強い理由で
   * 丸めを選んでいる（ADR 0358）。
   */
  it.each([
    ["NaN", Number.NaN],
    ["0", 0],
    ["負の数", -5],
  ])("maxBatchSize が %s なら、1件ずつに丸めて分割する", async (_label, value) => {
    const recorder = createRecordingPipeline();
    const provider = new LocalEmbeddingProvider({
      createPipeline: recorder.createPipeline,
      maxBatchSize: value,
    });
    const texts = ["a", "b", "c"];

    await provider.embed(ctx, texts);

    expect(recorder.embeddedBatches).toEqual([["a"], ["b"], ["c"]]);
  });

  it("maxBatchSize が非整数（128.7）なら、切り捨てて使う", async () => {
    const recorder = createRecordingPipeline();
    const provider = new LocalEmbeddingProvider({
      createPipeline: recorder.createPipeline,
      maxBatchSize: 128.7,
    });
    const texts = Array.from({ length: 130 }, (_, i) => `テキスト${i}`);

    await provider.embed(ctx, texts);

    expect(recorder.embeddedBatches.map((b) => b.length)).toEqual([128, 2]);
  });

  it("maxBatchSize が Infinity なら、何件渡しても分割しない", async () => {
    const recorder = createRecordingPipeline();
    const provider = new LocalEmbeddingProvider({
      createPipeline: recorder.createPipeline,
      maxBatchSize: Number.POSITIVE_INFINITY,
    });
    const texts = Array.from({ length: 500 }, (_, i) => `テキスト${i}`);

    await provider.embed(ctx, texts);

    expect(recorder.embeddedBatches).toHaveLength(1);
    expect(recorder.embeddedBatches[0]).toHaveLength(500);
  });

  it("maxBatchSize が -Infinity なら、1件ずつに丸めて分割する", async () => {
    const recorder = createRecordingPipeline();
    const provider = new LocalEmbeddingProvider({
      createPipeline: recorder.createPipeline,
      maxBatchSize: Number.NEGATIVE_INFINITY,
    });
    const texts = ["a", "b"];

    await provider.embed(ctx, texts);

    expect(recorder.embeddedBatches).toEqual([["a"], ["b"]]);
  });
});

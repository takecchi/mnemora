import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOCAL_EMBEDDING_MODEL_ID,
  DEFAULT_LOCAL_EMBEDDING_REPO,
  LocalEmbeddingProvider,
} from "../local-embedding-provider.js";

/**
 * この歯が捕まえないもの:
 * - 実際に読み込まれた重みが `modelId` の名乗りと合っているか。縛っているのは宣言どうしの整合（`repo` を変えたら `modelId` も変えたか）だけで、本物の指紋照合は別の話。
 * - `dtype`。量子化が変われば出てくるベクトルは変わりうるが、この guard は `dtype` を見ない。
 * - 既定の `repo` と `modelId` の組が正しいこと。
 * モデルのサイズをこのファイルに書かない。サイズの正本は `scripts/__tests__/local-embedding-size-noun-correspondence.test.mjs` が持ち、書くと数字と名詞が対応していないとして赤になる。
 * 既定の repo/modelId の文字列を literal で書かない。差し替え側には既定から確実に異なる値（`${DEFAULT_LOCAL_EMBEDDING_REPO}-OTHER`）を使う。焼き込んだ錨に頼ると、既定値が変わったときにこの歯が意味を失っていることに気づけない。
 */

const OTHER_REPO = `${DEFAULT_LOCAL_EMBEDDING_REPO}-OTHER`;
const OTHER_MODEL_ID = `${DEFAULT_LOCAL_EMBEDDING_MODEL_ID}-OTHER`;

describe("repo/modelId 宣言食い違い検査（コンストラクタ、Issue #142 / ADR 0247）", () => {
  it("既定のまま作れる（陽性対照——ここが落ちたら以下は何も測っていない）", () => {
    const provider = new LocalEmbeddingProvider();
    expect(provider.space.model).toBe(DEFAULT_LOCAL_EMBEDDING_MODEL_ID);
  });

  it("repo だけ差し替えると落ちる", () => {
    expect(() => new LocalEmbeddingProvider({ repo: OTHER_REPO })).toThrow();

    let message = "";
    try {
      new LocalEmbeddingProvider({ repo: OTHER_REPO });
    } catch (error) {
      message = (error as Error).message;
    }
    // メッセージ全文の一致では縛らない（文面を直すたびに歯が壊れる）。assert するのは (a) 渡した repo の値 (b) modelId という語 (c) space または EmbeddingSpaceId の語、の3点だけ。
    expect(message).toContain(OTHER_REPO);
    expect(message).toContain("modelId");
    expect(message).toMatch(/space|EmbeddingSpaceId/);
  });

  it("repo を差し替えても modelId を明示すれば通る（逃げ道が効く）", () => {
    const provider = new LocalEmbeddingProvider({ repo: OTHER_REPO, modelId: OTHER_MODEL_ID });
    expect(provider.space.model).toBe(OTHER_MODEL_ID);
  });

  it("既定と同じ repo を明示しても落ちない（誤検出しない）", () => {
    expect(() => new LocalEmbeddingProvider({ repo: DEFAULT_LOCAL_EMBEDDING_REPO })).not.toThrow();
  });

  it("modelId だけを差し替えるのは落ちない（この guard の範囲外である）", () => {
    const provider = new LocalEmbeddingProvider({ modelId: OTHER_MODEL_ID });
    expect(provider.space.model).toBe(OTHER_MODEL_ID);
  });

  it("repo を差し替えても、既定と同じ modelId を明示すれば通る（私設ミラーの逃げ道。決定3）", () => {
    const provider = new LocalEmbeddingProvider({
      repo: OTHER_REPO,
      modelId: DEFAULT_LOCAL_EMBEDDING_MODEL_ID,
    });
    expect(provider.space.model).toBe(DEFAULT_LOCAL_EMBEDDING_MODEL_ID);
  });

  it.each([
    ["revision", { revision: "0123456789abcdef0123456789abcdef01234567" }],
    ["cacheDir", { cacheDir: "/tmp/mnemora-guard-test-cache" }],
    ["dtype", { dtype: "fp32" as const }],
    ["numThreads", { numThreads: 1 }],
    ["dimensions", { dimensions: 128 }],
    ["prefix", { prefix: "" }],
    ["maxBatchSize", { maxBatchSize: 8 }],
    ["retry", { retry: { attempts: 1 } }],
    ["createPipeline", { createPipeline: async () => ({}) as never }],
  ])(
    "repo だけ差し替えて %s を同時に渡しても、modelId が無ければ落ちる（別の option で guard が黙らない）",
    (_name, extra) => {
      expect(() => new LocalEmbeddingProvider({ repo: OTHER_REPO, ...extra })).toThrow(OTHER_REPO);
    },
  );

  it("repo が空文字でも落ちる（`undefined` でないものは指定されたものとして見る）", () => {
    expect(() => new LocalEmbeddingProvider({ repo: "" })).toThrow(/modelId/);
  });

  it("大文字小文字だけ違う repo も、既定とは別の repo として落ちる（文字列そのままの比較）", () => {
    const shouted = DEFAULT_LOCAL_EMBEDDING_REPO.toUpperCase();
    expect(shouted).not.toBe(DEFAULT_LOCAL_EMBEDDING_REPO);
    expect(() => new LocalEmbeddingProvider({ repo: shouted })).toThrow(shouted);
  });
});

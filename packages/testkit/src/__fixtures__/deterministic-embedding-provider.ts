import type { Ctx, EmbeddingProvider, EmbeddingSpaceId } from "@mnemora/core";

/**
 * `EmbeddingProvider` の決定的な擬似実装。意味的な類似度は表現しない。同じテキストには常に同じベクトルを返す。
 */
export class DeterministicEmbeddingProvider implements EmbeddingProvider {
  readonly space: EmbeddingSpaceId;

  constructor(
    space: EmbeddingSpaceId = { provider: "testkit", model: "deterministic", dimensions: 8 },
  ) {
    // 構築時に断る: 本物の provider と揃え、`embed` の時点で `RangeError: Invalid array length` になるのを避ける。
    // 数でなければ TypeError、数として不正（小数・非有限・`0` 以下）は RangeError。
    const dimensionsMessage =
      "DeterministicEmbeddingProvider: space.dimensions は正の整数でなければならない" +
      `（${String(space.dimensions)}）。`;
    if (typeof space.dimensions !== "number") {
      throw new TypeError(dimensionsMessage);
    }
    if (!Number.isInteger(space.dimensions) || space.dimensions <= 0) {
      throw new RangeError(dimensionsMessage);
    }
    // 呼び出し側が構築後に書き換えても `space` が動かないよう、写して凍結する。
    this.space = Object.freeze({ ...space });
  }

  async embed(_ctx: Ctx, texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.vectorFor(text));
  }

  private vectorFor(text: string): number[] {
    const vector = new Array<number>(this.space.dimensions).fill(0);
    for (let i = 0; i < text.length; i += 1) {
      const bucket = i % this.space.dimensions;
      vector[bucket] = (vector[bucket] ?? 0) + text.charCodeAt(i);
    }
    return vector.map((value) => Math.round((value % 997) * 1000) / 1000);
  }
}

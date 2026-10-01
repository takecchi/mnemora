import type { Ctx, EmbeddingProvider, EmbeddingSpaceId } from "@mnemora/core";

/**
 * `EmbeddingProvider` の決定的な擬似実装（roadmap.md 段階3・PR 本文「擬似物の扱い」）。
 *
 * 本物の埋め込みモデルを模してはいない。文字コードから機械的にベクトルを作るだけであり、
 * 意味的な類似度は一切表現しない。**同じテキストには常に同じベクトルを返す**ことだけを
 * 保証する（decay/recall のテストではなく、observe → embed → embeddingStatus 遷移の
 * 配線を検査するために十分な性質）。
 */
export class DeterministicEmbeddingProvider implements EmbeddingProvider {
  readonly space: EmbeddingSpaceId;

  constructor(
    space: EmbeddingSpaceId = { provider: "testkit", model: "deterministic", dimensions: 8 },
  ) {
    // ADR 0452: 本物の provider と同じく、`space.dimensions` は正の整数でなければならない（以前は `embed` の時点で
    // `RangeError: Invalid array length` になるか、`0` なら空のベクトルを返していた）。構築時に断る。
    if (!Number.isInteger(space.dimensions) || space.dimensions <= 0) {
      throw new Error(
        "DeterministicEmbeddingProvider: space.dimensions は正の整数でなければならない" +
          `（${String(space.dimensions)}）。`,
      );
    }
    // 渡されたオブジェクトそのものは持たない（構築後に呼び出し側が書き換えても、`space` は動かない）。
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
    // 桁を丸めて安定した比較をしやすくする（浮動小数の誤差を避ける）。
    return vector.map((value) => Math.round((value % 997) * 1000) / 1000);
  }
}

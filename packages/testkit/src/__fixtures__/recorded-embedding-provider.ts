import type { Ctx, EmbeddingProvider, EmbeddingSpaceId } from "@mnemora/core";
import type { EmbeddingCassetteSection } from "./cassette.js";
import { embeddingCassetteKey } from "./cassette.js";

/**
 * 記録した実 API の応答を再生する `EmbeddingProvider`（ADR 0051）。
 *
 * **`DeterministicEmbeddingProvider` の代わりではない。**あちらは文字コードから
 * 機械的にベクトルを作る stub であり、意味的な類似度を一切表現しない（配線の検査用）。
 * こちらは**本物の `text-embedding-3-small` が実際に返したベクトルをそのまま返す**ため、
 * 記録済みの入力に対しては本物と同じ順位が出る。
 *
 * **記録に無い入力に対しては例外を投げる。**黙って stub のベクトルへ倒れたり、
 * ゼロベクトルを返したりしない——それをすると「本物で測った」と読める出力の中に
 * 意味を持たない値が混ざり、どの行が信用できるかが誰にも分からなくなる。
 * これは `DeterministicLLMProvider` が既に守っている原則（「知らない形に遭遇したら
 * 黙って何か返すことをしない」）の、この文脈への適用である。
 */
export interface RecordedEmbeddingProviderOptions {
  section: EmbeddingCassetteSection;
  /**
   * 呼び出し側が期待する埋め込み空間。指定すると、記録元の空間と食い違ったときに
   * **構築時に**落ちる。
   *
   * **なぜ必要か（ADR 0051 の「引き受ける負債」）**: カセットはモデル版を凍結する。
   * 呼び出し側が `text-embedding-3-small` / 256次元のつもりで、別のモデルで録った
   * カセットを読んだ場合、ベクトルは正常に引けてしまい、順位も出てしまう——
   * **数字が出るのに意味が違う**という最も見つけにくい壊れ方になる。ここで照合する。
   */
  expectedSpace?: EmbeddingSpaceId;
}

export class RecordedEmbeddingProvider implements EmbeddingProvider {
  readonly space: EmbeddingSpaceId;
  private readonly entries: EmbeddingCassetteSection["entries"];

  constructor(options: RecordedEmbeddingProviderOptions) {
    const { section, expectedSpace } = options;
    if (expectedSpace !== undefined) {
      const a = section.space;
      const b = expectedSpace;
      if (a.provider !== b.provider || a.model !== b.model || a.dimensions !== b.dimensions) {
        throw new Error(
          "RecordedEmbeddingProvider: カセットの埋め込み空間が、呼び出し側の期待と違う。" +
            `記録: ${a.provider}/${a.model}/${a.dimensions}次元、` +
            `期待: ${b.provider}/${b.model}/${b.dimensions}次元。` +
            "モデルか次元を変えたのなら、記録し直すこと。",
        );
      }
    }
    this.space = section.space;
    this.entries = section.entries;
  }

  async embed(_ctx: Ctx, texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      const entry = this.entries[embeddingCassetteKey(text)];
      if (entry === undefined) {
        throw new Error(
          "RecordedEmbeddingProvider: この入力は記録に無い（黙って擬似ベクトルへ倒れない）。" +
            `入力: ${JSON.stringify(text)}。` +
            "probe set や会話生成を変えたのなら、実キーを設定して記録し直すこと" +
            "（examples/chat の `record` サブコマンド）。",
        );
      }
      if (entry.vector.length !== this.space.dimensions) {
        throw new Error(
          "RecordedEmbeddingProvider: 記録されたベクトルの次元が空間と食い違っている。" +
            `記録: ${entry.vector.length}次元、空間: ${this.space.dimensions}次元。` +
            "カセットが壊れている。",
        );
      }
      return entry.vector;
    });
  }
}

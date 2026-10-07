import type { Ctx, EmbeddingProvider, EmbeddingSpaceId } from "@mnemora/core";
import type { EmbeddingCassetteSection } from "./cassette.js";
import { embeddingCassetteKey } from "./cassette.js";

/**
 * 記録した実 API の応答を再生する `EmbeddingProvider`（ADR 0051）。`DeterministicEmbeddingProvider` と違い、
 * 記録元の本物のモデルが返したベクトルをそのまま返す。
 * 記録に無い入力には例外を投げる: stub のベクトルやゼロベクトルへ黙って倒れると、本物で測った出力に意味の無い値が混ざり、信用できる行が分からなくなる。
 */
export interface RecordedEmbeddingProviderOptions {
  /** 再生するカセットの埋め込みの節。 */
  section: EmbeddingCassetteSection;
  /** 期待する埋め込み空間。指定すると、記録元の空間と食い違ったときに構築時に落ちる（別モデルで録ったカセットを、数字が出るまま読むのを防ぐ）。 */
  expectedSpace?: EmbeddingSpaceId | undefined;
}

/**
 * 記録した実 API のベクトルを再生する `EmbeddingProvider`（ADR 0051）。説明は {@link RecordedEmbeddingProviderOptions} の doc を見ること。
 * `space` はカセットの記録元の空間になる。
 *
 * 投げるもの: 構築時に `expectedSpace` が記録元と食い違えば `Error`。`embed` で記録に無い入力が1つでもあれば `Error`。
 * 記録されたベクトルの次元が空間と違う、または成分が有限の数でないときも `Error`（ADR 0452）。
 */
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
    this.space = Object.freeze({ ...section.space });
    this.entries = section.entries;
  }

  async embed(_ctx: Ctx, texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      const entry = this.entries[embeddingCassetteKey(text)];
      if (entry === undefined) {
        throw new Error(
          "RecordedEmbeddingProvider: この入力は記録に無い（黙って擬似ベクトルへ倒れない）。" +
            `入力: ${describeRecordedInput(text)}。` +
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
      const bad = entry.vector.findIndex((x) => typeof x !== "number" || !Number.isFinite(x));
      if (bad !== -1) {
        throw new Error(
          "RecordedEmbeddingProvider: 記録されたベクトルに有限でない成分がある" +
            `（${bad} 番目: ${String(entry.vector[bad])}）。カセットが壊れている。`,
        );
      }
      return [...entry.vector];
    });
  }
}

/** 例外の文面に載せる入力は先頭 80 文字と全体の長さだけにする: 本文を丸ごと載せると、例外文とそれを写すログが本文で埋まる。 */
function describeRecordedInput(text: string): string {
  const LIMIT = 80;
  const chars = Array.from(text);
  if (chars.length <= LIMIT) return JSON.stringify(text);
  return `${JSON.stringify(chars.slice(0, LIMIT).join(""))}…（全 ${chars.length} 文字）`;
}

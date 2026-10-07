import OpenAI from "openai";
import type { AbortOptions, Ctx, EmbeddingProvider, EmbeddingSpaceId } from "@mnemora/core";
import { runAbortable } from "@mnemora/core";
import { assertApiKeyFitsInHeader } from "./api-key.js";
import { assertPositiveSafeInteger } from "./option-check.js";
import type { OpenAIEmbeddingsClient } from "./client-types.js";

/**
 * {@link OpenAIEmbeddingProvider} のコンストラクタに渡す設定。
 *
 * 1インスタンス = 1 `EmbeddingSpaceId` に固定する。`model` / `dimensions` は実行時に変わらない。
 * `client` を省略すると SDK 既定のクライアント（`OPENAI_API_KEY` を読む）が使われ、SDK が 429・5xx を再試行する
 * （回数・timeout は SDK の既定）。変えたい場合は設定した `OpenAI` インスタンスを `client` へ渡す。
 */
export interface OpenAIEmbeddingProviderOptions {
  /**
   * API キー。省略すると SDK が `OPENAI_API_KEY` を読む。
   *
   * `client` を渡さないとき、ヘッダに載せられない文字（キーの途中の CR・LF・NUL など）を含めば、
   * **キーを含まない**メッセージの `Error` を構築時に投げる。`client` を渡したときは検査しない。
   */
  apiKey?: string | undefined;
  /** OpenAI の埋め込みモデル名（例: `text-embedding-3-small`）。`space.model` にそのまま入る。既定値は無い。 */
  model: string;
  /**
   * 返すベクトルの次元。API の `dimensions` にそのまま渡し、`space.dimensions` にも入る。
   * 返ったベクトルの次元がこれと違えば `embed` は例外を投げる。正の安全な整数でなければ構築時に投げる
   * （型が違えば `TypeError`、数として不正なら `RangeError`）。
   */
  dimensions: number;
  /**
   * 自分で作った `OpenAI` のクライアント（再試行・timeout を変えたいとき）。渡すと `apiKey` は使わず、
   * キーの検査もしない。型は SDK のクラスを名指ししない構造型 {@link OpenAIEmbeddingsClient}。
   */
  client?: OpenAIEmbeddingsClient | undefined;
}

/**
 * OpenAI の埋め込み API を呼ぶ `EmbeddingProvider`。1インスタンスは1つの埋め込み空間に固定される。
 *
 * 構築時: `client` を省き、キーが見つからなければ SDK が `OpenAIError`（`Missing credentials`）を投げる。
 * キーがヘッダに載せられない文字を含めば、キーを含まない `Error` を投げる。`dimensions` が不正なら
 * `TypeError` / `RangeError` を投げる。`embed` の `opts?.signal` は SDK の request options にも渡す。
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly space: EmbeddingSpaceId;
  private readonly client: OpenAIEmbeddingsClient;
  private readonly model: string;

  constructor(options: OpenAIEmbeddingProviderOptions) {
    assertPositiveSafeInteger("OpenAIEmbeddingProvider", "dimensions", options.dimensions);
    if (options.client !== undefined) {
      this.client = options.client;
    } else {
      const client = new OpenAI({ apiKey: options.apiKey });
      assertApiKeyFitsInHeader(
        "OpenAIEmbeddingProvider",
        "apiKey",
        "authorization",
        `Bearer ${client.apiKey}`,
      );
      this.client = client;
    }
    this.model = options.model;
    this.space = { provider: "openai", model: options.model, dimensions: options.dimensions };
  }

  /**
   * `texts` を1回の API 呼び出しで埋め込み、入力と同じ順（応答の `index` で並べ直す）で返す。
   * 空配列なら API を呼ばずに `[]` を返す（`opts.signal` が abort 済みなら、空配列でも `signal.reason` で reject する）。
   *
   * 失敗は SDK の例外がそのまま伝わる（専用のエラー型は無い）。`opts?.signal` は呼ぶ前・待っている間の abort で `signal.reason` で reject する。
   *
   * 応答を検査し、次のどれかが崩れていれば素の `Error`（メッセージは `OpenAIEmbeddingProvider:` で始まる）を投げる。
   * (1) `response.data` の件数が `texts.length` と等しい、(2) `index` が 0..n-1 をちょうど1回ずつ、
   * (3) 各ベクトルの長さが `space.dimensions` と等しい、(4) 成分がすべて有限。
   * メッセージに入力テキストの本文と API キーは入れない。`response.data` が丸ごと無い応答は生の `TypeError` が伝わる。
   */
  async embed(_ctx: Ctx, texts: string[], opts?: AbortOptions): Promise<number[][]> {
    opts?.signal?.throwIfAborted();
    if (texts.length === 0) {
      return [];
    }
    const response = await runAbortable(opts?.signal, async (signal) =>
      this.client.embeddings.create(
        {
          model: this.model,
          input: texts,
          dimensions: this.space.dimensions,
        },
        { signal },
      ),
    );
    const data = response.data;

    if (data.length !== texts.length) {
      throw new Error(
        `OpenAIEmbeddingProvider: ${texts.length} 件のテキストに対して ` +
          `${data.length} 件のベクトルが返った（model=${this.model}）`,
      );
    }

    // `index` で並べ直す: OpenAI は入力順を保つと文書化しているが、順序の保証を暗黙に信頼しない。
    const ordered = new Array<number[] | undefined>(texts.length);
    for (const [position, item] of data.entries()) {
      const index = item.index;
      if (!Number.isInteger(index) || index < 0 || index >= texts.length) {
        throw new Error(
          `OpenAIEmbeddingProvider: 応答の ${position} 番目の index が範囲外だった ` +
            `（index=${String(index)}、期待は 0 以上 ${texts.length} 未満の整数。model=${this.model}）`,
        );
      }
      if (ordered[index] !== undefined) {
        throw new Error(
          `OpenAIEmbeddingProvider: 応答の index=${index} が重複している ` +
            `（${position} 番目。0..${texts.length - 1} をちょうど1回ずつ期待。model=${this.model}）`,
        );
      }
      ordered[index] = item.embedding;
    }

    const vectors: number[][] = [];
    for (const [index, vector] of ordered.entries()) {
      if (vector === undefined) {
        throw new Error(
          `OpenAIEmbeddingProvider: 応答に index=${index} が無い（model=${this.model}）`,
        );
      }
      if (vector.length !== this.space.dimensions) {
        throw new Error(
          `OpenAIEmbeddingProvider: 宣言した次元数 ${this.space.dimensions} に対して、` +
            `API が返したベクトルは ${vector.length} 次元だった（${index} 番目。model=${this.model}）`,
        );
      }
      const nonFinite = vector.findIndex((component) => !Number.isFinite(component));
      if (nonFinite !== -1) {
        throw new Error(
          `OpenAIEmbeddingProvider: 返したベクトルに有限でない成分がある ` +
            `（${index} 番目のベクトルの ${nonFinite} 番目の成分が ${String(vector[nonFinite])}。` +
            `model=${this.model}）`,
        );
      }
      vectors.push(vector);
    }
    return vectors;
  }
}

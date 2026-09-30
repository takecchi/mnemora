import OpenAI from "openai";
import type { AbortOptions, Ctx, EmbeddingProvider, EmbeddingSpaceId } from "@mnemora/core";
import { assertApiKeyFitsInHeader } from "./api-key.js";
import type { OpenAIEmbeddingsClient } from "./client-types.js";

/**
 * {@link OpenAIEmbeddingProvider} のコンストラクタに渡す設定。
 *
 * 以下はクラスの説明を兼ねる——`packages/openai` の `EmbeddingProvider` 実装（docs/architecture.md §5.5）。
 *
 * 契約: 1インスタンス = 1 `EmbeddingSpaceId` に固定する（D8・§5.5）。`model` /
 * `dimensions` はコンストラクタ引数で固定され、実行時に変わらない。
 *
 * `client` を注入できるようにしてある。本番では省略して OpenAI SDK の既定クライアント
 * （`OPENAI_API_KEY` 環境変数を読む）を使うが、テストでは本物の HTTP を叩かない
 * 手書きの偽クライアントを注入する（PR 本文「擬似物の扱い」参照。ここで擬似にしているのは
 * ネットワーク呼び出しの往復だけであり、`EmbeddingSpaceId` の固定・入出力の対応付けは
 * 本物のロジックを検査している）。
 *
 * ⚠ **2026-09-26 追記（[Issue #884](https://github.com/takecchi/mnemora/issues/884)）:
 * `client` を省略すると `new OpenAI({ apiKey })` が作る SDK 既定のクライアントが使われる
 * ——このクライアントは SDK 自身が内部で 429・5xx 等に対して再試行する（実測:
 * `openai@7.10.0` は既定 `maxRetries: 2`＝最大3回・`timeout: 600000`ms。この数値は
 * mnemora の契約ではなく SDK の既定値であり、SDK の版が上がれば変わりうる）。再試行の
 * 有無・回数・timeout を変えたい呼び出し側は、`maxRetries`/`timeout` を設定した
 * `OpenAI` インスタンスを自分で作り、`client` へ渡すこと。**
 */
export interface OpenAIEmbeddingProviderOptions {
  /**
   * API キー。省略すると SDK が `OPENAI_API_KEY` を読む。
   *
   * **構築時に例外を投げることがある**（Issue #1080）: `client` を渡さずに SDK のクライアントを
   * このクラスが作るとき、SDK が送るヘッダ（`Authorization: Bearer <apiKey>`）に載せられない
   * 文字（キーの途中の CR・LF・NUL、U+0100 以上の文字など）を含んでいれば、**キーを含まない**
   * メッセージの `Error` を投げる（元の例外は `cause` にも付けない）。末尾の空白・改行のように
   * `fetch` が受け付ける値は拒まない。`client` を渡したときは検査しない。
   */
  apiKey?: string;
  /** OpenAI の埋め込みモデル名（例: `text-embedding-3-small`）。`space.model` にそのまま入る。既定値は無い。 */
  model: string;
  /**
   * 返すベクトルの次元。API の `dimensions` にそのまま渡し、`space.dimensions` にも入る。
   * 返ったベクトルの次元がこれと違えば `embed` は例外を投げる（下の `embed` の doc）。
   */
  dimensions: number;
  /**
   * 自分で作った `OpenAI` のクライアント（再試行・timeout を変えたいとき。上の Issue #884 の追記）。
   * 渡すと `apiKey` は使わず、キーの検査もしない。
   *
   * ⚠ **2026-09-29 追記（[Issue #1221](https://github.com/takecchi/mnemora/issues/1221)）:**
   * この欄の型は `openai` SDK のクラスを名指ししない自前の構造型 {@link OpenAIEmbeddingsClient}
   * である（以前は `Pick<OpenAI, "embeddings">` だった）。**`openai` を自分の依存として入れる
   * 版は、`@mnemora/openai` が固定している版と揃える必要が無い**（packages/openai/README.md 参照）。
   */
  client?: OpenAIEmbeddingsClient;
}

/**
 * OpenAI の埋め込み API を呼ぶ `EmbeddingProvider`（docs/architecture.md §5.5）。
 * 1インスタンスは1つの埋め込み空間に固定される。設定と、`client` を省いたときの SDK の既定の
 * 再試行は {@link OpenAIEmbeddingProviderOptions} の doc を見ること。
 *
 * 構築時: `client` を省き、キーが見つからなければ OpenAI の SDK が `OpenAIError`（`Missing credentials`）を投げる。
 * キーがヘッダに載せられない文字を含むときは、キーを含まない `Error` を投げる（`apiKey` の doc）。
 *
 * ⚠ **2026-09-29 追記（[Issue #1200](https://github.com/takecchi/mnemora/issues/1200)、
 * [ADR 0359](../../../docs/decisions/0359-abort-signal-for-provider-calls.md)）:
 * `embed` の第3引数 `opts?.signal` を、そのまま `embeddings.create` の request options
 * （`{ signal }`）へ渡す。** SDK が既定で対応する `AbortSignal` の仕組みに委ねているだけ。
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  /** `{ provider: "openai", model, dimensions }`。構築時に決まり、変わらない。 */
  readonly space: EmbeddingSpaceId;
  private readonly client: OpenAIEmbeddingsClient;
  private readonly model: string;

  constructor(options: OpenAIEmbeddingProviderOptions) {
    if (options.client !== undefined) {
      this.client = options.client;
    } else {
      const client = new OpenAI({ apiKey: options.apiKey });
      // Issue #1080: SDK は `Authorization: Bearer <apiKey>` を送る（`apiKey` を省略すると
      // `OPENAI_API_KEY` を読む）。`api-key.ts` の doc コメント参照。
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
   * 空配列なら API を呼ばずに `[]` を返す。
   *
   * 失敗は SDK の例外がそのまま伝わる（このクラスに専用のエラー型は無い）。
   *
   * ⚠ **2026-09-30 追記（[Issue #860](https://github.com/takecchi/mnemora/issues/860)、
   * [ADR 0305](../../../docs/decisions/0305-embedding-provider-input-limit-contract.md) の同日付追記）:
   * 応答を検査する。** 次のどれかが崩れていれば、素の `Error`（メッセージは `OpenAIEmbeddingProvider:` で始まる。
   * 専用のエラー型・`kind` は無い）を投げる——(1) `response.data` の件数が `texts.length` と等しい、
   * (2) `index` が 0..n-1 をちょうど1回ずつ（重複・欠落・範囲外が無い）、(3) 各ベクトルの長さが
   * `space.dimensions` と等しい、(4) 成分がすべて有限（`NaN`/`Infinity` が無い）。メッセージには期待値・実際の値・
   * 何番目かを入れ、入力テキストの本文と API キーは入れない。以前（〜1.1.x）は検査せず、食い違った応答の
   * 戻り値は未定義だった。これは**新しく例外になる場合が増える変更**であり、CHANGELOG の `[1.2.0]` と
   * docs/migration-v1.md に破壊的変更として書いてある。
   */
  // ⚠ 2026-09-26 追記（Issue #885）: `response.data` キー自体が丸ごと無い応答
  // （`{}` が返る等）が来ると、下の `data.length` は `TypeError`（`Cannot read properties of
  // undefined`）を投げる。このクラスは専用の
  // エラー型を持たず（`OpenAILLMProvider` の `kind` 分類に相当するものが埋め込み側には
  // 無い）、壊れた応答は最初から生の例外がそのまま呼び出し元へ伝播する形である
  // （`packages/openai/src/errors.ts` 冒頭コメントの同日付追記を参照）。
  // 2026-09-30: 上の検査は `data` が配列として在ることが前提で、その形の検査は足していない
  // （`{}` は従来どおり `TypeError` のまま）。
  //
  // ⚠ 2026-09-30 追記（Issue #860）: 2026-09-26 に「件数を検査しない・戻り値は未定義」と書いたが、
  // 上のとおり検査を足した。お手本は `@mnemora/local-embedding` の `LocalEmbeddingProvider.embed`
  // （`packages/local-embedding/src/local-embedding-provider.ts`）。
  async embed(_ctx: Ctx, texts: string[], opts?: AbortOptions): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }
    const response = await this.client.embeddings.create(
      {
        model: this.model,
        input: texts,
        dimensions: this.space.dimensions,
      },
      { signal: opts?.signal },
    );
    const data = response.data;

    // 件数: 入力と同じ件数でなければ、呼び出し側で memory とベクトルが1つずれて対応する。
    if (data.length !== texts.length) {
      throw new Error(
        `OpenAIEmbeddingProvider: ${texts.length} 件のテキストに対して ` +
          `${data.length} 件のベクトルが返った（model=${this.model}）`,
      );
    }

    // index: 0..n-1 をちょうど1回ずつ（重複・欠落・範囲外を落とす）。
    // OpenAI は入力順を保つと文書化しているが、`index` で並べ直して前提を作らない
    // （原則の姿3寄り: 順序の保証を暗黙のものとして信頼しない）。
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
        // 件数が一致し、範囲外・重複が無ければ欠落は起きない。型の上で確かめておく。
        throw new Error(
          `OpenAIEmbeddingProvider: 応答に index=${index} が無い（model=${this.model}）`,
        );
      }
      // 次元: 宣言した `space.dimensions` と実物の食い違いを、DB へ入る前に落とす。
      if (vector.length !== this.space.dimensions) {
        throw new Error(
          `OpenAIEmbeddingProvider: 宣言した次元数 ${this.space.dimensions} に対して、` +
            `API が返したベクトルは ${vector.length} 次元だった（${index} 番目。model=${this.model}）`,
        );
      }
      // 有限性: NaN / Infinity は pgvector が拒否する。原因から離れた SQL の失敗にしない。
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

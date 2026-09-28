import OpenAI from "openai";
import type { Ctx, EmbeddingProvider, EmbeddingSpaceId } from "@mnemora/core";
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
   * このクラスは返ったベクトルの次元を検査しない（下の `embed` の doc）。
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
   * 失敗は SDK の例外がそのまま伝わる（このクラスに専用のエラー型は無い）。件数・次元は検査しない（下の注）。
   */
  // ⚠ 2026-09-26 追記（Issue #885）: `response.data` キー自体が丸ごと無い応答
  // （`{}` が返る等）が来ると、下の `[...response.data]` は
  // `TypeError: response.data is not iterable` を投げる。このクラスは専用の
  // エラー型を持たず（`OpenAILLMProvider` の `kind` 分類に相当するものが埋め込み側には
  // 無い）、壊れた応答は最初から生の例外がそのまま呼び出し元へ伝播する形である
  // （`packages/openai/src/errors.ts` 冒頭コメントの同日付追記を参照）。
  //
  // ⚠ 2026-09-26 追記（Issue #860）: `response.data` の件数が `texts.length` と
  // 食い違った場合（多い・少ない・0件など）を検査していない。下の
  // `.sort(...).map(...)` は `response.data` に何件あってもその件数のまま返す
  // ——`@mnemora/local-embedding` の `LocalEmbeddingProvider.embed`
  // （`packages/local-embedding/src/local-embedding-provider.ts`）と違い、件数・次元の
  // 突き合わせを実行時に行わない。`EmbeddingProvider` の契約（`embed` は入力と同じ件数を
  // 返す）を守っているのは、OpenAI のサーバが常に `texts.length` 件を返すことへの
  // 依存であり、この関数自身の検査ではない。応答の件数が食い違ったときの戻り値は
  // 未定義である（ADR 0305 の「上限超過をサーバの拒否に依存する」負債と同じ形）。
  // 本番経路（`packages/core` の `runtime.ts`/`recall-runtime.ts`）は常に `texts` を
  // 1件ずつ渡すため、この食い違いは踏まれていない。
  async embed(_ctx: Ctx, texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }
    const response = await this.client.embeddings.create({
      model: this.model,
      input: texts,
      dimensions: this.space.dimensions,
    });
    // OpenAI は入力順を保つと文書化しているが、`index` で並べ直して前提を作らない
    // （原則の姿3寄り: 順序の保証を暗黙のものとして信頼しない）。
    return [...response.data].sort((a, b) => a.index - b.index).map((item) => item.embedding);
  }
}

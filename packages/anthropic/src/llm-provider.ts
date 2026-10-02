import Anthropic from "@anthropic-ai/sdk";
import type {
  AbortOptions,
  Ctx,
  LLMProvider,
  LLMResponse,
  PromptSpec,
  StructuredRequest,
} from "@mnemora/core";
import { runAbortable } from "@mnemora/core";
import { assertApiKeyFitsInHeader } from "./api-key.js";
import { assertPositiveSafeInteger } from "./option-check.js";
import type {
  AnthropicContentBlock,
  AnthropicMessageParam,
  AnthropicMessagesClient,
} from "./client-types.js";
import { AnthropicLLMProviderError } from "./errors.js";
import type { AnthropicJsonSchemaFormat } from "./json-schema.js";
import { translateForAnthropicStructuredOutput } from "./json-schema.js";

/**
 * `packages/anthropic` の `LLMProvider` 実装（docs/architecture.md §3.8・§5.4）。
 * `packages/openai` の `llm-provider.ts` と同じ構造・同じ契約で書く
 * （オーナーの決定: `LLMProvider` は差し替え可能でなければならない）。
 *
 * `completeStructured` がこのパッケージの中心的な責務——zod スキーマを Anthropic の
 * ネイティブ構造化出力（`output_config.format: json_schema`、`json-schema.ts` 参照）へ
 * 翻訳し、返ってきた JSON をもう一度 zod でパースして返す。**core・呼び出し側に
 * Anthropic SDK の型は一切現れない**（`Anthropic`/`Message` 等の型はこのファイルの外に出ない）。
 *
 * `client` を注入できるようにしてある（`@mnemora/openai` と同じ理由・同じ形。
 * `Pick<Anthropic, "messages">` は `OpenAILLMProviderOptions.client` の
 * `Pick<OpenAI, "chat">` に対応する）。
 *
 * ⚠ **2026-09-26 追記（[Issue #884](https://github.com/takecchi/mnemora/issues/884)）:
 * `client` を省略すると `new Anthropic({ apiKey })` が作る SDK 既定のクライアントが
 * 使われる——このクライアントは SDK 自身が内部で 429・5xx 等に対して再試行する
 * （実測: `@anthropic-ai/sdk@0.124.0` は既定 `maxRetries: 2`＝最大3回・
 * `timeout: 600000`ms。この数値は mnemora の契約ではなく SDK の既定値であり、
 * SDK の版が上がれば変わりうる）。再試行の有無・回数・timeout を変えたい呼び出し側は、
 * `maxRetries`/`timeout` を設定した `Anthropic` インスタンスを自分で作り、`client` へ
 * 渡すこと。**
 */

/** Anthropic の `messages.create` は `max_tokens` が必須（OpenAI の chat completions と違う）。
 * 省略時のデフォルトをここに持つ。**確かめていないこと**: 16000 という値そのものの妥当性
 * ——`@mnemora/openai` 側に対応する既定値は無い（OpenAI 側は `max_tokens` 省略可）ため、
 * 比較対象が無い。要求された出力の長さに応じて呼び出し側が `maxTokens` で上書きすることを
 * 前提にしている。 */
export const DEFAULT_MAX_TOKENS = 16000;

/** {@link AnthropicLLMProvider} のコンストラクタに渡す設定。 */
export interface AnthropicLLMProviderOptions {
  /**
   * API キー。省略すると SDK が `ANTHROPIC_API_KEY` を読む。
   *
   * **構築時に例外を投げることがある**（Issue #1080）: `client` を渡さずに SDK のクライアントを
   * このクラスが作るとき、SDK が送るヘッダ（`x-api-key`。SDK が `ANTHROPIC_AUTH_TOKEN` を
   * 読んだときは `Authorization: Bearer <authToken>` も）に載せられない文字（キーの途中の
   * CR・LF・NUL、U+0100 以上の文字など）を含んでいれば、**キーを含まない**メッセージの
   * `Error` を投げる（元の例外は `cause` にも付けない）。末尾の空白・改行のように
   * `fetch` が受け付ける値は拒まない。`client` を渡したときは検査しない。
   */
  apiKey?: string | undefined;
  /** ⚠ 必須。既定値を持たない（`@mnemora/openai` の `OpenAILLMProviderOptions.model` と
   * 同じ規律——どのモデルを使うかは呼び出し側が決める）。 */
  model: string;
  /**
   * 省略時 {@link DEFAULT_MAX_TOKENS}。
   *
   * ⚠ ADR 0498: **渡すなら正の安全な整数でなければ、構築時に投げる**（型が違えば `TypeError`、数として不正なら
   * `RangeError`。message に値が入る）。
   */
  maxTokens?: number | undefined;
  /**
   * 自分で作った `Anthropic` のクライアント（再試行・timeout を変えたいとき）。渡すと `apiKey` は使わず、
   * キーの検査もしない。
   *
   * ⚠ **2026-09-29 追記（[Issue #1221](https://github.com/takecchi/mnemora/issues/1221)）:**
   * この欄の型は `@anthropic-ai/sdk` のクラスを名指ししない自前の構造型
   * {@link AnthropicMessagesClient} である（以前は `Pick<Anthropic, "messages">` だった）。
   * **`@anthropic-ai/sdk` を自分の依存として入れる版は、`@mnemora/anthropic` が固定している
   * 版と揃える必要が無い**（packages/anthropic/README.md 参照）。
   */
  client?: AnthropicMessagesClient | undefined;
}

/** `toAnthropicRequest` の戻り値。`messages.create` にそのまま展開して渡す形。
 * `messages` の要素の型は {@link AnthropicMessageParam}（`client-types.ts`。
 * Anthropic の `messages` 配列は `role: "user" | "assistant"` のみで、
 * `role: "system"` は使えない——`system` は top-level パラメータ）。 */
export interface AnthropicRequest {
  /** `PromptSpec.system`。無ければ鍵ごと無い（Anthropic では top-level の `system` に入る）。 */
  system?: string;
  /** `PromptSpec.messages` を `role` と `content` だけの形にしたもの。 */
  messages: AnthropicMessageParam[];
}

/**
 * `PromptSpec` → Anthropic 形式への変換。**テストから直接検査できるように export する**
 * （`json-schema.ts` の翻訳と同じ理由——擬似 provider ではこの変換の壊れに気づけない）。
 *
 * **OpenAI と違う点**: OpenAI の `toOpenAIMessages`（`@mnemora/openai/src/llm-provider.ts`）は
 * `system` を `role: "system"` のメッセージとして `messages` 配列の先頭に積むだけで済む
 * （OpenAI の chat completions は `role: "system"` を受け付けるため）。Anthropic はそれを
 * 受け付けず、`system` は独立した top-level パラメータになる。そのため、ここでは
 * (1) `prompt.system` を top-level `system` の先頭に置き、
 * (2) `prompt.messages` のうち `role === "system"` のものは**黙って捨てず**、
 *     top-level `system` へ改行区切りで連結し、
 * (3) 残りの `user`/`assistant` だけを `messages` に入れる。
 *
 * 空文字の system（`prompt.system` も、`role === "system"` のメッセージの `content` も）は連結に入れない。
 * どれも空なら `system` の鍵ごと持たない（{@link AnthropicRequest.system} の「無ければ鍵ごと無い」）。
 * 以前は `prompt.system` の空文字だけを落とし、`content` が空文字の `role: "system"` のメッセージは
 * `system: ""` として送っていた。
 */
export function toAnthropicRequest(prompt: PromptSpec): AnthropicRequest {
  const systemParts: string[] = [];
  if (prompt.system) {
    systemParts.push(prompt.system);
  }

  const messages: AnthropicMessageParam[] = [];
  for (const message of prompt.messages) {
    if (message.role === "system") {
      if (message.content) {
        systemParts.push(message.content);
      }
      continue;
    }
    messages.push({ role: message.role, content: message.content });
  }

  return systemParts.length > 0 ? { system: systemParts.join("\n"), messages } : { messages };
}

/** 応答の `content` は content block の配列。テキストは `{ type: "text", text: string }`
 * ブロック。`@mnemora/openai` の「最初の choice の content」に対応する規律として、
 * **最初に見つかったテキストブロック**を採用する（thinking 等の他ブロック型は無視する）。
 *
 * ⚠ 2026-09-26 追記（[Issue #885](https://github.com/takecchi/mnemora/issues/885)）:
 * 呼び出し元（`complete`/`completeStructured`）はこの関数へ `response.content` を
 * そのまま渡す。`content` キー自体が応答オブジェクトに丸ごと無い場合（`{}` が返る等）、
 * `content` 引数は `undefined` になり、下の `content.find(...)` が
 * `TypeError: Cannot read properties of undefined (reading 'find')` を投げる——
 * `AnthropicLLMProviderError` の `kind` 分類には一切載らない。詳細は `errors.ts`
 * 冒頭コメントの同日付追記を参照。 */
function firstTextBlock(content: AnthropicContentBlock[]): string | undefined {
  return content.find((block) => block.type === "text")?.text;
}

/**
 * ⭐ **`content` を読む前に、必ずこれを通す。**
 *
 * **拒否は HTTP 200 で返る。** `stop_reason: "refusal"` が付いた成功応答であり、
 * SDK は例外を投げない。`content` には テキストブロックが1つも無いことがある。
 * ⟹ **見ないと、拒否を「空の成功」として core へ渡す。**
 *
 * **`stop_reason` が無い/null のときは通す。** 非 streaming では常に非 null だと
 * SDK の型コメントが述べているが、streaming の `message_start` では null になり、
 * テストの偽 client も設定しない。**「分からない」を「拒否された」と読まない。**
 *
 * **⚠ `truncated` は依頼された範囲の外である**（依頼は「拒否と空応答を区別する」だった）。
 * 同じ `stop_reason` を読む一手で分かり、**切り詰められた JSON は `SyntaxError` になって
 * 「モデルが壊れた JSON を吐いた」と区別が付かなくなる**ため、同じ固定点
 * （「無い」の種類を潰さない）に当たると判断して入れた。**要らなければ落とせる。**
 */
function assertNotRefusedOrTruncated(response: {
  stop_reason?: string | null;
  stop_details?: { category?: string | null } | null;
}): void {
  const stopReason = response.stop_reason ?? null;
  if (stopReason === null) {
    return;
  }
  if (stopReason === "refusal") {
    throw new AnthropicLLMProviderError({
      kind: "refusal",
      stopReason,
      refusalCategory: response.stop_details?.category ?? null,
    });
  }
  if (stopReason === "max_tokens" || stopReason === "model_context_window_exceeded") {
    throw new AnthropicLLMProviderError({ kind: "truncated", stopReason });
  }
}

/**
 * Anthropic の Messages API を呼ぶ `LLMProvider`。**`EmbeddingProvider` は実装しない**（Anthropic に埋め込み API が無い。
 * 埋め込みは別の provider を併用する）。設定は {@link AnthropicLLMProviderOptions} を見ること。
 *
 * 構築時: キーがヘッダに載せられない文字を含むときは、キーを含まない `Error` を投げる（`apiKey` の doc）。
 * `maxTokens` を渡すとき、正の安全な整数でなければ、`TypeError`（型が違う）か `RangeError`（数として不正）を投げる（ADR 0498。`AnthropicLLMProviderOptions.maxTokens` の doc）。
 * ⚠ キーが見つからなくても構築は通る——`complete()` などを呼んだ時点で、SDK の素の `Error`
 * （`Could not resolve authentication method`）が伝わる（`kind` を持たない。【実測 2026-09-27】）。
 *
 * 拒否・切り詰め・空応答は {@link AnthropicLLMProviderError} の `kind` で返る（`instanceof` ではなく `kind` で分岐すること）。
 * HTTP の失敗・認証の失敗などは、SDK の例外がそのまま伝わる。
 *
 * ⚠ **2026-09-29 追記（[Issue #1200](https://github.com/takecchi/mnemora/issues/1200)、
 * [ADR 0359](../../../docs/decisions/0359-abort-signal-for-provider-calls.md)）:
 * `complete`/`completeStructured` の第3引数 `opts?.signal` を、そのまま
 * `messages.create` の request options（`{ signal }`）へ渡す。** `@mnemora/openai` と
 * 同じ形——SDK が既定で対応する `AbortSignal` の仕組みに委ねているだけ。
 */
export class AnthropicLLMProvider implements LLMProvider {
  private readonly client: AnthropicMessagesClient;
  private readonly model: string;
  private readonly maxTokens: number;

  constructor(options: AnthropicLLMProviderOptions) {
    // ADR 0498: 省略（`undefined`）は既定。渡すなら正の安全な整数。
    if (options.maxTokens !== undefined) {
      assertPositiveSafeInteger("AnthropicLLMProvider", "maxTokens", options.maxTokens);
    }
    if (options.client !== undefined) {
      this.client = options.client;
    } else {
      const client = new Anthropic({ apiKey: options.apiKey });
      // Issue #1080: SDK は `apiKey` を `x-api-key` で、`authToken`（`ANTHROPIC_AUTH_TOKEN` から
      // 読まれうる）を `Authorization: Bearer <authToken>` で送る。`api-key.ts` の doc コメント参照。
      if (client.apiKey != null) {
        assertApiKeyFitsInHeader("AnthropicLLMProvider", "apiKey", "x-api-key", client.apiKey);
      }
      if (client.authToken != null) {
        assertApiKeyFitsInHeader(
          "AnthropicLLMProvider",
          "authToken",
          "authorization",
          `Bearer ${client.authToken}`,
        );
      }
      this.client = client;
    }
    this.model = options.model;
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  }

  /**
   * `req` を1回送り、最初のテキストブロックを返す。
   *
   * `stop_reason: "refusal"` は `kind: "refusal"`、`"max_tokens"`・`"model_context_window_exceeded"` は `kind: "truncated"` の
   * {@link AnthropicLLMProviderError} を投げる。⚠ どちらでもなくテキストブロックが無いときは、例外にせず空文字を返す
   * （ADR 0072「引き受けた負債」2。`@mnemora/openai` も同じ形）。
   *
   * ⚠ **`opts?.signal`（ADR 0359・ADR 0428）:** 呼ぶ前に abort 済みなら SDK を呼ばずに、待っている間に abort したら即座に、
   * `signal.reason`（`abortReason(signal)`）で reject する——SDK の `APIUserAbortError` には化けず、SDK の再試行待ち
   * （429 の `retry-after` 等）の最中でも切れる。`signal` は SDK にも渡すので、裏のリクエストも切れる。
   */
  async complete(_ctx: Ctx, req: PromptSpec, opts?: AbortOptions): Promise<LLMResponse> {
    const { system, messages } = toAnthropicRequest(req);
    const response = await runAbortable(opts?.signal, async (signal) =>
      this.client.messages.create(
        {
          model: this.model,
          max_tokens: this.maxTokens,
          ...(system !== undefined ? { system } : {}),
          messages,
        },
        { signal },
      ),
    );
    assertNotRefusedOrTruncated(response);
    // ⚠ **ここの `?? ""` は残した。** ADR 0072「引き受けた負債」2 の通り、
    // `@mnemora/openai` も同じ形であり、片方だけ throw にすると差し替えられなくなる。
    // **ただし上の門を通した後なので、意味が変わっている**——ここへ来る空文字は
    // 「拒否された」でも「切り詰められた」でもなく、**モデルが本当に何も言わなかった**場合だけである。
    // ⟹ **「空文字は安全だ」と主張しているのではない。**望ましい姿でもない。
    // 直すなら両 provider 同時（＝公開 API の破壊的変更）なので、提起までにしてある。
    return { content: firstTextBlock(response.content) ?? "" };
  }

  /**
   * zod スキーマを Anthropic のネイティブ構造化出力へ翻訳して送り、返った JSON を `req.schema` で検査して返す。
   *
   * ⚠ **2026-09-29 追記（[Issue #1148](https://github.com/takecchi/mnemora/issues/1148)、
   * [ADR 0360](../../../docs/decisions/0360-schema-unsupported-thrown-before-send.md)）:
   * 翻訳できない形は、送る前に {@link AnthropicLLMProviderError}（`kind: "schema_unsupported"`、
   * `cause` に元の例外）で落ちる。**`z.tuple`・`z.date`・`transform` は SDK の `zodOutputFormat`
   * が投げた例外をこの `kind` に包む——`messages.create` は呼ばれない。
   * ⚠ **2026-09-30 追記（ADR 0360 の追記、負債3）: `z.record` を含むスキーマも、深さを問わず（欄・配列の要素・
   * optional/nullable の内側・union の枝・`z.lazy` の先）同じ `kind` で送る前に落ちる**——以前は翻訳が通り、
   * 空の object しか許さない形で送って、record の欄が例外無しで黙って空になっていた。`@mnemora/openai` と揃う。
   * 代わりに `{ key, value }` の配列を使うこと。`z.lazy`・`default`・根が union は今までどおり送る
   * （Anthropic が受けるかは実 API で確かめていない）。一覧は README。
   *
   * 送った後に投げるもの: 拒否・切り詰めは `complete` と同じ {@link AnthropicLLMProviderError}（`kind: "refusal"`・`"truncated"`）、
   * テキストブロックが無ければ `kind: "no_content"`。本文が JSON として壊れていれば `JSON.parse` の `SyntaxError`、
   * `req.schema` に合わなければ zod の `ZodError` がそのまま伝わる（どちらも `kind` を持たない）。
   *
   * ⚠ **`opts?.signal`（ADR 0359・ADR 0428）:** 呼ぶ前に abort 済みなら SDK を呼ばずに、待っている間に abort したら即座に、
   * `signal.reason`（`abortReason(signal)`）で reject する——SDK の `APIUserAbortError` には化けず、SDK の再試行待ち
   * （429 の `retry-after` 等）の最中でも切れる。`signal` は SDK にも渡すので、裏のリクエストも切れる。
   */
  async completeStructured<T>(
    _ctx: Ctx,
    req: StructuredRequest<T>,
    opts?: AbortOptions,
  ): Promise<T> {
    let format: AnthropicJsonSchemaFormat;
    try {
      format = translateForAnthropicStructuredOutput(req.schema);
    } catch (cause) {
      // ⭐ ここで投げるのは、送る前の翻訳（SDK の `zodOutputFormat`）だけである。
      // `messages.create` はまだ呼んでいない——拒否・切り詰め・応答の検証エラーとは
      // 混ぜない（ADR 0360）。
      throw new AnthropicLLMProviderError({ kind: "schema_unsupported", cause });
    }
    const { system, messages } = toAnthropicRequest(req.prompt);
    const response = await runAbortable(opts?.signal, async (signal) =>
      this.client.messages.create(
        {
          model: this.model,
          max_tokens: this.maxTokens,
          ...(system !== undefined ? { system } : {}),
          messages,
          output_config: { format },
        },
        { signal },
      ),
    );

    // ⭐ **`content` を読む前に `stop_reason` を見る。**順序が本質である
    // ——後ろに置くと、拒否が `no_content` に化けて種類が潰れる。
    assertNotRefusedOrTruncated(response);
    const raw = firstTextBlock(response.content);
    if (!raw) {
      // メッセージは `@mnemora/openai` と同じ形のまま（差し替え可能性を壊さない）。
      // 種類は `kind` で足しただけである。
      throw new AnthropicLLMProviderError({ kind: "no_content" });
    }
    // JSON.parse が失敗すれば SyntaxError をそのまま伝播させる（catch しない）。
    const parsedJson: unknown = JSON.parse(raw);
    // `json-schema.ts` 冒頭のコメントの通り、Anthropic 側は `required` を元のまま通すため
    // `.optional()` は optional のまま残る。`@mnemora/openai` の `stripNulls`
    // （strict モードが返す null を「省略」へ変換し戻す処理）に相当する処理は不要
    // ——モデルの生の JSON をそのまま core の zod スキーマへ渡してよい。
    // `.parse` が失敗すれば ZodError をそのまま伝播させる（`.safeParse` は使わない）。
    return req.schema.parse(parsedJson);
  }
}

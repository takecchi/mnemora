/**
 * `AnthropicLLMProviderOptions.client` に渡せるクライアントの、SDK のクラスから
 * 独立した構造型（[Issue #1221](https://github.com/takecchi/mnemora/issues/1221)。
 * `@mnemora/openai` の `client-types.ts` と同じ理由・同じ形——詳細はそちらの冒頭コメントを見ること）。
 *
 * オーナーの回答（ask_human f259eeb8、2026-09-28、逐語「型を SDK のクラスから切り離すって
 * いうのはだめですか？」）に沿い、`Pick<Anthropic, "messages">` をやめてここへ切り離した。
 *
 * ⚠ **method 記法で書く**（`@mnemora/openai` と同じ理由。双変なパラメータ検査に
 * 意図的に依拠している）。
 */

/** `messages.create` の `messages` の要素。Anthropic は `role: "system"` を持たない
 * （`toAnthropicRequest` 参照）。 */
export interface AnthropicMessageParam {
  role: "user" | "assistant";
  content: string;
}

/** `messages.create` の `output_config.format`。`json-schema.ts` の
 * {@link AnthropicJsonSchemaFormat}（`translateForAnthropicStructuredOutput` の戻り値）を
 * そのまま送る形と一致させてある。 */
export interface AnthropicJSONOutputFormat {
  type: "json_schema";
  schema: Record<string, unknown>;
}

/** `messages.create` の `output_config`。 */
export interface AnthropicOutputConfig {
  format?: AnthropicJSONOutputFormat | null;
}

/** `messages.create` へ実際に渡す引数（`complete`/`completeStructured` が組み立てる形と
 * 一致させてある）。 */
export interface AnthropicMessageCreateParams {
  model: string;
  max_tokens: number;
  system?: string;
  messages: AnthropicMessageParam[];
  output_config?: AnthropicOutputConfig;
}

/** `messages.create` の戻り値の `content` の要素。`firstTextBlock` が読むフィールドだけ
 * （`type` が `"text"` の要素だけ `text` を読む。他の block 種別は `text` を持たないことがある
 * ので任意にしてある）。 */
export interface AnthropicContentBlock {
  type: string;
  text?: string;
}

/** `messages.create` の戻り値の `stop_details`。`assertNotRefusedOrTruncated` が読む
 * フィールドだけ。 */
export interface AnthropicStopDetails {
  category?: string | null;
}

/** `messages.create` の戻り値の形（読むフィールドだけ）。 */
export interface AnthropicMessageResult {
  content: AnthropicContentBlock[];
  stop_reason?: string | null;
  stop_details?: AnthropicStopDetails | null;
}

/**
 * `AnthropicLLMProviderOptions.client` に渡せる最小の構造型。
 * SDK の `Anthropic` クラスのインスタンス（`Pick<Anthropic, "messages">` を含む）は、版が
 * 違っても代入できる（歯: `__tests__/client-type-compat.test.ts`）。
 */
export interface AnthropicMessagesClient {
  messages: {
    create(
      params: AnthropicMessageCreateParams,
      options?: unknown,
    ): PromiseLike<AnthropicMessageResult>;
  };
}

/**
 * `AnthropicLLMProviderOptions.client` に渡せる構造型。SDK のクラスから切り離してあり、
 * SDK の `Anthropic` インスタンスは版が違っても代入できる。
 *
 * ⚠ **method 記法で書く**: 双変なパラメータ検査に意図的に依拠している。
 */

/** Anthropic は `role: "system"` を持たない。 */
export interface AnthropicMessageParam {
  role: "user" | "assistant";
  content: string;
}

export interface AnthropicJSONOutputFormat {
  type: "json_schema";
  schema: Record<string, unknown>;
}

export interface AnthropicOutputConfig {
  format?: AnthropicJSONOutputFormat | null;
}

export interface AnthropicMessageCreateParams {
  model: string;
  max_tokens: number;
  system?: string;
  messages: AnthropicMessageParam[];
  output_config?: AnthropicOutputConfig;
}

/** 他の block 種別は `text` を持たないことがあるので `text` は任意。 */
export interface AnthropicContentBlock {
  type: string;
  text?: string;
}

export interface AnthropicStopDetails {
  category?: string | null;
}

export interface AnthropicMessageResult {
  content: AnthropicContentBlock[];
  stop_reason?: string | null;
  stop_details?: AnthropicStopDetails | null;
}

/** `AnthropicLLMProviderOptions.client` に渡せる最小のクライアント型。 */
export interface AnthropicMessagesClient {
  messages: {
    create(
      params: AnthropicMessageCreateParams,
      options?: unknown,
    ): PromiseLike<AnthropicMessageResult>;
  };
}

/**
 * `OpenAILLMProviderOptions.client` / `OpenAIEmbeddingProviderOptions.client` に渡せる構造型。
 * SDK のクラスを名指ししないので、利用者が別の版の `openai` を入れても `client` に渡せる。
 *
 * ⚠ **method 記法（`create(...): ...`）で書く。** パラメータを双変に検査させるため。
 * arrow function 型にすると、overload を持つ実クライアントを代入できなくなる。
 */

export interface OpenAIChatMessageParam {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface OpenAIChatResponseFormatJsonSchema {
  type: "json_schema";
  json_schema: { name: string; schema: Record<string, unknown>; strict: true };
}

export interface OpenAIChatCompletionCreateParams {
  model: string;
  messages: OpenAIChatMessageParam[];
  temperature?: number;
  response_format?: OpenAIChatResponseFormatJsonSchema;
}

export interface OpenAIChatCompletionChoice {
  finish_reason?: string | null;
  message?: { content?: string | null; refusal?: string | null } | null;
}

export interface OpenAIChatCompletionResult {
  choices: OpenAIChatCompletionChoice[];
}

/** `OpenAILLMProviderOptions.client` に渡せる最小のクライアント型。 */
export interface OpenAIChatClient {
  chat: {
    completions: {
      create(
        params: OpenAIChatCompletionCreateParams,
        options?: unknown,
      ): PromiseLike<OpenAIChatCompletionResult>;
    };
  };
}

export interface OpenAIEmbeddingCreateParams {
  model: string;
  input: string[];
  dimensions?: number;
}

export interface OpenAIEmbeddingItem {
  embedding: number[];
  index: number;
}

export interface OpenAIEmbeddingsResult {
  data: OpenAIEmbeddingItem[];
}

/** `OpenAIEmbeddingProviderOptions.client` に渡せる最小のクライアント型。 */
export interface OpenAIEmbeddingsClient {
  embeddings: {
    create(
      params: OpenAIEmbeddingCreateParams,
      options?: unknown,
    ): PromiseLike<OpenAIEmbeddingsResult>;
  };
}

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
 * `max_tokens` の既定。Anthropic の `messages.create` は `max_tokens` が必須なので既定を持つ。
 * 16000 という値の妥当性は確かめていない。要求する出力の長さに応じて `maxTokens` で上書きする想定。
 */
export const DEFAULT_MAX_TOKENS = 16000;

/** {@link AnthropicLLMProvider} のコンストラクタに渡す設定。 */
export interface AnthropicLLMProviderOptions {
  /**
   * API キー。省略すると SDK が `ANTHROPIC_API_KEY` を読む。
   *
   * `client` を渡さないとき、ヘッダに載せられない文字（キーの途中の CR・LF・NUL など）を含めば、
   * **キーを含まない**メッセージの `Error` を構築時に投げる。`client` を渡したときは検査しない。
   */
  apiKey?: string | undefined;
  /** 必須。既定値を持たない。 */
  model: string;
  /**
   * 省略時 {@link DEFAULT_MAX_TOKENS}。
   *
   * 渡すなら正の安全な整数でなければ構築時に投げる（型が違えば `TypeError`、数として不正なら `RangeError`）。
   * 上限は見ない: `client` が `timeout` を持たないと（省略時を含む）、21334 以上では SDK が送信前に素の
   * `AnthropicError`（`Streaming is required ...`）を投げる。SDK の仕様であり、避けるには `timeout` を持つ
   * `Anthropic` を自分で作って {@link AnthropicLLMProviderOptions.client} へ渡す。
   */
  maxTokens?: number | undefined;
  /**
   * 自分で作った `Anthropic` のクライアント（再試行・timeout を変えたいとき）。渡すと `apiKey` は使わず、
   * キーの検査もしない。省略時は SDK 既定のクライアントで、SDK が 429・5xx を再試行する（回数・timeout は SDK の既定）。
   * 型は SDK のクラスを名指ししない構造型 {@link AnthropicMessagesClient}。
   */
  client?: AnthropicMessagesClient | undefined;
}

/** `toAnthropicRequest` の戻り値。`messages.create` にそのまま展開して渡す形。 */
export interface AnthropicRequest {
  /** 無ければ鍵ごと無い。 */
  system?: string;
  /** `role: "system"` は含まない。 */
  messages: AnthropicMessageParam[];
}

/**
 * `PromptSpec` を Anthropic 形式へ変換する。Anthropic の `messages` は `role: "system"` を受け付けないので、
 * `prompt.system` と `role: "system"` のメッセージは改行区切りで top-level `system` に連結する（黙って捨てない）。
 * 空文字は連結に入れず、どれも空なら `system` の鍵ごと持たない。
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

// 最初のテキストブロックを採用する（OpenAI の「最初の choice」に揃える）。`content` が応答に無いときは
// `TypeError` が `kind` 分類に載らず伝播する。
function firstTextBlock(content: AnthropicContentBlock[]): string | undefined {
  return content.find((block) => block.type === "text")?.text;
}

// `content` を読む前に必ず通す: 拒否は HTTP 200 で返るので、見ないと「空の成功」として core へ渡る。
// `stop_reason` が無い/null のときは通す: streaming の途中や偽 client では null で、「分からない」を「拒否」と読まない。
// `truncated` も同じ `stop_reason` で判る: 切り詰められた JSON は `SyntaxError` になり、壊れた JSON と区別が付かなくなる。
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
 * Anthropic の Messages API を呼ぶ `LLMProvider`。`EmbeddingProvider` は実装しない（Anthropic に埋め込み API が無い）。
 *
 * 構築時: キーがヘッダに載せられない文字を含めば、キーを含まない `Error` を投げる。`maxTokens` が不正なら
 * `TypeError` / `RangeError` を投げる。キーが見つからなくても構築は通り、呼んだ時点で SDK の素の `Error` が伝わる。
 *
 * 拒否・切り詰め・空応答は {@link AnthropicLLMProviderError} の `kind` で返る。HTTP・認証の失敗は SDK の例外がそのまま伝わる。
 * `complete`/`completeStructured` の `opts?.signal` は SDK の request options にも渡す。
 */
export class AnthropicLLMProvider implements LLMProvider {
  private readonly client: AnthropicMessagesClient;
  private readonly model: string;
  private readonly maxTokens: number;

  constructor(options: AnthropicLLMProviderOptions) {
    if (options.maxTokens !== undefined) {
      assertPositiveSafeInteger("AnthropicLLMProvider", "maxTokens", options.maxTokens);
    }
    if (options.client !== undefined) {
      this.client = options.client;
    } else {
      const client = new Anthropic({ apiKey: options.apiKey });
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
   * `req` を1回送り、最初のテキストブロックを返す。拒否は `kind: "refusal"`、切り詰めは `kind: "truncated"` の
   * {@link AnthropicLLMProviderError} を投げる。どちらでもなくテキストブロックが無いときは空文字を返す。
   *
   * `opts?.signal`: 呼ぶ前に abort 済みなら SDK を呼ばずに、待っている間に abort したら即座に `signal.reason` で reject する。
   * 例外は包まない（`maxTokens` の SDK 側の例外もそのまま伝わる）。
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
    // `?? ""` を throw にしない: `@mnemora/openai` と同じ形を保ち、差し替え可能にするため。
    return { content: firstTextBlock(response.content) ?? "" };
  }

  /**
   * zod スキーマを Anthropic のネイティブ構造化出力へ翻訳して送り、返った JSON を `req.schema` で検査して返す。
   *
   * 翻訳できない形（`z.tuple`・`z.date`・`transform`、深さを問わず `z.record` を含むもの）は、送る前に
   * `kind: "schema_unsupported"` の {@link AnthropicLLMProviderError} で落ちる（`cause` に元の例外）。`z.record` の代わりに `{ key, value }` の配列を使う。
   *
   * 送った後: 拒否・切り詰めは `complete` と同じ `kind`、テキストブロックが無ければ `kind: "no_content"`。
   * 本文が JSON として壊れていれば `SyntaxError`、`req.schema` に合わなければ `ZodError` がそのまま伝わる。
   * `opts?.signal` と `maxTokens` の SDK 側の例外は `complete` と同じ。
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

    // `content` より前に `stop_reason` を見る: 後ろに置くと拒否が `no_content` に化ける。
    assertNotRefusedOrTruncated(response);
    const raw = firstTextBlock(response.content);
    if (!raw) {
      throw new AnthropicLLMProviderError({ kind: "no_content" });
    }
    const parsedJson: unknown = JSON.parse(raw);
    // `stripNulls` 相当は不要: Anthropic は `required` を元のまま通すので、生の JSON をそのまま渡す。
    return req.schema.parse(parsedJson);
  }
}

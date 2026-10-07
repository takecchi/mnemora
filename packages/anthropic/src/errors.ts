/**
 * `AnthropicLLMProvider` が投げる失敗を、呼び出し側が `kind` で区別できる形にする。
 * `Error` を継承する。拒否は HTTP 200（`stop_reason: "refusal"`）で返るため、`content` を読む前に判定して投げる。
 *
 * `kind` の外の例外（`AnthropicLLMProviderError` にならない）:
 *
 * - API が HTTP 400（`prompt is too long` 等）で拒んだとき: SDK の例外がそのまま伝播する。
 * - HTTP 200 の応答オブジェクトの形が壊れているとき: 生の `TypeError` 等が伝播する。
 * - `maxTokens` が 21334 以上で `client` が `timeout` を持たない（省略時を含む）とき:
 *   SDK が送信前に投げる素の `AnthropicError`（`Streaming is required ...`）が伝播する。
 *
 * `kind: "schema_unsupported"` のとき、`completeStructured` は送る前の翻訳の例外を包んで
 * `messages.create` を呼ぶ前に投げ直す。元の例外は `cause` に載る。
 */

/** 失敗の種類。 */
export type AnthropicLLMFailureKind =
  /** `stop_reason: "refusal"`。`refusalCategory` に分類が入る */
  | "refusal"
  /** `stop_reason: "max_tokens"` / `"model_context_window_exceeded"`。応答が途中で切れた */
  | "truncated"
  /** 上記のどれでもないのに、テキストブロックが1つも無かった */
  | "no_content"
  /** 送る前の翻訳が例外を投げた。`messages.create` は呼ばれていない。元の例外は `cause` に載る */
  | "schema_unsupported";

/** {@link AnthropicLLMProviderError} のコンストラクタに渡す値。 */
export interface AnthropicLLMProviderErrorOptions {
  kind: AnthropicLLMFailureKind;
  /** SDK が返した生の `stop_reason`。分からなければ `null` */
  stopReason?: string | null | undefined;
  /** `stop_details.category`。開いた集合なので列挙に押し込めず文字列のまま持つ */
  refusalCategory?: string | null | undefined;
  /** 省略時は `kind` から組み立てる */
  message?: string | undefined;
  /** `kind: "schema_unsupported"` のとき、翻訳が投げた元の例外 */
  cause?: unknown;
}

function defaultMessage(options: AnthropicLLMProviderErrorOptions): string {
  switch (options.kind) {
    case "refusal":
      return (
        "AnthropicLLMProvider: the model refused to answer" +
        (options.refusalCategory != null ? ` (category: ${options.refusalCategory})` : "") +
        " — this is a successful HTTP 200 response with stop_reason=refusal, not an empty answer"
      );
    case "truncated":
      return (
        "AnthropicLLMProvider: the response was cut off before it finished" +
        (options.stopReason != null ? ` (stop_reason: ${options.stopReason})` : "") +
        " — raise maxTokens if stop_reason is max_tokens; shorten the input if it is" +
        " model_context_window_exceeded"
      );
    case "no_content":
      return "AnthropicLLMProvider: structured completion returned no content";
    case "schema_unsupported":
      return (
        "AnthropicLLMProvider: the zod schema could not be translated to Anthropic's" +
        " native structured output" +
        (options.cause instanceof Error ? ` (${options.cause.message})` : "") +
        " — messages.create was not called; see the `cause` for the original error"
      );
  }
}

/**
 * ⚠ **`instanceof` で分岐せず、`kind` で分岐すること。**
 * bundler が同じクラスを二重に読み込むと `instanceof` は落ちる。
 */
export class AnthropicLLMProviderError extends Error {
  readonly kind: AnthropicLLMFailureKind;
  /** SDK が返した生の `stop_reason`。分からなければ `null`。 */
  readonly stopReason: string | null;
  /** `stop_details.category`。拒否でなければ・分からなければ `null`。 */
  readonly refusalCategory: string | null;

  constructor(options: AnthropicLLMProviderErrorOptions) {
    super(
      options.message ?? defaultMessage(options),
      options.cause !== undefined ? { cause: options.cause } : undefined,
    );
    this.name = "AnthropicLLMProviderError";
    this.kind = options.kind;
    this.stopReason = options.stopReason ?? null;
    this.refusalCategory = options.refusalCategory ?? null;
  }
}

const ANTHROPIC_LLM_FAILURE_KINDS: ReadonlySet<unknown> = new Set<AnthropicLLMFailureKind>([
  "refusal",
  "truncated",
  "no_content",
  "schema_unsupported",
]);

/**
 * 受け取ったものが {@link AnthropicLLMProviderError} かを、`instanceof` を使わずに判定する。
 * `kind` があれば {@link AnthropicLLMFailureKind} のどれかであること（`name` が文字列なら
 * `"AnthropicLLMProviderError"` であることも）を見て、`kind` が無ければ `name` で見る。
 */
export function isAnthropicLLMProviderError(value: unknown): value is AnthropicLLMProviderError {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as { kind?: unknown; name?: unknown };
  if (candidate.kind !== undefined) {
    // `kind` の値は openai と anthropic で重なる。`name` も見て、相手の provider の例外を取り違えない。
    return (
      ANTHROPIC_LLM_FAILURE_KINDS.has(candidate.kind) &&
      (typeof candidate.name !== "string" || candidate.name === "AnthropicLLMProviderError")
    );
  }
  return candidate.name === "AnthropicLLMProviderError";
}

/**
 * `OpenAILLMProvider` が投げる失敗を、呼び出し側が `kind` で区別できる形にする。`Error` を継承する。
 * 拒否・切り詰めは HTTP 200 で返るため、`content` を読む前に `message.refusal`・`finish_reason` を見て投げる。
 *
 * `kind` の外の例外（`OpenAILLMProviderError` にならない）:
 *
 * - API が HTTP 400（`context_length_exceeded`）で拒んだとき: SDK の例外がそのまま伝播する。
 * - HTTP 200 の応答オブジェクトの形が壊れているとき（`choices` が無い等）: 生の `TypeError` 等が伝播する。
 *
 * `kind: "schema_unsupported"` のとき、`completeStructured` は送る前の翻訳・検査の例外を包んで
 * `chat.completions.create` を呼ぶ前に投げ直す。元の例外は `cause` に載る。
 */

/** 失敗の種類。 */
export type OpenAILLMFailureKind =
  /** `message.refusal` が非 null かつ空文字でない。または `finish_reason === "content_filter"`（生の値は `finishReason` に残る） */
  | "refusal"
  /** `finish_reason === "length"`。応答が max tokens で途中で切れた */
  | "truncated"
  /** 上記のどちらでもないのに、`content` が空/欠落だった。`completeStructured` だけが投げる（`complete` は空文字を返す） */
  | "no_content"
  /** 送る前の翻訳・検査が例外を投げた。`chat.completions.create` は呼ばれていない。元の例外は `cause` に載る */
  | "schema_unsupported";

/** {@link OpenAILLMProviderError} のコンストラクタに渡す値。 */
export interface OpenAILLMProviderErrorOptions {
  kind: OpenAILLMFailureKind;
  /** SDK が返した生の `finish_reason`。分からなければ `null`（偽 client など） */
  finishReason?: string | null | undefined;
  /** `message.refusal` の中身（拒否理由の文面）。無ければ `null` */
  refusalMessage?: string | null | undefined;
  /** 省略時は `kind` から組み立てる */
  message?: string | undefined;
  /** `kind: "schema_unsupported"` のとき、翻訳・検査が投げた元の例外 */
  cause?: unknown;
}

function defaultMessage(options: OpenAILLMProviderErrorOptions): string {
  switch (options.kind) {
    case "refusal":
      return (
        "OpenAILLMProvider: the model refused to answer" +
        (options.refusalMessage != null ? ` (${options.refusalMessage})` : "") +
        (options.finishReason != null ? ` (finish_reason: ${options.finishReason})` : "") +
        " — this is a successful HTTP 200 response, not an empty answer"
      );
    case "truncated":
      return (
        "OpenAILLMProvider: the response was cut off before it finished" +
        (options.finishReason != null ? ` (finish_reason: ${options.finishReason})` : "") +
        " — shorten the input: OpenAILLMProvider does not set max_tokens, so the model's own" +
        " output limit or context window was reached"
      );
    case "no_content":
      return "OpenAILLMProvider: structured completion returned no content";
    case "schema_unsupported":
      return (
        "OpenAILLMProvider: the zod schema could not be translated to OpenAI's strict" +
        " Structured Output" +
        (options.cause instanceof Error ? ` (${options.cause.message})` : "") +
        " — chat.completions.create was not called; see the `cause` for the original error"
      );
  }
}

/**
 * ⚠ **`instanceof` で分岐せず、`kind` で分岐すること。**
 * bundler が同じクラスを二重に読み込むと `instanceof` は落ちる。
 */
export class OpenAILLMProviderError extends Error {
  readonly kind: OpenAILLMFailureKind;
  /** SDK が返した生の `finish_reason`。分からなければ `null`。 */
  readonly finishReason: string | null;
  /** `message.refusal` の中身（拒否理由の文面）。無ければ `null`。 */
  readonly refusalMessage: string | null;

  constructor(options: OpenAILLMProviderErrorOptions) {
    super(
      options.message ?? defaultMessage(options),
      options.cause !== undefined ? { cause: options.cause } : undefined,
    );
    this.name = "OpenAILLMProviderError";
    this.kind = options.kind;
    this.finishReason = options.finishReason ?? null;
    this.refusalMessage = options.refusalMessage ?? null;
  }
}

const OPENAI_LLM_FAILURE_KINDS: ReadonlySet<unknown> = new Set<OpenAILLMFailureKind>([
  "refusal",
  "truncated",
  "no_content",
  "schema_unsupported",
]);

/**
 * 受け取ったものが {@link OpenAILLMProviderError} かを、`instanceof` を使わずに判定する。
 * `kind` があれば {@link OpenAILLMFailureKind} のどれかであること（`name` が文字列なら
 * `"OpenAILLMProviderError"` であることも）を見て、`kind` が無ければ `name` で見る。
 */
export function isOpenAILLMProviderError(value: unknown): value is OpenAILLMProviderError {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as { kind?: unknown; name?: unknown };
  if (candidate.kind !== undefined) {
    // `kind` の値は openai と anthropic で重なる。`name` も見て、相手の provider の例外を取り違えない。
    return (
      OPENAI_LLM_FAILURE_KINDS.has(candidate.kind) &&
      (typeof candidate.name !== "string" || candidate.name === "OpenAILLMProviderError")
    );
  }
  return candidate.name === "OpenAILLMProviderError";
}

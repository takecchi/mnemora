/**
 * このパッケージが投げるエラーの種類。
 *
 * - `"input_too_long"`: 同じ入力での再試行は必ず失敗する。入力を分割・短縮する。
 * - `"unknown_input_limit"`: 入力ではなくモデル（`repo`）か `createPipeline` 側の問題。
 *
 * ⚠ 分岐は `instanceof` ではなく `kind` で行う。bundler がクラスを二重に読み込むと `instanceof` は落ちる。
 */
export type LocalEmbeddingProviderErrorKind = "input_too_long" | "unknown_input_limit";

/** {@link LocalEmbeddingProviderErrorKind} が `"input_too_long"` のときに付く欄。 */
export interface LocalEmbeddingInputTooLongDetail {
  /** `embed(ctx, texts)` に渡された配列の何番目か。 */
  readonly index: number;
  /** 切り詰め**前**に数えたトークン数（特殊トークンを含む）。 */
  readonly tokens: number;
  /** モデルが受け付ける上限トークン数。 */
  readonly maxInputTokens: number;
  /** `prefix` を付けた後の文字数。参考値で、判定は `tokens` と `maxInputTokens` の比較で行う。 */
  readonly characters: number;
}

/** このパッケージが投げる、種類の付いたエラー。分岐は `kind`（または {@link isLocalEmbeddingProviderError}）で行う。 */
export class LocalEmbeddingProviderError extends Error {
  /** 常に `"LocalEmbeddingProviderError"`。 */
  override readonly name = "LocalEmbeddingProviderError";
  /** 失敗の種類。分岐はこの値で行う。 */
  readonly kind: LocalEmbeddingProviderErrorKind;
  /** `kind` が `"input_too_long"` のときだけ入る。 */
  readonly detail: LocalEmbeddingInputTooLongDetail | null;

  constructor(
    kind: LocalEmbeddingProviderErrorKind,
    message: string,
    detail: LocalEmbeddingInputTooLongDetail | null = null,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.kind = kind;
    this.detail = detail;
  }
}

/** `instanceof` を使わず `kind` の値で判定する。クラスが二重に読み込まれていても効く。 */
export function isLocalEmbeddingProviderError(
  value: unknown,
): value is LocalEmbeddingProviderError {
  if (!(typeof value === "object" && value !== null)) {
    return false;
  }
  const kind = (value as { kind?: unknown }).kind;
  return kind === "input_too_long" || kind === "unknown_input_limit";
}

/**
 * `AnthropicLLMProvider` が投げる失敗を、**呼び出し側が種類として区別できる形**にする。
 *
 * **なぜ要るか（ADR 0072 の追記「実測で見つかった穴」）**
 *
 * ADR 0072 の初版は「構造化出力が返らなかったら例外を投げる」までしか決めていなかった。
 * その結果、**「モデルが拒否した」と「応答が空だった」が同じ `Error` になっていた。**
 *
 * これはこのリポジトリの固定点——**「無い」の種類を潰さない**（`docs/recall.md`・
 * ADR 0008 / 0013 / 0026 / 0027 / 0044 が一貫して守ってきた線）——に正面から当たる。
 * `packages/core/src/extraction.ts` の `extractCandidates` はこの例外を `try/catch` で飲み、
 * **`ExtractionOutcome: "llm_failed_whole_observation"` へ倒す。**⟹ 種類を潰したまま
 * 投げると、「モデルが拒否した」という情報はそこで完全に消える。
 *
 * **⚠ 拒否は HTTP 200 で返る。** `stop_reason: "refusal"` が付いた成功応答であり、
 * SDK は例外を投げない。**`content` を読む前に `stop_reason` を見ないと、
 * 空文字を「成功」として core へ渡すことになる。**
 *
 * `Error` を継承しているので、`@mnemora/openai` と揃えた既存の契約
 * （`rejects.toThrow(/.../)` でメッセージを見る形）はそのまま通る。
 * **揃えるためにこちらを弱くはしない**——種類は足すだけである。
 *
 * ⚠ **2026-09-27 追記（プロンプトの大きさの軸）:** 入力がモデルのコンテキストを超えたときの顔は2つある（今の振る舞い。実 API では確かめておらず、SDK の例外の形を模した偽のクライアントで確かめた）。成功応答の
 * `stop_reason: "model_context_window_exceeded"` は `kind: "truncated"` になるが、API が
 * リクエストを HTTP 400（`prompt is too long` 等）で拒むと、SDK の例外がそのまま伝播し
 * `kind` は付かない（下の「分類の外」と同じ扱い）。
 *
 * ⚠ **2026-09-26 追記（[Issue #885](https://github.com/takecchi/mnemora/issues/885)）:
 * `kind`（`refusal`/`truncated`/`no_content`）が表すのは、この3種のどれかである。**
 * HTTP 200 の応答オブジェクトそのものの形が壊れている場合——トップレベルの `content`
 * 欄がキーごと丸ごと無い場合（`{}` が返る等）——は、この分類の**外**にある生の例外
 * （`TypeError` 等。壊れた JSON の `SyntaxError`、スキーマ不適合の `ZodError` と同じ
 * 扱い）がそのまま伝播する。`AnthropicLLMProviderError` にはならず、`instanceof` でも
 * `kind` でも捕まえられない。**実 API がこの形（200 応答なのにトップレベルのキーが
 * 丸ごと欠ける）を実際に返すかは確認していない。** 詳細・検討した案は
 * [ADR 0072](../../../docs/decisions/0072-anthropic-llm-provider.md) の同日付追記を
 * 参照。`llm-provider.ts` の `firstTextBlock` にも個別の doc コメントがある。
 *
 * ⚠ **2026-09-29 追記（[Issue #1148](https://github.com/takecchi/mnemora/issues/1148)、
 * [ADR 0360](../../../docs/decisions/0360-schema-unsupported-thrown-before-send.md)）:
 * `kind: "schema_unsupported"` を足した。** `completeStructured` は、送る前の翻訳
 * （`json-schema.ts` の `translateForAnthropicStructuredOutput`、SDK の `zodOutputFormat`）
 * が投げた例外を、この `kind` に包んで `messages.create` を呼ぶ前に投げ直す。**元の例外は
 * `cause`（ES2022 の `Error.cause`）に載る**。`z.tuple`・`z.date`・`transform` と、
 * **`z.record`（2026-09-30 から。ADR 0360 の追記）**がこの経路に当たる（README「`completeStructured` に
 * 渡せる zod の形」参照）。
 */

/**
 * 失敗の種類。**増やすときは、呼び出し側が本当に区別したい単位かを先に問うこと**
 * ——区別できない種類を増やしても「無い」の分類は増えない。
 */
export type AnthropicLLMFailureKind =
  /** `stop_reason: "refusal"`。安全性の分類器が介入した。`refusalCategory` に分類が入る */
  | "refusal"
  /** `stop_reason: "max_tokens"` / `"model_context_window_exceeded"`。応答が途中で切れた */
  | "truncated"
  /** 上記のどれでもないのに、テキストブロックが1つも無かった */
  | "no_content"
  /** 送る前の翻訳（`translateForAnthropicStructuredOutput`、SDK の `zodOutputFormat`）が
   * 例外を投げた。`messages.create` は呼ばれていない。元の例外は `cause` に載る（#1148）。 */
  | "schema_unsupported";

/** {@link AnthropicLLMProviderError} のコンストラクタに渡す値。 */
export interface AnthropicLLMProviderErrorOptions {
  /** 失敗の種類（{@link AnthropicLLMFailureKind}）。 */
  kind: AnthropicLLMFailureKind;
  /** SDK が返した生の `stop_reason`。分からなければ `null`（偽 client・streaming の途中など） */
  stopReason?: string | null;
  /** `stop_details.category`（`cyber` / `bio` / `frontier_llm` / `reasoning_extraction` …）。
   * **開いた集合である**——SDK の型は将来値が増えることを前提にしているので、
   * ここでも文字列のまま持ち、列挙に押し込めない。 */
  refusalCategory?: string | null;
  /** 人が読むためのメッセージ。省略時は `kind` から組み立てる */
  message?: string;
  /** `kind: "schema_unsupported"` のとき、送る前の翻訳が投げた元の例外。
   * `Error` の標準の `cause`（ES2022）としてそのまま載せる。 */
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
 * `kind` は値なのでその影響を受けない。
 */
export class AnthropicLLMProviderError extends Error {
  /** 失敗の種類。分岐はこの値で行う。 */
  readonly kind: AnthropicLLMFailureKind;
  /** SDK が返した生の `stop_reason`。分からなければ `null`。 */
  readonly stopReason: string | null;
  /** `stop_details.category`（開いた集合の文字列）。拒否でなければ・分からなければ `null`。 */
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
 * 受け取ったものが {@link AnthropicLLMProviderError} かを、**`instanceof` を使わずに**判定する
 * （[ADR 0418](../../../docs/decisions/0418-store-error-kind-guards.md) の作法、
 * ADR 0428）。
 *
 * **「`kind` を見て、`kind` が無ければ `name` を見る」。** `kind` があるときは、それが
 * {@link AnthropicLLMFailureKind} のどれかであることを見る。`kind` の値は openai と anthropic で重なるので、`name` が文字列ならそれが `"AnthropicLLMProviderError"` であることも見る（`name` を持たない素の値は `kind` だけで見る）。`kind` が無い値
 * （`kind` を持たない古い版が投げた例外など）は、`name === "AnthropicLLMProviderError"` で見る。
 * bundler が同じクラスを二重に読み込んでいても効く。`name` は偽装できるが、provider は利用者が
 * 自分で配線する信頼された部品なので実害は無いと判断している。
 */
export function isAnthropicLLMProviderError(value: unknown): value is AnthropicLLMProviderError {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as { kind?: unknown; name?: unknown };
  if (candidate.kind !== undefined) {
    // kind の値は openai と anthropic で重なる（`refusal` など）。`name` を持つ値は、
    // それが一致することも見る——相手の provider の例外を取り違えないため。
    return (
      ANTHROPIC_LLM_FAILURE_KINDS.has(candidate.kind) &&
      (typeof candidate.name !== "string" || candidate.name === "AnthropicLLMProviderError")
    );
  }
  return candidate.name === "AnthropicLLMProviderError";
}

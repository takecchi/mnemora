/**
 * `OpenAILLMProvider` が投げる失敗を、**呼び出し側が種類として区別できる形**にする。
 *
 * **なぜ要るか**
 *
 * `@mnemora/anthropic` の `errors.ts`（ADR 0072 の追記「実測で見つかった穴」）と同じ穴が
 * `@mnemora/openai` 側にも残っていた。**「モデルが拒否した」と「応答が空だった」が
 * 同じ `Error` になっていた。**
 *
 * これはこのリポジトリの固定点——**「無い」の種類を潰さない**（`docs/recall.md`・
 * ADR 0008 / 0013 / 0026 / 0027 / 0044 が一貫して守ってきた線）——に正面から当たる。
 * `packages/core/src/extraction.ts` の `extractCandidates` はこの例外を `try/catch` で飲み、
 * **`ExtractionOutcome: "llm_failed_whole_observation"` へ倒す。**⟹ 種類を潰したまま
 * 投げると、「モデルが拒否した」という情報はそこで完全に消える。
 *
 * **⚠ OpenAI の機構は Anthropic と形が違う。** Anthropic は `stop_reason` 一本で拒否・
 * 切り詰めを表すが、OpenAI は**2つの独立した機構**を持つ:
 * - `message.refusal: string | null` — 拒否したとき `content` は `null` になり、
 *   `refusal` に拒否理由の文字列が入る。**拒否も HTTP 200 で返る。**
 * - `finish_reason: "length" | "content_filter" | ...` — `length` は max tokens 到達、
 *   `content_filter` はコンテンツフィルタで出力が省かれたことを示す。
 * **`content` を読む前にこの2つを見ないと、拒否・切り詰めを「空の成功」として
 * core へ渡すことになる**（`llm-provider.ts` の `assertNotRefusedOrTruncated` 参照）。
 *
 * `Error` を継承しているので、`@mnemora/anthropic` と揃えた既存の契約
 * （`rejects.toThrow(/.../)` でメッセージを見る形）はそのまま通る。
 * **揃えるためにこちらを弱くはしない**——種類は足すだけである。
 *
 * ⚠ **2026-09-27 追記（プロンプトの大きさの軸）:** 入力がモデルのコンテキストを超えて API がリクエストを HTTP 400
 * （`context_length_exceeded`）で拒むと、SDK の例外がそのまま伝播し `kind` は付かない
 * （今の振る舞い。実 API では確かめておらず、SDK の例外の形を模した偽のクライアントで確かめた。`kind: "truncated"` は `finish_reason: "length"`、つまり出力が途中で
 * 切れた成功応答だけを指す）。
 *
 * ⚠ **2026-09-26 追記（[Issue #885](https://github.com/takecchi/mnemora/issues/885)）:
 * `kind`（`refusal`/`truncated`/`no_content`）が表すのは、この3種のどれかである。**
 * HTTP 200 の応答オブジェクトそのものの形が壊れている場合——`choices`/`data` の
 * トップレベルの欄がキーごと丸ごと無い場合（`{}` が返る等）——は、この分類の**外**にある
 * 生の例外（`TypeError` 等。壊れた JSON の `SyntaxError`、スキーマ不適合の `ZodError` と
 * 同じ扱い）がそのまま伝播する。`OpenAILLMProviderError` にはならず、`instanceof` でも
 * `kind` でも捕まえられない（埋め込み側の `OpenAIEmbeddingProvider.embed` はそもそも
 * この `errors.ts` を使わず、専用のエラー型を持たない——壊れた応答は最初から生の
 * 例外がそのまま伝播する形である）。**実 API がこの形
 * （200 応答なのにトップレベルのキーが丸ごと欠ける）を実際に返すかは確認していない。**
 * 詳細・検討した案は
 * [ADR 0072](../../../docs/decisions/0072-anthropic-llm-provider.md) の同日付追記
 * （主たる記録）を参照。`llm-provider.ts` の `assertNotRefusedOrTruncated` 呼び出し箇所、
 * `embedding-provider.ts` の `embed` にも個別の doc コメントがある。
 *
 * ⚠ **2026-09-29 追記（[Issue #1148](https://github.com/takecchi/mnemora/issues/1148)、
 * [ADR 0360](../../../docs/decisions/0360-schema-unsupported-thrown-before-send.md)）:
 * `kind: "schema_unsupported"` を足した。** `completeStructured` が、送る前の翻訳
 * （`structured-root.ts` の `toBaseJsonSchema`、zod の既定＝ throw）と、送る直前の検査
 * （`openai` SDK 自身の `lib/transform` の `toStrictJsonSchema` を、実際に送る JSON Schema
 * に通す。戻り値は使わず、送るのは今までどおり mnemora 自身の翻訳結果である）のどちらかで
 * 投げた例外を、この `kind` に包んで `chat.completions.create` を呼ぶ前に投げ直す。**元の例外は
 * `cause`（ES2022 の `Error.cause`）に載る**。`z.record`・`z.tuple`・`z.date`・`transform` が
 * この経路に当たる（README「`completeStructured` に渡せる zod の形」参照）。
 */

/**
 * 失敗の種類。**増やすときは、呼び出し側が本当に区別したい単位かを先に問うこと**
 * ——区別できない種類を増やしても「無い」の分類は増えない。
 */
export type OpenAILLMFailureKind =
  /** `message.refusal` が非 null かつ空文字でない。または `finish_reason === "content_filter"`
   * （コンテンツフィルタでの省略はモデル自身の拒否とは別機構だが、呼び出し側の次の一手は
   * 同じ——同じ入力で再試行しても意味が無い。`kind` は増やさず `finishReason` に生の値を残す）。 */
  | "refusal"
  /** `finish_reason === "length"`。応答が max tokens で途中で切れた */
  | "truncated"
  /** 上記のどちらでもないのに、`content` が空/欠落だった */
  | "no_content"
  /** 送る前の翻訳・検査（`toBaseJsonSchema`・`toStrictJsonSchema`）が例外を投げた。
   * `chat.completions.create` は呼ばれていない。元の例外は `cause` に載る（#1148）。 */
  | "schema_unsupported";

/** {@link OpenAILLMProviderError} のコンストラクタに渡す値。 */
export interface OpenAILLMProviderErrorOptions {
  /** 失敗の種類（{@link OpenAILLMFailureKind}）。 */
  kind: OpenAILLMFailureKind;
  /** SDK が返した生の `finish_reason`。分からなければ `null`（偽 client など） */
  finishReason?: string | null;
  /** `message.refusal` の中身（拒否理由の文面）。無ければ `null` */
  refusalMessage?: string | null;
  /** 人が読むためのメッセージ。省略時は `kind` から組み立てる */
  message?: string;
  /** `kind: "schema_unsupported"` のとき、送る前の翻訳・検査が投げた元の例外。
   * `Error` の標準の `cause`（ES2022）としてそのまま載せる。 */
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
 * `kind` は値なのでその影響を受けない。
 */
export class OpenAILLMProviderError extends Error {
  /** 失敗の種類。分岐はこの値で行う。 */
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
 * 受け取ったものが {@link OpenAILLMProviderError} かを、**`instanceof` を使わずに**判定する
 * （[ADR 0418](../../../docs/decisions/0418-store-error-kind-guards.md) の作法、
 * ADR 0428）。
 *
 * **「`kind` を見て、`kind` が無ければ `name` を見る」。** `kind` があるときは、それが
 * {@link OpenAILLMFailureKind} のどれかであることを見る。`kind` の値は openai と anthropic で重なるので、`name` が文字列ならそれが `"OpenAILLMProviderError"` であることも見る（`name` を持たない素の値は `kind` だけで見る）。`kind` が無い値
 * （`kind` を持たない古い版が投げた例外など）は、`name === "OpenAILLMProviderError"` で見る。
 * bundler が同じクラスを二重に読み込んでいても効く。`name` は偽装できるが、provider は利用者が
 * 自分で配線する信頼された部品なので実害は無いと判断している。
 */
export function isOpenAILLMProviderError(value: unknown): value is OpenAILLMProviderError {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as { kind?: unknown; name?: unknown };
  if (candidate.kind !== undefined) {
    // kind の値は openai と anthropic で重なる（`refusal` など）。`name` を持つ値は、
    // それが一致することも見る——相手の provider の例外を取り違えないため。
    return (
      OPENAI_LLM_FAILURE_KINDS.has(candidate.kind) &&
      (typeof candidate.name !== "string" || candidate.name === "OpenAILLMProviderError")
    );
  }
  return candidate.name === "OpenAILLMProviderError";
}

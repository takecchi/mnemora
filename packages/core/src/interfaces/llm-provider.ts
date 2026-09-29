import type { z } from "zod";
import type { AbortOptions } from "../abort.js";
import type { Ctx } from "../ctx.js";

/**
 * core は OpenAI SDK・Anthropic SDK のどちらの型も import しない
 * （docs/architecture.md §3.8）。provider 非依存の最小限の型のみ持つ。
 */
export interface PromptMessage {
  /** 発話者の役割。 */
  role: "system" | "user" | "assistant";
  /** 本文。 */
  content: string;
}

/** LLM に送るプロンプト（provider に依らない形）。 */
export interface PromptSpec {
  /** system プロンプト。省略できる。 */
  system?: string;
  /** 会話の本文（古い順）。 */
  messages: PromptMessage[];
}

/** `LLMProvider.complete` の戻り値。 */
export interface LLMResponse {
  /** モデルの応答の本文。⚠ 拒否でも切り詰めでもない空応答は空文字になりうる（`@mnemora/openai`・`@mnemora/anthropic` とも。ADR 0072）。 */
  content: string;
}

/** `LLMProvider.completeStructured` に渡す要求。 */
export interface StructuredRequest<T> {
  /** 送るプロンプト。 */
  prompt: PromptSpec;
  /** core は zod でスキーマを記述するだけ。ベンダー固有の Structured Output 形式への
   * 翻訳は各 provider package の責務（docs/architecture.md §3.8）。 */
  schema: z.ZodType<T>;
}

/**
 * LLMProvider — Phase 1（docs/architecture.md §5.4）。
 *
 * 契約:
 * - `completeStructured` はベンダー固有の Structured Output 機構へ翻訳する義務を negate
 *   できない。core・呼び出し側に OpenAI/Anthropic SDK の型を漏らしてはならない。
 * - タイムアウト・レート制限・失敗時は例外を投げる。`LLMProvider` 自体はリトライを
 *   内蔵しない（責務の混在を避ける）。
 *
 * ⚠ **2026-09-26 追記（[Issue #850](https://github.com/takecchi/mnemora/issues/850)）:
 * `completeStructured` が返した後の値を、core は `req.schema` で再検証しない。**
 * core・呼び出し側（`extraction.ts`/`claim-key.ts`/`strategies/consolidate.ts`/
 * `strategies/reflect.ts`）は戻り値の型 `T` をそのまま信じて使う。schema への適合を
 * 保証するのは provider の責務であり、`@mnemora/openai`・`@mnemora/anthropic` は
 * 内部で `req.schema.parse` を通した値だけを返す（ADR 0072 決定3・ADR 0266 歯2）。
 * この契約を破る provider（例: schema を検証せず素のキャストで値を返す実装）を渡すと、
 * `completeStructured` は成功したように見えたまま型の違う値が core へ渡り、その後の
 * プロパティアクセスで未処理の例外（例: `TypeError: content.trim is not a function`）が
 * 起きうる。`observe()` の「LLM 呼び出し自体が失敗しても Memory を1件残す」安全弁
 * （`docs/memory-model.md` §4）は `completeStructured` が例外を*投げた*場合だけを覆い、
 * この形（成功したように見えて中身の型が違う場合）は覆わない。
 *
 * ⚠ **2026-09-26 追記（[Issue #884](https://github.com/takecchi/mnemora/issues/884)）:
 * 「`LLMProvider` 自体はリトライを内蔵しない」は、mnemora の provider コードが再試行を
 * 書いていない、という意味である。**`client` を指定しない `@mnemora/openai`
 * （`OpenAILLMProvider`）・`@mnemora/anthropic`（`AnthropicLLMProvider`）は SDK 既定の
 * クライアントを作り（`options.client ?? new OpenAI({ apiKey })` /
 * `new Anthropic({ apiKey })`）、その SDK 自身が内部で 429・5xx 等に対して再試行する
 * （実測: `openai@7.10.0` / `@anthropic-ai/sdk@0.124.0` はどちらも既定
 * `maxRetries: 2`＝最大3回・`timeout: 600000`ms）。この数値は mnemora の契約ではなく
 * SDK の既定値であり、SDK の版が上がれば変わりうる。変えたい呼び出し側は、
 * `maxRetries`/`timeout` を設定した SDK client を自分で作り、各 Options の `client` へ
 * 渡す（`OpenAILLMProviderOptions`/`AnthropicLLMProviderOptions` の `client`）。
 *
 * ⚠ **2026-09-27 追記（今の振る舞いを書いたもの、[Issue #1200](https://github.com/takecchi/mnemora/issues/1200)）:
 * runtime はこの呼び出しに時間の上限を付けず、中断の口（`AbortSignal` など）も渡さない。**`complete`/`completeStructured` が
 * 返るまで、呼んだ Runtime の口（`observe`・`recall`・`tick`・`consolidate`・`reflect`・`reextract`）も返らない。
 * 上限になるのは provider の側の設定だけである（`@mnemora/openai`・`@mnemora/anthropic` は SDK の既定——
 * 上の #884 の追記、`@mnemora/local-embedding` は推論のタイムアウトを持たない）。待っている間、
 * runtime は DB の接続を握らない（【実測 2026-09-27】`@mnemora/postgres` で `max: 1` の pool の横から
 * 別の DB 操作が通った。歯は `packages/postgres/src/__tests__/provider-hang.postgres.test.ts`）。
 *
 * ⚠ **2026-09-29 追記（クローン miku の判断。[Issue #1200](https://github.com/takecchi/mnemora/issues/1200)、
 * [ADR 0359](../../../docs/decisions/0359-abort-signal-for-provider-calls.md)）: 上の「中断の口も渡さない」は
 * もう成り立たない。** `complete`/`completeStructured` は任意の第3引数 `opts?: AbortOptions` を受け取る。
 * `opts.signal` を渡すと:
 * - 呼ぶ前に既に abort 済みなら、runtime はこの呼び出しを行わずに reject する。
 * - 呼んでいる間に abort されたら、runtime はこの Promise の解決を待たずに reject する
 *   （`signal.reason`。無ければ `AbortError` 相当）——**provider がこの引数を無視しても**、
 *   runtime 自身が provider の Promise と abort を競わせるため、呼んだ Runtime の口は返る。
 * - **既定の時間の上限は今回も持たない。**`opts`/`opts.signal` を省略すれば、今までどおり
 *   provider が返るまで待ち続ける——この追記は opt-in の選択肢を足しただけで、上の
 *   「今の振る舞い」の記述を1バイトも動かさない。
 * - `opts` を渡さない既存の実装（2引数の `complete`/`completeStructured`）は、そのまま
 *   この interface に適合する（TypeScript の構造的部分型——第3引数が省略可能なため）。
 *   `@mnemora/openai`・`@mnemora/anthropic` は `opts.signal` を SDK 呼び出しの request options
 *   （`{ signal }`）へ渡す。`@mnemora/local-embedding`（`EmbeddingProvider`）は推論の前後で
 *   `signal` を確かめるだけで、推論の途中では止まらない（`embedding-provider.ts` の追記）。
 */
export interface LLMProvider {
  /** `req` を送り、応答の本文を返す。失敗は例外で返す（上の契約。リトライは内蔵しない）。`opts.signal` は上の2026-09-29追記を参照。 */
  complete(ctx: Ctx, req: PromptSpec, opts?: AbortOptions): Promise<LLMResponse>;
  /** `req.schema` に合う値を返させる。`req.schema` への適合を保証するのは provider である（上の #850 の追記）。失敗は例外で返す。`opts.signal` は上の2026-09-29追記を参照。 */
  completeStructured<T>(ctx: Ctx, req: StructuredRequest<T>, opts?: AbortOptions): Promise<T>;
}

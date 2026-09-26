import type { z } from "zod";
import type { Ctx } from "../ctx.js";

/**
 * core は OpenAI SDK・Anthropic SDK のどちらの型も import しない
 * （docs/architecture.md §3.8）。provider 非依存の最小限の型のみ持つ。
 */
export interface PromptMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface PromptSpec {
  system?: string;
  messages: PromptMessage[];
}

export interface LLMResponse {
  content: string;
}

export interface StructuredRequest<T> {
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
 */
export interface LLMProvider {
  complete(ctx: Ctx, req: PromptSpec): Promise<LLMResponse>;
  completeStructured<T>(ctx: Ctx, req: StructuredRequest<T>): Promise<T>;
}

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
 * LLMProvider（docs/architecture.md §5.4）。
 *
 * 契約:
 * - `completeStructured` はベンダー固有の Structured Output 機構へ翻訳する義務を負う。
 *   core・呼び出し側に OpenAI/Anthropic SDK の型を漏らしてはならない。
 * - タイムアウト・レート制限・失敗時は例外を投げる。`LLMProvider` 自体はリトライを内蔵しない。
 *
 * ⚠ **`completeStructured` が返した後の値を、core は `req.schema` で再検証しない。**
 * 戻り値の型 `T` をそのまま信じて使う。schema への適合を保証するのは provider の責務であり、
 * `@mnemora/openai`・`@mnemora/anthropic` は内部で `req.schema.parse` を通した値だけを返す（ADR 0072 決定3）。
 * この契約を破る provider を渡すと、成功したように見えたまま型の違う値が core へ渡り、その後のプロパティアクセスで
 * 未処理の例外が起きうる。`observe()` の「LLM 呼び出しが失敗しても Memory を1件残す」安全弁（`docs/memory-model.md` §4）は
 * `completeStructured` が例外を*投げた*場合だけを覆い、この形は覆わない。
 *
 * ⚠ **「リトライを内蔵しない」は、mnemora の provider コードが再試行を書いていない、という意味である。**
 * `client` を指定しない `@mnemora/openai`・`@mnemora/anthropic` は SDK 既定のクライアントを作り、その SDK 自身が
 * 429・5xx 等に対して再試行する（実測: `openai@7.10.0` / `@anthropic-ai/sdk@0.124.0` はどちらも既定
 * `maxRetries: 2`・`timeout: 600000`ms）。この数値は mnemora の契約ではなく SDK の既定値で、版が上がれば変わりうる。
 * 変えたい呼び出し側は、`maxRetries`/`timeout` を設定した SDK client を自分で作り、各 Options の `client` へ渡す。
 *
 * ⚠ **中断と時間の上限**（ADR 0359）: `complete`/`completeStructured` は任意の第3引数 `opts?: AbortOptions` を受け取る。
 * - **既定の時間の上限は持たない。** `opts`/`opts.signal` を省略すれば、provider が返るまで呼んだ Runtime の口
 *   （`observe`・`recall`・`tick`・`consolidate`・`reflect`・`reextract`）も返らない。上限になるのは provider 側の設定だけである。
 *   待っている間、runtime は DB の接続を握らない。
 * - `opts.signal` を渡したとき、呼ぶ前に既に abort 済みなら、runtime はこの呼び出しを行わずに reject する。
 * - 呼んでいる間に abort されたら、runtime はこの Promise の解決を待たずに reject する（`signal.reason`。無ければ `AbortError` 相当）。
 *   **provider がこの引数を無視しても**、runtime 自身が provider の Promise と abort を競わせるため、呼んだ Runtime の口は返る。
 * - `opts` を渡さない既存の実装（2引数の `complete`/`completeStructured`）は、そのままこの interface に適合する。
 * - `@mnemora/openai`・`@mnemora/anthropic` は SDK 呼び出しを core の `runAbortable` で包み、`signal` を SDK にも渡す。
 *   **provider を直に呼んだときも**、abort の reject の値は `signal.reason`（SDK の `APIUserAbortError` ではない）で、
 *   呼ぶ前に abort 済みなら SDK を呼ばずに reject し、SDK の再試行待ちの最中でも abort の時点で返る（ADR 0428、ADR 0445）。
 *   `EmbeddingProvider` 側は `embedding-provider.ts` を見ること。
 */
export interface LLMProvider {
  /** `req` を送り、応答の本文を返す。失敗は例外で返す（上の契約。リトライは内蔵しない）。`opts.signal` は上の「中断と時間の上限」を参照。 */
  complete(ctx: Ctx, req: PromptSpec, opts?: AbortOptions): Promise<LLMResponse>;
  /** `req.schema` に合う値を返させる。`req.schema` への適合を保証するのは provider である（上の #850）。失敗は例外で返す。`opts.signal` は上の「中断と時間の上限」を参照。 */
  completeStructured<T>(ctx: Ctx, req: StructuredRequest<T>, opts?: AbortOptions): Promise<T>;
}

/**
 * `OpenAILLMProviderOptions.client` / `OpenAIEmbeddingProviderOptions.client` に渡せる
 * クライアントの、SDK のクラスから独立した構造型（[Issue #1221](https://github.com/takecchi/mnemora/issues/1221)）。
 *
 * **なぜ SDK の型を使わないか**: `Pick<OpenAI, "chat">` のように `openai` パッケージの実クラスの型を
 * 公開すると、利用者が `@mnemora/openai` の依存に固定した版（`openai@7.10.0`）と違う版の `openai` を
 * 自分の依存として入れて `client` に渡したとき、型が食い違って `TS2322` になる（Issue #1221 で実測）。
 * そのため、SDK のクラスを名指ししない自前の構造型にした（オーナーの方針）。
 *
 * **持たせるのは、provider が実際に呼ぶメソッドの、実際に送る引数・実際に読む戻り値の
 * フィールドだけ。**SDK が持つ他のメソッド・フィールドは持たない。
 *
 * ⚠ **method 記法（`create(...): ...`）で書く。**TypeScript はメソッド記法で書いた
 * プロパティのパラメータを双変（bivariant）に検査する——`create: (...) => ...` という
 * arrow function 型で書くと、`strictFunctionTypes` の下でパラメータが共変のみの検査に
 * なり、`chat.completions.create` の実際の型（`stream` の有無で戻り値が変わる複数の
 * overload を持つ）を実装する実クライアントを代入できなくなる。ここでは意図的に
 * メソッド記法の緩さへ依拠している——**そのため、SDK の版が上がって `create` の
 * パラメータ・戻り値の形が多少変わっても、この構造型が実際の値の上位/下位どちらの
 * 形になっても代入できる余地がある**（歯は `__tests__/client-type-compat.test.ts`）。
 *
 * `openai` の import 自体は残る（`new OpenAI(...)` で既定のクライアントを作るため）。
 * だが **公開する `.d.ts` にはこのファイルの型だけが現れ、`openai` パッケージの型は
 * 一切参照しない**（歯は `scripts/check-public-api-surface.mjs` の snapshot と、
 * `__tests__/client-type-compat.test.ts` の `describe("公開する .d.ts に openai パッケージの
 * import が出ない（grep）")`。後者は `dist` を読まず、build の設定で `.d.ts` をメモリへ出して読む
 * ——CI は `test` を `build` より前に走らせるため）。
 */

/** `chat.completions.create` の `messages` の要素。`system`/`user`/`assistant` の3種のみ
 * （core の `PromptSpec` が使う形。`toOpenAIMessages` 参照）。 */
export interface OpenAIChatMessageParam {
  role: "system" | "user" | "assistant";
  content: string;
}

/** `chat.completions.create` の `response_format`（Structured Output、strict モード）。
 * `json-schema.ts` の {@link OpenAIJsonSchemaFormat}（`translateForOpenAIStructuredOutput`
 * の戻り値）をそのまま送る形と一致させてある。 */
export interface OpenAIChatResponseFormatJsonSchema {
  type: "json_schema";
  json_schema: { name: string; schema: Record<string, unknown>; strict: true };
}

/** `chat.completions.create` へ実際に渡す引数（`complete`/`completeStructured` が
 * 組み立てる形と一致させてある）。 */
export interface OpenAIChatCompletionCreateParams {
  model: string;
  messages: OpenAIChatMessageParam[];
  temperature?: number;
  response_format?: OpenAIChatResponseFormatJsonSchema;
}

/** `chat.completions.create` の戻り値のうち、`assertNotRefusedOrTruncated`・`complete`・
 * `completeStructured` が実際に読むフィールドだけ。 */
export interface OpenAIChatCompletionChoice {
  finish_reason?: string | null;
  message?: { content?: string | null; refusal?: string | null } | null;
}

/** `chat.completions.create` の戻り値の形（読むフィールドだけ）。 */
export interface OpenAIChatCompletionResult {
  choices: OpenAIChatCompletionChoice[];
}

/**
 * `OpenAILLMProviderOptions.client` に渡せる最小の構造型。
 * SDK の `OpenAI` クラスのインスタンス（`Pick<OpenAI, "chat">` を含む）は、版が違っても
 * この形を満たす限りそのまま代入できる（歯: `__tests__/client-type-compat.test.ts`）。
 */
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

/** `embeddings.create` へ実際に渡す引数（`OpenAIEmbeddingProvider.embed` が組み立てる形と
 * 一致させてある）。 */
export interface OpenAIEmbeddingCreateParams {
  model: string;
  input: string[];
  dimensions?: number;
}

/** `embeddings.create` の戻り値の要素のうち、`embed` が実際に読むフィールドだけ。 */
export interface OpenAIEmbeddingItem {
  embedding: number[];
  index: number;
}

/** `embeddings.create` の戻り値の形（読むフィールドだけ）。 */
export interface OpenAIEmbeddingsResult {
  data: OpenAIEmbeddingItem[];
}

/**
 * `OpenAIEmbeddingProviderOptions.client` に渡せる最小の構造型。
 * SDK の `OpenAI` クラスのインスタンス（`Pick<OpenAI, "embeddings">` を含む）は、版が
 * 違っても代入できる（歯: `__tests__/client-type-compat.test.ts`）。
 */
export interface OpenAIEmbeddingsClient {
  embeddings: {
    create(
      params: OpenAIEmbeddingCreateParams,
      options?: unknown,
    ): PromiseLike<OpenAIEmbeddingsResult>;
  };
}

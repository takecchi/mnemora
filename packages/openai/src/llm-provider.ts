import OpenAI from "openai";
import type { Ctx, LLMProvider, LLMResponse, PromptSpec, StructuredRequest } from "@mnemora/core";
import { assertApiKeyFitsInHeader } from "./api-key.js";
import { OpenAILLMProviderError } from "./errors.js";
import { translateForOpenAIStructuredOutput } from "./json-schema.js";
import { needsRootWrap, toBaseJsonSchema, unwrapRootValue } from "./structured-root.js";

/**
 * `packages/openai` の `LLMProvider` 実装（docs/architecture.md §5.4・§3.8）。
 *
 * `completeStructured` がこのパッケージの中心的な責務——zod スキーマを OpenAI の
 * Structured Output（`response_format: json_schema`, strict）へ翻訳し、返ってきた
 * JSON をもう一度 zod でパースして返す。**core・呼び出し側に OpenAI SDK の型は
 * 一切現れない**（`OpenAI`/`ChatCompletion` 等の型はこのファイルの外に出ない）。
 *
 * `client` を注入できるようにしてある（`OpenAIEmbeddingProvider` と同じ理由）。
 *
 * ⚠ **2026-09-26 追記（[Issue #884](https://github.com/takecchi/mnemora/issues/884)）:
 * `client` を省略すると `new OpenAI({ apiKey })` が作る SDK 既定のクライアントが使われる
 * ——このクライアントは SDK 自身が内部で 429・5xx 等に対して再試行する（実測:
 * `openai@7.10.0` は既定 `maxRetries: 2`＝最大3回・`timeout: 600000`ms。この数値は
 * mnemora の契約ではなく SDK の既定値であり、SDK の版が上がれば変わりうる）。再試行の
 * 有無・回数・timeout を変えたい呼び出し側は、`maxRetries`/`timeout` を設定した
 * `OpenAI` インスタンスを自分で作り、`client` へ渡すこと。**
 */
export interface OpenAILLMProviderOptions {
  /**
   * API キー。省略すると SDK が `OPENAI_API_KEY` を読む。
   *
   * **構築時に例外を投げることがある**（Issue #1080）: `client` を渡さずに SDK のクライアントを
   * このクラスが作るとき、SDK が送るヘッダ（`Authorization: Bearer <apiKey>`）に載せられない
   * 文字（キーの途中の CR・LF・NUL、U+0100 以上の文字など）を含んでいれば、**キーを含まない**
   * メッセージの `Error` を投げる（元の例外は `cause` にも付けない）。末尾の空白・改行のように
   * `fetch` が受け付ける値は拒まない。`client` を渡したときは検査しない。
   */
  apiKey?: string;
  /** OpenAI のチャットモデル名（例: `gpt-4o-mini`）。必須で、既定値は無い。 */
  model: string;
  /**
   * 自分で作った `OpenAI` のクライアント（再試行・timeout を変えたいとき）。渡すと `apiKey` は使わず、
   * キーの検査もしない。⚠ `openai` を自分の依存として入れるときは、`@mnemora/openai` が固定している版と
   * 同じにすること——違う版だと型が食い違う（packages/openai/README.md の 2026-09-27 追記）。
   */
  client?: Pick<OpenAI, "chat">;
  /**
   * `chat.completions.create` へ渡す `temperature`（省略可能な純追加、Issue #690 段3a）。
   *
   * **省略時（既定）は渡さない**——OpenAI API 自身の既定値がそのまま使われ、
   * この欄を渡さない既存の呼び出しの挙動は1バイトも変わらない。`examples/chat` の
   * `answer-time-weighting` ベンチが、temperature を固定して非決定性を切り分けるために
   * `CreateProvidersOptions.llmTemperature`（`providers.ts`）経由でのみ使う——
   * 他のベンチ・呼び出し元はこの欄を渡さない。
   */
  temperature?: number;
}

/**
 * OpenAI の strict モードは「省略可能」を `null` として返す（`json-schema.ts` の翻訳が
 * そう変換しているため）。しかし core の zod スキーマは `.optional()` を使っており、
 * **`null` を受け付けない**（`z.string().optional().safeParse(null)` は失敗する。
 * `undefined`/キー省略だけを許す）。そのため、OpenAI から返った JSON をそのまま
 * `req.schema.parse` に渡すと、モデルが「省略可能なので何も無い」と判断しただけの
 * フィールドで検証エラーになってしまう。
 *
 * ここでは再帰的に `null` を「キーが無い」状態へ変換してから core のスキーマでパースする。
 * **決めたこと（PR 本文にも記載）**: この変換は「`null` は常に『値が無い』を意味する」
 * という前提に立つ。将来 `completeStructured` へ渡すスキーマが `null` を意味のある値
 * として区別したくなった場合（`.nullable()` を意図的に使う場合）、この汎用的な変換は
 * 見直しが必要になる。Phase 1 で `completeStructured` に渡す実際のスキーマ
 * （`extraction.ts` の `ExtractionResultSchema`）にはそのような区別を要するフィールドが
 * 無いことを確認済み。
 *
 * ⚠ **2026-09-27 追記（[Issue #1082](https://github.com/takecchi/mnemora/issues/1082)）: 上の「確認済み」は、
 * Issue #608 の後は成り立っていない。**`ExtractedMemoryCandidateSchema.subjectId` は
 * `.nullable().optional()` で、省略（未指定）と明示の `null`（主題なし）を区別する。この変換が
 * `null` を消すので、この provider ではモデルが返した「主題なし」が省略として届き、Memory は
 * observation の主題を持つ（`@mnemora/anthropic` は `null` を保つので結果が分かれる）。
 * `null` を保つだけでは直らない——strict モードの翻訳では、`subjectCandidates` を渡さないときの
 * 「未指定」も応答の上では `null` になるので、今度は候補一覧の無い観測のすべてが主題なしになる。
 * クローン miku の判断で、スキーマ・翻訳を変える案は採らず、今の振る舞いを記録した
 * （選び直す余地は Issue に残してある）。ほかの3つのスキーマ（統合・内省・claim key）には
 * `.nullable()` の欄が無い。
 */
function stripNulls(value: unknown): unknown {
  if (value === null) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.map(stripNulls);
  }
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const stripped = stripNulls(child);
      if (stripped !== undefined) {
        result[key] = stripped;
      }
    }
    return result;
  }
  return value;
}

/**
 * ⭐ **`content` を読む前に、必ずこれを通す。**
 *
 * **拒否は HTTP 200 で返る。** `message.refusal` に拒否理由の文字列が入り、
 * このとき `message.content` は `null` になる。SDK は例外を投げない。
 * ⟹ **見ないと、拒否を「空の成功」として core へ渡す。**
 *
 * OpenAI は Anthropic の `stop_reason` 一本とは形が違い、**2つの独立した機構**を持つ
 * ——`message.refusal` と `finish_reason`。両方をここで見る。
 *
 * - `message.refusal` が非 null かつ空文字でなければ `kind: "refusal"`。
 * - `finish_reason === "content_filter"` も `kind: "refusal"` として扱う。
 *   **判断**: コンテンツフィルタで出力が省かれたのはモデル自身の拒否とは別機構だが、
 *   呼び出し側の次の一手は同じ（同じ入力で再試行しても意味が無い）。⟹ `kind` は
 *   増やさず、生の `finishReason` をフィールドに残すことで情報は潰さない。
 * - `finish_reason === "length"` は `kind: "truncated"`。**切り詰められた JSON は
 *   `JSON.parse` で `SyntaxError` になり、「モデルが壊れた JSON を吐いた」と
 *   区別が付かなくなる。** だから分ける。
 * - それ以外（`stop` / `tool_calls` / `function_call` / 未設定 / null）は素通しする
 *   ——「分からない」を「拒否された」と読まない（`@mnemora/anthropic` と同じ固定点）。
 *
 * **`choices` が空（choice 自体が無い）ときは、この門では投げない。** 既存の
 * `no_content` の経路（`complete` の `?? ""` / `completeStructured` の `if (!raw)`）に任せる。
 *
 * ⚠ **2026-09-26 追記（[Issue #885](https://github.com/takecchi/mnemora/issues/885)）:
 * 上の「`choices` が空」は `choices: []`（キー自体はある）を指す——`response.choices[0]`
 * が `undefined` になり、この関数はそれを `choice` 引数として受け取って `if (!choice)`
 * で素通しする。**`choices` キー自体が丸ごと無い応答（`{}` が返る等）は、この関数の
 * *外*で先に壊れる**——呼び出し元（`complete`/`completeStructured`）の
 * `response.choices[0]` という式が、`response.choices` が `undefined` であることに
 * より、この関数を呼ぶ前に `TypeError: Cannot read properties of undefined
 * (reading '0')` を投げる。この場合 `OpenAILLMProviderError` の `kind` 分類には
 * 一切載らない。詳細は `errors.ts` 冒頭コメントの同日付追記を参照。
 */
function assertNotRefusedOrTruncated(choice?: {
  finish_reason?: string | null;
  message?: { refusal?: string | null } | null;
}): void {
  if (!choice) {
    return;
  }
  const refusalMessage = choice.message?.refusal ?? null;
  if (refusalMessage != null && refusalMessage !== "") {
    throw new OpenAILLMProviderError({
      kind: "refusal",
      refusalMessage,
      finishReason: choice.finish_reason ?? null,
    });
  }
  const finishReason = choice.finish_reason ?? null;
  if (finishReason === "content_filter") {
    throw new OpenAILLMProviderError({ kind: "refusal", finishReason });
  }
  if (finishReason === "length") {
    throw new OpenAILLMProviderError({ kind: "truncated", finishReason });
  }
}

function toOpenAIMessages(
  prompt: PromptSpec,
): { role: "system" | "user" | "assistant"; content: string }[] {
  const messages: { role: "system" | "user" | "assistant"; content: string }[] = [];
  if (prompt.system) {
    messages.push({ role: "system", content: prompt.system });
  }
  for (const message of prompt.messages) {
    messages.push({ role: message.role, content: message.content });
  }
  return messages;
}

/**
 * OpenAI の Chat Completions を呼ぶ `LLMProvider`。設定は {@link OpenAILLMProviderOptions} を見ること。
 *
 * 構築時: `client` を省き、キーが見つからなければ OpenAI の SDK が `OpenAIError`（`Missing credentials`）を投げる。
 * キーがヘッダに載せられない文字を含むときは、キーを含まない `Error` を投げる（`apiKey` の doc）。
 *
 * 拒否・切り詰め・空応答は {@link OpenAILLMProviderError} の `kind` で返る（`instanceof` ではなく `kind` で分岐すること）。
 * HTTP の失敗・認証の失敗・400 などは、SDK の例外がそのまま伝わる。
 */
export class OpenAILLMProvider implements LLMProvider {
  private readonly client: Pick<OpenAI, "chat">;
  private readonly model: string;
  private readonly temperature?: number;

  constructor(options: OpenAILLMProviderOptions) {
    if (options.client !== undefined) {
      this.client = options.client;
    } else {
      const client = new OpenAI({ apiKey: options.apiKey });
      // Issue #1080: SDK は `Authorization: Bearer <apiKey>` を送る（`apiKey` を省略すると
      // `OPENAI_API_KEY` を読む）。`api-key.ts` の doc コメント参照。
      assertApiKeyFitsInHeader(
        "OpenAILLMProvider",
        "apiKey",
        "authorization",
        `Bearer ${client.apiKey}`,
      );
      this.client = client;
    }
    this.model = options.model;
    this.temperature = options.temperature;
  }

  /**
   * `req` を1回送り、最初の選択肢の本文を返す。
   *
   * 拒否（`message.refusal`・`finish_reason === "content_filter"`）は `kind: "refusal"`、`finish_reason === "length"` は
   * `kind: "truncated"` の {@link OpenAILLMProviderError} を投げる。⚠ どちらでもない空応答は、例外にせず空文字を返す
   * （ADR 0072「引き受けた負債」2。`@mnemora/anthropic` も同じ形）。
   */
  async complete(_ctx: Ctx, req: PromptSpec): Promise<LLMResponse> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: toOpenAIMessages(req),
      ...(this.temperature !== undefined ? { temperature: this.temperature } : {}),
    });
    assertNotRefusedOrTruncated(response.choices[0]);
    // ⚠ **ここの `?? ""` は残した。** ADR 0072「引き受けた負債」2 の通り、
    // `@mnemora/anthropic` も同じ形であり、片方だけ throw にすると差し替えられなくなる。
    // **ただし上の門を通した後なので、意味が変わっている**——ここへ来る空文字は
    // 「拒否された」でも「切り詰められた」でもなく、**モデルが本当に何も言わなかった**場合だけである。
    // ⟹ **「空文字は安全だ」と主張しているのではない。**望ましい姿でもない。
    // 直すなら両 provider 同時（＝公開 API の破壊的変更）なので、提起までにしてある。
    return { content: response.choices[0]?.message?.content ?? "" };
  }

  /**
   * zod スキーマを OpenAI の Structured Output へ翻訳して送り、返った JSON を `req.schema` で検査して返す。
   *
   * ⚠ **送る前に「OpenAI が受け付ける形か」は検査しない**（#1148、今の振る舞い）。`z.record`・`z.tuple`・
   * `z.date`・`transform` は、送った後に OpenAI が `BadRequestError`（HTTP 400、`param: response_format`）で拒む
   * （【実測 2026-09-27】）。`z.lazy`（再帰）・`default`・根が union（包んで送る）は通る。一覧は README。
   *
   * 投げるもの: 拒否・切り詰めは `complete` と同じ {@link OpenAILLMProviderError}（`kind: "refusal"`・`"truncated"`）、
   * 本文が空・欠落なら `kind: "no_content"`。本文が JSON として壊れていれば `JSON.parse` の `SyntaxError`、
   * `req.schema` に合わなければ zod の `ZodError` がそのまま伝わる（どちらも `kind` を持たない）。
   */
  async completeStructured<T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> {
    const format = translateForOpenAIStructuredOutput("mnemora_structured_output", req.schema);
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: toOpenAIMessages(req.prompt),
      response_format: { type: "json_schema", json_schema: format },
      ...(this.temperature !== undefined ? { temperature: this.temperature } : {}),
    });
    // ⭐ **`content` を読む前に拒否・切り詰めを見る。**順序が本質である
    // ——後ろに置くと、拒否が `no_content` に化けて種類が潰れる（拒否時は `content` が `null`）。
    assertNotRefusedOrTruncated(response.choices[0]);
    const raw = response.choices[0]?.message?.content;
    if (!raw) {
      // メッセージは既存の文言のまま（差し替え可能性・provider-parity.test.ts を壊さない）。
      // 種類は `kind` で足しただけである。
      throw new OpenAILLMProviderError({ kind: "no_content" });
    }
    const parsedJson: unknown = JSON.parse(raw);
    // OpenAI の strict モードは JSON Schema としての形は保証するが、それが core の zod
    // スキーマとして意味的に妥当かは別問題。上の stripNulls で null → 省略へ変換してから
    // もう一度 zod でパースし、core・呼び出し側には常に検証済みの T を返す。
    //
    // 根が object でないスキーマは包んで送っている（`translateForOpenAIStructuredOutput`、
    // `structured-root.ts`）ので、包みの欄から取り出してから検査する。
    const value = needsRootWrap(toBaseJsonSchema(req.schema))
      ? unwrapRootValue(parsedJson)
      : parsedJson;
    return req.schema.parse(stripNulls(value));
  }
}

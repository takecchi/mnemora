import OpenAI from "openai";
// `openai/lib/transform` は `openai` パッケージの `exports` には載っているが、README 等で
// 案内される文書化された入口ではない（ADR 0360「引き受けた負債」）。実際に送る JSON Schema が
// OpenAI 自身の strict 変換を通るかを、送る前に検査するためだけに使う——戻り値は使わない
// （送るのは今までどおり mnemora 自身の翻訳結果である）。
import { toStrictJsonSchema } from "openai/lib/transform";
import type {
  AbortOptions,
  Ctx,
  LLMProvider,
  LLMResponse,
  PromptSpec,
  StructuredRequest,
} from "@mnemora/core";
import { runAbortable } from "@mnemora/core";
import { assertApiKeyFitsInHeader } from "./api-key.js";
import { assertFiniteNonNegative } from "./option-check.js";
import type { OpenAIChatClient } from "./client-types.js";
import { OpenAILLMProviderError } from "./errors.js";
import type { OpenAIJsonSchemaFormat } from "./json-schema.js";
import { translateForOpenAIStructuredOutput } from "./json-schema.js";
import { needsRootWrap, toBaseJsonSchema, unwrapRootValue } from "./structured-root.js";
import { setOwn } from "./own-property.js";

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
  apiKey?: string | undefined;
  /** OpenAI のチャットモデル名（例: `gpt-4o-mini`）。必須で、既定値は無い。 */
  model: string;
  /**
   * 自分で作った `OpenAI` のクライアント（再試行・timeout を変えたいとき）。渡すと `apiKey` は使わず、
   * キーの検査もしない。
   *
   * ⚠ **2026-09-29 追記（[Issue #1221](https://github.com/takecchi/mnemora/issues/1221)）:**
   * この欄の型は `openai` SDK のクラスを名指ししない自前の構造型 {@link OpenAIChatClient}
   * である（以前は `Pick<OpenAI, "chat">` だった）。**`openai` を自分の依存として入れる版は、
   * `@mnemora/openai` が固定している版と揃える必要が無い**——`OpenAI` インスタンスは、
   * 版が違ってもこの構造型を満たす限りそのまま渡せる（packages/openai/README.md 参照）。
   */
  client?: OpenAIChatClient | undefined;
  /**
   * `chat.completions.create` へ渡す `temperature`（省略可能な純追加、Issue #690 段3a）。
   *
   * **省略時（既定）は渡さない**——OpenAI API 自身の既定値がそのまま使われ、
   * この欄を渡さない既存の呼び出しの挙動は1バイトも変わらない。`examples/chat` の
   * `answer-time-weighting` ベンチが、temperature を固定して非決定性を切り分けるために
   * `CreateProvidersOptions.llmTemperature`（`providers.ts`）経由でのみ使う——
   * 他のベンチ・呼び出し元はこの欄を渡さない。
   *
   * ⚠ ADR 0498: **渡すなら有限で `0` 以上の数でなければ、構築時に投げる**（型が違えば `TypeError`、数として不正なら
   * `RangeError`。message に値が入る）。上限は API・モデルごとに違うので見ない（超えた値は API が断る）。
   */
  temperature?: number | undefined;
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
 *
 * ⚠ **2026-09-28 追記:** この変換だけでは、スキーマがもともと `null` を許す位置（必須の `.nullable()`・
 * 配列の要素・根）の `null` まで消して `ZodError` にしていた（README は `nullable` を「通る」としていた）。
 * いまはこの変換を1段目とし、`ZodError` のときだけ {@link keepSchemaNulls} で検査し直す
 * （{@link parseStructuredValue}）。上の #1082 の振る舞い（`.nullable().optional()` の `null` は省略）は変えていない。
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
        setOwn(result, key, stripped);
      }
    }
    return result;
  }
  return value;
}

type JsonSchemaNode = Record<string, unknown>;

function isSchemaNode(value: unknown): value is JsonSchemaNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `$ref`（根 `#` と `#/$defs/...`）を辿る。辿れなければ `undefined`。 */
function resolveRef(node: unknown, root: JsonSchemaNode, depth = 0): JsonSchemaNode | undefined {
  if (!isSchemaNode(node) || depth > 32) {
    return undefined;
  }
  const ref = node["$ref"];
  if (typeof ref !== "string") {
    return node;
  }
  if (ref === "#") {
    return root;
  }
  const match = /^#\/\$defs\/(.+)$/.exec(ref);
  const defs = root["$defs"];
  return match && isSchemaNode(defs) ? resolveRef(defs[match[1]!], root, depth + 1) : undefined;
}

/** `anyOf`/`oneOf` を平らにした選択肢（`$ref` は辿る）。 */
function schemaBranches(node: unknown, root: JsonSchemaNode, depth = 0): JsonSchemaNode[] {
  const resolved = resolveRef(node, root);
  if (resolved === undefined || depth > 32) {
    return [];
  }
  const alternatives = resolved["anyOf"] ?? resolved["oneOf"];
  return Array.isArray(alternatives)
    ? alternatives.flatMap((alternative) => schemaBranches(alternative, root, depth + 1))
    : [resolved];
}

function admitsNull(node: unknown, root: JsonSchemaNode): boolean {
  return schemaBranches(node, root).some((branch) => {
    const type = branch["type"];
    return (
      type === "null" ||
      (Array.isArray(type) && type.includes("null")) ||
      ("const" in branch && branch["const"] === null) ||
      (Array.isArray(branch["enum"]) && branch["enum"].includes(null))
    );
  });
}

/**
 * {@link stripNulls} の2段目。元のスキーマ（翻訳の前の JSON Schema）が `null` を許す位置の `null` だけを残し、
 * ほかの `null` は {@link stripNulls} と同じく消す。
 *
 * 残すのは次の位置だけである:
 * - object の欄: **その欄が元の `required` に入り**、かつ `null` を許すとき。`.optional()` 由来の欄
 *   （`.nullable().optional()` を含む。Issue #1082）の `null` は、翻訳が足した `null` と区別できないので消す。
 *   union で候補の枝が複数あるときは、その欄を持つ**すべての枝**が「必須かつ `null` を許す」ときだけ残す。
 * - 配列の要素・根: その位置のスキーマが `null` を許すとき。
 *
 * スキーマが分からない位置（`$ref` が辿れない・候補の枝が無い）では消す側に倒す。
 */
function keepSchemaNulls(value: unknown, node: unknown, root: JsonSchemaNode): unknown {
  if (value === null) {
    return admitsNull(node, root) ? null : undefined;
  }
  const branches = schemaBranches(node, root);
  if (Array.isArray(value)) {
    const items = branches.flatMap((branch) =>
      branch["items"] !== undefined ? [branch["items"]] : [],
    );
    const itemNode = items.length === 1 ? items[0] : { anyOf: items };
    return value.map((item) => keepSchemaNulls(item, itemNode, root));
  }
  if (typeof value === "object") {
    const objects = branches.filter((branch) => isSchemaNode(branch["properties"]));
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const candidates = objects.filter((branch) =>
        Object.hasOwn(branch["properties"] as JsonSchemaNode, key),
      );
      const propertyOf = (branch: JsonSchemaNode) => (branch["properties"] as JsonSchemaNode)[key];
      if (child === null) {
        const keep =
          candidates.length > 0 &&
          candidates.every(
            (branch) =>
              Array.isArray(branch["required"]) &&
              branch["required"].includes(key) &&
              admitsNull(propertyOf(branch), root),
          );
        if (keep) {
          setOwn(result, key, null);
        }
        continue;
      }
      const childNode =
        candidates.length === 1
          ? propertyOf(candidates[0]!)
          : { anyOf: candidates.map(propertyOf) };
      const kept = keepSchemaNulls(child, childNode, root);
      if (kept !== undefined) {
        setOwn(result, key, kept);
      }
    }
    return result;
  }
  return value;
}

/**
 * 戻りの JSON（根を包んで送ったなら取り出した後の値）を `schema` で検査する。
 *
 * 1. {@link stripNulls} で `null` を消して検査し、通ればそれを返す（今までの形。ここで通る入力の結果は変えない）。
 * 2. `ZodError` のときだけ、{@link keepSchemaNulls} で元のスキーマが許す `null` を残して検査し直し、通ればそれを返す。
 * 3. 2でも落ちたら、**1の `ZodError` をそのまま投げる**（2の失敗は投げない）。
 *
 * ⟹ 変わるのは、今までは `ZodError` になっていた入力の結果だけである。
 */
function parseStructuredValue<T>(
  schema: StructuredRequest<T>["schema"],
  base: JsonSchemaNode,
  value: unknown,
): T {
  const first = schema.safeParse(stripNulls(value));
  if (first.success) {
    return first.data;
  }
  const second = schema.safeParse(keepSchemaNulls(value, base, base));
  if (second.success) {
    return second.data;
  }
  throw first.error;
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

/**
 * `req.schema` を OpenAI の Structured Output へ翻訳し、**実際に送る JSON Schema**を OpenAI SDK
 * 自身の strict 変換 `toStrictJsonSchema`（`openai/lib/transform`）に通してから返す
 * （[Issue #1148](https://github.com/takecchi/mnemora/issues/1148)、
 * [ADR 0360](../../../docs/decisions/0360-schema-unsupported-thrown-before-send.md)）。
 *
 * ⭐ **`toStrictJsonSchema` の戻り値は捨てる。**検査のためだけに呼ぶ——送るのは、あくまで
 * mnemora 自身の翻訳（`translateForOpenAIStructuredOutput`）が作った `format.schema` である。
 * `toStrictJsonSchema` は内部で `structuredClone` するため、渡した `format.schema` 自体も
 * 変更しない。
 *
 * ここで投げた例外（`translateForOpenAIStructuredOutput` 自身が投げるもの＝ zod の既定
 * （throw）で `z.date()`・`transform` が「representable ではない」と判定したもの、または
 * `toStrictJsonSchema` が `z.record`・`z.tuple` 等の strict 非互換を検出したもの）は、
 * 呼び出し元（`completeStructured`）が {@link OpenAILLMProviderError}
 * （`kind: "schema_unsupported"`）に包んで投げ直す。**ここでは包まない**——このファイルの
 * ほかの `assertNotRefusedOrTruncated` 等と同じく、変換の責務と例外の型付けの責務を分ける。
 *
 * ⚠ **自前の strict 検査は書かない**（ADR 0360 決定）。`openai` SDK 自身の検査を再利用する。
 */
function translateAndValidateStructuredOutputFormat<T>(
  schema: StructuredRequest<T>["schema"],
): OpenAIJsonSchemaFormat {
  const format = translateForOpenAIStructuredOutput("mnemora_structured_output", schema);
  toStrictJsonSchema(format.schema as Parameters<typeof toStrictJsonSchema>[0]);
  return format;
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
 * `temperature` を渡すとき、有限で `0` 以上の数でなければ、`TypeError`（型が違う）か `RangeError`（数として不正）を投げる（ADR 0498。`OpenAILLMProviderOptions.temperature` の doc）。
 *
 * 拒否・切り詰め・空応答は {@link OpenAILLMProviderError} の `kind` で返る（`instanceof` ではなく `kind` で分岐すること）。
 * HTTP の失敗・認証の失敗・400 などは、SDK の例外がそのまま伝わる。
 *
 * ⚠ **2026-09-29 追記（[Issue #1200](https://github.com/takecchi/mnemora/issues/1200)、
 * [ADR 0359](../../../docs/decisions/0359-abort-signal-for-provider-calls.md)）:
 * `complete`/`completeStructured` の第3引数 `opts?.signal` を、そのまま
 * `chat.completions.create` の request options（`{ signal }`）へ渡す。** SDK が既定で
 * 対応する `AbortSignal` の仕組みに委ねているだけであり、`@mnemora/openai` 自身は
 * 中断のロジックを持たない。
 */
export class OpenAILLMProvider implements LLMProvider {
  private readonly client: OpenAIChatClient;
  private readonly model: string;
  private readonly temperature?: number;

  constructor(options: OpenAILLMProviderOptions) {
    // ADR 0498: 省略（`undefined`）は渡さない（API の既定のまま）。渡すなら有限で 0 以上。上限は API・モデルごとに違うので見ない。
    if (options.temperature !== undefined) {
      assertFiniteNonNegative("OpenAILLMProvider", "temperature", options.temperature);
    }
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
   *
   * ⚠ **`opts?.signal`（ADR 0359・ADR 0428）:** 呼ぶ前に abort 済みなら SDK を呼ばずに、待っている間に abort したら即座に、
   * `signal.reason`（`abortReason(signal)`）で reject する——SDK の `APIUserAbortError` には化けず、SDK の再試行待ち
   * （429 の `retry-after` 等）の最中でも切れる。`signal` は SDK にも渡すので、裏のリクエストも切れる。
   */
  async complete(_ctx: Ctx, req: PromptSpec, opts?: AbortOptions): Promise<LLMResponse> {
    const response = await runAbortable(opts?.signal, async (signal) =>
      this.client.chat.completions.create(
        {
          model: this.model,
          messages: toOpenAIMessages(req),
          ...(this.temperature !== undefined ? { temperature: this.temperature } : {}),
        },
        { signal },
      ),
    );
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
   * ⚠ **2026-09-29 追記（[Issue #1148](https://github.com/takecchi/mnemora/issues/1148)、
   * [ADR 0360](../../../docs/decisions/0360-schema-unsupported-thrown-before-send.md)）:
   * 送る前に検査するようになった。**`z.record`・`z.tuple`・`z.date`・`transform` は、いまは
   * `chat.completions.create` を呼ぶ前に {@link OpenAILLMProviderError}（`kind:
   * "schema_unsupported"`、`cause` に元の例外）で落ちる——以前はここで送ってからベンダーに
   * 拒ませていた（`BadRequestError`、HTTP 400）。`z.lazy`（再帰）・`default`・根が union
   * （包んで送る）は今までどおり通る。一覧は README。
   *
   * 送った後に投げるもの: 拒否・切り詰めは `complete` と同じ {@link OpenAILLMProviderError}（`kind: "refusal"`・`"truncated"`）、
   * 本文が空・欠落なら `kind: "no_content"`。本文が JSON として壊れていれば `JSON.parse` の `SyntaxError`、
   * `req.schema` に合わなければ zod の `ZodError` がそのまま伝わる（どちらも `kind` を持たない）。
   *
   * 戻りの `null`: `.optional()` の欄の `null`（strict への翻訳が足したもの）は省略へ戻す。スキーマがもともと `null` を許す
   * 必須の欄（`.nullable()`）・配列の要素・根の `null` は `null` のまま返す。`.nullable().optional()` の欄の `null` は
   * 省略として届く（Issue #1082。`stripNulls` の doc）。
   *
   * ⚠ **`opts?.signal`（ADR 0359・ADR 0428）:** 呼ぶ前に abort 済みなら SDK を呼ばずに、待っている間に abort したら即座に、
   * `signal.reason`（`abortReason(signal)`）で reject する——SDK の `APIUserAbortError` には化けず、SDK の再試行待ち
   * （429 の `retry-after` 等）の最中でも切れる。`signal` は SDK にも渡すので、裏のリクエストも切れる。
   */
  async completeStructured<T>(
    _ctx: Ctx,
    req: StructuredRequest<T>,
    opts?: AbortOptions,
  ): Promise<T> {
    let format: OpenAIJsonSchemaFormat;
    try {
      format = translateAndValidateStructuredOutputFormat(req.schema);
    } catch (cause) {
      // ⭐ ここで投げるのは、翻訳（zod の既定＝throw）または送る直前の strict 検査
      // （`toStrictJsonSchema`）のどちらかだけである。`chat.completions.create` はまだ
      // 呼んでいない——拒否・切り詰め・応答の検証エラーとは混ぜない（ADR 0360）。
      throw new OpenAILLMProviderError({ kind: "schema_unsupported", cause });
    }
    const response = await runAbortable(opts?.signal, async (signal) =>
      this.client.chat.completions.create(
        {
          model: this.model,
          messages: toOpenAIMessages(req.prompt),
          response_format: { type: "json_schema", json_schema: format },
          ...(this.temperature !== undefined ? { temperature: this.temperature } : {}),
        },
        { signal },
      ),
    );
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
    // もう一度 zod でパースし（落ちたら元のスキーマが許す null を残して検査し直す。
    // `parseStructuredValue`）、core・呼び出し側には常に検証済みの T を返す。
    //
    // 根が object でないスキーマは包んで送っている（`translateForOpenAIStructuredOutput`、
    // `structured-root.ts`）ので、包みの欄から取り出してから検査する。
    const base = toBaseJsonSchema(req.schema);
    const value = needsRootWrap(base) ? unwrapRootValue(parsedJson) : parsedJson;
    return parseStructuredValue(req.schema, base, value);
  }
}

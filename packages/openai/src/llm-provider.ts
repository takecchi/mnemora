import OpenAI from "openai";
// `openai/lib/transform` は文書化された入口ではないが、実際に送る JSON Schema が OpenAI 自身の strict 変換を
// 通るかを送る前に検査するためだけに使う。戻り値は使わない（送るのは mnemora 自身の翻訳結果）。
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
 * {@link OpenAILLMProvider} のコンストラクタに渡す設定。
 *
 * `client` を省略すると SDK 既定のクライアントが使われ、SDK が 429・5xx を再試行する（回数・timeout は SDK の既定）。
 * 変えたい場合は設定した `OpenAI` インスタンスを `client` へ渡す。
 */
export interface OpenAILLMProviderOptions {
  /**
   * API キー。省略すると SDK が `OPENAI_API_KEY` を読む。
   *
   * `client` を渡さないとき、ヘッダに載せられない文字（キーの途中の CR・LF・NUL など）を含めば、
   * **キーを含まない**メッセージの `Error` を構築時に投げる。`client` を渡したときは検査しない。
   */
  apiKey?: string | undefined;
  /** OpenAI のチャットモデル名（例: `gpt-4o-mini`）。必須で、既定値は無い。 */
  model: string;
  /**
   * 自分で作った `OpenAI` のクライアント（再試行・timeout を変えたいとき）。渡すと `apiKey` は使わず、
   * キーの検査もしない。型は SDK のクラスを名指ししない構造型 {@link OpenAIChatClient}。
   */
  client?: OpenAIChatClient | undefined;
  /**
   * `chat.completions.create` へ渡す `temperature`。省略時は渡さず、OpenAI API の既定のまま。
   * 渡すなら有限で `0` 以上の数でなければ構築時に投げる（型が違えば `TypeError`、数として不正なら `RangeError`）。
   * 上限は API・モデルごとに違うので見ない。
   */
  temperature?: number | undefined;
}

// strict の翻訳は「省略可能」を `null` にするが、core の `.optional()` は `null` を受け付けないので、
// 再帰的に `null` を「キーが無い」状態へ変換してからパースする。
// ⚠ `.nullable().optional()` の欄（`ExtractedMemoryCandidateSchema.subjectId`）では「主題なし」の `null` が省略として届く
// （`@mnemora/anthropic` は `null` を保つので結果が分かれる）。`null` を保つだけでは直らない:
// `subjectCandidates` を渡さないときの「未指定」も応答の上では `null` になる。
// この変換だけだと、スキーマがもともと `null` を許す位置の `null` まで消えて `ZodError` になるので、
// `ZodError` のときだけ {@link keepSchemaNulls} で検査し直す（{@link parseStructuredValue}）。
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

// {@link stripNulls} の2段目。元のスキーマが `null` を許す位置の `null` だけを残す。
// object の欄は、元の `required` に入りかつ `null` を許すときだけ残す: `.optional()` 由来の欄の `null` は、
// 翻訳が足した `null` と区別できないので消す。union で枝が複数あれば、その欄を持つすべての枝で満たすときだけ残す。
// スキーマが分からない位置は消す側に倒す。
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

// 1. `stripNulls` で検査して通ればそれを返す。2. `ZodError` のときだけ `keepSchemaNulls` で検査し直す。
// 3. それも落ちたら 1 の `ZodError` を投げる（2 の失敗は投げない）。
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

// `content` を読む前に必ず通す: 拒否は HTTP 200 で返り、見ないと「空の成功」として core へ渡る。
// `content_filter` も `refusal` として扱う: 別機構だが、呼び出し側の次の一手は同じ。生の `finishReason` は残す。
// `length` を分ける: 切り詰められた JSON は `SyntaxError` になり、壊れた JSON と区別が付かなくなる。
// それ以外は素通しする: 「分からない」を「拒否された」と読まない。
// `choices` が空のときは投げず、`no_content` の経路に任せる。`choices` キーが無い応答は呼び出し元の `response.choices[0]` で
// `TypeError` になり、`kind` に載らない。
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

// `toStrictJsonSchema` の戻り値は捨てる: 検査のためだけに呼び、送るのは mnemora 自身の翻訳結果。
// 自前の strict 検査は書かない: `openai` SDK 自身の検査を再利用する（ADR 0360）。
// ここでは例外を包まない: 型付けは呼び出し元（`completeStructured`）の責務。
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
    messages.push({ role: message.role === "assistant" ? "user" : message.role, content: message.content });
  }
  return messages;
}

/**
 * OpenAI の Chat Completions を呼ぶ `LLMProvider`。
 *
 * 構築時: `client` を省き、キーが見つからなければ SDK が `OpenAIError`（`Missing credentials`）を投げる。
 * キーがヘッダに載せられない文字を含めば、キーを含まない `Error` を投げる。`temperature` が不正なら
 * `TypeError` / `RangeError` を投げる。
 *
 * 拒否・切り詰め・空応答は {@link OpenAILLMProviderError} の `kind` で返る。HTTP・認証の失敗は SDK の例外がそのまま伝わる。
 * `complete`/`completeStructured` の `opts?.signal` は SDK の request options にも渡す。
 */
export class OpenAILLMProvider implements LLMProvider {
  private readonly client: OpenAIChatClient;
  private readonly model: string;
  private readonly temperature?: number;

  constructor(options: OpenAILLMProviderOptions) {
    if (options.temperature !== undefined) {
      assertFiniteNonNegative("OpenAILLMProvider", "temperature", options.temperature);
    }
    if (options.client !== undefined) {
      this.client = options.client;
    } else {
      const client = new OpenAI({ apiKey: options.apiKey });
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
   * `req` を1回送り、最初の選択肢の本文を返す。拒否は `kind: "refusal"`、切り詰めは `kind: "truncated"` の
   * {@link OpenAILLMProviderError} を投げる。どちらでもない空応答は、例外にせず空文字を返す。
   *
   * `opts?.signal`: 呼ぶ前に abort 済みなら SDK を呼ばずに、待っている間に abort したら即座に `signal.reason` で reject する。
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
    // `?? ""` を throw にしない: `@mnemora/anthropic` と同じ形を保ち、差し替え可能にするため。
    return { content: response.choices[0]?.message?.content ?? "" };
  }

  /**
   * zod スキーマを OpenAI の Structured Output へ翻訳して送り、返った JSON を `req.schema` で検査して返す。
   *
   * `z.record`・`z.tuple`・`z.date`・`transform` は、送る前に `kind: "schema_unsupported"` の
   * {@link OpenAILLMProviderError} で落ちる（`cause` に元の例外）。`z.lazy`・`default`・根が union は通る。
   *
   * 送った後: 拒否・切り詰めは `complete` と同じ `kind`、本文が空なら `kind: "no_content"`。
   * 本文が JSON として壊れていれば `SyntaxError`、`req.schema` に合わなければ `ZodError` がそのまま伝わる。
   *
   * 戻りの `null`: `.optional()` の欄の `null` は省略へ戻す。もともと `null` を許す必須の欄・配列の要素・根の `null` は
   * そのまま返す。`.nullable().optional()` の欄の `null` は省略として届く。`opts?.signal` は `complete` と同じ。
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
    // `content` より前に拒否・切り詰めを見る: 後ろに置くと拒否が `no_content` に化ける（拒否時は `content` が `null`）。
    assertNotRefusedOrTruncated(response.choices[0]);
    const raw = response.choices[0]?.message?.content;
    if (!raw) {
      throw new OpenAILLMProviderError({ kind: "no_content" });
    }
    const parsedJson: unknown = JSON.parse(raw);
    const base = toBaseJsonSchema(req.schema);
    const value = needsRootWrap(base) ? unwrapRootValue(parsedJson) : parsedJson;
    return parseStructuredValue(req.schema, base, value);
  }
}

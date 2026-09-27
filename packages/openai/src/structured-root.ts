import { z } from "zod";

/**
 * 根が object でないスキーマを、OpenAI の strict な Structured Outputs へ送るための包み
 * （`index.ts` からは出さない内部のモジュール）。
 *
 * OpenAI の strict は、根が `type: "object"` であることを求める（`openai` SDK の strict 変換
 * `lib/transform.js` の `toStrictJsonSchema` は、根が object でない・根に `anyOf` を持つスキーマで
 * 投げる）。core の `ReflectionLLMResultSchema`（判別可能ユニオン、ADR 0091）はこれに当たる。
 * ⟹ 根が object でないときだけ、1つの欄 {@link WRAPPED_ROOT_KEY} を持つ object に包んで送り、
 * 返った JSON からその欄を取り出してから `req.schema.parse` に渡す。根が object のスキーマは
 * 包まない（送る形も読む形も今までと同じ）。
 *
 * 歯は `__tests__/structured-root-union.test.ts`。
 */

/** 包んだときの唯一の欄の名前。 */
export const WRAPPED_ROOT_KEY = "result";

type JsonSchemaNode = Record<string, unknown>;

/**
 * zod スキーマから、翻訳の元になる JSON Schema を作る。`translateForOpenAIStructuredOutput` と
 * `OpenAILLMProvider.completeStructured` が、包むかどうかを同じ元から決めるための1か所。
 */
export function toBaseJsonSchema(schema: z.ZodType<unknown>): JsonSchemaNode {
  return z.toJSONSchema(schema, {
    target: "draft-2020-12",
    unrepresentable: "any",
  }) as JsonSchemaNode;
}

/** 根が object でない（包んで送る）スキーマか。 */
export function needsRootWrap(base: JsonSchemaNode): boolean {
  return base.type !== "object";
}

/**
 * 強化済みのスキーマを、{@link WRAPPED_ROOT_KEY} だけを持つ object に包む。`$defs` は根に残す
 * （`#/$defs/...` の参照が指す先を変えないため）。
 */
export function wrapRootSchema(hardened: JsonSchemaNode): JsonSchemaNode {
  const { $defs, ...inner } = hardened;
  return {
    type: "object",
    properties: { [WRAPPED_ROOT_KEY]: inner },
    required: [WRAPPED_ROOT_KEY],
    additionalProperties: false,
    ...($defs !== undefined ? { $defs } : {}),
  };
}

/**
 * 包んで送った応答から、元の値を取り出す。欄が無い・object でない応答は `undefined` を返し、
 * 続く `req.schema.parse` がほかのスキーマ不一致と同じく `ZodError` で落とす（黙って通さない）。
 */
export function unwrapRootValue(parsed: unknown): unknown {
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    return (parsed as Record<string, unknown>)[WRAPPED_ROOT_KEY];
  }
  return undefined;
}

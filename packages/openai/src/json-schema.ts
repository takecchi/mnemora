import type { z } from "zod";
import { needsRootWrap, toBaseJsonSchema, wrapRootSchema } from "./structured-root.js";

/** OpenAI の `response_format: { type: "json_schema", json_schema }` に入れる値。 */
export interface OpenAIJsonSchemaFormat {
  name: string;
  /** strict モードの制約を満たすように翻訳した JSON Schema。 */
  schema: Record<string, unknown>;
  /** 常に `true`（strict モードで送る）。 */
  strict: true;
}

type JsonSchemaNode = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonSchemaNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// strict は全キーを required にさせるため、「省略可能」は required から外さず値を null 許容にして表す。
// `const` / `enum` は `type` と独立に値を縛るので、`type` に "null" を足すだけでは null が弾かれる。
// `const` は `anyOf` に包み、`enum` は `enum` にも null を足す。
function makeNullable(node: JsonSchemaNode): JsonSchemaNode {
  if ("const" in node) {
    return { anyOf: [node, { type: "null" }] };
  }
  if (typeof node.type === "string") {
    return Array.isArray(node.enum)
      ? { ...node, type: [node.type, "null"], enum: [...(node.enum as unknown[]), null] }
      : { ...node, type: [node.type, "null"] };
  }
  if (Array.isArray(node.anyOf)) {
    return { ...node, anyOf: [...node.anyOf, { type: "null" }] };
  }
  return { anyOf: [node, { type: "null" }] };
}

// JSON Schema の全機能を網羅する変換ではない。core のスキーマが要求する範囲だけを扱う。
function hardenForStrictMode(node: unknown): unknown {
  if (!isPlainObject(node)) {
    return node;
  }

  const result: JsonSchemaNode = { ...node };

  if (result.type === "object" && isPlainObject(result.properties)) {
    const properties = result.properties as Record<string, unknown>;
    const originalRequired = new Set(
      Array.isArray(result.required) ? (result.required as string[]) : [],
    );
    const nextProperties: Record<string, unknown> = {};
    const nextRequired: string[] = [];
    for (const key of Object.keys(properties)) {
      const hardenedChild = hardenForStrictMode(properties[key]) as JsonSchemaNode;
      const wasRequired = originalRequired.has(key);
      nextProperties[key] = wasRequired ? hardenedChild : makeNullable(hardenedChild);
      nextRequired.push(key);
    }
    result.properties = nextProperties;
    result.required = nextRequired;
    result.additionalProperties = false;
  }

  if (result.type === "array" && result.items !== undefined) {
    result.items = hardenForStrictMode(result.items);
  }

  for (const combinator of ["anyOf", "oneOf", "allOf"] as const) {
    if (Array.isArray(result[combinator])) {
      result[combinator] = (result[combinator] as unknown[]).map(hardenForStrictMode);
    }
  }

  // `oneOf` を `anyOf` にする: OpenAI の strict は `oneOf` を受け付けない。判別可能ユニオンの枝は
  // 判別子で排他なので受ける値は変わらず、`req.schema.parse` が元のユニオンで検査する。
  if (Array.isArray(result.oneOf) && result.anyOf === undefined) {
    result.anyOf = result.oneOf;
    delete result.oneOf;
  }

  if (isPlainObject(result.$defs)) {
    const defs = result.$defs as Record<string, unknown>;
    const nextDefs: Record<string, unknown> = {};
    for (const key of Object.keys(defs)) {
      nextDefs[key] = hardenForStrictMode(defs[key]);
    }
    result.$defs = nextDefs;
  }

  return result;
}

/**
 * `StructuredRequest.schema` を OpenAI の `response_format.json_schema` の形へ翻訳する。
 * `strict` は常に `true`、`name` は渡された値がそのまま入る。zod が JSON Schema で表せない形
 * （`z.date()`・`transform` など）は、ここで投げる（`OpenAILLMProvider.completeStructured` が
 * `kind: "schema_unsupported"` に包む）。
 */
export function translateForOpenAIStructuredOutput<T>(
  name: string,
  schema: z.ZodType<T>,
): OpenAIJsonSchemaFormat {
  const base = toBaseJsonSchema(schema);
  const hardened = hardenForStrictMode(base) as JsonSchemaNode;
  delete hardened.$schema;
  return {
    name,
    schema: needsRootWrap(base) ? wrapRootSchema(hardened) : hardened,
    strict: true,
  };
}

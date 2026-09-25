import { z } from "zod";

/**
 * zod スキーマ → OpenAI Structured Output（`response_format: json_schema`, strict モード）への
 * 翻訳（docs/architecture.md §3.8）。**この翻訳がこのパッケージの本体である。**
 *
 * OpenAI の strict モードには JSON Schema の一般形にない制約が2つある:
 * 1. すべての object は `additionalProperties: false` を持たなければならない。
 * 2. すべての object は、`properties` に載っているキーを **全て** `required` に含めなければ
 *    ならない——「省略可能」は required から外すのではなく、**値を `null` にできる**ことで
 *    表現する（OpenAI の Structured Output ガイドが明記する回避策）。
 *
 * zod v4 の `z.toJSONSchema()` は (1) を既定で満たすが、(2) は満たさない
 * （zod の `.optional()` は素直に `required` から除外されるだけで、`null` を許容する
 * 型には変換されない）。この差分を埋めるのがこのモジュールの仕事であり、
 * **ここが壊れても擬似物（testkit の DeterministicLLMProvider）では気づけない**
 * ——だからこそ、翻訳結果そのものを検査する歯を専用に用意する（PR 本文参照）。
 */

export interface OpenAIJsonSchemaFormat {
  name: string;
  schema: Record<string, unknown>;
  strict: true;
}

type JsonSchemaNode = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonSchemaNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 「省略可能」だったフィールドの型を null 許容に変える。
 * - `type` が単一の文字列なら `[type, "null"]` の配列にする。
 * - 既に `anyOf` を持つ（zod の union 等）なら `{ type: "null" }` を選択肢に足す。
 * - それ以外（`enum` のみ等、type を持たない形）は `anyOf: [元のスキーマ, { type: "null" }]` に包む。
 *
 * ⚠ `enum` / `const` は `type` と独立に値を縛る。`type` に "null" を足しただけでは null が
 * `enum` / `const` で弾かれ、モデルは「省略」を表せない（任意の欄が実質必須に化ける）。
 * ⟹ `const` を持つ形は `anyOf` に包み、`enum` を持つ形は `enum` にも null を足す。
 */
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

/**
 * JSON Schema 木を再帰的に「強化」する。object を見つけるたびに、全プロパティを
 * `required` に含め、`additionalProperties: false` を強制する。配列・combinator
 * （`anyOf`/`oneOf`/`allOf`）・`$defs` の中も辿る。
 *
 * **確かめていないこと**: JSON Schema の全機能（`$ref` による外部循環参照、
 * `patternProperties` 等）を網羅した変換ではない。`extraction.ts` の
 * `ExtractionResultSchema`（object/array/string/number/enum の組み合わせ）が
 * 要求する範囲をカバーすることを目的にしたスコープであり、それ以上は
 * 確かめていない。
 */
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
 * `StructuredRequest.schema`（core の `z.ZodType<T>`）を OpenAI の
 * `response_format.json_schema` の形へ翻訳する。
 */
export function translateForOpenAIStructuredOutput<T>(
  name: string,
  schema: z.ZodType<T>,
): OpenAIJsonSchemaFormat {
  const base = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    unrepresentable: "any",
  }) as JsonSchemaNode;
  const hardened = hardenForStrictMode(base) as JsonSchemaNode;
  // `$schema` はメタ情報であり OpenAI 側は要求しない。翻訳結果を最小限にするため落とす。
  delete hardened.$schema;
  return { name, schema: hardened, strict: true };
}

import { z } from "zod";

// 根が object でないスキーマ（core の判別可能ユニオン等）は strict の Structured Outputs に直接送れないので、
// 欄 `WRAPPED_ROOT_KEY` を持つ object に包んで送り、返った JSON から取り出してから `req.schema.parse` に渡す。

export const WRAPPED_ROOT_KEY = "result";

type JsonSchemaNode = Record<string, unknown>;

// `unrepresentable: "any"` は渡さない: 渡すと `z.date()`・`.transform(...)` が型の無いスキーマ
// （何でも受ける）として静かに送られる。zod の既定の throw を、呼び出し元が `schema_unsupported` に包む。
export function toBaseJsonSchema(schema: z.ZodType<unknown>): JsonSchemaNode {
  return z.toJSONSchema(schema, {
    target: "draft-2020-12",
  }) as JsonSchemaNode;
}

export function needsRootWrap(base: JsonSchemaNode): boolean {
  return base.type !== "object";
}

// 根そのものを指す参照（`$ref: "#"`）は書き換えない: 根が再帰する union を包むと、
// 子の `$ref: "#"` は元の union ではなく包みの object を指す。`$defs` は参照先を変えないため根に残す。
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

/** 欄が無い・object でない応答は `undefined` を返し、続く `req.schema.parse` が `ZodError` で落とす。 */
export function unwrapRootValue(parsed: unknown): unknown {
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    return (parsed as Record<string, unknown>)[WRAPPED_ROOT_KEY];
  }
  return undefined;
}

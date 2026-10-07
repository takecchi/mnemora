import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { toJSONSchema } from "zod";
import type { z } from "zod";

// 自前で JSON Schema を作り直さない: 公式ヘルパ `zodOutputFormat` の変換をそのまま使う。
// `required` は元のまま通る（`.optional()` は optional のまま）ので、OpenAI 側の
// `hardenForStrictMode`・`stripNulls` に相当する処理は要らない。
// `enum`・`minLength` 等は SDK が `description` へ降格する。翻訳は直さず、`json-schema.test.ts` が実際の形を検査する。

/** `messages.create` の `output_config.format` に入れる値。 */
export interface AnthropicJsonSchemaFormat {
  /** 常に `"json_schema"`。 */
  type: "json_schema";
  /** `zodOutputFormat` が作った JSON Schema。 */
  schema: Record<string, unknown>;
}

/**
 * zod スキーマを Anthropic の構造化出力（`output_config.format`）へ翻訳する。
 *
 * 投げるもの: `z.record` を含むスキーマは、送る前に素の `Error`
 * （message は `z.record cannot be sent to Anthropic structured output: ...` で始まる）。
 * `z.tuple`・`z.date`・`transform` は `zodOutputFormat` 自身の例外がそのまま伝わる。
 */
export function translateForAnthropicStructuredOutput<T>(
  schema: z.ZodType<T>,
): AnthropicJsonSchemaFormat {
  assertNoRecord(schema);
  const format = zodOutputFormat(schema);
  // `parse`（関数）を落として純データにする: 送った内容を JSON として検査できるようにするため。
  return { type: "json_schema", schema: format.schema };
}

/**
 * `z.record` を含むスキーマを送る前に投げる（[ADR 0360](../../../docs/decisions/0360-schema-unsupported-thrown-before-send.md)
 * の 2026-09-30 追記）。
 *
 * 落とさないと、SDK が `additionalProperties: false` を強制して record の欄が例外無しで黙って空になる。
 * 走査は自前の再帰ではなく `z.toJSONSchema` の `override` フックに任せる（循環は zod が `$ref` で止める）。
 * `unrepresentable: "any"` は `z.tuple`・`z.date`・`transform` をここで投げないため
 * （後段の `zodOutputFormat` が落とす）。
 */
function assertNoRecord(schema: z.ZodType<unknown>): void {
  let found = false;
  toJSONSchema(schema, {
    unrepresentable: "any",
    cycles: "ref",
    reused: "ref",
    override: (ctx) => {
      if (ctx.zodSchema._zod.def.type === "record") found = true;
    },
  });
  if (found) {
    throw new Error(
      "z.record cannot be sent to Anthropic structured output: the translation forces additionalProperties: false, so the field would always be an empty object. Use an array of { key, value } instead.",
    );
  }
}

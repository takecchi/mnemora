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
 *
 * ⚠ **2026-09-29 追記（[Issue #1148](https://github.com/takecchi/mnemora/issues/1148)）:
 * `unrepresentable: "any"` は渡さない（zod の既定＝ throw）。** 以前はここで `"any"` を渡しており、
 * `z.date()`・`.transform(...)` のように JSON Schema で表現できない形が、型の無いスキーマ
 * （`{}`＝何でも受ける）として静かに送られていた。**いまは zod 自身が「Date cannot be
 * represented in JSON Schema」「Transforms cannot be represented in JSON Schema」で
 * ここで投げる**——呼び出し元（`OpenAILLMProvider.completeStructured`）がこれを
 * `OpenAILLMProviderError`（`kind: "schema_unsupported"`）に包み、`chat.completions.create`
 * を呼ぶ前に落とす。core の4スキーマ（抽出・claim key・統合・内省）はこの既定でも投げない
 * （`__tests__/core-schemas-send-shape.test.ts` で縛る）。
 */
export function toBaseJsonSchema(schema: z.ZodType<unknown>): JsonSchemaNode {
  return z.toJSONSchema(schema, {
    target: "draft-2020-12",
  }) as JsonSchemaNode;
}

/** 根が object でない（包んで送る）スキーマか。 */
export function needsRootWrap(base: JsonSchemaNode): boolean {
  return base.type !== "object";
}

/**
 * 強化済みのスキーマを、{@link WRAPPED_ROOT_KEY} だけを持つ object に包む。`$defs` は根に残す
 * （`#/$defs/...` の参照が指す先を変えないため）。
 *
 * ⚠ **根そのものを指す参照（`$ref: "#"`）は書き換えない**（今の振る舞い）。根が自分自身を再帰で含む
 * union（`z.lazy` で根の union を子に持つ形）を包むと、子の `$ref: "#"` は元の union ではなく**包みの object**
 * （`{ result: … }`）を指すようになり、送る形が元のスキーマと変わる。core の4つのスキーマはこの形を使わない。
 * 歯は `__tests__/structured-root-union.test.ts` の「根が再帰する union」。
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

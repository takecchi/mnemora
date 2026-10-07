import { z } from "zod";

/**
 * `attributes` のキーに自前の `__proto__` があれば、`ZodError`（既存のキー検査と同じ形: `invalid_key`・
 * `origin: "record"`・`path: [...pathPrefix, "__proto__"]`）で断る（ADR 0496）。
 *
 * `AttributesSchema` の中では断れない: zod の record は `__proto__` をキーの検査より前に読み飛ばす
 * ので、`JSON.parse` が作った自前の `__proto__` キーは schema 内で黙って落ちる。そのため
 * `Runtime.observe`・`runRecall` が zod の `parse` の前にこれを呼ぶ。`attributes` が省略・object
 * でない場合は何もしない（そちらは zod が断る）。
 *
 * 公開しない（`index.ts` から export しない）。message に入力値は入れない。
 */
export function assertNoProtoAttributesKey(
  attributes: unknown,
  pathPrefix: readonly string[] = ["attributes"],
): void {
  if (typeof attributes !== "object" || attributes === null) {
    return;
  }
  if (!Object.hasOwn(attributes, "__proto__")) {
    return;
  }
  throw new z.ZodError([
    {
      code: "invalid_key",
      origin: "record",
      issues: [
        {
          code: "custom",
          message: "attributes key must not be __proto__",
          input: "__proto__",
          path: [],
        },
      ],
      input: "__proto__",
      path: [...pathPrefix, "__proto__"],
      message: "Invalid key in record",
    },
  ]);
}

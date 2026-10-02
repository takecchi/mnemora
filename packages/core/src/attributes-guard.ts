import { z } from "zod";

/**
 * `attributes` のキーに自前の `__proto__` があれば、**`ZodError`**（既存のキー検査と同じ形: `invalid_key`・`origin: "record"`・
 * `path: [...pathPrefix, "__proto__"]`）で断る（ADR 0496、ADR 0472 材料1）。
 *
 * zod の record は `__proto__` を**キーの検査より前に**読み飛ばす（出力のオブジェクトの prototype を差し替えないため）。
 * そのため `AttributesSchema` の中では断れず、`JSON.parse` が作った自前の `__proto__` キーは黙って落ちていた
 * （`recall` の絞り込みが `{}` になって外れる・`observe` の属性が消える）。`Runtime.observe`・`runRecall` が、zod の `parse` の
 * **前**にこれを呼ぶ。`attributes` が省略・object でない場合は何もしない（そちらは zod が断る）。
 *
 * 公開しない（`index.ts` から export しない）。message に入力値は入れない（キー名は固定の `__proto__` だけ）。
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

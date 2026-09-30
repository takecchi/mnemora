import { expect } from "vitest";

/**
 * 適合テストが「保存の形で区別できない識別子を、入口で断る」ことを見るための入力と検査
 * （内部の道具。`index.ts` から export しない）。
 *
 * 断る対象は、孤立サロゲート（対をなさない UTF-16 のサロゲートコードユニット）と NUL（U+0000）を含む識別子。
 * 対をなすサロゲート（絵文字など）は識別子として受け付ける（`WELL_FORMED_NON_BMP_IDENTIFIER`）。
 */
export const MALFORMED_IDENTIFIER_CASES: ReadonlyArray<readonly [label: string, value: string]> = [
  ["孤立した上位サロゲート", "id-\uD800"],
  ["孤立した下位サロゲート", "id-\uDC00"],
  ["逆順に並んだサロゲート", "id-\uDC00\uD800"],
  ["後ろに文字が続く上位サロゲート", "id-\uD800x"],
  ["NUL", "id-\u0000"],
];

/** 対をなすサロゲートを含む（BMP の外の文字）。識別子として受け付ける。 */
export const WELL_FORMED_NON_BMP_IDENTIFIER = "id-\u{1F600}";

/** 例外の `kind`（ADR 0418 の作法。`instanceof` を使わない）。 */
export const MALFORMED_IDENTIFIER_KIND = "malformed_identifier";

/** `promise` が reject し、その例外が `kind: "malformed_identifier"` で、message に入力値を含まないこと。 */
export async function expectMalformedIdentifierRejection(
  promise: PromiseLike<unknown>,
  label: string,
  value: string,
): Promise<void> {
  let settled = false;
  let reason: unknown;
  try {
    await promise;
    settled = true;
  } catch (error) {
    reason = error;
  }
  expect(settled, `${label}: reject するはずが、通った`).toBe(false);
  const { kind, message } = (reason ?? {}) as { kind?: unknown; message?: unknown };
  expect(kind, `${label}: kind（message=${String(message).slice(0, 120)}）`).toBe(
    MALFORMED_IDENTIFIER_KIND,
  );
  expect(String(message)).not.toContain(value);
}

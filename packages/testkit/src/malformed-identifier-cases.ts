import { expect } from "vitest";

/** 孤立サロゲートと NUL（U+0000）を含む識別子。対をなすサロゲートは受け付ける。内部の道具で、`index.ts` から出さない。 */
export const MALFORMED_IDENTIFIER_CASES: ReadonlyArray<readonly [label: string, value: string]> = [
  ["孤立した上位サロゲート", "id-\uD800"],
  ["孤立した下位サロゲート", "id-\uDC00"],
  ["逆順に並んだサロゲート", "id-\uDC00\uD800"],
  ["後ろに文字が続く上位サロゲート", "id-\uD800x"],
  ["NUL", "id-\u0000"],
];

/** 対をなすサロゲートを含む（BMP の外の文字）。識別子として受け付ける。 */
export const WELL_FORMED_NON_BMP_IDENTIFIER = "id-\u{1F600}";

/** 例外の `kind`。`instanceof` を使わない。 */
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

import { expect } from "vitest";

/**
 * 適合テストが core の公開エラーを見分けるための道具（ADR 0418 の追記）。
 *
 * 🔴 **`toBeInstanceOf(クラス)` / `toThrow(クラス)` を使わない理由。** 中身は `instanceof` である。
 * 利用者の手元で `@mnemora/core` が2つの版に分かれると、adapter が投げる例外のクラスは適合テストが
 * import したクラスとは別物になり、正しい adapter でも false になる（誤って赤になる）。
 * core が公開する判定関数（`isMemoryStatusConflictError` など。「`kind`、無ければ `name`」）で見る。
 *
 * ⚠ 公開しない（`index.ts` から export しない）。適合テストの内部の道具である。
 */

function describeThrown(value: unknown): string {
  if (typeof value !== "object" || value === null) {
    return `${typeof value}: ${String(value)}`;
  }
  const { name, kind, message } = value as { name?: unknown; kind?: unknown; message?: unknown };
  return `name=${String(name)} kind=${String(kind)} message=${String(message)}`;
}

/** `value` が判定関数を通ることを確かめ、その型で返す。通らなければ、何が来たかを添えて落ちる。 */
export function expectStoreError<T>(
  value: unknown,
  guard: (value: unknown) => value is T,
  label: string,
): T {
  expect(guard(value), `${label} のはずが: ${describeThrown(value)}`).toBe(true);
  return value as T;
}

/** `promise` が reject し、その理由が判定関数を通ることを確かめ、その型で返す。 */
export async function expectRejectsWithStoreError<T>(
  promise: PromiseLike<unknown>,
  guard: (value: unknown) => value is T,
  label: string,
): Promise<T> {
  let settled = false;
  let reason: unknown;
  try {
    await promise;
    settled = true;
  } catch (error) {
    reason = error;
  }
  expect(settled, `${label} を投げるはずが、reject しなかった`).toBe(false);
  return expectStoreError(reason, guard, label);
}

/** `promise` が reject し、その理由が判定関数を通らないこと（別の失敗であること）を確かめる。 */
export async function expectRejectsWithoutStoreError(
  promise: PromiseLike<unknown>,
  guard: (value: unknown) => boolean,
  label: string,
): Promise<void> {
  let settled = false;
  let reason: unknown;
  try {
    await promise;
    settled = true;
  } catch (error) {
    reason = error;
  }
  expect(settled, "reject するはずが、reject しなかった").toBe(false);
  expect(guard(reason), `${label} ではないはずが: ${describeThrown(reason)}`).toBe(false);
}

import { expect } from "vitest";

/*
 * `toBeInstanceOf(クラス)` / `toThrow(クラス)` を使わない: `@mnemora/core` が2つの版に分かれると
 * 例外のクラスが別物になり、正しい adapter でも誤って赤になる。core の判定関数（`kind`、無ければ `name`）で見る。
 * 公開しない（適合テストの内部の道具）。
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

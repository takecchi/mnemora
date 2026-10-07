/**
 * `target[key] = value` ではなく自分自身の欄として足す。代入だと `key` が `"__proto__"` のとき
 * プロトタイプの差し替えになり、応答の値が zod に継承された値として読まれる（ADR 0468）。
 */
export function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

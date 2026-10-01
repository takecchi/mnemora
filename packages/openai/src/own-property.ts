/** 内部のモジュール（`index.ts` からは出さない）。 */

/**
 * `target[key] = value` の代わり。**`key` が `"__proto__"` でも、代入ではなく自分自身の欄として足す**
 * （ADR 0468）。
 *
 * `JSON.parse` は `"__proto__"` を普通の欄（自分自身のプロパティ）として作る。それを `result[key] = ...` で
 * 別の object へ写すと、欄ではなく**その object のプロトタイプの差し替え**になり、応答の
 * `{"__proto__": {"subjectId": "x"}}` が、zod の `object` に**継承された値として読まれる**
 * （`@mnemora/anthropic` は `JSON.parse` の結果をそのまま zod に渡すので、同じ応答の `__proto__` は無視される）。
 * strict モードが守られていれば応答に余分な欄は無いが、`client` に差す OpenAI 互換のサーバが strict を守る保証は無い。
 */
export function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

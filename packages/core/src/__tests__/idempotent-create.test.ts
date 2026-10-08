import { describe, expect, it, vi } from "vitest";
import { resolveIdempotentCreate } from "../idempotent-create.js";

// 公開の TSDoc は `existing` を「無ければ `null`/`undefined`」とし、`insert` を「既存が無いときだけ呼ばれる」とする。
// 擬似実装の呼び手は `undefined` しか渡さないので、関数を直接呼んで残りの入力を見る。

describe("resolveIdempotentCreate", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
  ])(
    "existing が %s なら insert を1回だけ呼び、その値を created: true で返す",
    (_label, existing) => {
      const insert = vi.fn(() => ({ id: "new" }));
      const result = resolveIdempotentCreate<{ id: string }>(existing, insert);
      expect(insert).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ value: { id: "new" }, created: true });
    },
  );

  it("existing が在れば insert を呼ばず、既存の値を created: false で返す", () => {
    const existing = { id: "old" };
    const insert = vi.fn(() => ({ id: "new" }));
    const result = resolveIdempotentCreate(existing, insert);
    expect(insert).not.toHaveBeenCalled();
    expect(result.value).toBe(existing);
    expect(result.created).toBe(false);
  });

  it.each([
    ["0", 0],
    ["空文字", ""],
    ["false", false],
    ["NaN", Number.NaN],
  ])(
    "falsy でも null/undefined でない既存（%s）は在る扱いで、insert を呼ばない",
    (_label, existing) => {
      const insert = vi.fn(() => existing);
      const result = resolveIdempotentCreate<unknown>(existing, insert);
      expect(insert).not.toHaveBeenCalled();
      expect(result.value).toBe(existing);
      expect(result.created).toBe(false);
    },
  );
});

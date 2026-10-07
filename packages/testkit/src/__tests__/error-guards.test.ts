import { describe, expect, it } from "vitest";
import {
  expectRejectsWithoutStoreError,
  expectRejectsWithStoreError,
  expectStoreError,
} from "../error-guards.js";

class Boom extends Error {
  readonly kind = "boom" as const;
}
const isBoom = (value: unknown): value is Boom => value instanceof Boom && value.kind === "boom";

describe("expectStoreError（Issue #1734 / PR #1514 のすり抜け）", () => {
  it("判定関数を通る値は、そのまま返す", () => {
    const boom = new Boom("x");
    expect(expectStoreError(boom, isBoom, "Boom")).toBe(boom);
  });

  it.each([
    ["別の Error", new Error("other")],
    ["文字列", "boom"],
    ["undefined", undefined],
    ["null", null],
  ])("判定関数を通らない値（%s）では落ちる", (_label, value) => {
    expect(() => expectStoreError(value, isBoom, "Boom")).toThrow(/Boom のはずが/);
  });
});

describe("expectRejectsWithStoreError", () => {
  it("判定関数を通る理由で reject すれば、その理由を返す", async () => {
    const boom = new Boom("x");
    await expect(expectRejectsWithStoreError(Promise.reject(boom), isBoom, "Boom")).resolves.toBe(
      boom,
    );
  });

  it("別の理由で reject したら落ちる", async () => {
    await expect(
      expectRejectsWithStoreError(Promise.reject(new Error("other")), isBoom, "Boom"),
    ).rejects.toThrow(/Boom のはずが/);
  });

  it("reject しなければ落ちる", async () => {
    await expect(expectRejectsWithStoreError(Promise.resolve(1), isBoom, "Boom")).rejects.toThrow(
      /reject しなかった/,
    );
  });
});

describe("expectRejectsWithoutStoreError", () => {
  it("判定関数を通らない理由で reject すれば通る（別の失敗であることの確認）", async () => {
    await expect(
      expectRejectsWithoutStoreError(Promise.reject(new Error("other")), isBoom, "Boom"),
    ).resolves.toBeUndefined();
  });

  it("判定関数を通る理由で reject したら落ちる（別の失敗のはずが、その例外だった）", async () => {
    await expect(
      expectRejectsWithoutStoreError(Promise.reject(new Boom("x")), isBoom, "Boom"),
    ).rejects.toThrow(/Boom ではないはずが/);
  });

  it("reject しなければ落ちる", async () => {
    await expect(
      expectRejectsWithoutStoreError(Promise.resolve(1), isBoom, "Boom"),
    ).rejects.toThrow(/reject しなかった/);
  });
});

import { describe, expect, it } from "vitest";
import {
  expectRejectsWithoutStoreError,
  expectRejectsWithStoreError,
  expectStoreError,
} from "../error-guards.js";

/**
 * Issue #1734（2026-09-30 マージ分の確かめ直し）の歯。PR #1514（ADR 0418 の続き）の変異試験で、
 * 適合テストの道具 `error-guards.ts` が判定関数の結果を見ない（常に通す）変異が、`expectStoreError`・
 * `expectRejectsWithoutStoreError` の両方ですり抜けた。担当はクローン（miku）の判断で進めている作業であり、
 * オーナーの判断ではない。
 *
 * 既存の歯（`foreign-realm-conformance.test.ts`）は、**正しい**例外が別 realm でも通ることだけを見る。
 * 道具自身が「別の例外を落とす」ことを、間違った例外で確かめる歯が無かった。道具が壊れると、すべての
 * 適合テストの「正しい例外を投げる」検査が静かに緑になる（Postgres の適合テストも同じ道具を通る）。
 * この歯は道具そのものを、通る例外・通らない例外の両方で縛る。`error-guards.ts` は公開しない内部の道具なので、
 * 公開の適合テスト（`*-conformance.ts`）には触れない。
 */

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

import { describe, expect, it } from "vitest";
import {
  MALFORMED_IDENTIFIER_CASES,
  MALFORMED_IDENTIFIER_KIND,
  WELL_FORMED_NON_BMP_IDENTIFIER,
  expectMalformedIdentifierRejection,
} from "../malformed-identifier-cases.js";

/**
 * 適合テストの各 suite が使う道具そのものの歯。道具が緩むと、suite が adapter の穴を見逃しても緑のままになる。
 */
describe("expectMalformedIdentifierRejection: 道具そのものが約束どおりに判定する", () => {
  const value = "id-\uD800";

  it("message に入力値を含む例外なら、道具が落ちる", async () => {
    const leaking = Promise.reject({
      kind: MALFORMED_IDENTIFIER_KIND,
      message: `壊れた識別子: ${value}`,
    });
    await expect(
      expectMalformedIdentifierRejection(leaking, "漏らす実装", value),
    ).rejects.toThrow();
  });

  it("Error のインスタンスでない例外でも、kind が合っていて message に入力値を含まなければ通す（instanceof を使わない）", async () => {
    const plain = Promise.reject({ kind: MALFORMED_IDENTIFIER_KIND, message: "壊れた識別子" });
    await expect(
      expectMalformedIdentifierRejection(plain, "素のオブジェクト", value),
    ).resolves.toBeUndefined();
  });

  it("kind が malformed_identifier でない例外なら、message に入力値を含まなくても、道具が落ちる", async () => {
    const otherKind = Promise.reject({ kind: "invalid_argument", message: "壊れた識別子" });
    await expect(
      expectMalformedIdentifierRejection(otherKind, "別の kind", value),
    ).rejects.toThrow();
  });

  it('kind の値そのものは、文字列 "malformed_identifier" である（定数の値が変わっても、この値で縛る）', async () => {
    const literal = Promise.reject({ kind: "malformed_identifier", message: "壊れた識別子" });
    await expect(
      expectMalformedIdentifierRejection(literal, "文字列の kind", value),
    ).resolves.toBeUndefined();
  });

  it("reject しなければ、道具が落ちる", async () => {
    await expect(
      expectMalformedIdentifierRejection(Promise.resolve("ok"), "通す実装", value),
    ).rejects.toThrow();
  });
});

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("MALFORMED_IDENTIFIER_CASES: 孤立サロゲートと NUL の例をそろえて持つ", () => {
  const values = MALFORMED_IDENTIFIER_CASES.map(([, v]) => v);

  it("孤立した上位・下位サロゲート、逆順のサロゲート、NUL の例を、どれも落とさずに持つ", () => {
    expect(values).toEqual(
      expect.arrayContaining(["id-\uD800", "id-\uDC00", "id-\uDC00\uD800", "id-\u0000"]),
    );
  });

  it("どの例も、孤立サロゲートか NUL を含む", () => {
    for (const v of values) {
      expect(LONE_SURROGATE.test(v) || v.includes("\u0000"), JSON.stringify(v)).toBe(true);
    }
  });

  it("受け付ける側の例は、対をなすサロゲートを含み、孤立サロゲートも NUL も含まない", () => {
    expect(LONE_SURROGATE.test(WELL_FORMED_NON_BMP_IDENTIFIER)).toBe(false);
    expect(WELL_FORMED_NON_BMP_IDENTIFIER).not.toContain("\u0000");
    expect(WELL_FORMED_NON_BMP_IDENTIFIER.length).toBeGreaterThan(
      [...WELL_FORMED_NON_BMP_IDENTIFIER].length,
    );
  });
});

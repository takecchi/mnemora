/**
 * `workflow-name-comment-lib.mjs` の冒頭コメントが書いている境界のうち、
 * `workflow-name-comment-lib.test.mjs` の入力に無い形を押さえる。
 * - コメントを始める空白は半角スペースとタブだけ（全角空白は含めない）。
 * - 同じ行で閉じていない引用符は unhandled（逃がした引用符を閉じとして数えない）。
 */

import { describe, expect, it } from "vitest";
import { classifyNameValue, findNameDeclarations } from "../workflow-name-comment-lib.mjs";

describe("コメントを始める空白は、半角スペースとタブだけ", () => {
  it("タブの直後の # は、値を切る", () => {
    const result = classifyNameValue("値を残す\t#136");
    expect(result.status).toBe("truncated");
    expect(result.kept).toBe("値を残す");
  });

  it("⛔ 全角空白の直後の # は、値を切らない（全角空白は YAML の空白ではない）", () => {
    expect(classifyNameValue("値を残す　#136").status).toBe("safe");
  });

  it("切れる位置 `cutAt` は、値の中の # の位置を指す", () => {
    const value = "値を残す #136";
    expect(classifyNameValue(value).cutAt).toBe(value.indexOf("#"));
  });
});

describe("逃がした引用符は、閉じの引用符として数えない", () => {
  it('二重引用符: 末尾が \\" で終わる値は、同じ行で閉じていない', () => {
    const result = classifyNameValue('"値を残す \\" #1');
    expect(result.status).toBe("unhandled");
    expect(result.reason).toBe("quoted-not-closed-on-same-line");
  });

  it("単一引用符: 末尾が '' で終わる値は、同じ行で閉じていない", () => {
    const result = classifyNameValue("'値を残す '' #1");
    expect(result.status).toBe("unhandled");
    expect(result.reason).toBe("quoted-not-closed-on-same-line");
  });
});

describe("findNameDeclarations の行番号", () => {
  it("`lineNumber` は 1 始まり（エラーメッセージがそのまま指す行）", () => {
    const yaml = [
      "jobs:",
      "  a:",
      "    name: 一つ目",
      "    steps:",
      "      - name: 二つ目",
      "",
    ].join("\n");
    expect(findNameDeclarations(yaml).map((d) => d.lineNumber)).toEqual([3, 5]);
  });
});

/**
 * `isReleasedHeading` は「日付で終わる」見出しだけを true にする。
 * 日付の後ろに何かが続く見出しは、日付を含んでいても released と読まない。
 */

import { describe, expect, it } from "vitest";
import { isReleasedHeading } from "../release-changelog-gate-lib.mjs";

describe("⭐ 日付の後ろに語が続く見出しは released ではない", () => {
  it.each([
    "## [1.4.0] - 2026-10-09 未リリース",
    "## [1.4.0] - 2026-10-09 (draft)",
    "## [1.4.0] - 2026-10-09-rc",
  ])("%s は false", (line) => {
    expect(isReleasedHeading(line)).toBe(false);
  });

  it("日付の後ろが空白だけなら released のまま", () => {
    expect(isReleasedHeading("## [1.4.0] - 2026-10-09 \t")).toBe(true);
  });
});

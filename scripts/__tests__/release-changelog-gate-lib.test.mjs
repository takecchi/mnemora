import { describe, expect, it } from "vitest";
import { isReleasedHeading } from "../release-changelog-gate-lib.mjs";

describe("⭐ `isReleasedHeading` は日付で終わる見出しだけを true にする（肯定形の述語）", () => {
  it("released の形（`- YYYY-MM-DD`）は true", () => {
    expect(isReleasedHeading("## [0.5.0] - 2026-09-21")).toBe(true);
    expect(isReleasedHeading("## [1.0.0] - 2026-09-23")).toBe(true);
    expect(isReleasedHeading("## [0.5.0] - 2026-09-21  ")).toBe(true);
  });

  it("🔴 未リリース節・日付の無い見出し・空・null は false", () => {
    for (const line of ["## [1.0.0] - 未リリース", "## [1.0.0]", "## [1.0.0] - TBD", "", null]) {
      expect(isReleasedHeading(line), `${String(line)} は false のはず`).toBe(false);
    }
  });

  it("⭐ 肯定形であることの意味 —— 日付*以外*で終わる見出しは、言葉が何であれ false になる", () => {
    // 否定形（「`- 未リリース` で終わらない」）にしない。別の言葉の未リリース節が黙って true に倒れる。
    for (const line of [
      "## [1.0.0] - Unreleased",
      "## [1.0.0] - 未定",
      "## [1.0.0] - 2026-09",
      "## [1.0.0] - 2026/09/23",
    ]) {
      expect(isReleasedHeading(line), `${line} は false のはず`).toBe(false);
    }
  });
});

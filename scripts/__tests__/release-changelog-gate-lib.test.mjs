import { describe, expect, it } from "vitest";
import { isReleasedHeading } from "../release-changelog-gate-lib.mjs";

/**
 * ⭐ **この歯が測っているもの（消す前に読むこと）**
 *
 * **`isReleasedHeading` が、released の節の見出しだけを true にすること。**
 *
 * 🔴 **この歯は 2026-09-23 に大きく削られている。**
 * **それまでは `decideReleaseChangelogGate`（`npm publish` を止める門の判定）を測る歯が
 * 大半を占めていた**（[ADR 0252](../../docs/decisions/0252-release-changelog-section-is-a-publish-gate.md)）。
 * ⟹ **その門はオーナーの判断で撤回され、判定の関数ごと消えた**
 * （[ADR 0267](../../docs/decisions/0267-withdraw-the-release-changelog-publish-gate.md)）。
 * ⟹ **測る対象が無くなったので、その分の歯を落とした。**
 * ⛔ **歯が「通らなくなったから」落としたのではない。対象が消えたからである。**
 *
 * ⚠ **`isReleasedHeading` だけが残るのは、門の持ち物ではなかったからである。**
 * `scripts/__tests__/changelog-released-heading-format.test.mjs` が
 * **現物の `CHANGELOG.md`** に当てて使っており、そちらは publish を止める話とは独立に効く。
 * ⟹ **こちらは入力を自分で作って述語そのものを測る**（あちらの重複ではない）。
 */
describe("⭐ `isReleasedHeading` は日付で終わる見出しだけを true にする（肯定形の述語）", () => {
  it("released の形（`- YYYY-MM-DD`）は true", () => {
    expect(isReleasedHeading("## [0.5.0] - 2026-09-21")).toBe(true);
    expect(isReleasedHeading("## [1.0.0] - 2026-09-23")).toBe(true);
    // 行末の空白は許す（現物の CHANGELOG.md が持ちうる形）。
    expect(isReleasedHeading("## [0.5.0] - 2026-09-21  ")).toBe(true);
  });

  it("🔴 未リリース節・日付の無い見出し・空・null は false", () => {
    for (const line of ["## [1.0.0] - 未リリース", "## [1.0.0]", "## [1.0.0] - TBD", "", null]) {
      expect(isReleasedHeading(line), `${String(line)} は false のはず`).toBe(false);
    }
  });

  it("⭐ 肯定形であることの意味 —— 日付*以外*で終わる見出しは、言葉が何であれ false になる", () => {
    /**
     * ⚠ **「`- 未リリース` で終わらないこと」という否定形にしなかった理由の歯である。**
     * 否定形だと、未リリース節を別の言葉（`- TBD` / `- Unreleased`）で書いた瞬間に
     * **黙って true 側へ倒れる。**⟹ 肯定形なら、知らない言葉はすべて false に倒れる。
     */
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

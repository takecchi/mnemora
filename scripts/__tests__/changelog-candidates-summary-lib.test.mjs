import { describe, expect, it } from "vitest";
import {
  computeChangelogCandidates,
  computeUnreleasedSectionAddition,
  findUnreleasedSectionRange,
  formatChangelogCandidatesSummary,
  parseAddedLineNumbers,
} from "../changelog-candidates-summary-lib.mjs";

/**
 * `scripts/changelog-candidates-summary-lib.mjs`（Issue #433 方向B2 の純関数の側）の歯。
 *
 * ⚠ このファイルは `git` を1度も呼ばない。差分は合成した unified diff テキストで表現する
 * ——`release-candidates-lib.test.mjs` が commit を合成するのと同じ役割分担。CLI がこれを
 * 正しく配線しているかは `changelog-candidates-summary.test.mjs`（実プロセス）が見る。
 */

describe("findUnreleasedSectionRange", () => {
  it("`## [x.y.z] - 未リリース` の見出しから、次の `## [` 見出しの直前までを範囲にする", () => {
    const changelog = [
      "# Changelog",
      "",
      "## [1.1.0] - 未リリース",
      "",
      "### Added",
      "- foo",
      "",
      "## [1.0.0] - 2026-09-23",
      "",
      "### Added",
      "- bar",
    ].join("\n");
    const range = findUnreleasedSectionRange(changelog);
    expect(range.found).toBe(true);
    expect(range.startLine).toBe(3);
    expect(range.endLine).toBe(7);
  });

  it("最後の節が未リリース節なら、ファイル末尾までを範囲にする", () => {
    const changelog = ["# Changelog", "", "## [1.1.0] - 未リリース", "", "### Added", "- foo"].join(
      "\n",
    );
    const range = findUnreleasedSectionRange(changelog);
    expect(range.found).toBe(true);
    expect(range.startLine).toBe(3);
    expect(range.endLine).toBe(6);
  });

  it("🔴 未リリース節が無ければ found=false（例外にしない）— 【実測 2026-09-24】v1.0.0 直後の origin/main と同じ形", () => {
    const changelog = ["# Changelog", "", "## [1.0.0] - 2026-09-23", "", "### Added"].join("\n");
    const range = findUnreleasedSectionRange(changelog);
    expect(range.found).toBe(false);
    expect(range.startLine).toBeNull();
    expect(range.endLine).toBeNull();
  });

  it("空文字列・見出しが無い本文でも例外にならない", () => {
    expect(findUnreleasedSectionRange("").found).toBe(false);
    expect(findUnreleasedSectionRange("何の見出しも無い本文").found).toBe(false);
  });
});

describe("parseAddedLineNumbers", () => {
  it("`--unified=0` の1ハンクから、追加された行の新ファイル側行番号を読み取る", () => {
    const diff = [
      "diff --git a/CHANGELOG.md b/CHANGELOG.md",
      "index 111..222 100644",
      "--- a/CHANGELOG.md",
      "+++ b/CHANGELOG.md",
      "@@ -4,0 +5,2 @@",
      "+- foo (#1)",
      "+- bar (#2)",
    ].join("\n");
    expect(parseAddedLineNumbers(diff)).toEqual([5, 6]);
  });

  it("複数ハンクを正しく分けて読む", () => {
    const diff = ["@@ -2,0 +3 @@", "+- foo", "@@ -10,0 +12 @@", "+- bar", "+- baz"].join("\n");
    expect(parseAddedLineNumbers(diff)).toEqual([3, 12, 13]);
  });

  it("削除だけのハンクは追加行を返さない", () => {
    const diff = ["@@ -4,2 +4,0 @@", "-- foo", "-- bar"].join("\n");
    expect(parseAddedLineNumbers(diff)).toEqual([]);
  });

  it("context 行（先頭が半角スペース）でも新ファイル側の行番号を正しく進める", () => {
    const diff = ["@@ -3,2 +3,3 @@", " context line", "+added line", " another context"].join("\n");
    // 3行目は context、4行目が追加、5行目が次の context
    expect(parseAddedLineNumbers(diff)).toEqual([4]);
  });

  it("空文字列・ハンクを持たない diff は空配列（例外にしない）", () => {
    expect(parseAddedLineNumbers("")).toEqual([]);
    expect(parseAddedLineNumbers("diff --git a/x b/x\nindex 1..2 100644\n")).toEqual([]);
  });
});

describe("computeUnreleasedSectionAddition", () => {
  const changelogWithUnreleased = [
    "# Changelog",
    "",
    "## [1.1.0] - 未リリース",
    "",
    "### Added",
    "- foo",
    "",
    "## [1.0.0] - 2026-09-23",
  ].join("\n");

  it("追加された行が未リリース節の範囲内にあれば added=true", () => {
    const diff = ["@@ -4,0 +6 @@", "+- foo (#1)"].join("\n");
    const result = computeUnreleasedSectionAddition({
      changelogText: changelogWithUnreleased,
      diffText: diff,
    });
    expect(result.sectionFound).toBe(true);
    expect(result.added).toBe(true);
  });

  it("追加された行が未リリース節の外（released 節側）にあれば added=false", () => {
    const diff = ["@@ -8,0 +9 @@", "+補足を足しただけ"].join("\n");
    const result = computeUnreleasedSectionAddition({
      changelogText: changelogWithUnreleased,
      diffText: diff,
    });
    expect(result.sectionFound).toBe(true);
    expect(result.added).toBe(false);
  });

  it("未リリース節が無ければ sectionFound=false・added=false", () => {
    const result = computeUnreleasedSectionAddition({
      changelogText: "## [1.0.0] - 2026-09-23",
      diffText: "@@ -1,0 +2 @@\n+何か",
    });
    expect(result.sectionFound).toBe(false);
    expect(result.added).toBe(false);
  });
});

describe("computeChangelogCandidates", () => {
  it("⭐ 歯1: packages/*/src を触り、未リリース節に追加行が無い差分 → 候補が出る（触ったファイルが列挙される）", () => {
    const result = computeChangelogCandidates({
      touchedFiles: ["packages/core/src/recall.ts", "packages/core/src/__tests__/recall.test.ts"],
      changelogText: [
        "## [1.1.0] - 未リリース",
        "",
        "### Added",
        "",
        "## [1.0.0] - 2026-09-23",
      ].join("\n"),
      changelogDiffText: "", // CHANGELOG.md 自体を触っていない
    });
    expect(result.hasCandidates).toBe(true);
    // __tests__ 配下は isPackageSrcPath が除外するので、候補に出ない
    expect(result.srcFiles).toEqual(["packages/core/src/recall.ts"]);
    expect(result.sectionFound).toBe(true);
  });

  it("⭐ 歯2（陽性対照）: docs だけの差分 → 候補は出ない", () => {
    const result = computeChangelogCandidates({
      touchedFiles: ["docs/recall.md", "README.md"],
      changelogText: "## [1.1.0] - 未リリース\n\n## [1.0.0] - 2026-09-23",
      changelogDiffText: "",
    });
    expect(result.hasCandidates).toBe(false);
    expect(result.srcFiles).toEqual([]);
  });

  it("⭐ 歯3: packages/*/src を触り、未リリース節にも行を足した差分 → 候補は出ない", () => {
    const changelogText = [
      "## [1.1.0] - 未リリース",
      "",
      "### Added",
      "- recall() の挙動を直した (#999)",
      "",
      "## [1.0.0] - 2026-09-23",
    ].join("\n");
    const diffText = ["@@ -3,0 +4 @@", "+- recall() の挙動を直した (#999)"].join("\n");
    const result = computeChangelogCandidates({
      touchedFiles: ["packages/core/src/recall.ts", "CHANGELOG.md"],
      changelogText,
      changelogDiffText: diffText,
    });
    expect(result.hasCandidates).toBe(false);
    expect(result.srcFiles).toEqual(["packages/core/src/recall.ts"]);
  });

  it("src を1件も触っていなければ CHANGELOG.md を読みにも行かず候補なし", () => {
    const result = computeChangelogCandidates({
      touchedFiles: ["packages/core/README.md"],
      changelogText: "",
      changelogDiffText: "",
    });
    expect(result.hasCandidates).toBe(false);
    expect(result.sectionFound).toBeNull();
  });

  it("🔴 未リリース節が無いときは、srcFiles が在れば候補として出るが sectionFound=false を持つ", () => {
    const result = computeChangelogCandidates({
      touchedFiles: ["packages/core/src/recall.ts"],
      changelogText: "## [1.0.0] - 2026-09-23",
      changelogDiffText: "",
    });
    expect(result.hasCandidates).toBe(true);
    expect(result.sectionFound).toBe(false);
  });
});

describe("formatChangelogCandidatesSummary", () => {
  it("候補が無いときは1行で黙る（ADR 0088 §3 の作法）", () => {
    const text = formatChangelogCandidatesSummary({ hasCandidates: false, srcFiles: [] });
    const bodyLines = text.split("\n").filter((line) => line.trim().length > 0);
    // ヘッダ1行 + 本文1行の2行のみ（見出しと空行を除いた「本文」が1行）
    expect(bodyLines).toHaveLength(2);
    expect(text).toContain("🟢");
  });

  it("候補が在るときは、触ったファイルを列挙し『判定ではない』と名乗る", () => {
    const text = formatChangelogCandidatesSummary({
      hasCandidates: true,
      srcFiles: ["packages/core/src/recall.ts", "packages/core/src/observation.ts"],
      sectionFound: true,
    });
    expect(text).toContain("packages/core/src/recall.ts");
    expect(text).toContain("packages/core/src/observation.ts");
    expect(text).toContain("判定ではない");
    expect(text).toContain("Issue #433");
  });

  it("未リリース節が見つからなかったときは、その旨を明記する", () => {
    const text = formatChangelogCandidatesSummary({
      hasCandidates: true,
      srcFiles: ["packages/core/src/recall.ts"],
      sectionFound: false,
    });
    expect(text).toContain("未リリース");
    expect(text).toContain("見つからなかった");
  });
});

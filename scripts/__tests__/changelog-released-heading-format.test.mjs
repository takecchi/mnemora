import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isReleasedHeading } from "../release-changelog-gate-lib.mjs";

/** 見るのは見出しの形だけ。節の中身・日付の実在・未リリース節が1つだけであることは要求しない（数を焼き込まない）。 */

const changelogPath = fileURLToPath(new URL("../../CHANGELOG.md", import.meta.url));
const changelog = readFileSync(changelogPath, "utf8");

const versionHeadings = changelog.split("\n").filter((line) => /^##\s+\[[^\]]+\]/.test(line));

describe("🔴 門が前提にしている CHANGELOG.md の見出しの形（ADR 0252）", () => {
  it("版の見出しが1本も無い、ということは無い", () => {
    expect(versionHeadings.length).toBeGreaterThan(0);
  });

  it("⭐ 各見出しは『released（`- YYYY-MM-DD`）』か『未リリース』のどちらかである", () => {
    const unknown = versionHeadings.filter(
      (line) => !isReleasedHeading(line) && !line.includes("未リリース"),
    );
    expect(
      unknown,
      "どちらとも読めない見出しが在る。門の前提が崩れている——" +
        "見出しの形を戻すか、`release-changelog-gate-lib.mjs` の述語のほうを直すこと（歯を消さないこと）。",
    ).toEqual([]);
  });

  it("🔴 released と読める見出しが少なくとも1本は在る（述語が誰にも当たらない形になっていない）", () => {
    expect(versionHeadings.some((line) => isReleasedHeading(line))).toBe(true);
  });

  it("🔴 同じ版の見出しが2本在る、ということは無い（起こし損ねの検出）", () => {
    const seen = new Map();
    for (const line of versionHeadings) {
      const version = line.match(/^##\s+\[([^\]]+)\]/)[1];
      seen.set(version, (seen.get(version) ?? 0) + 1);
    }
    const duplicated = [...seen.entries()].filter(([, n]) => n > 1).map(([v]) => v);
    expect(
      duplicated,
      "同じ版の見出しが2本在る。未リリース節を『起こす』のではなく『足して』いないか確かめること" +
        "——並びによっては publish の門が通ってしまう。",
    ).toEqual([]);
  });

  it("⚠ 『未リリース』と名乗る見出しは、released の形をしていない（両方に読めない）", () => {
    const both = versionHeadings.filter(
      (line) => line.includes("未リリース") && isReleasedHeading(line),
    );
    expect(both).toEqual([]);
  });
});

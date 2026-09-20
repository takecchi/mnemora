import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isReleasedHeading } from "../release-changelog-gate-lib.mjs";

/**
 * ⭐ **この歯が測っているもの（消す前に読むこと）**
 *
 * **`npm publish` の門（[ADR 0252](../../docs/decisions/0252-release-changelog-section-is-a-publish-gate.md)）が
 * 前提にしている「`CHANGELOG.md` の見出しの形」が、現物で保たれていること。**
 *
 * 🔴 **なぜ要るか**
 *
 * 門の述語は「出す版の見出しが `- YYYY-MM-DD` で終わること」である。
 * ⟹ **`CHANGELOG.md` が別の書き方へ変わると、門は「released の節が無い」と言い続けるか、
 * あるいは逆に未リリース節を released と読む。**どちらも**門の前提が黙って崩れた**状態である。
 * ⟹ ⭐ **前提そのものを、現物に当てて縛る。**
 *
 * ⚠ **これは上位の歯（`release-changelog-gate-lib.test.mjs`）の重複ではない。**
 * あちらは**判定の関数**を測る（入力を自分で作る）。
 * こちらは**現物の `CHANGELOG.md`** を読む——**関数が正しくても、現物の形が変われば門は働かない。**
 *
 * 🔴 **この歯が捕まえないもの:**
 * - **節の中身**は見ていない（見出しの形だけ）。
 * - **日付が実在するか**（13月・32日でないか）は見ていない。見たいのは
 *   **未リリース節と区別できるか**であって、日付の妥当性ではない。
 * - **未リリース節が「1つだけ」であること**は要求していない。⛔ 数を焼き込まないためである
 *   （`AGENTS.md`「⚠ 数を、道具と生成物に焼き込まない」）。
 */

const changelogPath = fileURLToPath(new URL("../../CHANGELOG.md", import.meta.url));
const changelog = readFileSync(changelogPath, "utf8");

/** `## [x.y.z]` で始まる見出しの行をすべて拾う。 */
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
    /**
     * ⚠ **リリース当日に直接効く。**未リリース節を *起こす* のではなく、
     * released の節を *足して* しまうと、同じ版の見出しが2本になる。
     * 🔴 **並びによっては門が通る**（released が上に在ると、門は最初の一致を読んで通す）。
     * ⟹ **PR の時点でここが赤くなるようにしておく。**
     */
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

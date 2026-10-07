import { describe, expect, it } from "vitest";
import { blankOutWorkflowComments } from "../workflow-comment-blank-lib.mjs";

/**
 * #1783（ADR 0664）の確かめ直し（Issue #1877）。`publish-yml-changelog-gate-wiring.test.mjs` の
 * 「CHANGELOG を1か所も読まない」は、コメントを潰した後の本文を見る。潰す側が `CHANGELOG` を含む行を
 * 丸ごと潰す（コメントでない行まで）変異が入ると、門を戻しても緑のままになる。その変異は
 * `workflow-comment-blank-lib.test.mjs` では赤にならなかったので、ここで縛る。
 */

describe("コメントでない行は、CHANGELOG を含んでいても残す", () => {
  it("run の行（`grep … CHANGELOG.md || exit 1`）は残る", () => {
    const { text, unhandled } = blankOutWorkflowComments(
      "steps:\n  - run: grep -q released CHANGELOG.md || exit 1\n",
    );
    expect(unhandled).toEqual([]);
    expect(text).toContain("grep -q released CHANGELOG.md || exit 1");
  });

  it("run: | の中の行も残る", () => {
    const { text } = blankOutWorkflowComments(
      "steps:\n  - run: |\n      set -e\n      cat CHANGELOG.md\n",
    );
    expect(text).toContain("cat CHANGELOG.md");
  });

  it("引用符の中の `#` の後ろの CHANGELOG は残る", () => {
    const { text } = blankOutWorkflowComments('steps:\n  - run: echo "# CHANGELOG"\n');
    expect(text).toContain('echo "# CHANGELOG"');
  });

  it("env の値の CHANGELOG も残る", () => {
    const { text } = blankOutWorkflowComments("env:\n  FILE: CHANGELOG.md\n");
    expect(text).toContain("FILE: CHANGELOG.md");
  });
});

describe("コメントは潰す（やりすぎの対）", () => {
  it("行頭のコメントと、行末のコメントの CHANGELOG は消える", () => {
    const { text } = blankOutWorkflowComments(
      "# 昔は CHANGELOG を見ていた\nsteps:\n  - run: corepack enable # CHANGELOG とは無関係\n",
    );
    expect(text).not.toMatch(/changelog/i);
    expect(text).toContain("run: corepack enable");
  });

  it("行数は変わらない", () => {
    const input = "# CHANGELOG\na: 1\n# x\n";
    expect(blankOutWorkflowComments(input).text.split("\n")).toHaveLength(input.split("\n").length);
  });
});

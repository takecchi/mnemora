import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { blankOutWorkflowComments } from "../workflow-comment-blank-lib.mjs";

// 門の撤回（ADR 0267）を黙って戻せなくするため、歯を消さずに「配線が無いこと」を測る。
// YAML は文字列で見る（依存を足さない）。注釈の中の同じ文字列で赤くならないよう、
// blankOutWorkflowComments でコメントを潰してから判定する。

const workflowPath = fileURLToPath(new URL("../../.github/workflows/publish.yml", import.meta.url));
const workflowRaw = readFileSync(workflowPath, "utf8");
const { text: workflow, unhandled } = blankOutWorkflowComments(workflowRaw);

const GATE_SCRIPT = "scripts/check-release-changelog-section-gate.mjs";

describe("⚠ コメントを潰す前処理そのもの", () => {
  it("潰しきれなかった形が1件も無い（在ると、以下の判定が信用できない）", () => {
    expect(unhandled).toEqual([]);
  });
});

describe("🔴 出す版の節の門は publish.yml に配線されていない（ADR 0267 が ADR 0252 を撤回した）", () => {
  it("門の道具が呼ばれていない", () => {
    expect(
      workflow,
      "門の配線が publish.yml に戻っている。ADR 0267 を読み、戻すのが決定なら " +
        "ADR を積んでこの歯をもう一度反転させること（歯を消さないこと）。",
    ).not.toContain(GATE_SCRIPT);
  });

  it("門が読むために `CHANGELOG.md` を origin/main から取る段も残っていない", () => {
    expect(workflow).not.toContain("git show origin/main:CHANGELOG.md");
  });

  it("門へ tag / prerelease を渡していた env も残っていない", () => {
    expect(workflow).not.toContain("RELEASE_PRERELEASE:");
  });

  it("コメントを除いた publish.yml は、CHANGELOG を1か所も読まない（書き方を変えた門の復活も捕まえる）", () => {
    const lines = workflow
      .split("\n")
      .map((line, i) => `${i + 1}: ${line.trim()}`)
      .filter((line) => /changelog/i.test(line));
    expect(
      lines,
      "publish.yml が CHANGELOG を読んでいる。出す版の節の門の復活なら ADR 0267 を読むこと。",
    ).toEqual([]);
  });

  it("⚠ 門の道具そのものが repo に残っていない（残っていると、戻すのが1行で済んでしまう）", async () => {
    const { existsSync } = await import("node:fs");
    const scriptPath = fileURLToPath(new URL(`../../${GATE_SCRIPT}`, import.meta.url));
    expect(existsSync(scriptPath)).toBe(false);
  });
});

describe("⛔ ADR 0251 の通知は、いまも門にされていない", () => {
  // 通知を門へ格上げしない（ADR 0251 が却下した案）。
  it("通知の道具（`check-release-changelog-section.mjs`）は publish.yml から呼ばれていない", () => {
    expect(workflow).not.toContain("scripts/check-release-changelog-section.mjs");
  });
});

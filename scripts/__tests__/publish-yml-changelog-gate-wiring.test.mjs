import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { blankOutWorkflowComments } from "../workflow-comment-blank-lib.mjs";

/**
 * ⭐ **この歯が測っているもの（消す前に読むこと）**
 *
 * **[ADR 0252](../../docs/decisions/0252-release-changelog-section-is-a-publish-gate.md) が入れた
 * 「出す版の節が `CHANGELOG.md` に在るか」の門が、`.github/workflows/publish.yml` に
 * *配線されていない* こと。**
 *
 * 🔴 **この歯は 2026-09-23 に向きが反転している。**
 * **それまでは「門が配線されていること」を測っていた。**
 * ⟹ 門はオーナーの判断で撤回された
 * （[ADR 0267](../../docs/decisions/0267-withdraw-the-release-changelog-publish-gate.md)）。
 * ⛔ **歯を消さずに反転させたのは、撤回を「黙って戻せる」状態にしないためである。**
 *
 * ## ⭐ なぜ「無いこと」を測るのか —— 消してしまえばよいのではないか
 *
 * **撤回は決定であって、事故ではないからである。**
 * ⟹ 🔴 **門の配線が黙って復活したら、それは ADR 0267 を読まずに戻したということである。**
 * **そのときに赤くなる場所が、どこかに要る。**
 * ⛔ **歯を消すと、復活は誰にも気づかれない**——`publish.yml` は required の check を持たない
 * （`release` の引き金でしか走らない）ので、**壊れていても PR は緑のままである。**
 *
 * ⚠ **これは「門を二度と入れるな」という意味ではない。**入れ直す判断が出たなら、
 * **この歯をもう一度反転させること**（＋ ADR を積むこと）が、その判断の記録になる。
 *
 * ⚠ **YAML は構造として解析していない（文字列で見ている）。** 既存の workflow 検査の歯と同じ判断で、
 * 依存（js-yaml 等）を足していない（依存追加はオーナー専権）。**だからこの歯は書き方の変更に弱い。**
 * ⚠ **注釈の中に同じ文字列があるだけで赤くなる誤検出を避けるため、`blankOutWorkflowComments` で
 * コメントを潰した本文に対して判定する**（`workflow-comment-blank-lib.mjs` の docstring と同じ理由）。
 *
 * 🔴 **この歯が捕まえないもの:**
 * - **`CHANGELOG.md` の節が実際に在るか**は、もうどこも機械で止めていない。
 *   ADR 0251 の**非門の通知**（`.github/workflows/release-followup-notice.yml`）も
 *   オーナーの判断で削除した。⟹ **いまは何も見ていない。**
 *   ⛔ **その限界は ADR 0267「引き受けた負債」に書いてある。ここで薄めないこと。**
 * - **`if:` の式を GitHub が本当にそう評価するか**は見ていない。
 */

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

  it("⚠ 門の道具そのものが repo に残っていない（残っていると、戻すのが1行で済んでしまう）", async () => {
    const { existsSync } = await import("node:fs");
    const scriptPath = fileURLToPath(new URL(`../../${GATE_SCRIPT}`, import.meta.url));
    expect(existsSync(scriptPath)).toBe(false);
  });
});

describe("⛔ ADR 0251 の通知は、いまも門にされていない", () => {
  /**
   * 🔴 **ADR 0251 の核心は「終了コードが常に 0 であること」である。**
   * ⚠ **門が撤回されたいま、この歯の意味はむしろ増している**——
   * **「止めるものが無くなったから、通知のほうを門に格上げする」という筋は、
   * ADR 0251 が明示的に却下した案である。**⟹ ADR を積まずに移らないこと。
   */
  it("通知の道具（`check-release-changelog-section.mjs`）は publish.yml から呼ばれていない", () => {
    expect(workflow).not.toContain("scripts/check-release-changelog-section.mjs");
  });
});

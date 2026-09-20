import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { blankOutWorkflowComments } from "../workflow-comment-blank-lib.mjs";

/**
 * ⭐ **この歯が測っているもの（消す前に読むこと）**
 *
 * **[ADR 0252](../../docs/decisions/0252-release-changelog-section-is-a-publish-gate.md) が入れた門が、
 * `.github/workflows/publish.yml` に実際に配線されており、かつ配線の向きが正しいこと。**
 *
 * 🔴 **測る向きは4つである:**
 *
 * 1. **門の道具が呼ばれている**（`check-release-changelog-section-gate.mjs`）。
 * 2. **`npm publish` より前に呼ばれている。**⛔ 後ろに動いたら門の意味が消える
 *    ——それでも CI は緑になるので、ここで縛る。
 * 3. **`CHANGELOG.md` を `origin/main` から取っている。**🔴 **checkout されているのは tag の木であり、
 *    そこに節がまだ無いのは正常な瞬間**である ⟹ 作業木を見る形へ変わると、**門が毎回落ちる**。
 * 4. **除外が2つのまま**である（`release` 以外の引き金 / `prerelease`）。
 *    ⛔ ADR 0252 決定5 は「3つ目を足さないこと」と書いている。
 *
 * ⚠ **`scripts/__tests__/publish-yml-gate-shell-wiring.test.mjs` の重複ではない。**
 * あちらは**既定シェルの意味論**（`-e` が保たれているか）だけを測り、どのステップが在るかは見ない。
 * こちらは**特定のステップの存在と順序**を測り、`shell:` は1バイトも見ない。
 *
 * ⚠ **`scripts/__tests__/release-changelog-gate-lib.test.mjs` の重複でもない。**
 * あちらは**判定そのもの**（純関数）を測る。⟹ **判定が正しくても、配線されていなければ何も止まらない。**
 *
 * ⚠ **YAML は構造として解析していない（文字列で見ている）。** 既存の workflow 検査の歯と同じ判断で、
 * 依存（js-yaml 等）を足していない（依存追加はオーナー専権）。**だからこの歯は書き方の変更に弱い。**
 * 壊れたら「配線が変わった」か「書き方が変わった」かを見分け、**後者なら取り出し方のほうを直すこと
 * （歯を消さないこと）**。
 *
 * ⚠ **注釈の中に同じ文字列があるだけで緑になる誤検出を避けるため、`blankOutWorkflowComments` で
 * コメントを潰した本文に対して判定する**（`workflow-comment-blank-lib.mjs` の docstring と同じ理由）。
 *
 * 🔴 **この歯が捕まえないもの:**
 * - **門が実際の Release で通るか**は見ていない（`RUNNER_TEMP` / `git show` の経路）。
 *   ⟹ ADR 0252「確かめていないこと」と同じ断りである。
 * - **`if:` の式を GitHub が本当にそう評価するか**は見ていない。見ているのは**文字列として在ること**までである。
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

describe("🔴 出す版の節の門が publish.yml に配線されている（ADR 0252）", () => {
  it("門の道具が呼ばれている", () => {
    expect(workflow).toContain(GATE_SCRIPT);
  });

  it("🔴 `npm publish` より前に呼ばれている（後ろへ動いたら門の意味が消える）", () => {
    const gateAt = workflow.indexOf(GATE_SCRIPT);
    const publishAt = workflow.indexOf('npm publish "${tarball}"');
    expect(gateAt, "門の呼び出しが見つからない").toBeGreaterThan(-1);
    expect(publishAt, "npm publish の行が見つからない").toBeGreaterThan(-1);
    expect(gateAt).toBeLessThan(publishAt);
  });

  it("🔴 `CHANGELOG.md` を origin/main から取っている（作業木＝tag の木を見ていない）", () => {
    expect(workflow).toContain("git show origin/main:CHANGELOG.md");
    // 出所を明示的に渡している（既定値を持たない道具なので、省くと落ちる）。
    expect(workflow).toContain("--changelog-file");
  });

  it("⛔ 除外は2つのまま（release 以外の引き金 / prerelease）", () => {
    const gateAt = workflow.indexOf(GATE_SCRIPT);
    // 門のステップの手前 900 文字の窓に、2つの除外条件が両方在ること。
    const window = workflow.slice(Math.max(0, gateAt - 900), gateAt);
    expect(window).toContain("github.event_name == 'release'");
    expect(window).toContain("github.event.release.prerelease == false");
  });

  it("tag と prerelease を env 経由で渡している（`${{ }}` の直接展開にしていない）", () => {
    const gateAt = workflow.indexOf(GATE_SCRIPT);
    const window = workflow.slice(Math.max(0, gateAt - 900), gateAt);
    expect(window).toContain("RELEASE_TAG:");
    expect(window).toContain("RELEASE_PRERELEASE:");
  });
});

describe("⛔ ADR 0251 の通知は、門にされていない", () => {
  /**
   * 🔴 **ADR 0251 の核心は「終了コードが常に 0 であること」である。**
   * ⟹ **門を足したついでに、通知のほうを publish の経路へ引き込んでいないことを縛る。**
   * ⛔ 引き込んだ瞬間、ADR 0251 が却下した案へ移る。
   */
  it("通知の道具（`check-release-changelog-section.mjs`）は publish.yml から呼ばれていない", () => {
    // ⚠ 門の道具は同じ接頭辞を持つので、`-gate.mjs` を取り除いてから数える。
    const withoutGate = workflow.split(GATE_SCRIPT).join("");
    expect(withoutGate).not.toContain("scripts/check-release-changelog-section.mjs");
  });
});

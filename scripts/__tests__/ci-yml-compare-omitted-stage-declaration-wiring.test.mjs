import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { blankOutWorkflowComments } from "../workflow-comment-blank-lib.mjs";

/**
 * ⭐ **この歯が測っているもの（消す前に読むこと）**
 *
 * **`.github/workflows/ci.yml` の `example-chat` ジョブが、
 * `scripts/check-compare-omitted-stage-declaration.mjs` へ実際に配線されていること**
 * （Issue #403 / ADR 0280）。
 *
 * ⚠ **`compare-omitted-stage-declaration.test.mjs` の重複ではない**
 * （`ci-yml-compare-wiring.test.mjs` の docstring と同じ理由）。あちらは**入力を自分で作って**
 * 判定と exit code を測る——**`ci.yml` を1バイトも読まない。**⟹ 誰かが `ci.yml` から
 * この段を落としても、`--baseline` のパスを打ち間違えても、`PR_BODY` を渡し忘れても、
 * **あちらは緑のまま通る。**
 *
 * ## 🔴 この歯が生まれた理由（実際に踏んだ）
 *
 * **【実測 2026-09-23】この段を足した最初の push で、`ci.yml` が YAML として壊れた**
 * ——段の名前を `'omitted' の …` と書いたため、YAML が先頭のシングルクォートを
 * 引用符と解釈した。⟹ **workflow がそもそも起動せず、`jobs` が0件で `failure` になった。**
 * 🔴 **そのとき、手元の `scripts/__tests__/` の 1564件はすべて緑だった。**
 * 既存の `ci-yml-*-wiring` の歯は、逐語「**YAML は構造として解析していない（文字列で見ている）**」
 * と自ら断っており、**構文エラーは射程外**である。
 *
 * ⟹ ⛔ **この歯も YAML パーサを持たない**（パーサを repo の依存に足すのは
 * `docs/autonomy.md` §3「依存の追加方針の変更」＝オーナーの判断である）。
 * **この歯が足すのは「この段が在り、正しい引数と env で呼ばれている」ことだけである。**
 * ⚠ **構文の妥当性は、いまも CI に出してみるまで分からない。**（ADR 0280「引き受けた負債」）
 */

const WORKFLOW_PATH = fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url));
const raw = readFileSync(WORKFLOW_PATH, "utf8");
const { text: workflow } = blankOutWorkflowComments(raw);

const SCRIPT = "scripts/check-compare-omitted-stage-declaration.mjs";

describe("ci.yml への配線（Issue #403 / ADR 0280）", () => {
  it("⭐ 空振り防止: ci.yml を読めていて、中身が空でない", () => {
    expect(raw.length).toBeGreaterThan(1000);
    expect(workflow).toContain("example-chat");
  });

  it("この門の CLI を呼ぶ段が、コメントではなく実際の run に1箇所だけ在る", () => {
    const occurrences = workflow.split(SCRIPT).length - 1;
    expect(occurrences).toBe(1);
  });

  it("`--measured` に、compare が書き出す先と同じパスを渡している", () => {
    // `MNEMORA_COMPARE_JSON` が compare の書き先、`--measured` が読み先。
    // ⟹ この2つがずれていたら、この門は古い/存在しないファイルを見ることになる。
    const writeTarget = /MNEMORA_COMPARE_JSON:\s*(\S+)/.exec(workflow)?.[1];
    expect(writeTarget).toBeDefined();
    const block = workflow.slice(workflow.indexOf(SCRIPT));
    const readTarget = /--measured\s+"?([^"\s\\]+)"?/.exec(block)?.[1];
    expect(readTarget).toBe(writeTarget);
  });

  it("`--baseline` に、現物の基準値ファイルを渡している", () => {
    const block = workflow.slice(workflow.indexOf(SCRIPT));
    expect(/--baseline\s+examples\/chat\/compare-baseline\.json/.test(block)).toBe(true);
  });

  it("🔴 `PR_BODY` を env で渡している（run: の中へ直接展開していない）", () => {
    const start = workflow.lastIndexOf("- name:", workflow.indexOf(SCRIPT));
    const block = workflow.slice(start, workflow.indexOf(SCRIPT));
    expect(block).toContain("PR_BODY: ${{ github.event.pull_request.body }}");
    // ⛔ 利用者が書く自由記述を run: の中へ直接展開しない（既存の
    // check-pr-adr-reference の段と同じ線）。
    const runBlock = workflow.slice(workflow.indexOf(SCRIPT));
    expect(runBlock.slice(0, 300)).not.toContain("github.event.pull_request.body");
  });

  it("`if: always()` で、compare が落ちた場合も理由が残る", () => {
    const start = workflow.lastIndexOf("- name:", workflow.indexOf(SCRIPT));
    const block = workflow.slice(start, workflow.indexOf(SCRIPT));
    expect(block).toContain("if: always()");
  });
});

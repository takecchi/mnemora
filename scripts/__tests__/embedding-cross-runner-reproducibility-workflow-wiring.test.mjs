import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CROSS_RUNNER_NUM_THREADS,
  CROSS_RUNNER_REPS,
  CROSS_RUNNER_RUNNERS,
  crossRunnerArtifactName,
} from "../cross-runner-embedding-fingerprint-lib.mjs";

/**
 * ⭐ **この歯が測っているもの（消す前に読むこと）**
 *
 * `.github/workflows/embedding-cross-runner-reproducibility.yml` の matrix・artifact 名が、
 * `scripts/cross-runner-embedding-fingerprint-lib.mjs` の宣言（`CROSS_RUNNER_RUNNERS` /
 * `CROSS_RUNNER_NUM_THREADS` / `CROSS_RUNNER_REPS` / `crossRunnerArtifactName`）と
 * 実際に一致していること。
 *
 * ⚠ **YAML は構造として解析していない（文字列で見ている）。**
 * `ci-yml-embedding-output-fingerprint-wiring.test.mjs` と同じ判断——依存追加は
 * オーナー専権であり（`docs/autonomy.md`）、YAML パーサを追加で入れない。壊れたときは
 * 「配線が変わった」か「書き方が変わった」かを見て、配線が変わっていないなら
 * 取り出し方のほうを直すこと（歯を消さないこと）。
 *
 * このずれを検出しないと何が起きるか: matrix の `runner:` を変えたのに
 * `crossRunnerArtifactName` の呼び先（`compare-cross-runner-embedding-fingerprints.mjs`
 * の `allExpectedCrossRunnerLegs()`）を直し忘れると、比較段が実際には存在する artifact を
 * 「無い」として扱う——測っているのに「測れていない」と報告する、という壊れ方になる。
 */

const workflowPath = fileURLToPath(
  new URL("../../.github/workflows/embedding-cross-runner-reproducibility.yml", import.meta.url),
);
const workflow = readFileSync(workflowPath, "utf8");

describe("matrix の値が cross-runner-embedding-fingerprint-lib.mjs の宣言と一致する", () => {
  it("runner: の一覧が CROSS_RUNNER_RUNNERS の label と一致する", () => {
    const match = /runner:\s*\[([^\]]+)\]/.exec(workflow);
    expect(match, "workflow に `runner: [...]` の matrix 行が見つからない").not.toBeNull();
    const declaredRunners = /** @type {RegExpExecArray} */ (match)[1]
      .split(",")
      .map((s) => s.trim());
    expect(declaredRunners).toEqual(CROSS_RUNNER_RUNNERS.map((r) => r.label));
  });

  it("numThreads: の一覧が CROSS_RUNNER_NUM_THREADS と一致する", () => {
    const match = /numThreads:\s*\[([^\]]+)\]/.exec(workflow);
    expect(match, "workflow に `numThreads: [...]` の matrix 行が見つからない").not.toBeNull();
    const declared = /** @type {RegExpExecArray} */ (match)[1]
      .split(",")
      .map((s) => Number(s.trim()));
    expect(declared).toEqual([...CROSS_RUNNER_NUM_THREADS]);
  });

  it("rep: の一覧が CROSS_RUNNER_REPS と一致する", () => {
    const match = /rep:\s*\[([^\]]+)\]/.exec(workflow);
    expect(match, "workflow に `rep: [...]` の matrix 行が見つからない").not.toBeNull();
    const declared = /** @type {RegExpExecArray} */ (match)[1]
      .split(",")
      .map((s) => Number(s.trim()));
    expect(declared).toEqual([...CROSS_RUNNER_REPS]);
  });
});

describe("upload-artifact の name: が crossRunnerArtifactName() と同じ形で書かれている", () => {
  it("`name:` のテンプレート文字列に matrix.runner / matrix.numThreads / matrix.rep が過不足なく入っている", () => {
    const nameLineMatch =
      /name: "cross-runner-embedding-fingerprint--runner-\$\{\{ matrix\.runner \}\}--nt-\$\{\{ matrix\.numThreads \}\}--rep-\$\{\{ matrix\.rep \}\}"/.exec(
        workflow,
      );
    expect(
      nameLineMatch,
      "upload-artifact の name: が crossRunnerArtifactName() の形と一致しない",
    ).not.toBeNull();
  });

  it("具体的な matrix の値で埋めたときに crossRunnerArtifactName() と文字列として一致する（陽性対照）", () => {
    const sampleRunner = CROSS_RUNNER_RUNNERS[0].label;
    const sampleNumThreads = CROSS_RUNNER_NUM_THREADS[0];
    const sampleRep = CROSS_RUNNER_REPS[0];
    const expected = crossRunnerArtifactName(sampleRunner, sampleNumThreads, sampleRep);
    const filled = `cross-runner-embedding-fingerprint--runner-${sampleRunner}--nt-${sampleNumThreads}--rep-${sampleRep}`;
    expect(filled).toBe(expected);
  });
});

describe("測る段・比較段の配線", () => {
  it("embedding-fingerprint サブコマンドを、MNEMORA_EMBEDDING_FINGERPRINT_NUM_THREADS 付きで呼んでいる", () => {
    expect(workflow).toContain("run embedding-fingerprint");
    expect(workflow).toContain(
      "MNEMORA_EMBEDDING_FINGERPRINT_NUM_THREADS: ${{ matrix.numThreads }}",
    );
  });

  it("scripts/measure-cross-runner-embedding-fingerprint.mjs を --rep 付きで呼んでいる", () => {
    expect(workflow).toContain("node scripts/measure-cross-runner-embedding-fingerprint.mjs");
    expect(workflow).toContain("--rep");
  });

  it("scripts/compare-cross-runner-embedding-fingerprints.mjs を --artifacts-dir --json-out 付きで呼んでいる", () => {
    expect(workflow).toContain("node scripts/compare-cross-runner-embedding-fingerprints.mjs");
    expect(workflow).toContain("--artifacts-dir");
    expect(workflow).toContain("--json-out");
  });

  it("actions/download-artifact@v6 を pattern: cross-runner-embedding-fingerprint--* で使っている", () => {
    expect(workflow).toContain("uses: actions/download-artifact@v6");
    expect(workflow).toContain('pattern: "cross-runner-embedding-fingerprint--*"');
  });

  it("compare ジョブが measure ジョブに needs: で依存し、if: always() を持つ", () => {
    expect(workflow).toContain("needs: [measure]");
    const compareJobStart = workflow.indexOf("needs: [measure]");
    const nearby = workflow.slice(compareJobStart, compareJobStart + 200);
    expect(nearby).toContain("if: always()");
  });

  it("strategy に fail-fast: false が付いている（1脚の失敗が他の脚を止めない）", () => {
    expect(workflow).toContain("fail-fast: false");
  });
});

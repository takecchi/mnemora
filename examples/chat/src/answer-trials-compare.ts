import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { AnswerTrialsResult } from "./answer-trials.js";

/**
 * Issue #705 完了条件2:「対照の材料の記憶集合が、比べたい記録（カセット）と同じであることを、
 * 器が確かめて表示する」——`answer-trials` の複数回の実行結果（JSON、`MNEMORA_ANSWER_TRIALS_JSON`
 * で書き出したもの）を突き合わせ、**カセットの sha256 かケースごとの材料指紋が一致しなければ
 * exit 1**、一致すれば並べて表示して exit 0 にする。
 *
 * ⛔ **指紋を見ずに通す実装は事故そのものである**（ADR 0295 追記2 の再発防止が Issue #705 の
 * 動機）。この module の中心はまさにその比較——変異試験(b)がここを狙う。
 */

export interface AnswerTrialsCompareInput {
  label: string;
  result: AnswerTrialsResult;
}

export interface FingerprintMismatchDetail {
  caseId: string;
  /** ラベルごとの指紋。その入力にケースが無ければ `undefined`。 */
  fingerprintByLabel: Record<string, string | undefined>;
}

export interface AnswerTrialsCompareResult {
  ok: boolean;
  labels: string[];
  cassetteShaByLabel: Record<string, string>;
  cassetteMismatch: boolean;
  fingerprintMismatches: FingerprintMismatchDetail[];
}

/**
 * 2件以上の `answer-trials` 実行結果を突き合わせる。**カセットの sha256 全体か、
 * ケースごとの材料指紋（`fingerprint`）のどちらかが1件でもずれていれば `ok: false`。**
 */
export function compareAnswerTrials(
  inputs: readonly AnswerTrialsCompareInput[],
): AnswerTrialsCompareResult {
  if (inputs.length < 2) {
    throw new Error(
      `compareAnswerTrials: 比較には2件以上の入力が要る（実際: ${inputs.length}件）。`,
    );
  }
  const labels = inputs.map((i) => i.label);
  const dupLabels = labels.filter((l, i) => labels.indexOf(l) !== i);
  if (dupLabels.length > 0) {
    throw new Error(
      `compareAnswerTrials: ラベルが重複している: ${[...new Set(dupLabels)].join(", ")}`,
    );
  }

  const cassetteShaByLabel: Record<string, string> = {};
  for (const input of inputs) {
    cassetteShaByLabel[input.label] = input.result.cassetteSha256;
  }
  const distinctShas = new Set(Object.values(cassetteShaByLabel));
  const cassetteMismatch = distinctShas.size > 1;

  // caseId の和集合を、最初に現れた入力の順序で並べる。
  const caseIdOrder: string[] = [];
  const seen = new Set<string>();
  for (const input of inputs) {
    for (const cm of input.result.caseMaterials) {
      if (!seen.has(cm.caseId)) {
        seen.add(cm.caseId);
        caseIdOrder.push(cm.caseId);
      }
    }
  }

  const fingerprintMismatches: FingerprintMismatchDetail[] = [];
  for (const caseId of caseIdOrder) {
    const fingerprintByLabel: Record<string, string | undefined> = {};
    for (const input of inputs) {
      const cm = input.result.caseMaterials.find((c) => c.caseId === caseId);
      fingerprintByLabel[input.label] = cm?.fingerprint;
    }
    const distinctFingerprints = new Set(Object.values(fingerprintByLabel));
    if (distinctFingerprints.size > 1) {
      fingerprintMismatches.push({ caseId, fingerprintByLabel });
    }
  }

  return {
    ok: !cassetteMismatch && fingerprintMismatches.length === 0,
    labels,
    cassetteShaByLabel,
    cassetteMismatch,
    fingerprintMismatches,
  };
}

// ---------------------------------------------------------------------------
// 表示
// ---------------------------------------------------------------------------

/** ずれた箇所を具体的に示す（exit 1 のときに画面へ出す）。 */
export function formatCompareMismatchReport(compare: AnswerTrialsCompareResult): string {
  const lines: string[] = ["⛔ 比較できない——記憶集合が一致しない入力がある。"];
  if (compare.cassetteMismatch) {
    lines.push("");
    lines.push("カセットの sha256 が一致しない:");
    for (const [label, sha] of Object.entries(compare.cassetteShaByLabel)) {
      lines.push(`  ${label}: ${sha}`);
    }
  }
  if (compare.fingerprintMismatches.length > 0) {
    lines.push("");
    lines.push("ケースごとの材料指紋が一致しない:");
    for (const mismatch of compare.fingerprintMismatches) {
      lines.push(`  ${mismatch.caseId}:`);
      for (const [label, fp] of Object.entries(mismatch.fingerprintByLabel)) {
        lines.push(`    ${label}: ${fp ?? "(この入力にケースが無い)"}`);
      }
    }
  }
  return lines.join("\n");
}

function verdictCell(result: AnswerTrialsResult, caseId: string, renderName: string): string {
  if (!result.evaluated) {
    return "未評価";
  }
  const cr = result.caseResults.find((c) => c.caseId === caseId);
  const v = cr?.renders.find((r) => r.renderName === renderName);
  if (v === undefined) {
    return "(無)";
  }
  return `pass=${v.passCount}/fail=${v.failCount}/indet=${v.indeterminateCount}(n=${v.n})`;
}

/** 一致したときに画面へ出す、並べた表。 */
export function formatCompareTable(inputs: readonly AnswerTrialsCompareInput[]): string {
  const lines: string[] = ["✅ 記憶集合は一致している（カセット・材料指紋とも同一）。", ""];
  const first = inputs[0];
  if (first === undefined) {
    return lines.join("\n");
  }
  lines.push(`cassette sha256: ${first.result.cassetteSha256}`);
  const renderNames = first.result.renders;
  for (const cm of first.result.caseMaterials) {
    lines.push(`\n${cm.caseId} (fingerprint=${cm.fingerprint.slice(0, 12)}…)`);
    for (const renderName of renderNames) {
      lines.push(`  [${renderName}]`);
      for (const input of inputs) {
        lines.push(`    ${input.label}: ${verdictCell(input.result, cm.caseId, renderName)}`);
      }
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// ファイルから読む（CLI 用）
// ---------------------------------------------------------------------------

function readAnswerTrialsJson(path: string): AnswerTrialsResult {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(
      `readAnswerTrialsJson: ${path} を読めなかった。原因: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  return JSON.parse(raw) as AnswerTrialsResult;
}

/**
 * `answer-trials-compare` サブコマンドの本体。**副作用のある手（exit の判定そのもの）は
 * ここでは打たない**——呼び出し側（`cli.ts`）が戻り値の `ok` を見て `process.exitCode` を
 * 明示的に立てる（`docs/autonomy.md` §4.1 の作法）。
 */
export function runAnswerTrialsCompareFromFiles(paths: readonly string[]): {
  ok: boolean;
  report: string;
} {
  if (paths.length < 2) {
    throw new Error(
      `runAnswerTrialsCompareFromFiles: 比較には2件以上のパスが要る（実際: ${paths.length}件）。`,
    );
  }
  const inputs: AnswerTrialsCompareInput[] = paths.map((path) => ({
    label: basename(path),
    result: readAnswerTrialsJson(path),
  }));
  const compare = compareAnswerTrials(inputs);
  const report = compare.ok ? formatCompareTable(inputs) : formatCompareMismatchReport(compare);
  return { ok: compare.ok, report };
}

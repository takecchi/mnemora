import type { TimeWeightingAggregateCell } from "./time-weighting-bench.js";
import { answerQualityClaimable } from "./answer-case.js";
import type { ProviderMode } from "./providers.js";

/**
 * `answer-time-weighting` の人間向け出力（Markdown 表 + 目立つ注記）。
 *
 * `answer-format.ts` と同じ規律——`llmMode=deterministic` では正答数を主張しない
 * （`answerQualityClaimable` が false を返す）。
 */

export function formatTimeWeightingQualityBanner(llmMode: ProviderMode): string {
  if (answerQualityClaimable(llmMode)) {
    return "";
  }
  return (
    "⛔⛔⛔ これは配線の検査であり、回答品質は測っていない（llmMode=deterministic） ⛔⛔⛔\n" +
    "deterministic の LLM は意味を持たない stub である。以下の正答数は、legacy/" +
    "eventAwareFreshness が recall() へ正しく渡っているかの配線検査であって、" +
    "どちらの方針が正しく答えられるかは、この run からは何も言えない。"
  );
}

/**
 * 「方針 × ケース」の正答数/試行数を Markdown 表にする。
 *
 * `answerQualityClaimable(llmMode) === false` のときは正答数の列を `—` にする。
 */
export function formatTimeWeightingTable(
  cells: readonly TimeWeightingAggregateCell[],
  llmMode: ProviderMode,
): string {
  const claimable = answerQualityClaimable(llmMode);
  const header = "| case | kind | policy | pass/trials |";
  const sep = "|---|---|---|---|";
  const body = [...cells]
    .sort((a, b) => a.caseId.localeCompare(b.caseId) || a.policy.localeCompare(b.policy))
    .map((cell) => {
      const rate = claimable ? `${cell.passCount}/${cell.trials}` : "—";
      return `| ${cell.caseId} | ${cell.kind} | ${cell.policy} | ${rate} |`;
    });
  const lines = [header, sep, ...body];
  if (!claimable) {
    lines.push(
      "",
      "(注) llmMode=deterministic のため正答数は出していない。上の formatTimeWeightingQualityBanner を見ること。",
    );
  }
  return lines.join("\n");
}

/**
 * 類型ごとに legacy/eventAwareFreshness を並べた要約行を足す
 * （類型A: legacy が低く eventAwareFreshness が高いはず。類型B/C: 両方とも同程度に高いはず）。
 */
export function formatTimeWeightingKindSummary(
  cells: readonly TimeWeightingAggregateCell[],
  llmMode: ProviderMode,
): string {
  if (!answerQualityClaimable(llmMode)) {
    return "";
  }
  const kinds = [...new Set(cells.map((c) => c.kind))];
  const lines = ["", "--- 類型ごとの正答率（legacy vs eventAwareFreshness） ---"];
  for (const kind of kinds) {
    const forKind = cells.filter((c) => c.kind === kind);
    const legacy = forKind.filter((c) => c.policy === "legacy");
    const eventAware = forKind.filter((c) => c.policy === "eventAwareFreshness");
    const sum = (xs: readonly TimeWeightingAggregateCell[], key: "passCount" | "trials") =>
      xs.reduce((acc, x) => acc + x[key], 0);
    lines.push(
      `  ${kind}: legacy=${sum(legacy, "passCount")}/${sum(legacy, "trials")}, ` +
        `eventAwareFreshness=${sum(eventAware, "passCount")}/${sum(eventAware, "trials")}`,
    );
  }
  return lines.join("\n");
}

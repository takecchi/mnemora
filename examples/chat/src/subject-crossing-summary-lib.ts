import type { CorpusPole, CtxSubjectVariant, TrialResult } from "./subject-crossing-measure.js";

/**
 * `subject-crossing-summary.ts`(CLI)の純関数側(`consolidation-cost-summary-lib.mjs`
 * と同じ分担——組み立ては純関数に、argv・ファイルI/Oは薄い CLI 側に置く)。
 *
 * `TrialResult`（`subject-crossing-measure.ts` が書き出す raw JSON の要素）を、
 * S×N×pole×ctxVariant×minAffinity で集約する。**加工ではなく集約だけ**——`mixed`
 * （`consolidate.ts` 本体の判定そのもの）を group ごとに数えるだけで、新しい判定は
 * 作らない。
 */

export interface SummaryRow {
  pole: CorpusPole;
  s: number;
  n: number;
  ctxVariant: CtxSubjectVariant;
  minAffinity: number;
  totalTrials: number;
  /** eligible(種を含む)が2件以上あった試行——実際に統合され得た試行。 */
  trialsWithCandidates: number;
  mixedCount: number;
  /** `trialsWithCandidates` が0のときは `null`(0/0 を0%と書かない)。 */
  mixedRateAmongCandidates: number | null;
  meanEligibleCount: number;
  maxSubjectSpanObserved: number;
}

function groupKey(r: TrialResult): string {
  return [r.pole, r.s, r.n, r.ctxVariant, r.minAffinity].join("|");
}

export function summarizeTrials(results: readonly TrialResult[]): SummaryRow[] {
  const groups = new Map<string, TrialResult[]>();
  for (const r of results) {
    const k = groupKey(r);
    const bucket = groups.get(k);
    if (bucket === undefined) {
      groups.set(k, [r]);
    } else {
      bucket.push(r);
    }
  }

  const rows: SummaryRow[] = [];
  for (const items of groups.values()) {
    const first = items[0]!;
    const total = items.length;
    const withCandidates = items.filter((r) => r.eligibleCount >= 2);
    const mixed = withCandidates.filter((r) => r.mixed);
    const meanEligible = items.reduce((sum, r) => sum + r.eligibleCount, 0) / total;
    const maxSubjSpan = items.reduce((max, r) => Math.max(max, r.eligibleSubjectCount), 0);
    rows.push({
      pole: first.pole,
      s: first.s,
      n: first.n,
      ctxVariant: first.ctxVariant,
      minAffinity: first.minAffinity,
      totalTrials: total,
      trialsWithCandidates: withCandidates.length,
      mixedCount: mixed.length,
      mixedRateAmongCandidates:
        withCandidates.length > 0 ? mixed.length / withCandidates.length : null,
      meanEligibleCount: meanEligible,
      maxSubjectSpanObserved: maxSubjSpan,
    });
  }

  rows.sort(
    (a, b) =>
      a.pole.localeCompare(b.pole) ||
      a.s - b.s ||
      a.n - b.n ||
      a.ctxVariant.localeCompare(b.ctxVariant) ||
      a.minAffinity - b.minAffinity,
  );
  return rows;
}

function pct(x: number | null): string {
  return x === null ? "n/a" : `${(x * 100).toFixed(0)}%`;
}

/**
 * N を行・S を列にした `mixedRateAmongCandidates` の表を、pole×ctxVariant×minAffinity
 * ごとに作る。
 */
export function renderMarkdownReport(rows: readonly SummaryRow[]): string {
  const poles = [...new Set(rows.map((r) => r.pole))];
  const ctxVariants = [...new Set(rows.map((r) => r.ctxVariant))];
  const minAffinities = [...new Set(rows.map((r) => r.minAffinity))].sort((a, b) => a - b);
  const sValues = [...new Set(rows.map((r) => r.s))].sort((a, b) => a - b);
  const nValues = [...new Set(rows.map((r) => r.n))].sort((a, b) => a - b);

  const lines: string[] = [];
  lines.push("# Issue #579 案B 測定結果 — mixed-subject consolidation 頻度");
  lines.push("");
  lines.push(
    "【実測】`runtime.consolidate(ctx, { target: { seedMemoryId }, dryRun: true, minAffinity })` " +
      "を実際に呼んだ結果。",
  );
  lines.push(
    "mixedRate = eligible(dryRun の `eligible` 分類、種を含む)が2件以上あった試行のうち、" +
      "eligible の subjectId が2種以上だった割合。",
  );
  lines.push("");

  for (const pole of poles) {
    for (const ctxVariant of ctxVariants) {
      for (const minAffinity of minAffinities) {
        const subset = rows.filter(
          (r) => r.pole === pole && r.ctxVariant === ctxVariant && r.minAffinity === minAffinity,
        );
        if (subset.length === 0) continue;
        lines.push(`## pole=${pole} ctx.subjectId=${ctxVariant} minAffinity=${minAffinity}`);
        lines.push("");
        lines.push(`| N \\ S | ${sValues.map((s) => `S=${s}`).join(" | ")} |`);
        lines.push(`|---|${sValues.map(() => "---").join("|")}|`);
        for (const n of nValues) {
          const cells = sValues.map((s) => {
            const row = subset.find((r) => r.s === s && r.n === n);
            if (row === undefined) return "n/a";
            return `${pct(row.mixedRateAmongCandidates)} (n=${row.trialsWithCandidates}/${row.totalTrials})`;
          });
          lines.push(`| N=${n} | ${cells.join(" | ")} |`);
        }
        lines.push("");
      }
    }
  }
  return lines.join("\n");
}

export interface SubjectCrossingRawFile {
  commit: string | null;
  measuredAt: string;
  results: TrialResult[];
}

/** raw JSON 文字列(未検証)を読む。壊れていたら `{ ok: false, error }`。 */
export function parseRawFile(
  text: string,
): { ok: true; value: SubjectCrossingRawFile } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      error: `JSON として読めない: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("results" in parsed) ||
    !Array.isArray((parsed as { results: unknown }).results)
  ) {
    return { ok: false, error: "results 配列が無い(subject-crossing-measure.ts が書く形と違う)" };
  }
  return { ok: true, value: parsed as SubjectCrossingRawFile };
}

import {
  CATEGORY_EXPECTS_CONFLICT,
  CONTESTED_CATEGORIES,
  type ContestedCategory,
} from "./contested-detection-case-set.js";

/** 1ケースの判定。`detected` は、検出がそのケースで衝突を1件以上報告したか。 */
export interface ContestedCaseResult {
  id: string;
  category: ContestedCategory;
  detected: boolean;
}

export interface Confusion {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
}

export interface ContestedMetrics extends Confusion {
  /** `tp + fp === 0`（何も陽性にしなかった）なら `null`。0 と区別する。 */
  precision: number | null;
  /** `tp + fn === 0`（陽性であるべきケースが無い）なら `null`。 */
  recall: number | null;
  /** precision・recall のどちらかが `null`、または両方 0 なら `null`。 */
  f1: number | null;
}

export function confusionOf(results: readonly ContestedCaseResult[]): Confusion {
  const c: Confusion = { tp: 0, fp: 0, fn: 0, tn: 0 };
  for (const r of results) {
    const expected = CATEGORY_EXPECTS_CONFLICT[r.category];
    if (expected && r.detected) c.tp += 1;
    else if (expected) c.fn += 1;
    else if (r.detected) c.fp += 1;
    else c.tn += 1;
  }
  return c;
}

export function metricsOf(c: Confusion): ContestedMetrics {
  const precision = c.tp + c.fp === 0 ? null : c.tp / (c.tp + c.fp);
  const recall = c.tp + c.fn === 0 ? null : c.tp / (c.tp + c.fn);
  const f1 =
    precision === null || recall === null || precision + recall === 0
      ? null
      : (2 * precision * recall) / (precision + recall);
  return { ...c, precision, recall, f1 };
}

/** カテゴリごとの判定の内訳。陰性であるべきカテゴリは `fp`/`tn`、陽性であるべきカテゴリは `tp`/`fn` だけが立つ。 */
export function confusionByCategory(
  results: readonly ContestedCaseResult[],
): Record<ContestedCategory, Confusion> {
  const out = {} as Record<ContestedCategory, Confusion>;
  for (const category of CONTESTED_CATEGORIES) {
    out[category] = confusionOf(results.filter((r) => r.category === category));
  }
  return out;
}

const fmt = (v: number | null) => (v === null ? "—" : v.toFixed(3));

export function formatContestedReport(results: readonly ContestedCaseResult[]): string {
  const lines: string[] = [];
  lines.push("## claim key の矛盾検出（決定的な段・oracle 鍵）");
  lines.push("");
  lines.push(
    "⚠ 抽出と claim key を理想どおりの値に固定し、検出段だけを測った。LLM の鍵の揺れは含まない。合成データで、件数は少ない。",
  );
  lines.push("");
  lines.push("| カテゴリ | 検出されるべきか | 件数 | 検出した | TP | FP | FN | TN |");
  lines.push("|---|---|---|---|---|---|---|---|");
  const byCategory = confusionByCategory(results);
  for (const category of CONTESTED_CATEGORIES) {
    const c = byCategory[category];
    const n = c.tp + c.fp + c.fn + c.tn;
    lines.push(
      `| ${category} | ${CATEGORY_EXPECTS_CONFLICT[category] ? "される" : "されない"} | ${String(n)} | ${String(c.tp + c.fp)} | ${String(c.tp)} | ${String(c.fp)} | ${String(c.fn)} | ${String(c.tn)} |`,
    );
  }
  const m = metricsOf(confusionOf(results));
  lines.push("");
  lines.push(
    `全体: TP=${String(m.tp)} FP=${String(m.fp)} FN=${String(m.fn)} TN=${String(m.tn)} / Precision=${fmt(m.precision)} Recall=${fmt(m.recall)} F1=${fmt(m.f1)}`,
  );
  lines.push("");
  lines.push("外れたケース:");
  for (const r of results) {
    const expected = CATEGORY_EXPECTS_CONFLICT[r.category];
    if (expected !== r.detected) {
      lines.push(`- ${r.id}（${r.category}）: ${r.detected ? "誤検出（FP）" : "見逃し（FN）"}`);
    }
  }
  return lines.join("\n");
}

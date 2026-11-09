import { DEFAULT_SCORE_THRESHOLD } from "@mnemora/core";
import {
  LONG_HORIZON_ARM_SPECS,
  aggregateCorrectionOrders,
  aggregateLongHorizon,
  predictedFirstMissDay,
  type LongHorizonArm,
  type LongHorizonProbeRecord,
  type LongHorizonReport,
} from "./long-horizon-bench.js";
import type { LongHorizonFactClass } from "./long-horizon-case-set.js";
import { GOLD_OUTCOME_KINDS } from "./long-horizon-outcome.js";

const FACT_CLASS_LABEL: Record<LongHorizonFactClass, string> = {
  habitual: "常用",
  dormant: "休眠",
  correction: "訂正（新しい側）",
};

function armLabel(arm: LongHorizonArm): string {
  const spec = LONG_HORIZON_ARM_SPECS[arm];
  return `${arm}（${spec.policy}・使用報告${spec.usageReporting ? "あり" : "なし"}）`;
}

/**
 * 見立て（{@link predictedFirstMissDay}）と実測の突き合わせ。使用報告の無い arm の、常用・休眠の gold について、
 * 最初の時点の診断スコアの similarity から見立てた「閾値・忘却ゲートで落ちる日」と、実際に閾値・忘却ゲートで最初に落ちた時点を並べる。
 * 見立ては絶対値の閾値だけを見ており、他の記憶との順位（`outranked`）を式に入れていない。⟹ 順位で先に負けた時点は別の欄に分けて出す。
 */
export interface PredictionRow {
  arm: LongHorizonArm;
  factId: string;
  similarityAtFirstCheckpoint: number | null;
  predictedFirstMissDay: number | null;
  /** 理由を問わず、最初に返らなかった時点。 */
  observedFirstMissCheckpoint: number | null;
  observedFirstMissOutcome: string | null;
  /** 見立てと比べる欄: `below_threshold` か `decayed` で最初に落ちた時点。 */
  observedFirstThresholdOrDecayCheckpoint: number | null;
}

export function buildPredictionRows(report: LongHorizonReport): PredictionRow[] {
  const rows: PredictionRow[] = [];
  const firstCheckpoint = report.checkpointDays[0];
  for (const arm of report.arms) {
    const spec = LONG_HORIZON_ARM_SPECS[arm];
    if (spec.usageReporting) {
      continue;
    }
    for (const fact of report.facts) {
      if (fact.factClass === "correction") {
        continue;
      }
      const series = report.probes
        .filter((p) => p.arm === arm && p.factId === fact.id && p.role === "gold")
        .sort((a, b) => a.checkpointDay - b.checkpointDay);
      const first = series.find((p) => p.checkpointDay === firstCheckpoint);
      const similarity = first?.diagnostic?.similarity ?? null;
      const firstMiss = series.find((p) => p.outcome !== "returned");
      const firstThresholdOrDecay = series.find(
        (p) => p.outcome === "below_threshold" || p.outcome === "decayed",
      );
      rows.push({
        arm,
        factId: fact.id,
        similarityAtFirstCheckpoint: similarity,
        predictedFirstMissDay:
          similarity === null ? null : predictedFirstMissDay(similarity, spec.policy),
        observedFirstMissCheckpoint: firstMiss?.checkpointDay ?? null,
        observedFirstMissOutcome: firstMiss?.outcome ?? null,
        observedFirstThresholdOrDecayCheckpoint: firstThresholdOrDecay?.checkpointDay ?? null,
      });
    }
  }
  return rows;
}

/** 候補に上がらなかった（`null`）ものは最下位より後ろとして扱い、中央値がそこに落ちたら「—」と出す。 */
export function formatMedianRank(ranks: readonly (number | null)[]): string {
  const sorted = [...ranks].sort((a, b) => (a ?? Infinity) - (b ?? Infinity));
  const median = sorted[Math.floor((sorted.length - 1) / 2)] ?? null;
  return median === null ? "—" : String(median);
}

function pad(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - [...text].length));
}

export function formatLongHorizonReport(report: LongHorizonReport): string {
  const lines: string[] = [];
  lines.push(
    `模擬期間 ${String(report.days)}日・記憶 ${String(report.memoriesWritten)}件（雑談 ${String(report.fillersPerDay)}件/日）・` +
      `植えた事実 ${String(report.facts.length)}件・測った時点 ${report.checkpointDays.join("/")}日目`,
  );
  lines.push(
    "⚠ 標本は事実が数件ずつである。ここから成功率は主張しない。⚠ 測っているのは「gold の記憶が返ったか」（出典への到達）であり、回答の正しさではない。",
  );

  const cells = aggregateLongHorizon(report.probes);
  for (const factClass of ["habitual", "dormant", "correction"] as const) {
    lines.push("");
    lines.push(`## ${FACT_CLASS_LABEL[factClass]} — 返った件数 / 全件（返らなかった理由の内訳）`);
    lines.push(
      `${pad("arm", 34)}${report.checkpointDays.map((d) => pad(`${String(d)}日`, 22)).join("")}`,
    );
    for (const arm of report.arms) {
      const row = report.checkpointDays.map((day) => {
        const cell = cells.find(
          (c) => c.arm === arm && c.checkpointDay === day && c.factClass === factClass,
        );
        if (cell === undefined) {
          return pad("—", 22);
        }
        const misses = GOLD_OUTCOME_KINDS.filter((k) => k !== "returned" && cell.counts[k] > 0)
          .map(
            (k) =>
              `${k.replace("below_threshold", "thr").replace("not_reached", "nr").replace("outranked", "out").replace("decayed", "dec")}${String(cell.counts[k])}`,
          )
          .join(",");
        return pad(
          `${String(cell.counts.returned)}/${String(cell.total)}${misses ? ` (${misses})` : ""}`,
          22,
        );
      });
      lines.push(`${pad(armLabel(arm), 34)}${row.join("")}`);
    }
  }
  lines.push("");
  lines.push(
    "略号: dec=decayed（忘却ゲート）/ thr=below_threshold（閾値 " +
      String(DEFAULT_SCORE_THRESHOLD) +
      " 未満）/ out=outranked（件数の上限の外）/ nr=not_reached（候補に上がらない）",
  );

  lines.push("");
  lines.push(
    "## gold の診断順位の中央値 / その時点の記憶の総数（閾値・忘却ゲート・件数の上限を外した recall() での順位）",
  );
  for (const factClass of ["habitual", "dormant", "correction"] as const) {
    for (const arm of report.arms) {
      const parts = report.checkpointDays.flatMap((day) => {
        const ranks = report.probes
          .filter(
            (p) =>
              p.arm === arm &&
              p.checkpointDay === day &&
              p.factClass === factClass &&
              p.role === "gold",
          )
          .map((p) => p.diagnostic?.rank ?? null);
        if (ranks.length === 0) {
          return [];
        }
        const memories = report.quantities.find(
          (q) => q.arm === arm && q.checkpointDay === day,
        )?.memoriesWritten;
        return [`${String(day)}日: ${formatMedianRank(ranks)}/${String(memories ?? "?")}`];
      });
      lines.push(`${pad(FACT_CLASS_LABEL[factClass], 10)} ${armLabel(arm)}: ${parts.join(" | ")}`);
    }
  }

  lines.push("");
  lines.push("## 訂正 — 新旧の順位関係（新しい側を植えた後の時点のみ）");
  const orders = aggregateCorrectionOrders(report.probes);
  for (const arm of report.arms) {
    const parts = orders
      .filter((o) => o.arm === arm)
      .sort((a, b) => a.checkpointDay - b.checkpointDay)
      .map(
        (o) =>
          `${String(o.checkpointDay)}日: 新>旧${String(o.counts.new_above_old)} 旧>新${String(o.counts.old_above_new)} 新のみ${String(o.counts.new_only)} 旧のみ${String(o.counts.old_only)} なし${String(o.counts.neither)}`,
      );
    lines.push(`${armLabel(arm)}: ${parts.join(" | ")}`);
  }

  lines.push("");
  lines.push("## 量 — プロンプトの平均文字数 / 全記憶の本文の文字数（naive の代理）");
  for (const arm of report.arms) {
    const parts = report.quantities
      .filter((q) => q.arm === arm)
      .sort((a, b) => a.checkpointDay - b.checkpointDay)
      .map(
        (q) =>
          `${String(q.checkpointDay)}日: ${String(Math.round(q.meanPromptChars))}/${String(q.naiveChars)}`,
      );
    lines.push(`${armLabel(arm)}: ${parts.join(" | ")}`);
  }

  lines.push("");
  lines.push("## 見立て（既定値からの計算）と実測 — 使用報告なしの arm の常用・休眠の gold");
  lines.push(
    "見立て: similarity × 0.5^(t / 実効半減期) が閾値を割る日と、忘却ゲートの日の早いほう。" +
      "閾値/床: 実際に閾値割れか忘却ゲートで最初に落ちた時点（見立てと比べる欄）。最初の取りこぼし: 理由を問わず最初に返らなかった時点。",
  );
  for (const row of buildPredictionRows(report)) {
    const predicted =
      row.predictedFirstMissDay === null ? "—" : `${row.predictedFirstMissDay.toFixed(1)}日`;
    const thresholdOrDecay =
      row.observedFirstThresholdOrDecayCheckpoint === null
        ? "落ちなかった"
        : `${String(row.observedFirstThresholdOrDecayCheckpoint)}日目`;
    const firstMiss =
      row.observedFirstMissCheckpoint === null
        ? "最後まで返った"
        : `${String(row.observedFirstMissCheckpoint)}日目に${row.observedFirstMissOutcome ?? ""}`;
    const sim =
      row.similarityAtFirstCheckpoint === null ? "—" : row.similarityAtFirstCheckpoint.toFixed(3);
    lines.push(
      `${row.arm} ${pad(row.factId, 28)} sim=${sim} 見立て=${pad(predicted, 8)} 閾値/床=${pad(thresholdOrDecay, 8)} 最初の取りこぼし=${firstMiss}`,
    );
  }

  lines.push("");
  lines.push(
    `使用報告の回数: ${report.arms.map((a) => `${a}=${String(report.usageReports[a])}`).join(" ")}`,
  );
  return lines.join("\n");
}

export interface LongHorizonJson {
  schemaVersion: 1;
  measuredAt: string;
  commit: string | null;
  llmMode: string;
  embeddingMode: string;
  embeddingSpace: { provider: string; model: string; dimensions: number };
  days: number;
  fillersPerDay: number;
  memoriesWritten: number;
  checkpointDays: readonly number[];
  arms: { arm: LongHorizonArm; policy: string; usageReporting: boolean }[];
  cells: ReturnType<typeof aggregateLongHorizon>;
  correctionOrders: ReturnType<typeof aggregateCorrectionOrders>;
  quantities: LongHorizonReport["quantities"];
  predictions: PredictionRow[];
  usageReports: LongHorizonReport["usageReports"];
  probes: LongHorizonProbeRecord[];
}

export function buildLongHorizonJson(params: {
  report: LongHorizonReport;
  measuredAt: Date;
  commit: string | null;
  llmMode: string;
  embeddingMode: string;
  embeddingSpace: { provider: string; model: string; dimensions: number };
}): LongHorizonJson {
  const { report } = params;
  const byCheckpointThenArm = <T extends { arm: LongHorizonArm; checkpointDay: number }>(
    items: T[],
  ): T[] =>
    [...items].sort((a, b) => a.checkpointDay - b.checkpointDay || a.arm.localeCompare(b.arm));
  return {
    schemaVersion: 1,
    measuredAt: params.measuredAt.toISOString(),
    commit: params.commit,
    llmMode: params.llmMode,
    embeddingMode: params.embeddingMode,
    embeddingSpace: params.embeddingSpace,
    days: report.days,
    fillersPerDay: report.fillersPerDay,
    memoriesWritten: report.memoriesWritten,
    checkpointDays: report.checkpointDays,
    arms: report.arms.map((arm) => ({ arm, ...LONG_HORIZON_ARM_SPECS[arm] })),
    cells: byCheckpointThenArm(aggregateLongHorizon(report.probes)),
    correctionOrders: byCheckpointThenArm(aggregateCorrectionOrders(report.probes)),
    quantities: byCheckpointThenArm(report.quantities),
    predictions: buildPredictionRows(report),
    usageReports: report.usageReports,
    probes: report.probes,
  };
}

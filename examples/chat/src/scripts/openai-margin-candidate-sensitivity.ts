import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import {
  DEFAULT_MARGIN_DROP_OPTIONS,
  decideMarginDropVerdict,
} from "../verdict-candidate-margin.js";
import { computeMarginStats } from "../identifier-arm.js";

/** 陽性対照: 「出なかった」を事象が無い証明にしない。実測 margin を手で縮めた変異で、探り棒が劣化を捕まえることを示す。実 API・DB は呼ばない。 */

const here = dirname(fileURLToPath(import.meta.url));
const CHAT_ROOT = join(here, "..", "..");
const INPUT_PATH = join(CHAT_ROOT, "openai-margin-candidate-measurement.json");
const OUTPUT_PATH = join(CHAT_ROOT, "openai-margin-candidate-sensitivity.json");

interface ProbeCapture {
  probeId: string;
  goldRank: number | null;
  hit1: boolean;
  margin: number | null;
}
interface GroupCapture {
  group: string;
  probes: ProbeCapture[];
}
interface RoundCapture {
  round: number;
  groups: GroupCapture[];
}
interface MeasurementJson {
  baseline: RoundCapture;
  perRound: RoundCapture[];
}

function loadMeasurement(): MeasurementJson {
  return JSON.parse(readFileSync(INPUT_PATH, "utf-8")) as MeasurementJson;
}

function marginsOf(round: RoundCapture, group: string): (number | null)[] {
  return round.groups.find((g) => g.group === group)!.probes.map((p) => p.margin);
}

function main(): void {
  const measurement = loadMeasurement();
  const GROUP = "identifiersSparse";
  const baselineMargins = marginsOf(measurement.baseline, GROUP);
  const round1 = measurement.perRound.find((r) => r.round === 1)!;
  const observedMargins = marginsOf(round1, GROUP);

  const baselineStats = computeMarginStats(baselineMargins);
  const unit = baselineStats.stdDev!;
  console.log(
    `[sensitivity] ${GROUP} baseline margin stats: count=${baselineStats.count} ` +
      `mean=${baselineStats.mean} stdDev=${unit}`,
  );

  const plainVerdict = decideMarginDropVerdict(observedMargins, baselineMargins);
  console.log(
    `[sensitivity] round1(実測、変異無し): red=${plainVerdict.red} ` +
      `shrunk=${plainVerdict.shrunkProbeCount}/${plainVerdict.comparableProbeCount}`,
  );

  const indexedByBaselineMargin = baselineMargins
    .map((m, i) => ({ i, m }))
    .filter((x): x is { i: number; m: number } => x.m !== null)
    .sort((a, b) => b.m - a.m);

  function mutate(count: number): (number | null)[] {
    const mutated = [...observedMargins];
    const dropAmount = DEFAULT_MARGIN_DROP_OPTIONS.stdDevMultiplier * unit * 2; // 閾値の2倍、確実に超える
    for (let k = 0; k < count; k += 1) {
      const idx = indexedByBaselineMargin[k]!.i;
      const current = mutated[idx];
      if (current !== null && current !== undefined) {
        mutated[idx] = current - dropAmount;
      }
    }
    return mutated;
  }

  const oneProbeShrunk = mutate(DEFAULT_MARGIN_DROP_OPTIONS.minShrunkProbes - 1);
  const oneProbeVerdict = decideMarginDropVerdict(oneProbeShrunk, baselineMargins);
  console.log(
    `[sensitivity] 変異(${DEFAULT_MARGIN_DROP_OPTIONS.minShrunkProbes - 1}件だけ縮める): ` +
      `red=${oneProbeVerdict.red} shrunk=${oneProbeVerdict.shrunkProbeCount}`,
  );

  const thresholdProbesShrunk = mutate(DEFAULT_MARGIN_DROP_OPTIONS.minShrunkProbes);
  const thresholdVerdict = decideMarginDropVerdict(thresholdProbesShrunk, baselineMargins);
  console.log(
    `[sensitivity] 変異(${DEFAULT_MARGIN_DROP_OPTIONS.minShrunkProbes}件縮める、陽性対照): ` +
      `red=${thresholdVerdict.red} shrunk=${thresholdVerdict.shrunkProbeCount}`,
  );

  if (!thresholdVerdict.red) {
    console.error(
      "🔴 陽性対照が red にならなかった——探り棒(margin基準の判定)が死んでいる疑いがある。",
    );
    process.exitCode = 1;
  }

  const output = {
    _readme:
      "Issue #109 残件「A」——候補案1(margin基準)の感度を、実測(OpenAI, " +
      "openai-margin-candidate-measurement.json の round0/round1)を土台にした変異で" +
      "確かめた陽性対照。⛔ 実 API・DBは呼んでいない(既存の実測JSONを読むだけ)。",
    measuredAt: new Date().toISOString(),
    group: GROUP,
    baselineMarginStats: baselineStats,
    plainRound1Verdict: plainVerdict,
    mutationBelowThreshold: {
      shrunkProbeCount: DEFAULT_MARGIN_DROP_OPTIONS.minShrunkProbes - 1,
      verdict: oneProbeVerdict,
    },
    mutationAtThreshold: {
      shrunkProbeCount: DEFAULT_MARGIN_DROP_OPTIONS.minShrunkProbes,
      verdict: thresholdVerdict,
    },
  };
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`, "utf-8");
  console.log(`\n[sensitivity] 書き出した: ${OUTPUT_PATH}`);
}

main();

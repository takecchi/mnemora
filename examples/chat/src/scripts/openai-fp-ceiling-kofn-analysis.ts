import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { clopperPearsonUpperBound } from "../openai-arm-verdict.js";
import {
  binomialAtLeastK,
  empiricalKOfNRedRate,
  pairAgreementRedRate,
} from "../verdict-candidate-kofn.js";
import { tryGitRevParseHead } from "../git-info.js";

/** 手で回す後処理。既存 JSON を読むだけで書き換えない。k-of-n は「N本録画して CI に置いた場合」のシミュレーションで、実装するなら録画コストが N 倍になる。 */

const here = dirname(fileURLToPath(import.meta.url));
const CHAT_ROOT = join(here, "..", "..");
const INPUT_PATH = join(CHAT_ROOT, "openai-embedding-fp-ceiling-measurement.json");
const OUTPUT_PATH = join(CHAT_ROOT, "openai-fp-ceiling-kofn-analysis.json");

interface RoundGroupVerdict {
  group: string;
  red: boolean;
}
interface PerRoundEntry {
  round: number;
  red: boolean;
  groups: RoundGroupVerdict[];
}
interface MeasurementJson {
  commit: string | null;
  rounds: number;
  perRound: PerRoundEntry[];
}

function loadMeasurement(): MeasurementJson {
  const raw: unknown = JSON.parse(readFileSync(INPUT_PATH, "utf-8"));
  return raw as MeasurementJson;
}

function redFlagsFor(measurement: MeasurementJson, group: string): boolean[] {
  return measurement.perRound.map((r) => {
    const g = r.groups.find((gg) => gg.group === group);
    if (g === undefined) {
      throw new Error(`round ${r.round}: 群 ${group} が見つからない`);
    }
    return g.red;
  });
}

const GROUPS = [
  "identifiersSparse",
  "identifiersDense",
  "japaneseNamesSparse",
  "japaneseNamesDense",
  "numeralSparse",
  "numeralDense",
] as const;

function analyzeGroup(measurement: MeasurementJson, group: string) {
  const flags = redFlagsFor(measurement, group);
  const trials = flags.length;
  const redCount = flags.filter(Boolean).length;
  const redRate = redCount / trials;
  const cpUpper = clopperPearsonUpperBound(redCount, trials, 0.05);
  return {
    group,
    trials,
    redCount,
    redRate,
    clopperPearsonUpperBound95: cpUpper,
    empirical: {
      twoOfTwo: empiricalKOfNRedRate(flags, 2, 2),
      threeOfThree: empiricalKOfNRedRate(flags, 3, 3),
      twoOfThree: empiricalKOfNRedRate(flags, 3, 2),
      fiveOfFive: empiricalKOfNRedRate(flags, 5, 5),
    },
    theoreticalUsingRedRate: {
      twoOfTwo: binomialAtLeastK(2, 2, redRate),
      threeOfThree: binomialAtLeastK(3, 3, redRate),
      twoOfThree: binomialAtLeastK(2, 3, redRate),
      fiveOfFive: binomialAtLeastK(5, 5, redRate),
    },
    theoreticalUsingCpUpperBound: {
      twoOfTwo: binomialAtLeastK(2, 2, cpUpper),
      threeOfThree: binomialAtLeastK(3, 3, cpUpper),
      twoOfThree: binomialAtLeastK(2, 3, cpUpper),
      fiveOfFive: binomialAtLeastK(5, 5, cpUpper),
    },
  };
}

function sparseDenseAgreement(measurement: MeasurementJson, sparseKey: string, denseKey: string) {
  const sparseFlags = redFlagsFor(measurement, sparseKey);
  const denseFlags = redFlagsFor(measurement, denseKey);
  const pairs = sparseFlags.map((s, i) => ({ a: s, b: denseFlags[i]! }));
  const agreement = pairAgreementRedRate(pairs);
  let eitherRed = 0;
  let exactlyOneRed = 0;
  for (let i = 0; i < sparseFlags.length; i += 1) {
    const s = sparseFlags[i]!;
    const d = denseFlags[i]!;
    if (s || d) eitherRed += 1;
    if (s !== d) exactlyOneRed += 1;
  }
  return {
    pair: `${sparseKey}/${denseKey}`,
    trials: agreement.trials,
    bothRed: agreement.redCount,
    bothRedClopperPearsonUpperBound95: agreement.clopperPearsonUpperBound95,
    eitherRed,
    exactlyOneRed,
    note:
      exactlyOneRed === 0
        ? "sparse/dense の red 集合は完全に一致した——一致条件(案2の一種)は、この" +
          "データでは偽陽性率を1件も下げない(束ねた集計・単独どちらと比べても同じ)"
        : `sparse/dense が食い違った round が ${exactlyOneRed} 件あった——一致条件は` +
          "偽陽性率を下げる",
  };
}

function main(): void {
  const measurement = loadMeasurement();
  console.log(
    `[openai-fp-ceiling-kofn-analysis] 入力: ${INPUT_PATH}(rounds=${measurement.rounds})`,
  );

  const perGroup = GROUPS.map((g) => analyzeGroup(measurement, g));
  for (const g of perGroup) {
    console.log(
      `  ${g.group}: 単独red=${g.redCount}/${g.trials}(上限${(g.clopperPearsonUpperBound95 * 100).toFixed(2)}%) ` +
        `2-of-2実測=${g.empirical.twoOfTwo.redWindowCount}/${g.empirical.twoOfTwo.windowCount} ` +
        `3-of-3実測=${g.empirical.threeOfThree.redWindowCount}/${g.empirical.threeOfThree.windowCount}`,
    );
  }

  const sparseDenseAgreements = [
    sparseDenseAgreement(measurement, "identifiersSparse", "identifiersDense"),
    sparseDenseAgreement(measurement, "japaneseNamesSparse", "japaneseNamesDense"),
    sparseDenseAgreement(measurement, "numeralSparse", "numeralDense"),
  ];
  for (const a of sparseDenseAgreements) {
    console.log(`  ${a.pair}: ${a.note}`);
  }

  const output = {
    _readme:
      "Issue #109 残件「A」——既存の openai-embedding-fp-ceiling-measurement.json" +
      "(ADR 0316 測定B、K=59)を読み、候補案2(k-of-n・sparse/dense一致)を、新しい実 API " +
      "呼び出し無しで評価した後処理。⛔ 入力ファイルは1バイトも書き換えていない。⛔ " +
      "門ではない。k-of-n は『N本の独立な録画を委託してCIに置いた場合』の実測/理論値" +
      "であり、現状のCI(1本のカセットを再生するだけ)を変更するものではない——" +
      "採用するなら録画コストがN倍になる(verdict-candidate-kofn.ts の doc コメント)。",
    measuredAt: new Date().toISOString(),
    commit: tryGitRevParseHead(process.cwd()),
    inputFile: "openai-embedding-fp-ceiling-measurement.json",
    inputCommit: measurement.commit,
    perGroup,
    sparseDenseAgreements,
  };
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`, "utf-8");
  console.log(`\n[openai-fp-ceiling-kofn-analysis] 書き出した: ${OUTPUT_PATH}`);
}

main();

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

/**
 * Issue #109 残件「A」——マネージャーからの実測依頼: ADR 0316 が**既にコミットした**
 * `openai-embedding-fp-ceiling-measurement.json`（測定B、K=59、実 API）を読み、
 * **候補案2（k-of-n・多数決）**を**新しい実 API 呼び出し無しで**評価する。
 *
 * ⛔ **入力ファイルは読むだけで、1バイトも書き換えない。**`openai-arm-verdict.ts`にも
 * 触れていない——`clopperPearsonUpperBound`（変更していない）と、この Issue の
 * ために新設した `verdict-candidate-kofn.ts`（変更していない、このスクリプトが
 * 呼ぶだけ）を使う。
 *
 * ## やること
 *
 * 1. 6群それぞれについて、round 1..59 の `red` フラグ列（既存 JSON の `perRound[].groups[].red`、
 *    ADR 0316 の判定=案0で確定済みの値）を取り出す。
 * 2. **sparse/dense 一致**（追加録画なしで CI 実装可能な案2の一種）を実測する——
 *    同じ round で sparse と dense が両方 red だったか、片方だけだったかを数える。
 * 3. **k-of-n（N本の独立な録画のうち k本以上）**を、既存59巡を「N個ずつ重ならない窓」に
 *    区切って実測する（`empiricalKOfNRedRate`）——これは「N本委託録画してCIに置いた場合」の
 *    シミュレーションであり、実装するなら録画コストがN倍になることに注意
 *    （`verdict-candidate-kofn.ts` の doc コメント）。
 * 4. 二項分布による理論値（`binomialAtLeastK`）も、実測 red 率とその
 *    Clopper–Pearson 片側95%上限の両方を p として代入し、参考値として併記する。
 *
 * ## 使い方
 *
 * ```
 * tsx examples/chat/src/scripts/openai-fp-ceiling-kofn-analysis.ts
 * ```
 *
 * ⛔ DB も実 API も呼ばない——既存 JSON を読むだけの純粋な後処理。
 */

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

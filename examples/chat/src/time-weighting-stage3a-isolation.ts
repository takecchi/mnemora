import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createTimeWeightingBenchRuntime,
  runTimeWeightingCase,
  type TimeWeightingContextDiagnosticEntry,
  type TimeWeightingTrialResult,
} from "./time-weighting-bench.js";
import { TIME_WEIGHTING_CASE_SET_EVAL_UNDATED } from "./time-weighting-case-set.eval-undated.js";

/**
 * 段3a（マネージャー指示、Issue #690）の切り分け専用スクリプト。
 *
 * ⛔ **cli.ts の dispatch には配線しない。** 1ケース（`eval-undated-c1-seat-floor-reinforced`）
 * だけを、temperature 未指定/temperature=0 の2通りで各方針20回ずつ実API（live）で
 * 走らせる、一度きりの切り分け実験である——恒久的な CLI サブコマンドにする理由が無い。
 *
 * **実行**（DATABASE_URL・OPENAI_API_KEY が要る。実 API を叩く——マネージャーが
 * 明示的に許可した1ケースのみ）:
 *
 * ```
 * DATABASE_URL=... OPENAI_API_KEY=... npx tsx src/time-weighting-stage3a-isolation.ts
 * ```
 *
 * 出力: `examples/chat/bench-results/answer-time-weighting-stage3a-isolation.json`
 * （生データ）と、標準出力への集計表。
 */

const TARGET_CASE_ID = "eval-undated-c1-seat-floor-reinforced";
const OLD_LOCAL_ID = "old-seat-undated";
const RUNS_PER_POLICY = 20;

const here = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = join(
  here,
  "..",
  "bench-results",
  "answer-time-weighting-stage3a-isolation.json",
);

interface TemperatureSettingResult {
  label: "unspecified" | "zero";
  llmTemperature: number | undefined;
  trials: TimeWeightingTrialResult[];
}

function findDiagnostic(
  entries: readonly TimeWeightingContextDiagnosticEntry[],
  localId: string,
): TimeWeightingContextDiagnosticEntry | undefined {
  return entries.find((e) => e.localId === localId);
}

async function runSetting(
  databaseUrl: string,
  label: "unspecified" | "zero",
  llmTemperature: number | undefined,
): Promise<TemperatureSettingResult> {
  const targetCase = TIME_WEIGHTING_CASE_SET_EVAL_UNDATED.find((c) => c.id === TARGET_CASE_ID);
  if (targetCase === undefined) {
    throw new Error(`stage3a-isolation: case "${TARGET_CASE_ID}" が見つからない。`);
  }

  const handle = await createTimeWeightingBenchRuntime(
    databaseUrl,
    { ...process.env, MNEMORA_LLM: "openai", MNEMORA_EMBEDDING: "openai" },
    llmTemperature !== undefined ? { llmTemperature } : {},
  );
  console.log(
    `\n########## stage3a-isolation: temperature=${label}（llmMode=${handle.llmMode}） ##########`,
  );
  try {
    const trials: TimeWeightingTrialResult[] = [];
    for (let trial = 1; trial <= RUNS_PER_POLICY; trial += 1) {
      const result = await runTimeWeightingCase(
        handle,
        targetCase,
        `stage3a-isolation-${label}`,
        trial,
      );
      trials.push(result);
      console.log(
        `  trial ${trial}/${RUNS_PER_POLICY}: ` +
          `legacy=${result.byPolicy.legacy.verdict} ` +
          `eventAwareFreshness=${result.byPolicy.eventAwareFreshness.verdict}`,
      );
    }
    if (handle.usageMeter) {
      console.log(`\n${handle.usageMeter.formatReport()}`);
    }
    return { label, llmTemperature, trials };
  } finally {
    await handle.close();
  }
}

function summarize(setting: TemperatureSettingResult): void {
  console.log(`\n--- 集計: temperature=${setting.label} ---`);
  for (const policy of ["legacy", "eventAwareFreshness"] as const) {
    let passCount = 0;
    let rank1Count = 0;
    let enteredContextCount = 0;
    for (const trial of setting.trials) {
      const p = trial.byPolicy[policy];
      if (p.verdict === "pass") {
        passCount += 1;
      }
      const oldDiag = findDiagnostic(p.contextDiagnostics, OLD_LOCAL_ID);
      if (oldDiag === undefined) {
        continue;
      }
      if (oldDiag.rank === 1) {
        rank1Count += 1;
      }
      if (oldDiag.enteredContext) {
        enteredContextCount += 1;
      }
    }
    console.log(
      `  ${policy}: gradeAnswer pass=${passCount}/${setting.trials.length}, ` +
        `古い予定(${OLD_LOCAL_ID}) rank1=${rank1Count}/${setting.trials.length}, ` +
        `文脈に入った=${enteredContextCount}/${setting.trials.length}`,
    );
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("stage3a-isolation: DATABASE_URL が要る。");
  }
  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      "stage3a-isolation: 実APIを叩く切り分け実験である。OPENAI_API_KEY を設定すること。",
    );
  }

  const settings: TemperatureSettingResult[] = [];
  settings.push(await runSetting(databaseUrl, "unspecified", undefined));
  settings.push(await runSetting(databaseUrl, "zero", 0));

  for (const setting of settings) {
    summarize(setting);
  }

  writeFileSync(
    OUTPUT_PATH,
    `${JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        targetCaseId: TARGET_CASE_ID,
        oldLocalId: OLD_LOCAL_ID,
        runsPerPolicy: RUNS_PER_POLICY,
        settings,
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
  console.log(`\n書き出した: ${OUTPUT_PATH}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

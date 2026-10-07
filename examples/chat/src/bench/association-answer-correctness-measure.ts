import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { TimeWeightingPolicy } from "@mnemora/core";
import { DEFAULT_RECALL_ASSOCIATION } from "@mnemora/core";
import type { AnswerVerdict } from "../answer-case.js";
import { cassettePathFor, loadCassette } from "../cassette-io.js";
import { tryGitRevParseHead } from "../git-info.js";
import { OPENAI_LLM_MODEL } from "../providers.js";
import { newRunToken } from "../retrieval-quality.js";
import {
  createTimeWeightingBenchRuntime,
  runTimeWeightingCase,
  type TimeWeightingBenchRuntimeHandle,
} from "../time-weighting-bench.js";
import { TIME_WEIGHTING_CASE_SET_DEV } from "../time-weighting-case-set.dev.js";
import { TIME_WEIGHTING_CASE_SET_EVAL } from "../time-weighting-case-set.eval.js";
import { TIME_WEIGHTING_CASE_SET_EVAL_UNDATED } from "../time-weighting-case-set.eval-undated.js";
import type { TimeWeightingCase } from "../time-weighting-case.js";
import {
  aggregateByPair,
  assertWithinHardCallLimit,
  chooseTrialCount,
  formatPairKey,
  overallRate,
  summarizeSignTest,
  type ChangedPair,
  type PairedTrialOutcome,
} from "./association-answer-correctness-measure-lib.js";

/**
 * 連想枠の off/on10 で回答の正誤が変わるかを測る道具本体。
 *
 * 段2の埋め込みは `recorded` を流用し、実 API を呼ばない。連想枠は `VectorStore.getVectors`/`search` しか呼ばず、
 * `embed()` の入力集合が off/on で変わらないため、既存カセットで足りる。
 * 新しいカセットは記録しない。ここで得る応答は使い捨ての実測で、既存カセットは書き換えない。
 * 呼び出し回数は `HARD_CALL_LIMIT` に達する前に、呼ぶ前のチェックで止める。
 */

const HARD_CALL_LIMIT = 200;
const PAIRED_CALL_BUDGET = 190;
const TRIAL_CAP = 5;

const OFF = null;
const ON10 = DEFAULT_RECALL_ASSOCIATION;

const OUTPUT_DIR = join(
  new URL("../../bench-results/association-answer-correctness-2026-09-26/", import.meta.url)
    .pathname,
);

interface PairDiffDetail {
  caseId: string;
  policy: TimeWeightingPolicy;
  changed: boolean;
  offChars: number;
  onChars: number;
  offMemLines: number;
  onMemLines: number;
}

function countMemoryLines(prompt: string): number {
  return prompt.split("\n").filter((l) => l.startsWith("- [由来:")).length;
}

function allTimeWeightingCases(): TimeWeightingCase[] {
  return [
    ...TIME_WEIGHTING_CASE_SET_DEV,
    ...TIME_WEIGHTING_CASE_SET_EVAL,
    ...TIME_WEIGHTING_CASE_SET_EVAL_UNDATED,
  ];
}

async function detectChangedPairs(
  databaseUrl: string,
  embeddingMode: "recorded" | "local",
  cassette: ReturnType<typeof loadCassette> | undefined,
): Promise<PairDiffDetail[]> {
  const handle = await createTimeWeightingBenchRuntime(
    databaseUrl,
    { ...process.env, MNEMORA_LLM: "deterministic", MNEMORA_EMBEDDING: embeddingMode },
    embeddingMode === "recorded" ? { cassette } : {},
  );
  try {
    if (embeddingMode === "local") {
      const { warmupLocalEmbedding } = await import("../local-embedding-warmup.js");
      const warmup = await warmupLocalEmbedding(handle.embeddingProvider);
      if (!warmup.ok) {
        throw new Error(`local embedding warmup に失敗した: ${warmup.detail}`);
      }
    }
    const cases = allTimeWeightingCases();
    const runToken = newRunToken();
    const details: PairDiffDetail[] = [];
    for (const c of cases) {
      const off = await runTimeWeightingCase(
        handle,
        c,
        `assoc-correctness-detect-off-${embeddingMode}-${runToken}`,
        1,
        OFF,
      );
      const on = await runTimeWeightingCase(
        handle,
        c,
        `assoc-correctness-detect-on10-${embeddingMode}-${runToken}`,
        1,
        ON10,
      );
      for (const policy of Object.keys(off.byPolicy) as TimeWeightingPolicy[]) {
        const offP = off.byPolicy[policy];
        const onP = on.byPolicy[policy];
        details.push({
          caseId: c.id,
          policy,
          changed: offP.prompt !== onP.prompt,
          offChars: offP.prompt.length,
          onChars: onP.prompt.length,
          offMemLines: countMemoryLines(offP.prompt),
          onMemLines: countMemoryLines(onP.prompt),
        });
      }
    }
    return details;
  } finally {
    await handle.close();
  }
}

interface TrialSideResult {
  verdict: AnswerVerdict;
  answer: string;
  promptChars: number;
  memLines: number;
}

interface PairedTrialRecord {
  pair: ChangedPair;
  trial: number;
  off: TrialSideResult;
  on: TrialSideResult;
}

function findCase(cases: readonly TimeWeightingCase[], caseId: string): TimeWeightingCase {
  const found = cases.find((c) => c.id === caseId);
  if (found === undefined) {
    throw new Error(`findCase: "${caseId}" が見つからない。`);
  }
  return found;
}

async function runOneSide(
  handle: TimeWeightingBenchRuntimeHandle,
  cases: readonly TimeWeightingCase[],
  pair: ChangedPair,
  arm: "off" | "on",
  trial: number,
  callCounterLabel: string,
): Promise<TrialSideResult> {
  assertWithinHardCallLimit(
    handle.llmProvider.snapshot().answerCalls,
    HARD_CALL_LIMIT,
    callCounterLabel,
  );
  const association = arm === "off" ? OFF : ON10;
  const sanitizedPairKey = formatPairKey(pair).replace(/\//g, "--");
  const tenantPrefix = `assoc-correctness-real-${sanitizedPairKey}-${arm}`;
  const result = await runTimeWeightingCase(
    handle,
    findCase(cases, pair.caseId),
    tenantPrefix,
    trial,
    association,
    [pair.policy],
  );
  const policyResult = result.byPolicy[pair.policy];
  if (policyResult === undefined) {
    throw new Error(
      `runOneSide: ${formatPairKey(pair)} trial=${trial} arm=${arm} の結果が無い（到達しないはず）。`,
    );
  }
  return {
    verdict: policyResult.verdict,
    answer: policyResult.answer,
    promptChars: policyResult.inputChars,
    memLines: countMemoryLines(policyResult.prompt),
  };
}

async function runRealApiPhase(
  databaseUrl: string,
  cassette: ReturnType<typeof loadCassette>,
  changedPairs: ChangedPair[],
  n: number,
): Promise<{ trials: PairedTrialRecord[]; totalRealApiCalls: number }> {
  const cases = allTimeWeightingCases();
  const handle = await createTimeWeightingBenchRuntime(
    databaseUrl,
    { ...process.env, MNEMORA_LLM: "openai", MNEMORA_EMBEDDING: "recorded" },
    { cassette },
  );
  const trials: PairedTrialRecord[] = [];
  try {
    let isFirst = true;
    for (const pair of changedPairs) {
      for (let trial = 1; trial <= n; trial += 1) {
        const label = `${formatPairKey(pair)} trial=${trial}`;
        if (isFirst) {
          console.log(
            `\n[smoke] 最初の1組×1回で混在指定(openai LLM + recorded embedding)を確認する: ${label}`,
          );
        }
        const off = await runOneSide(handle, cases, pair, "off", trial, `${label} off`);
        if (isFirst) {
          console.log(
            `[smoke] off 成功: verdict=${off.verdict} answer="${off.answer.slice(0, 40)}"`,
          );
        }
        const on = await runOneSide(handle, cases, pair, "on", trial, `${label} on`);
        if (isFirst) {
          console.log(`[smoke] on  成功: verdict=${on.verdict} answer="${on.answer.slice(0, 40)}"`);
          console.log(
            `[smoke] 混在指定は動く。本番へ続行する（呼び出し済み: ${handle.llmProvider.snapshot().answerCalls}回）。\n`,
          );
          isFirst = false;
        }
        trials.push({ pair, trial, off, on });
        console.log(
          `  ${label}: off=${off.verdict} on=${on.verdict}` +
            (off.verdict !== on.verdict ? "  ⚠ 食い違い" : ""),
        );
      }
    }
    return { trials, totalRealApiCalls: handle.llmProvider.snapshot().answerCalls };
  } finally {
    await handle.close();
  }
}

function sha256OfFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL が無い。");
  }
  const measuredAt = new Date().toISOString();
  const commit = tryGitRevParseHead(process.cwd());
  const cassettePath = cassettePathFor("answer-time-weighting");
  const cassette = loadCassette(cassettePath);
  const cassetteSha256 = sha256OfFile(cassettePath);

  console.log("########## 段1: off/on10 の回答プロンプト差を数える(実 API ゼロ) ##########");
  console.log(`カセット: ${cassettePath}`);
  console.log(`  sha256: ${cassetteSha256}`);
  console.log(`  recordedAt: ${cassette.recordedAt ?? "(無し)"}`);

  const recordedDetails = await detectChangedPairs(databaseUrl, "recorded", cassette);
  const recordedChanged = recordedDetails.filter((d) => d.changed);
  console.log(
    `\n[recorded embedding] ${recordedDetails.length}組中 ${recordedChanged.length}組で変化:`,
  );
  for (const d of recordedDetails) {
    console.log(
      `  ${d.changed ? "CHANGED" : "same   "} ${d.caseId}/${d.policy}: ` +
        `chars ${d.offChars}->${d.onChars} memLines ${d.offMemLines}->${d.onMemLines}`,
    );
  }

  const localDetails = await detectChangedPairs(databaseUrl, "local", undefined);
  const localChanged = localDetails.filter((d) => d.changed);
  console.log(
    `\n[local embedding(参考)] ${localDetails.length}組中 ${localChanged.length}組で変化`,
  );

  const changedPairs: ChangedPair[] = recordedChanged.map((d) => ({
    caseId: d.caseId,
    policy: d.policy,
  }));

  const n = chooseTrialCount(changedPairs.length, PAIRED_CALL_BUDGET, TRIAL_CAP);
  console.log(
    `\n段1確定: recorded embedding で変わった組 = ${changedPairs.length} 件。` +
      `n(試行回数) = ${n}（予算${PAIRED_CALL_BUDGET}回 ÷ (2×${changedPairs.length}組) を ${TRIAL_CAP} で cap）`,
  );

  let realApiResult: { trials: PairedTrialRecord[]; totalRealApiCalls: number } = {
    trials: [],
    totalRealApiCalls: 0,
  };
  if (changedPairs.length === 0) {
    console.log("\n変わった組が無いため、段2(実 API)は実行しない。");
  } else {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error(
        "OPENAI_API_KEY が無い。段2は実 API(gpt-4o-mini)を叩く——鍵を設定してから実行すること。",
      );
    }
    console.log(`\n########## 段2: 実 API(${OPENAI_LLM_MODEL})で対にして回す ##########`);
    console.log(
      `LLM: openai(${OPENAI_LLM_MODEL}, temperature=未指定=provider既定) / Embedding: recorded(既存カセットを流用、embed()の実API呼び出しは0回見込み)`,
    );
    realApiResult = await runRealApiPhase(databaseUrl, cassette, changedPairs, n);
  }

  const outcomes: PairedTrialOutcome[] = realApiResult.trials.map((t) => ({
    pair: t.pair,
    trial: t.trial,
    offVerdict: t.off.verdict,
    onVerdict: t.on.verdict,
  }));
  const byPair = aggregateByPair(outcomes);
  const offOverall = overallRate(outcomes.map((o) => o.offVerdict));
  const onOverall = overallRate(outcomes.map((o) => o.onVerdict));
  const signTest = summarizeSignTest(outcomes);

  console.log("\n########## 集計 ##########");
  console.log(
    `実 API 呼び出し回数（回答生成のみ。judge は無い）: ${realApiResult.totalRealApiCalls} / 上限 ${HARD_CALL_LIMIT}`,
  );
  console.log(
    `off 全体正答率: ${offOverall.passCount}/${offOverall.total} (${(offOverall.rate * 100).toFixed(1)}%)`,
  );
  console.log(
    `on  全体正答率: ${onOverall.passCount}/${onOverall.total} (${(onOverall.rate * 100).toFixed(1)}%)`,
  );
  console.log(
    `対にした差: on正・off誤=${signTest.onWinsOffLoses} / off正・on誤=${signTest.offWinsOnLoses} / ` +
      `一致=${signTest.concordant} / 符号検定(exact) p=${signTest.pValue.toFixed(4)}`,
  );
  for (const p of byPair) {
    console.log(
      `  ${formatPairKey(p.pair)}: off ${p.offPassCount}/${p.n} / on ${p.onPassCount}/${p.n}`,
    );
  }

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const json = {
    measuredAt,
    commit,
    // 実行した器の絶対パスをそのまま書き出さない。作業ディレクトリに依存する値を repo に焼き込まないため、`examples/chat/cassettes/` 配下の相対パスだけ残す。
    cassette: {
      path: join("examples", "chat", "cassettes", basename(cassettePath)),
      sha256: cassetteSha256,
      recordedAt: cassette.recordedAt ?? null,
    },
    llmModel: OPENAI_LLM_MODEL,
    temperature: "provider既定（未指定）",
    hardCallLimit: HARD_CALL_LIMIT,
    pairedCallBudget: PAIRED_CALL_BUDGET,
    trialCap: TRIAL_CAP,
    phase1: {
      recorded: {
        totalPairs: recordedDetails.length,
        changedCount: recordedChanged.length,
        details: recordedDetails,
      },
      local: {
        totalPairs: localDetails.length,
        changedCount: localChanged.length,
        details: localDetails,
      },
    },
    changedPairs,
    n,
    realApi: {
      llmMode: "openai",
      embeddingMode: "recorded",
      totalRealApiCalls: realApiResult.totalRealApiCalls,
      trials: realApiResult.trials,
    },
    aggregate: {
      byPair,
      offOverall,
      onOverall,
      signTest,
    },
  };
  const jsonPath = join(OUTPUT_DIR, "measure-run.json");
  writeFileSync(jsonPath, `${JSON.stringify(json, null, 2)}\n`, "utf-8");
  console.log(`\n書き出した: ${jsonPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

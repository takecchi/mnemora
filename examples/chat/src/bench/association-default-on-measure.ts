#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Omission } from "@mnemora/core";
import {
  COMPARE_CASSETTE_PATH,
  RETRIEVAL_CASSETTE_PATH,
  cassetteExists,
  loadCassette,
} from "../cassette-io.js";
import { ANSWER_CASE_SET_DEV } from "../answer-case-set.dev.js";
import { ANSWER_CASE_SET_EVAL } from "../answer-case-set.eval.js";
import { createAnswerBenchRuntime, runAnswerBench } from "../answer-bench.js";
import { DEFAULT_COMPARE_SEQUENCE, runComparison } from "../compare.js";
import type { ComparisonRow } from "../compare.js";
import { runConsolidationCost } from "../consolidation-cost.js";
import { createMutableClock } from "../mutable-clock.js";
import { tryGitRevParseHead } from "../git-info.js";
import {
  IDENTIFIER_PROBE_SET_SPEC,
  runIdentifierProbeArm,
} from "../identifier-arm.js";
import type { IdentifierArmReport } from "../identifier-arm.js";
import { NUMERAL_TOKEN_PROBE_SET_SPEC } from "../numeral-token-probe-set.js";
import { warmupLocalEmbedding } from "../local-embedding-warmup.js";
import { armHeadline, buildArmTenantId, newRunToken, runRetrievalQualityArm } from "../retrieval-quality.js";
import type { ArmReport } from "../retrieval-quality.js";
import { createExampleRuntime } from "../runtime-factory.js";
import { TIME_WEIGHTING_CASE_SET_DEV } from "../time-weighting-case-set.dev.js";
import { createTimeWeightingBenchRuntime, runTimeWeightingBench } from "../time-weighting-bench.js";
import type { TimeWeightingTrialResult } from "../time-weighting-bench.js";
import { runTimeTermArm } from "../time-term-arm.js";
import type { TimeTermArmReport, PairOutcome } from "../time-term-arm.js";
import { runValidityArm } from "../validity-arm.js";
import type { ValidityArmReport } from "../validity-arm.js";
import {
  ASSOCIATION_LEVELS,
  buildNumberDiffTable,
  fillMissingKeysWithZero,
  formatNumberDiffCell,
  parsePromptIndexLine,
  tallyStrings,
} from "./association-default-on-measure-lib.js";
import type { AssociationLevel } from "./association-default-on-measure-lib.js";

/**
 * ADR 0337 追記(2026-09-26)の測定本体。
 *
 * ## これは何を測るか
 *
 * PR #838(ADR 0337)は `RecallQuery.association` の既定を on(`maxCount:10`)に
 * したが、根拠は合成12問(ADR 0332/0168)だけである。リリース 1.1.0 の前に、
 * **既存の記録済みベンチ**(`retrieval`/`compare`/`time-term`/`validity`/
 * `answer-time-weighting`/`answer`、および安く走る `identifier-probes`/
 * `numeral-token-probes`/`consolidation-cost`)の上で、連想枠を
 * **off(null) / on(maxCount:5) / on(maxCount:10、既定) / on(maxCount:20)**
 * の4通りに振ったときに、各ベンチの指標(品質・載る量・omitted・連想枠経由の件数)が
 * どれだけ動くかを記録する。
 *
 * ⛔ **これは既定を戻すかどうかを決めるための測定ではない**(マネージャー指示、
 * ADR 0337 の「確かめていないこと」節と同じ範囲)。記録するだけである。
 *
 * ## どの層で測るか(⚠ ベンチごとに違う。表は本体の実行ログ・ADR 0337 追記に書く)
 *
 * - **retrieval-quality**: `llmMode=deterministic` / `embeddingMode=recorded`
 *   (`retrieval.json` カセット、arm B と同じ組み合わせ)。連想枠は
 *   `VectorStore.getVectors`/`search` しか呼ばない(`recall-runtime.ts` 段3.5)ため、
 *   embedding の recorded 再生に新しい入力は増えない——例外は起きない想定である
 *   (実測して確かめる。起きたら「所見」として記録する)。
 * - **compare**: `llmMode=recorded` / `embeddingMode=recorded`(`compare.json`)。
 *   ingest(抽出)は連想枠の影響を受けない——上と同じ理由で例外は起きない想定。
 * - **time-term/validity**: `llmMode=deterministic` / `embeddingMode=local`
 *   (CLI の既定は `deterministic`+`deterministic` だが、それでは連想枠が拾う近傍が
 *   意味を持たない——AGENTS.md「`deterministic` で測った想起の質は、性能について
 *   何も言っていない」。この測定だけ `local` へ明示的に上書きする)。
 * - **identifier-probes/numeral-token-probes**: `llmMode=deterministic` /
 *   `embeddingMode=local`(既存 CI ジョブと同じ層。sparse haystack のみ、
 *   dense/japanese-name 群は時間の都合で対象外——「確かめていないこと」に明記する)。
 * - **consolidation-cost**: `llmMode=deterministic` / `embeddingMode=local`
 *   (既存 CI ジョブと同じ層)。**時間の都合で `budgetLadder` を既定の9段から
 *   2段に減らす**(`[32, 128]`。`DEFAULT_BUDGET_LADDER` 自体は変えていない
 *   ——この測定スクリプトが渡す値だけを削っている)。
 * - **answer-time-weighting/answer(recall 側)**: `llmMode=deterministic` /
 *   `embeddingMode=local`。**回答の正誤(verdict)は読まない**——deterministic LLM の
 *   出力は実際の言語理解を経ていないため、正誤の判定に意味を持たせられない
 *   (AGENTS.md 同上)。読むのは recall 側の量(`recallMemoryCount`/`inputChars`/
 *   `inputEstimatedTokens`/索引行の `totalInScope`/`returned`)だけである。
 *   dev 集合のみを使う(`answer` は dev+eval)。
 *
 * ## archive-sweep-cost は対象外にした
 *
 * `archive-sweep-cost.ts` にも `association` オプションを足した(加算)が、この
 * スクリプトでは実行していない——`decayClock`/`MutableClock` によるバックデート・
 * `sweepArchive()` の呼び出しを正しく組むコストが、他のベンチに比べて高く、
 * 今回の時間予算では見送った。「確かめていないこと」に明記する。
 *
 * ## 実 API は使わない
 *
 * ここで測る4段の差は、すべて `recorded`/`local` 層で決定的に観測できる
 * (recall() の候補集合・量・omitted は provider 層に依らず構造的に決まる)。
 * gpt-4o-mini による再測定が要るのは「回答の正誤が on/off で変わるか」のような
 * 問いだけであり、この測定はその問いを対象にしていない(answer-time-weighting/
 * answer は recall 側の量だけを読む)——ADR 0337 自身が「回答の質…は測定していない」
 * と明記している範囲と同じ。⟹ 実 API 呼び出しは0回。
 */

// ---------------------------------------------------------------------------
// 共通ユーティリティ
// ---------------------------------------------------------------------------

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL が設定されていません。examples/chat/README.md / AGENTS.md" +
        "「手元で Postgres を立てる」の手順で用意すること。",
    );
  }
  return url;
}

/** `Omission` の kind の全体(`compare.ts` の `formatOmittedSummary` の switch と同じ列)。
 *  `fillMissingKeysWithZero` の対象を固定するためだけに、この配列でここへ写す。 */
const ALL_OMISSION_KINDS: readonly Omission["kind"][] = [
  "not_indexed",
  "filtered",
  "below_threshold",
  "over_limit",
  "budget_dropped",
  "stage_skipped",
  "ann_truncated",
  "ann_unreached",
  "lexical_truncated",
  "unit_assembly_dropped",
  "score_not_comparable",
];

/** `time-term-arm.ts` の `PairOutcome` の全体。`fillMissingKeysWithZero` の対象を固定する。 */
const ALL_PAIR_OUTCOMES: readonly PairOutcome[] = [
  "newer-ranked-higher",
  "older-ranked-higher",
  "tied",
  "newer-not-returned",
  "older-not-returned",
  "neither-returned",
  "collapsed",
];

/** `Omission` を「kind別」より少し細かい理由キーへ写す(`not_indexed:reason` 等)。 */
function omissionReasonKey(o: Omission): string {
  switch (o.kind) {
    case "not_indexed":
      return `not_indexed:${o.reason}`;
    case "filtered":
      return `filtered:${o.condition}`;
    default:
      return o.kind;
  }
}

interface Note {
  bench: string;
  detail: string;
}

const notes: Note[] = [];

function recordNote(bench: string, detail: string): void {
  notes.push({ bench, detail });
  console.log(`[association-default-on-measure] 所見(${bench}): ${detail}`);
}

// ---------------------------------------------------------------------------
// retrieval-quality
// ---------------------------------------------------------------------------

interface RetrievalQualityLevelResult {
  level: AssociationLevel["key"];
  headline: Record<string, number>;
  raw: ArmReport;
}

async function measureRetrievalQuality(databaseUrl: string): Promise<RetrievalQualityLevelResult[]> {
  console.log("\n=== retrieval-quality(llm=deterministic, embedding=recorded) ===");
  if (!cassetteExists(RETRIEVAL_CASSETTE_PATH)) {
    recordNote("retrieval-quality", "retrieval.json カセットが無いため測定をスキップした。");
    return [];
  }
  const cassette = loadCassette(RETRIEVAL_CASSETTE_PATH);
  const handle = await createExampleRuntime(
    databaseUrl,
    { ...process.env, MNEMORA_LLM: "deterministic", MNEMORA_EMBEDDING: "recorded" },
    { cassette },
  );
  const results: RetrievalQualityLevelResult[] = [];
  try {
    const runToken = newRunToken();
    for (const level of ASSOCIATION_LEVELS) {
      const tenantId = buildArmTenantId(`assoc-measure-retrieval-${level.key}`, runToken);
      let report: ArmReport;
      try {
        report = await runRetrievalQualityArm({
          armLabel: `association-default-on-measure/retrieval-quality/${level.key}`,
          tenantId,
          runtime: handle.runtime,
          memoryStore: handle.memoryStore,
          llmMode: handle.llmMode,
          embeddingMode: handle.embeddingMode,
          association: level.association,
        });
      } catch (error) {
        recordNote(
          "retrieval-quality",
          `level=${level.key} で例外が起きた(recorded カセットに無い入力が出たとみられる): ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      const headline = armHeadline(report);
      results.push({
        level: level.key,
        headline: {
          mrrOverall: headline.mrrOverall,
          hit1Count: headline.hit1Count,
          hit10Count: headline.hit10Count,
          probeCount: headline.probeCount,
          recalledRows: headline.recalledRows,
          associationRows: report.probes.reduce((sum, p) => sum + (p.associationRows ?? 0), 0),
          ...fillMissingKeysWithZero(
            tallyStrings(report.probes.flatMap((p) => p.omittedKinds)),
            ALL_OMISSION_KINDS,
          ),
        },
        raw: report,
      });
      console.log(
        `  ${level.label}: mrr=${headline.mrrOverall.toFixed(3)} hit@1=${headline.hit1Count}/${headline.probeCount} ` +
          `hit@10=${headline.hit10Count}/${headline.probeCount} associationRows=` +
          `${report.probes.reduce((sum, p) => sum + (p.associationRows ?? 0), 0)}`,
      );
    }
  } finally {
    await handle.close();
  }
  return results;
}

// ---------------------------------------------------------------------------
// compare
// ---------------------------------------------------------------------------

interface CompareLevelResult {
  level: AssociationLevel["key"];
  headline: Record<string, number>;
  raw: ComparisonRow[];
}

function compareHeadline(rows: readonly ComparisonRow[]): Record<string, number> {
  const omittedReasonTally = fillMissingKeysWithZero(
    tallyStrings(rows.flatMap((r) => r.omitted.map(omissionReasonKey))),
    // compare は `not_indexed`/`filtered` 以外の kind もそのまま出うる(`ALL_OMISSION_KINDS`
    // のうち reason 分割しない kind はそのままの名前で入るため、両方の列を渡す)。
    [
      ...ALL_OMISSION_KINDS,
      "not_indexed:pending",
      "not_indexed:embed_failed",
      "filtered:tenant",
      "filtered:status",
      "filtered:archived",
      "filtered:decayed",
      "filtered:expired",
      "filtered:not_yet_valid",
      "filtered:labels",
      "filtered:taxonomy",
    ],
  );
  return {
    totalMnemoraChars: rows.reduce((sum, r) => sum + r.mnemoraChars, 0),
    totalReturnedCount: rows.reduce((sum, r) => sum + r.returnedCount, 0),
    totalAssociationRows: rows.reduce((sum, r) => sum + (r.associationRows ?? 0), 0),
    factStatementSurvivedCount: rows.filter((r) => r.factStatementSurvived).length,
    rowCount: rows.length,
    ...omittedReasonTally,
  };
}

async function measureCompare(databaseUrl: string): Promise<CompareLevelResult[]> {
  console.log("\n=== compare(llm=recorded, embedding=recorded) ===");
  if (!cassetteExists(COMPARE_CASSETTE_PATH)) {
    recordNote("compare", "compare.json カセットが無いため測定をスキップした。");
    return [];
  }
  const cassette = loadCassette(COMPARE_CASSETTE_PATH);
  const handle = await createExampleRuntime(
    databaseUrl,
    { ...process.env, MNEMORA_LLM: "recorded", MNEMORA_EMBEDDING: "recorded" },
    { cassette },
  );
  const results: CompareLevelResult[] = [];
  try {
    const runToken = newRunToken();
    for (const level of ASSOCIATION_LEVELS) {
      let rows: ComparisonRow[];
      try {
        rows = await runComparison(handle.runtime, {
          fillerPairsSequence: DEFAULT_COMPARE_SEQUENCE,
          tenantPrefix: `assoc-measure-compare-${level.key}-${runToken}`,
          memoryStore: handle.memoryStore,
          association: level.association,
        });
      } catch (error) {
        recordNote(
          "compare",
          `level=${level.key} で例外が起きた(recorded カセットに無い入力が出たとみられる): ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      const headline = compareHeadline(rows);
      results.push({ level: level.key, headline, raw: rows });
      console.log(
        `  ${level.label}: totalMnemoraChars=${headline.totalMnemoraChars} ` +
          `totalReturnedCount=${headline.totalReturnedCount} associationRows=${headline.totalAssociationRows}`,
      );
    }
  } finally {
    await handle.close();
  }
  return results;
}

// ---------------------------------------------------------------------------
// time-term / validity(llm=deterministic, embedding=local)
// ---------------------------------------------------------------------------

interface TimeTermLevelResult {
  level: AssociationLevel["key"];
  headline: Record<string, number>;
  raw: TimeTermArmReport;
}

async function measureTimeTerm(databaseUrl: string): Promise<TimeTermLevelResult[]> {
  console.log("\n=== time-term(llm=deterministic, embedding=local) ===");
  const clock = createMutableClock();
  const handle = await createExampleRuntime(
    databaseUrl,
    { ...process.env, MNEMORA_LLM: "deterministic", MNEMORA_EMBEDDING: "local" },
    {},
    clock,
  );
  const results: TimeTermLevelResult[] = [];
  try {
    const warmup = await warmupLocalEmbedding(handle.embeddingProvider);
    if (!warmup.ok) {
      recordNote("time-term", `local embedding の warmup に失敗した: ${warmup.detail}`);
      return [];
    }
    const runToken = newRunToken();
    for (const level of ASSOCIATION_LEVELS) {
      const report = await runTimeTermArm({
        armLabel: `association-default-on-measure/time-term/${level.key}`,
        tenantIdPrefix: `assoc-measure-time-term-${level.key}-${runToken}`,
        runtime: handle.runtime,
        memoryStore: handle.memoryStore,
        llmMode: handle.llmMode,
        embeddingMode: handle.embeddingMode,
        clock,
        association: level.association,
      });
      const outcomeTally = fillMissingKeysWithZero(
        tallyStrings(report.probes.map((p) => p.outcome)),
        ALL_PAIR_OUTCOMES,
      );
      results.push({
        level: level.key,
        headline: { probeCount: report.probes.length, ...outcomeTally },
        raw: report,
      });
      console.log(`  ${level.label}: ${JSON.stringify(outcomeTally)}`);
    }
  } finally {
    await handle.close();
  }
  return results;
}

interface ValidityLevelResult {
  level: AssociationLevel["key"];
  headline: Record<string, number>;
  raw: ValidityArmReport;
}

async function measureValidity(databaseUrl: string): Promise<ValidityLevelResult[]> {
  console.log("\n=== validity(llm=deterministic, embedding=local) ===");
  const handle = await createExampleRuntime(databaseUrl, {
    ...process.env,
    MNEMORA_LLM: "deterministic",
    MNEMORA_EMBEDDING: "local",
  });
  const results: ValidityLevelResult[] = [];
  try {
    const warmup = await warmupLocalEmbedding(handle.embeddingProvider);
    if (!warmup.ok) {
      recordNote("validity", `local embedding の warmup に失敗した: ${warmup.detail}`);
      return [];
    }
    const runToken = newRunToken();
    for (const level of ASSOCIATION_LEVELS) {
      const report = await runValidityArm({
        armLabel: `association-default-on-measure/validity/${level.key}`,
        tenantIdPrefix: `assoc-measure-validity-${level.key}-${runToken}`,
        runtime: handle.runtime,
        memoryStore: handle.memoryStore,
        llmMode: handle.llmMode,
        embeddingMode: handle.embeddingMode,
        association: level.association,
      });
      const probeCount = report.probes.length;
      const currentReturnedAtNow = report.probes.filter((p) => p.current.returnedAtNow).length;
      const otherReturnedAtNow = report.probes.filter((p) => p.other.returnedAtNow).length;
      const historicalProbes = report.probes.filter((p) => p.historical !== null);
      const optOutOtherReturned = report.probes.filter((p) => p.optOut.otherReturned).length;
      results.push({
        level: level.key,
        headline: {
          probeCount,
          currentReturnedAtNow,
          otherReturnedAtNow,
          historicalProbeCount: historicalProbes.length,
          historicalOtherReturned: historicalProbes.filter((p) => p.historical?.otherReturned)
            .length,
          optOutOtherReturned,
        },
        raw: report,
      });
      console.log(
        `  ${level.label}: current@now=${currentReturnedAtNow}/${probeCount} ` +
          `other@now=${otherReturnedAtNow}/${probeCount}(既定はゲートで隠れているはずが0)`,
      );
    }
  } finally {
    await handle.close();
  }
  return results;
}

// ---------------------------------------------------------------------------
// identifier-probes / numeral-token-probes(sparse のみ、llm=deterministic, embedding=local)
// ---------------------------------------------------------------------------

interface IdentifierLevelResult {
  level: AssociationLevel["key"];
  headline: Record<string, number>;
  raw: IdentifierArmReport;
}

async function measureIdentifierLikeProbes(
  databaseUrl: string,
  benchName: string,
  probeSet: typeof IDENTIFIER_PROBE_SET_SPEC,
): Promise<IdentifierLevelResult[]> {
  console.log(`\n=== ${benchName}(sparse, llm=deterministic, embedding=local) ===`);
  const handle = await createExampleRuntime(databaseUrl, {
    ...process.env,
    MNEMORA_LLM: "deterministic",
    MNEMORA_EMBEDDING: "local",
  });
  const results: IdentifierLevelResult[] = [];
  try {
    const warmup = await warmupLocalEmbedding(handle.embeddingProvider);
    if (!warmup.ok) {
      recordNote(benchName, `local embedding の warmup に失敗した: ${warmup.detail}`);
      return [];
    }
    const runToken = newRunToken();
    for (const level of ASSOCIATION_LEVELS) {
      const report = await runIdentifierProbeArm({
        armLabel: `association-default-on-measure/${benchName}/${level.key}`,
        tenantId: `assoc-measure-${benchName}-${level.key}-${runToken}`,
        runtime: handle.runtime,
        memoryStore: handle.memoryStore,
        llmMode: handle.llmMode,
        embeddingMode: handle.embeddingMode,
        haystackKind: "sparse",
        probeSet,
        association: level.association,
      });
      results.push({
        level: level.key,
        headline: {
          mrrOverall: report.mrrOverall,
          hit1Count: report.hit1Count,
          hit10Count: report.hit10Count,
          probeCount: report.probeCount,
          associationRows: report.probes.reduce((sum, p) => sum + (p.associationRows ?? 0), 0),
        },
        raw: report,
      });
      console.log(
        `  ${level.label}: hit@1=${report.hit1Count}/${report.probeCount} ` +
          `hit@10=${report.hit10Count}/${report.probeCount} associationRows=` +
          `${report.probes.reduce((sum, p) => sum + (p.associationRows ?? 0), 0)}`,
      );
    }
  } finally {
    await handle.close();
  }
  return results;
}

// ---------------------------------------------------------------------------
// consolidation-cost(llm=deterministic, embedding=local、budgetLadder を縮めた版)
// ---------------------------------------------------------------------------

interface ConsolidationCostLevelResult {
  level: AssociationLevel["key"];
  headline: Record<string, number>;
  raw: Awaited<ReturnType<typeof runConsolidationCost>>;
}

/** 既定の9段(`DEFAULT_BUDGET_LADDER`)ではなく、この測定専用に縮めた2段。 */
const MEASURE_BUDGET_LADDER: readonly number[] = [32, 128];

async function measureConsolidationCost(databaseUrl: string): Promise<ConsolidationCostLevelResult[]> {
  console.log("\n=== consolidation-cost(llm=deterministic, embedding=local, budgetLadder=[32,128]) ===");
  const handle = await createExampleRuntime(databaseUrl, {
    ...process.env,
    MNEMORA_LLM: "deterministic",
    MNEMORA_EMBEDDING: "local",
  });
  const results: ConsolidationCostLevelResult[] = [];
  try {
    const warmup = await warmupLocalEmbedding(handle.embeddingProvider);
    if (!warmup.ok) {
      recordNote("consolidation-cost", `local embedding の warmup に失敗した: ${warmup.detail}`);
      return [];
    }
    const runToken = newRunToken();
    const measuredAt = new Date();
    const commit = tryGitRevParseHead(process.cwd());
    for (const level of ASSOCIATION_LEVELS) {
      const json = await runConsolidationCost({
        runtime: handle.runtime,
        memoryStore: handle.memoryStore,
        embeddingProvider: handle.embeddingProvider,
        pool: handle.pool,
        llmMode: handle.llmMode,
        embeddingMode: handle.embeddingMode,
        tenantId: `assoc-measure-consolidation-${level.key}-${runToken}`,
        groupSize: 5,
        budgetLadder: MEASURE_BUDGET_LADDER,
        recallLimit: 50,
        measuredAt,
        commit,
        association: level.association,
      });
      const round0 = json.rounds[0];
      const goldRanks = round0?.recall.unbudgeted.probes.map((p) => p.goldRank ?? null) ?? [];
      results.push({
        level: level.key,
        headline: {
          roundCount: json.rounds.length,
          round0UnbudgetedMeanUsageChars: round0?.recall.unbudgeted.mean.usageChars ?? 0,
          round0GoldReturnedCount: goldRanks.filter((r) => r !== null).length,
        },
        raw: json,
      });
      console.log(
        `  ${level.label}: rounds=${json.rounds.length} ` +
          `round0.unbudgeted.mean.usageChars=${round0?.recall.unbudgeted.mean.usageChars ?? "(無し)"}`,
      );
    }
  } finally {
    await handle.close();
  }
  return results;
}

// ---------------------------------------------------------------------------
// answer-time-weighting(recall 側だけ。llm=deterministic, embedding=local)
// ---------------------------------------------------------------------------

interface TimeWeightingLevelResult {
  level: AssociationLevel["key"];
  headline: Record<string, number>;
  raw: TimeWeightingTrialResult[];
}

function averageOf(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, v) => sum + v, 0) / values.length;
}

async function measureTimeWeighting(databaseUrl: string): Promise<TimeWeightingLevelResult[]> {
  console.log("\n=== answer-time-weighting(recall 側のみ、dev集合、llm=deterministic, embedding=local) ===");
  const handle = await createTimeWeightingBenchRuntime(databaseUrl, {
    ...process.env,
    MNEMORA_LLM: "deterministic",
    MNEMORA_EMBEDDING: "local",
  });
  const results: TimeWeightingLevelResult[] = [];
  try {
    const warmup = await warmupLocalEmbedding(handle.embeddingProvider);
    if (!warmup.ok) {
      recordNote("answer-time-weighting", `local embedding の warmup に失敗した: ${warmup.detail}`);
      return [];
    }
    // ⚠ `runToken` を挟む(ADR 0068 と同じ理由)——`seedTimeWeightingMemories` は
    // `observe()` の externalId 冪等性を経由しない直接書き込みであり、固定文字列の
    // tenantPrefix だとこのスクリプトを2回目に走らせたとき前回の記憶がそのまま残った
    // tenant へさらに書き込み、記憶が2倍に積み上がる(実測——`newRunToken()` を
    // 挟まない版で実際にこの事故を起こした。1回目 meanRecallMemoryCount=1.17 が
    // 2回目 2.33 になった)。
    const runToken = newRunToken();
    for (const level of ASSOCIATION_LEVELS) {
      const trialResults = await runTimeWeightingBench(
        handle,
        TIME_WEIGHTING_CASE_SET_DEV,
        `assoc-measure-time-weighting-${level.key}-${runToken}`,
        1,
        level.association,
      );
      const allPolicyResults = trialResults.flatMap((t) => Object.values(t.byPolicy));
      results.push({
        level: level.key,
        headline: {
          caseCount: trialResults.length,
          meanRecallMemoryCount: averageOf(allPolicyResults.map((p) => p.recallMemoryCount)),
          meanInputChars: averageOf(allPolicyResults.map((p) => p.inputChars)),
          meanInputEstimatedTokens: averageOf(allPolicyResults.map((p) => p.inputEstimatedTokens)),
        },
        raw: trialResults,
      });
      console.log(
        `  ${level.label}: meanRecallMemoryCount=${averageOf(allPolicyResults.map((p) => p.recallMemoryCount)).toFixed(2)} ` +
          `meanInputChars=${averageOf(allPolicyResults.map((p) => p.inputChars)).toFixed(1)}`,
      );
    }
  } finally {
    await handle.close();
  }
  return results;
}

// ---------------------------------------------------------------------------
// answer(recall 側だけ。llm=deterministic, embedding=local)
// ---------------------------------------------------------------------------

interface AnswerLevelResult {
  level: AssociationLevel["key"];
  headline: Record<string, number>;
}

async function measureAnswer(databaseUrl: string): Promise<AnswerLevelResult[]> {
  console.log("\n=== answer(recall 側のみ、dev+eval、llm=deterministic, embedding=local) ===");
  const handle = await createAnswerBenchRuntime(databaseUrl, {
    ...process.env,
    MNEMORA_LLM: "deterministic",
    MNEMORA_EMBEDDING: "local",
  });
  const results: AnswerLevelResult[] = [];
  try {
    const warmup = await warmupLocalEmbedding(handle.embeddingProvider);
    if (!warmup.ok) {
      recordNote("answer", `local embedding の warmup に失敗した: ${warmup.detail}`);
      return [];
    }
    const cases = [...ANSWER_CASE_SET_DEV, ...ANSWER_CASE_SET_EVAL];
    // ⚠ `runToken` を挟む(ADR 0068 / 上の `measureTimeWeighting` と同じ理由)。
    // `ingestConversation`/`observe()` は externalId で冪等なので、固定文字列でも
    // 2回目の実行が壊れて見えることは無い(実測——`runToken` 無しでも run1/run2 の
    // headline は一致した)。それでも、この repo の規約(ADR 0068「実行ごとに一意な
    // tenantId を使う」)に揃え、「冪等性に頼って動いている」を「一意な tenantId で
    // 動いている」へ直しておく。
    const runToken = newRunToken();
    for (const level of ASSOCIATION_LEVELS) {
      const caseResults = await runAnswerBench(
        handle.runtime,
        handle.llmProvider,
        handle.embeddingProvider,
        handle.judgeLLMProvider,
        cases,
        `assoc-measure-answer-${level.key}-${runToken}`,
        {},
        level.association,
      );
      const indexCounts = caseResults
        .map((r) => parsePromptIndexLine(r.mnemora.promptSpec.messages[0]?.content ?? ""))
        .filter((c): c is { totalInScope: number; returned: number } => c !== null);
      results.push({
        level: level.key,
        headline: {
          caseCount: caseResults.length,
          meanInputChars: averageOf(caseResults.map((r) => r.mnemora.inputChars)),
          meanInputEstimatedTokens: averageOf(caseResults.map((r) => r.mnemora.inputEstimatedTokens)),
          meanReturnedCount: averageOf(indexCounts.map((c) => c.returned)),
          meanTotalInScope: averageOf(indexCounts.map((c) => c.totalInScope)),
        },
      });
      console.log(
        `  ${level.label}: meanInputChars=${averageOf(caseResults.map((r) => r.mnemora.inputChars)).toFixed(1)} ` +
          `meanReturnedCount=${averageOf(indexCounts.map((c) => c.returned)).toFixed(2)}`,
      );
    }
  } finally {
    await handle.close();
  }
  return results;
}

// ---------------------------------------------------------------------------
// off/on10 の差・on5/10/20 の表(標準出力へ印字するだけ。JSON にも同じ数字を残す)
// ---------------------------------------------------------------------------

function printDiffTables(benchName: string, levels: readonly { level: string; headline: Record<string, number> }[]): void {
  const off = levels.find((l) => l.level === "off");
  const on5 = levels.find((l) => l.level === "on5");
  const on10 = levels.find((l) => l.level === "on10");
  const on20 = levels.find((l) => l.level === "on20");
  if (!off || !on10) {
    console.log(`  (${benchName}: off/on10 が両方揃わなかったため差の表は省略)`);
    return;
  }
  console.log(`\n  --- ${benchName}: off → on10(既定) の差 ---`);
  const offVsOn10 = buildNumberDiffTable(off.headline, on10.headline);
  for (const [key, cell] of Object.entries(offVsOn10)) {
    console.log(`    ${key}: ${formatNumberDiffCell(cell)}`);
  }
  if (on5 && on20) {
    console.log(`  --- ${benchName}: maxCount 5/10/20 の比較(基準=on5) ---`);
    const on5VsOn10 = buildNumberDiffTable(on5.headline, on10.headline);
    const on5VsOn20 = buildNumberDiffTable(on5.headline, on20.headline);
    for (const key of Object.keys(on5.headline)) {
      console.log(
        `    ${key}: on5=${on5.headline[key]} on10=${formatNumberDiffCell(on5VsOn10[key]!)} ` +
          `on20=${formatNumberDiffCell(on5VsOn20[key]!)}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const databaseUrl = requireDatabaseUrl();
  const measuredAt = new Date();
  const commit = tryGitRevParseHead(process.cwd());

  const retrievalQuality = await measureRetrievalQuality(databaseUrl);
  const compare = await measureCompare(databaseUrl);
  const timeTerm = await measureTimeTerm(databaseUrl);
  const validity = await measureValidity(databaseUrl);
  const identifierProbes = await measureIdentifierLikeProbes(
    databaseUrl,
    "identifier-probes",
    IDENTIFIER_PROBE_SET_SPEC,
  );
  const numeralTokenProbes = await measureIdentifierLikeProbes(
    databaseUrl,
    "numeral-token-probes",
    NUMERAL_TOKEN_PROBE_SET_SPEC,
  );
  const consolidationCost = await measureConsolidationCost(databaseUrl);
  const timeWeighting = await measureTimeWeighting(databaseUrl);
  const answer = await measureAnswer(databaseUrl);

  console.log("\n\n########## off → on10(既定)の差・maxCount 5/10/20 の比較 ##########");
  printDiffTables("retrieval-quality", retrievalQuality);
  printDiffTables("compare", compare);
  printDiffTables("time-term", timeTerm);
  printDiffTables("validity", validity);
  printDiffTables("identifier-probes", identifierProbes);
  printDiffTables("numeral-token-probes", numeralTokenProbes);
  printDiffTables("consolidation-cost", consolidationCost);
  printDiffTables("answer-time-weighting", timeWeighting);
  printDiffTables("answer", answer);

  console.log(`\n\n実 API 呼び出し回数: 0(このスクリプトは recorded/local 層だけで測る——本体の docstring 参照)`);
  if (notes.length > 0) {
    console.log("\n所見(例外・スキップの一覧):");
    for (const note of notes) {
      console.log(`  - [${note.bench}] ${note.detail}`);
    }
  } else {
    console.log("\n所見: 例外・スキップは無かった。");
  }

  const output = {
    schemaVersion: 1,
    measuredAt: measuredAt.toISOString(),
    commit,
    notes,
    benches: {
      retrievalQuality,
      compare,
      timeTerm,
      validity,
      identifierProbes,
      numeralTokenProbes,
      consolidationCost,
      timeWeighting,
      answer,
    },
  };

  const outDir =
    process.env.MNEMORA_ASSOCIATION_DEFAULT_ON_MEASURE_DIR ??
    join(process.cwd(), "bench-results", "association-default-on-2026-09-26");
  mkdirSync(outDir, { recursive: true });
  const outPath =
    process.env.MNEMORA_ASSOCIATION_DEFAULT_ON_MEASURE_JSON ?? join(outDir, "measure-run.json");
  writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`, "utf-8");
  console.log(`\n[association-default-on-measure] 生データを書き出した: ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

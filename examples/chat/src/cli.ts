#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import type { DecayClock } from "@mnemora/core";
import { DEFAULT_RECALL_LIMIT, heuristicTokenCounter } from "@mnemora/core";
import type { Cassette } from "@mnemora/testkit";
import { CassetteRecorder } from "@mnemora/testkit";
import { runAssociationArm } from "./association-arm.js";
import { formatAssociationProbeRunReport } from "./association-format.js";
import { buildAssociationProbeRunJson } from "./association-json.js";
import type { CassetteTarget } from "./cassette-io.js";
import { parseDecayClockFlag } from "./decay-clock-options.js";
import {
  cassetteExists,
  cassettePathFor,
  describeCassette,
  loadCassette,
  parseCassetteTarget,
  saveCassette,
} from "./cassette-io.js";
import {
  DEFAULT_COMPARE_SEQUENCE,
  formatComparisonTable,
  formatRecallQualityTable,
  runComparison,
} from "./compare.js";
import { buildCompareJson } from "./compare-json.js";
import { generateCalibrationSamples } from "./recall-footprint-calibration-samples.js";
import { buildRecallFootprintCalibrationSamplesJson } from "./recall-footprint-calibration-samples-json.js";
import { parseConsolidationCostOptions } from "./consolidation-cost-options.js";
import { runConsolidationCost } from "./consolidation-cost.js";
import { formatConsolidationCostReport } from "./consolidation-cost-format.js";
import {
  buildWeightsUnavailableConsolidationCostRunJson,
  exitCodeForConsolidationCostRun,
} from "./consolidation-json.js";
import { parseArchiveSweepCostOptions } from "./archive-sweep-options.js";
import { runArchiveSweepCost } from "./archive-sweep-cost.js";
import { formatArchiveSweepCostReport } from "./archive-sweep-format.js";
import {
  buildWeightsUnavailableArchiveSweepCostRunJson,
  exitCodeForArchiveSweepCostRun,
} from "./archive-sweep-json.js";
import { formatChatSummary, formatRecall } from "./format.js";
import { tryGitRevParseHead } from "./git-info.js";
import { formatIdentifierArmReport, runIdentifierProbeArm } from "./identifier-arm.js";
import { IDENTIFIER_PROBES } from "./identifier-probe-set.js";
import { JAPANESE_NAME_PROBES, JAPANESE_NAME_PROBE_SET_SPEC } from "./japanese-name-probe-set.js";
import { PROBES } from "./probe-set.js";
import {
  buildMeasuredIdentifierProbeJson,
  buildWeightsUnavailableIdentifierProbeJson,
} from "./identifier-json.js";
import { NUMERAL_TOKEN_PROBES, NUMERAL_TOKEN_PROBE_SET_SPEC } from "./numeral-token-probe-set.js";
import {
  buildMeasuredNumeralTokenProbeJson,
  buildWeightsUnavailableNumeralTokenProbeJson,
} from "./numeral-token-json.js";
import {
  IDENTIFIER_OPENAI_CASSETTE_PATH,
  NUMERAL_TOKEN_OPENAI_CASSETTE_PATH,
  loadOpenAiArmCassette,
} from "./openai-arm-cassette.js";
import { buildArmLabel, identifierArmGroups, numeralArmGroups } from "./openai-arm-probe-groups.js";
import { buildOpenAiArmRunJson } from "./openai-arm-json.js";
import {
  formatCorrectionCandidateReport,
  runCorrectionCandidateArm,
  summarizeCorrectionCandidateReport,
} from "./correction-candidate-arm.js";
import {
  buildMeasuredCorrectionCandidateProbeJson,
  buildWeightsUnavailableCorrectionCandidateProbeJson,
} from "./correction-candidate-json.js";
import { CORRECTION_CASE_SET_DEV } from "./correction-case-set.dev.js";
import {
  CORRECTION_ABSTAIN_CASE_SET_EVAL,
  CORRECTION_HIT_CASE_SET_EVAL,
} from "./correction-case-set.eval.js";
import { warmupLocalEmbedding } from "./local-embedding-warmup.js";
import { runEmbeddingFingerprint } from "./embedding-fingerprint.js";
import { buildMnemoraPrompt, ingestConversation, reportMemoryUsage } from "./mnemora-path.js";
import { TINY_BUDGET_CHARS, runBudgetDemo } from "./budget-demo.js";
import { measureNaive, naivePrompt } from "./naive-path.js";
import type {
  CreateProvidersOptions,
  PlannedProviderSource,
  ProviderMode,
  ProviderSourceDecision,
} from "./providers.js";
import {
  decideProviderSource,
  describePlanActualMismatch,
  describeProviderSourceReason,
  detectPlanActualMismatch,
} from "./providers.js";
import { buildRetrievalQualityJson } from "./retrieval-json.js";
import {
  armHeadline,
  buildArmTenantId,
  formatArmDetail,
  formatArmSummaryTable,
  formatProbeComparisonTable,
  newRunToken,
  parseBenchChannels,
  runRetrievalQualityArm,
} from "./retrieval-quality.js";
import { createExampleRuntime } from "./runtime-factory.js";
import { buildConversation } from "./scenario.js";
import { formatBackfillDemo, runBackfillDemo } from "./backfill.js";
import {
  checkCorrectionDemo,
  checkCorrectionOmission,
  formatCorrectionDemo,
  runCorrectionDemo,
} from "./correction-demo.js";
import { CORRECTION_SCENARIO } from "./correction-scenario.js";
import { formatScopeDemo, runScopeDemo } from "./scope.js";
import { formatRecallExplainDemo, runRecallExplainDemo } from "./recall-explain.js";
import { createMutableClock } from "./mutable-clock.js";
import { formatTimeTermReport, runTimeTermArm } from "./time-term-arm.js";
import { buildTimeTermJson } from "./time-term-json.js";
import { formatValidityReport, runValidityArm } from "./validity-arm.js";
import { buildValidityJson } from "./validity-json.js";
import { formatNoApiCallsNotice } from "./usage-meter.js";
import { formatSeedUsageReport } from "./seed-usage.js";
import { createAnswerBenchRuntime, runAnswerBench } from "./answer-bench.js";
import { ANSWER_CASE_SET_DEV } from "./answer-case-set.dev.js";
import { ANSWER_CASE_SET_EVAL } from "./answer-case-set.eval.js";
import { buildAnswerJson } from "./answer-json.js";
import { recordRetentionMutationPositiveControl } from "./answer-retention-mutation.js";
import {
  formatAnswerContentPreservation,
  formatAnswerCostTable,
  formatAnswerInputReduction,
  formatAnswerIntro,
  formatAnswerQualityBanner,
  formatAnswerTable,
} from "./answer-format.js";
import {
  aggregateTimeWeightingResults,
  createTimeWeightingBenchRuntime,
  runTimeWeightingBench,
} from "./time-weighting-bench.js";
import { TIME_WEIGHTING_CASE_SET_DEV } from "./time-weighting-case-set.dev.js";
import { TIME_WEIGHTING_CASE_SET_EVAL } from "./time-weighting-case-set.eval.js";
import { TIME_WEIGHTING_CASE_SET_EVAL_UNDATED } from "./time-weighting-case-set.eval-undated.js";
import { buildTimeWeightingJson } from "./time-weighting-json.js";
import {
  formatTimeWeightingKindSummary,
  formatTimeWeightingQualityBanner,
  formatTimeWeightingTable,
} from "./time-weighting-format.js";
import { runAnswerTrialsCompareFromFiles } from "./answer-trials-compare.js";
import { databaseErrorHint } from "./db-error-hint.js";
import { formatAnswerTrialsReport, runAnswerTrials } from "./answer-trials.js";

const DEFAULT_CHAT_FILLER_PAIRS = 8;

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL が設定されていません。mnemora は Postgres + pgvector を要求する " +
        "（docs/roadmap.md 段階2。⚠ 2026-09-29 に同節は削除した（#762）。当時の本文は 635c93d の版にある）。" +
        "examples/chat/README.md「DB を用意する」の手順で DB を用意し、" +
        "DATABASE_URL を設定してから実行すること。",
    );
  }
  return url;
}

/**
 * `ProviderMode` のすべての値を名指しする。「`openai` でなければ擬似 provider」と書くと、
 * `"recorded"` を足したとき再生中の run が擬似と表示され、同じ report の別の行と矛盾する（ADR 0051）。
 * モードを増やすときは必ずここも増やすこと。
 */
function describeMode(mode: ProviderMode): string {
  switch (mode) {
    case "openai":
      return "本物の OpenAI";
    case "recorded":
      return "記録した実 API 応答の再生（ADR 0051）";
    case "deterministic":
      return "@mnemora/testkit の決定的な擬似 provider";
    case "local":
      return "@mnemora/local-embedding によるプロセス内推論（外部サービスに繋がない。ADR 0085 / Issue #109）";
    default: {
      const exhaustive: never = mode;
      throw new Error(`describeMode: 未知の ProviderMode: ${String(exhaustive)}`);
    }
  }
}

/**
 * どの組み合わせで動いているかを必ず画面に出す。黙って擬似物にフォールバックしない。
 *
 * `cassetteIgnored` は引数に畳み込み、オプショナルにも既定値付きにもしない。
 * 「カセットを渡したのに使わなかった」を開示せずにバナーを出せる経路を作らないため（AGENTS.md「形で塞ぐ」）。
 */
function printProviderMode(
  modes: {
    llmMode: ProviderMode;
    embeddingMode: ProviderMode;
    cassetteIgnored: boolean;
  },
  plannedSource: PlannedProviderSource,
): void {
  console.log(`[provider] LLM       : ${describeMode(modes.llmMode)}`);
  console.log(`[provider] Embedding : ${describeMode(modes.embeddingMode)}`);
  if (modes.embeddingMode === "deterministic") {
    console.log(
      "  ⚠ 擬似 embedding は意味的な類似度を表現しないため、このモードでは recall の" +
        "関連度そのものは評価できない（examples/chat/README.md「正直に書くべき限界」参照）。",
    );
  }
  if (modes.cassetteIgnored) {
    console.log(
      "  ⚠ 読み込んだカセットは、この実行では使っていない" +
        '（llmMode/embeddingMode のどちらも "recorded" でない）。',
    );
  }
  // 上の `cassetteIgnored` は `cassette !== undefined` が前提なので、`resolveRecordedRun` の `openai` 枝（カセットを読まずに return する）を
  // 原理的に見ない。予定と実測の食い違いは、カセットとは別の検出器で開示する。
  const mismatch = detectPlanActualMismatch(plannedSource, modes);
  if (mismatch !== undefined) {
    console.log(describePlanActualMismatch(mismatch));
  }
}

/**
 * `resolveRecordedRun` の返り値。カセットを受け取る唯一の経路が、倒した env を必ず一緒に返す。
 * 「名乗ったのに倒し忘れる」形を書けなくするため。
 */
interface RecordedRunPlan {
  /** provider を構築するときに渡す env。カセットを読めたら `MNEMORA_LLM`/`MNEMORA_EMBEDDING` を `"recorded"` へ倒してある。 */
  env: NodeJS.ProcessEnv;
  providerOptions: CreateProvidersOptions;
  cassette: Cassette | undefined;
  /**
   * 画面に名乗った「予定」そのもの。返り値に含めることで、呼び出し側が `printProviderMode` へ渡し忘れる経路を無くす。
   * 名乗ることと、名乗りを検査へ渡すことを分離できない形にする。
   */
  plannedSource: ProviderSourceDecision["source"];
}

/**
 * この実行が実 API を使うのか、記録の再生を使うのかを決める。
 *
 * 判定は `decideProviderSource`（`providers.ts`）に委ね、ここは結果を画面へ出し、`"recorded"` ならカセットを読んで
 * 必要な env まで一緒に組み立てる薄い配線に留める。
 *
 * 名乗ることと env を倒すことを分離できない形にする。かつて env の書き換えを呼び出し側に委ねたところ、
 * `runAnswer` だけが忘れ、再生と名乗りながら擬似 provider で走った。
 * キーが在れば無条件に実 API、という判定にも戻さない。環境にキーが在るだけで意図せず課金が発生しうる（ADR 0068）。
 */
function resolveRecordedRun(target: CassetteTarget): RecordedRunPlan {
  const decision = decideProviderSource(process.env);
  console.log(
    // この行が名乗るのは「どの source を選んだか」まで。`createProviders` はこの判定を読まず、`MNEMORA_LLM`/`MNEMORA_EMBEDDING` と
    // 鍵の有無を見るので、両者は食い違いうる。だから「予定」と明示し、断定は `printProviderMode` の実測に寄せる。
    `[cassette] provider source の予定: ${decision.source}(理由: ${describeProviderSourceReason(decision)})`,
  );
  if (decision.source === "openai") {
    return {
      env: process.env,
      providerOptions: {},
      cassette: undefined,
      plannedSource: decision.source,
    };
  }
  const path = cassettePathFor(target);
  if (!cassetteExists(path)) {
    throw new Error(
      `${target} をカセット再生で走らせるには記録が要る。` +
        `先に \`record ${target}\` でカセットを作るか、` +
        "OPENAI_API_KEY を設定して実 API で走らせること。" +
        "（キーが在るのに再生したいときは MNEMORA_PROVIDER_SOURCE=recorded。" +
        "ADR 0052 / 0068）",
    );
  }
  const cassette = loadCassette(path);
  // この行は「読んだ」までしか名乗らない。ここでは provider をまだ組んでおらず、「再生する」は測っていない予告になる。
  // `MNEMORA_LLM=deterministic` の明示ではカセットを読んでも使わない。名乗ってよいのは、実際に確かめたことだけ。
  console.log(`[cassette] カセットを読んだ: ${describeCassette(cassette)}`);
  console.log(
    "  ⚠ これは記録した時点の API の姿である。実 API との乖離は `verify` で確かめること。",
  );
  console.log(
    "  ⚠ この行は「読めた」ことだけを言う。この実行が実際に何で走るかは、下の " +
      "[provider] 行が構築後の実測から出す（ADR 0223 決定5 / Issue #589）。",
  );
  return {
    // 明示が在るときは倒さない。無条件に `"recorded"` を焼き込むと、利用者の `MNEMORA_LLM=deterministic` を黙って上書きする（ADR 0068）。
    // `??` ではなく `||` を使う。`parseModeOverride` は空文字を「未指定」として扱うので、`??` だと規約がずれる。
    env: {
      ...process.env,
      MNEMORA_LLM: process.env.MNEMORA_LLM || "recorded",
      MNEMORA_EMBEDDING: process.env.MNEMORA_EMBEDDING || "recorded",
    },
    providerOptions: { cassette },
    cassette,
    plannedSource: decision.source,
  };
}

async function runChat(): Promise<void> {
  const handle = await createExampleRuntime(requireDatabaseUrl());
  printProviderMode(handle, null);
  try {
    const ctx = { tenantId: `example-chat-${Date.now()}` };
    const conversation = buildConversation(DEFAULT_CHAT_FILLER_PAIRS);

    console.log("\n=== 会話（全ターン） ===");
    for (const turn of conversation.turns) {
      console.log(`${turn.role}: ${turn.text}`);
    }
    console.log(`user(質問): ${conversation.query}`);

    console.log("\n=== 経路A（naive）: 会話ログを全部プロンプトへ積む ===");
    console.log(naivePrompt(conversation));
    const naive = measureNaive(conversation, heuristicTokenCounter);
    console.log(
      `naive usage: chars=${naive.chars} estimatedTokens=${naive.estimatedTokens} (counter=${naive.counter})`,
    );

    console.log("\n=== 経路B（mnemora）: observe() → tick() ===");
    const ingestDrain = await ingestConversation(handle.runtime, ctx, conversation);
    if (ingestDrain.totalFailed > 0) {
      // `chat` は実演なので、以降の recall の表示は止めずに出す（何が起きたかを画面で読めるように）。
      console.error(
        `\n🔴 embed に失敗した件がある(${String(ingestDrain.totalFailed)}件)。⛔ 以降の recall の結果は使えない。` +
          "（embedding provider の鍵・接続・上限を確かめること。失敗の理由は recall の omitted に出る）",
      );
      process.exitCode = 1;
    }
    console.log(
      `${conversation.userUtterances.length} 件の user 発話を observe() し、tick() で embed を処理した` +
        `（成功 ${String(ingestDrain.totalProcessed)} 件 / 失敗 ${String(ingestDrain.totalFailed)} 件）。`,
    );

    const { withoutBudget, withBudget } = await runBudgetDemo(handle.runtime, ctx, conversation);

    console.log("\n=== recall()（budget 無し） ===");
    console.log(formatRecall(withoutBudget, "budget 無し"));
    console.log("呼び出し側がプロンプトへ積む文字列（recall() の返り値だけから組み立てる例）:");
    console.log(buildMnemoraPrompt(withoutBudget));

    // recall() の測定・表示を終えたあとに使用報告する。この呼び出しは測定値を変えない。
    const usageReport = await reportMemoryUsage(handle.runtime, ctx, withoutBudget);
    console.log(
      usageReport.reported
        ? `[memory_usage] ${usageReport.usedMemoryIds.length} 件の Memory を使用報告した（recallId=${usageReport.recallId}）。`
        : "[memory_usage] 載せる Memory が0件だったため、報告しなかった。",
    );

    console.log(
      `\n=== budget を渡すと実際に切り詰められる（maxMemoryChars=${TINY_BUDGET_CHARS}） ===`,
    );
    console.log(formatRecall(withBudget, `budget maxMemoryChars=${TINY_BUDGET_CHARS}`));

    console.log("\n=== まとめ ===");
    console.log(formatChatSummary(naive.chars, withoutBudget, withBudget));
    console.log(
      "budget_dropped omission (budget あり):",
      withBudget.omitted.find((o) => o.kind === "budget_dropped") ?? "(発生しなかった)",
    );

    console.log("");
    console.log(
      handle.usageMeter
        ? handle.usageMeter.formatReport()
        : formatNoApiCallsNotice({
            llmMode: handle.llmMode,
            embeddingMode: handle.embeddingMode,
          }),
    );
  } finally {
    await handle.close();
  }
}

async function runScope(): Promise<void> {
  const handle = await createExampleRuntime(requireDatabaseUrl());
  printProviderMode(handle, null);
  try {
    const tenantId = `example-chat-scope-${Date.now()}`;
    const otherTenantId = `${tenantId}-other`;
    console.log(
      "\n同じテナントの中に alice/bob という2つの subject を作り、別テナントも1つ用意して、" +
        "recall() のスコープの違いを実演する。\n",
    );
    const result = await runScopeDemo(handle.runtime, tenantId, otherTenantId);
    console.log(formatScopeDemo(result));
  } finally {
    await handle.close();
  }
}

async function runExplain(): Promise<void> {
  const handle = await createExampleRuntime(requireDatabaseUrl());
  printProviderMode(handle, null);
  try {
    const tenantId = `example-chat-explain-${Date.now()}`;
    console.log(
      "\n2件の事実を observe して embed を干上がらせ、3件目はあえて索引に載せないまま" +
        "recall() を呼ぶ。返り値からは recallId だけを使い、別の呼び出し " +
        "runtime.getRecall(ctx, recallId) で、なぜその記憶が・どの内訳で選ばれたか" +
        "(そして3件目がなぜ落ちたか)を、永続化された recalls 行から読み戻す。\n",
    );
    const result = await runRecallExplainDemo(handle.runtime, handle.memoryStore, tenantId);
    console.log(formatRecallExplainDemo(result));
  } finally {
    await handle.close();
  }
}

async function runBackfill(): Promise<void> {
  const handle = await createExampleRuntime(requireDatabaseUrl());
  printProviderMode(handle, null);
  try {
    const base = `example-chat-backfill-${Date.now()}`;
    console.log(
      "\n生の会話ログを後から取り込む(backfill)と、recordedAt は取り込んだ今日になる。" +
        "occurredAt を渡すかどうかで、同じ recall() が別の答えを返すことを実演する。\n",
    );
    const result = await runBackfillDemo(handle.runtime, {
      withOccurredAt: `${base}-with`,
      withoutOccurredAt: `${base}-without`,
    });
    console.log(formatBackfillDemo(result));
  } finally {
    await handle.close();
  }
}

/**
 * 訂正を含む会話シナリオを実演するデモ（`src/correction-demo.ts`）。
 *
 * どの2件が対向し、どちらが勝つかは `correction-scenario.ts` が宣言する。訂正の相手は、この CLI が `CorrectionChoice` として
 * 明示的に渡す。`findCorrectionCandidates` の候補の並びからは導かない。
 *
 * 印字するだけでなく、`checkCorrectionDemo()`/`checkCorrectionOmission()` の全欄を assert し、1つでも false なら
 * `process.exitCode = 1` にする。`correction-demo.postgres.test.ts` は `runCorrectionDemo()` を直接 import しており、
 * この dispatch 行を経由しない。CI の `example-chat` ジョブから呼ぶことで、dispatch 行そのものが歯になる。
 *
 * provider 層は `deterministic` を使い、明示の override はしない。`recorded` にしないのは、`examples/chat/cassettes/` に
 * このデモの発話の記録が無く、記録に無い入力は例外になるため。確かめる性質は構造的なので `deterministic` で足りる。
 */
async function runCorrection(): Promise<void> {
  const handle = await createExampleRuntime(requireDatabaseUrl());
  printProviderMode(handle, null);
  try {
    const ctx = { tenantId: `example-chat-correction-${Date.now()}` };
    console.log(
      "\n最初に事実を表明し、後から訂正する会話を observe() し、findCorrectionCandidates(発見) → " +
        "指名の照合(選択) → markContested → recall → resolveContested → recall で" +
        "「間違いを正すと古いほうが出てこなくなる」ことを実演する。\n",
    );
    // choice は「記録済みの採用者の判断」で、候補の並びからは導かない（candidates[0] を機械的に採らないことの実演）。
    const result = await runCorrectionDemo(handle.runtime, ctx, CORRECTION_SCENARIO, {
      chosenExternalId: CORRECTION_SCENARIO.contestedPair.firstExternalId,
    });
    console.log(formatCorrectionDemo(result));

    if (result.outcome !== "resolved") {
      console.error(
        `\n🔴 correction デモが outcome="${result.outcome}" で停止した` +
          "(書き込みに進んでいない。指名または候補の対応を確認すること)。",
      );
      process.exitCode = 1;
      return;
    }

    const check = checkCorrectionDemo(result);
    const omissionCheck = checkCorrectionOmission(result);
    const allChecks: Record<string, boolean> = { ...check, ...omissionCheck };
    const failed = Object.entries(allChecks).filter(([, ok]) => !ok);
    if (failed.length > 0) {
      console.error(
        `\n🔴 correction デモの検査が ${failed.length}/${Object.keys(allChecks).length} 件` +
          ` 失敗した: ${failed.map(([name]) => name).join(", ")}`,
      );
      process.exitCode = 1;
      return;
    }
    console.log(
      `\n✔ correction デモの検査が全て通った(${Object.keys(allChecks).length}件。` +
        "checkCorrectionDemo() と checkCorrectionOmission() の全欄、Issue #374)。",
    );
  } finally {
    await handle.close();
  }
}

/** `--decay-clock` が指定されたときだけ画面に出す。未指定なら1行も出さず、「省略時は `writeDecayClock` を呼ばない」契約と対になる。 */
function printDecayClockNotice(decayClock: DecayClock | undefined): void {
  if (decayClock === undefined) {
    return;
  }
  console.log(
    `\n[decay-clock] --decay-clock ${decayClock} が指定された。` +
      `対象テナントの tenant_settings.decay_clock へ書き込む（ADR 0165）。`,
  );
}

async function runCompare(decayClock: DecayClock | undefined): Promise<void> {
  const databaseUrl = requireDatabaseUrl();
  const plan = resolveRecordedRun("compare");
  const handle = await createExampleRuntime(databaseUrl, plan.env, plan.providerOptions);
  printProviderMode(handle, plan.plannedSource);
  printDecayClockNotice(decayClock);
  try {
    console.log(
      "\n会話の長さを変えて、経路A（naive）と経路B（mnemora, budget 無し）の焼かれる量を測る。\n",
    );
    const rows = await runComparison(handle.runtime, {
      fillerPairsSequence: DEFAULT_COMPARE_SEQUENCE,
      memoryStore: handle.memoryStore,
      ...(decayClock !== undefined
        ? { decayClock: { store: handle.tenantSettingsStore, clock: decayClock } }
        : {}),
    });
    console.log(formatComparisonTable(rows));
    console.log(
      "\n(注) mnemora chars は recall() の budget 無し usage.chars。切り詰めていない、そのままの量。",
    );

    console.log(
      "\n量を削っただけでは北極星の物差しに答えられない——" +
        "「削っても冒頭の事実の出典に到達できるか」「実際に何件と競って絞ったか」を測る" +
        "（出典への到達だけであり、情報保持・最終回答の正誤は測っていない）:\n",
    );
    console.log(formatRecallQualityTable(rows));
    console.log(
      "\n(注) 「ANN の候補になれた件数」が「スコープ内の Memory」を下回っていたら、" +
        "そのぶんは `omitted` の `not_indexed` に理由付きで出ている" +
        "（docs/decisions/0021-drain-embed-ticks-in-ingest.md）。",
    );
    console.log("");
    console.log(
      handle.usageMeter
        ? handle.usageMeter.formatReport()
        : formatNoApiCallsNotice({
            llmMode: handle.llmMode,
            embeddingMode: handle.embeddingMode,
          }),
    );

    const compareJsonPath = process.env.MNEMORA_COMPARE_JSON;
    if (compareJsonPath) {
      const json = buildCompareJson({
        rows,
        llmMode: handle.llmMode,
        embeddingMode: handle.embeddingMode,
        measuredAt: new Date(),
        commit: tryGitRevParseHead(process.cwd()),
      });
      writeFileSync(compareJsonPath, `${JSON.stringify(json, null, 2)}\n`, "utf-8");
      console.log(`\n[compare] 機械可読な結果を書き出した: ${compareJsonPath}`);
    }
  } finally {
    await handle.close();
  }
}

/**
 * `recall-footprint` 較正の補助標本（`CALIBRATION_SAMPLE_DESIGN`）を、`compare` と同じ recorded カセットに対して生成する（ADR 0314）。
 *
 * `compare` の代わりではない。`compare-baseline.json`（⭐門）の `rows` には混ぜない。
 * 抽出プロンプトの鍵は発話内容だけで決まるので、`compare` のカセットがそのまま再生に使える。
 */
async function runRecallFootprintCalibrationSamples(): Promise<void> {
  const databaseUrl = requireDatabaseUrl();
  const plan = resolveRecordedRun("compare");
  const handle = await createExampleRuntime(databaseUrl, plan.env, plan.providerOptions);
  printProviderMode(handle, plan.plannedSource);
  try {
    console.log(
      "\nrecall-footprint の較正標本（目次帯が空のまま、件数と limit を固定した CALIBRATION_SAMPLE_DESIGN の各点）を生成する。\n",
    );
    const rows = await generateCalibrationSamples(handle.runtime);
    for (const row of rows) {
      console.log(
        `  fillerPairs=${row.fillerPairs} limit=${row.recallLimit} turnCount=${row.turnCount} ` +
          `totalInScope=${row.totalInScope} bandEntryCount=${row.bandEntryCount} ` +
          `mnemoraChars=${row.mnemoraChars}`,
      );
    }
    console.log(
      handle.usageMeter
        ? handle.usageMeter.formatReport()
        : formatNoApiCallsNotice({
            llmMode: handle.llmMode,
            embeddingMode: handle.embeddingMode,
          }),
    );

    const jsonPath = process.env.MNEMORA_RECALL_FOOTPRINT_CALIBRATION_SAMPLES_JSON;
    if (jsonPath) {
      const json = buildRecallFootprintCalibrationSamplesJson({
        rows,
        llmMode: handle.llmMode,
        embeddingMode: handle.embeddingMode,
        measuredAt: new Date(),
        commit: tryGitRevParseHead(process.cwd()),
      });
      writeFileSync(jsonPath, `${JSON.stringify(json, null, 2)}\n`, "utf-8");
      console.log(
        `\n[recall-footprint-calibration-samples] 機械可読な結果を書き出した: ${jsonPath}`,
      );
    }
  } finally {
    await handle.close();
  }
}

/**
 * arm A（擬似LLM+擬似embedding）・B（擬似LLM+本物embedding）・C（本物LLM+本物embedding）を順に走らせ、probe set の順位を比較する。
 *
 * arm ごとに別のテナントを使い、`runToken` ごとに違うテナントにする（ADR 0068）。固定文字列だと、DB をリセットしないこの harness の
 * 2回目の実行が冪等性に当たって新規 observation を作らず、`ingest` の欄が逆の結論を印字してしまう。
 *
 * CI は実 API を叩かず、`recorded` で走る（ADR 0088）。
 */
function buildArmSpecs(
  source: "openai" | "recorded",
  runToken: string,
): {
  armLabel: string;
  tenantId: string;
  llmOverride: ProviderMode;
  embeddingOverride: ProviderMode;
  /** この arm が実 API に触れるか。`record` はこの欄で対象を選ぶ。tenantId の文字列一致で除外すると、arm の id を変えた瞬間に静かに壊れる。 */
  touchesApi: boolean;
}[] {
  return [
    {
      armLabel: "A: 擬似LLM+擬似埋め込み",
      tenantId: buildArmTenantId("a", runToken),
      llmOverride: "deterministic",
      embeddingOverride: "deterministic",
      touchesApi: false,
    },
    {
      armLabel: "B: 擬似LLM+本物の埋め込み",
      tenantId: buildArmTenantId("b", runToken),
      llmOverride: "deterministic",
      embeddingOverride: source,
      touchesApi: true,
    },
    {
      armLabel: "C: 本物LLM+本物の埋め込み",
      tenantId: buildArmTenantId("c", runToken),
      llmOverride: source,
      embeddingOverride: source,
      touchesApi: true,
    },
  ];
}

async function runRetrieval(): Promise<void> {
  const databaseUrl = requireDatabaseUrl();

  const plan = resolveRecordedRun("retrieval");
  // 実行ごとに新しい tenantId を使う（ADR 0068）。2回目が前回の記憶を「取り込み済み」として素通りし、`ingest` の欄が逆の結論を
  // 印字しないようにするため。冪等性（externalId の重複排除）自体は正しい挙動なので崩さない。
  const runToken = newRunToken();
  const armSpecs = buildArmSpecs(plan.cassette ? "recorded" : "openai", runToken);

  // `MNEMORA_BENCH_CHANNELS` 未指定なら `undefined` のまま渡し、`packages/core` の既定 `["ann"]` の挙動を変えない（ADR 0148）。
  const benchChannels = parseBenchChannels(process.env.MNEMORA_BENCH_CHANNELS);
  if (benchChannels !== undefined) {
    console.log(
      `\n[retrieval] MNEMORA_BENCH_CHANNELS により channels=[${benchChannels.join(", ")}] で実行する`,
    );
  }

  const reports = [];
  for (const arm of armSpecs) {
    console.log(`\n########## arm ${arm.armLabel} ##########`);
    const handle = await createExampleRuntime(
      databaseUrl,
      {
        ...plan.env,
        MNEMORA_LLM: arm.llmOverride,
        MNEMORA_EMBEDDING: arm.embeddingOverride,
      },
      plan.providerOptions,
    );
    printProviderMode(handle, plan.plannedSource);
    try {
      const report = await runRetrievalQualityArm({
        armLabel: arm.armLabel,
        tenantId: arm.tenantId,
        runtime: handle.runtime,
        memoryStore: handle.memoryStore,
        llmMode: handle.llmMode,
        embeddingMode: handle.embeddingMode,
        ...(handle.usageMeter !== undefined ? { usageMeter: handle.usageMeter } : {}),
        ...(benchChannels !== undefined ? { channels: benchChannels } : {}),
      });
      reports.push(report);
      console.log(formatArmDetail(report));
    } finally {
      await handle.close();
    }
  }

  console.log("\n\n=== probe ごとの比較(3 arm を並べる) ===");
  console.log(formatProbeComparisonTable(reports));
  console.log("\n=== arm ごとのまとめ ===");
  console.log(formatArmSummaryTable(reports));

  const retrievalJsonPath = process.env.MNEMORA_RETRIEVAL_JSON;
  if (retrievalJsonPath) {
    const json = buildRetrievalQualityJson({
      reports,
      providerSource: plan.cassette ? "recorded" : "openai",
      cassette: plan.cassette,
      measuredAt: new Date(),
      commit: tryGitRevParseHead(process.cwd()),
    });
    writeFileSync(retrievalJsonPath, `${JSON.stringify(json, null, 2)}\n`, "utf-8");
    console.log(`\n[retrieval] 機械可読な結果を書き出した: ${retrievalJsonPath}`);
  }
}

/**
 * 実 API の応答を記録してカセットに書き出す（ADR 0051）。
 *
 * 再生する当のもの（`retrieval` の arm B・C）をそのまま走らせて録る。probe set から「必要そうな入力」を列挙する形は採らない。
 * 列挙が漏れると再生時に「記録に無い」で落ちる。arm B と C は埋め込みへの入力が違うので両方録る。arm A は API を叩かない。
 */
async function recordRetrieval(
  databaseUrl: string,
  recorder: CassetteRecorder,
  runId: number,
): Promise<void> {
  // id の文字列一致ではなく、宣言された欄で選ぶ。
  const armSpecs = buildArmSpecs("openai", String(runId)).filter((a) => a.touchesApi);
  for (const arm of armSpecs) {
    console.log(`\n########## 記録中: arm ${arm.armLabel} ##########`);
    const handle = await createExampleRuntime(
      databaseUrl,
      { ...process.env, MNEMORA_LLM: arm.llmOverride, MNEMORA_EMBEDDING: arm.embeddingOverride },
      { recorder },
    );
    printProviderMode(handle, null);
    try {
      await runRetrievalQualityArm({
        armLabel: arm.armLabel,
        tenantId: `${arm.tenantId}-record-${runId}`,
        runtime: handle.runtime,
        memoryStore: handle.memoryStore,
        llmMode: handle.llmMode,
        embeddingMode: handle.embeddingMode,
        ...(handle.usageMeter !== undefined ? { usageMeter: handle.usageMeter } : {}),
      });
    } finally {
      await handle.close();
    }
  }
}

/**
 * `compare` の全会話長を実 API で走らせて記録する（ADR 0052）。
 * `retrieval` より1桁高い費用がかかる（見積もりは ADR 0019 §3、数はここに写さない）。だから `record` は対象を明示させる。
 */
async function recordCompare(
  databaseUrl: string,
  recorder: CassetteRecorder,
  runId: number,
): Promise<void> {
  console.log("\n########## 記録中: compare（全会話長） ##########");
  const handle = await createExampleRuntime(
    databaseUrl,
    { ...process.env, MNEMORA_LLM: "openai", MNEMORA_EMBEDDING: "openai" },
    { recorder },
  );
  printProviderMode(handle, null);
  try {
    const rows = await runComparison(handle.runtime, {
      fillerPairsSequence: DEFAULT_COMPARE_SEQUENCE,
      tenantPrefix: `example-compare-record-${runId}`,
      memoryStore: handle.memoryStore,
    });
    console.log(`\n${formatComparisonTable(rows)}`);
    console.log(`\n${formatRecallQualityTable(rows)}`);
    if (handle.usageMeter) {
      console.log(`\n${handle.usageMeter.formatReport()}`);
    }
  } finally {
    await handle.close();
  }
}

/**
 * 「種カセット」を環境変数 `MNEMORA_RECORD_SEED_CASSETTE` から読む。未設定なら `undefined` で、既存の挙動を変えない。
 * 録り直すたびに抽出が実 API でやり直されて記憶集合が変わりうるので、旧カセットを種に渡して揃え、実 API の呼び出し回数も減らす。
 */
function loadRecordSeedCassette(): Cassette | undefined {
  const path = process.env.MNEMORA_RECORD_SEED_CASSETTE;
  if (!path) {
    return undefined;
  }
  console.log(`[record] 種カセットを読む（MNEMORA_RECORD_SEED_CASSETTE）: ${path}`);
  return loadCassette(path);
}

/**
 * `answer` を実 API で走らせて記録する（ADR 0051）。再生する当のもの（`runAnswer` と同じ実行経路）をそのまま走らせて録る。
 *
 * tenantPrefix に `runId` を含め、毎回新しいテナントにする。`observe()` は `externalId` で重複排除するため、
 * 取り込み済みのテナントで録ると抽出も埋め込みも呼ばれず、空のカセットで `CassetteRecorder.toCassette()` が落ちる。
 */
async function recordAnswer(
  databaseUrl: string,
  recorder: CassetteRecorder,
  runId: number,
): Promise<void> {
  console.log("\n########## 記録中: answer ##########");
  const measuredAt = new Date();
  const commit = tryGitRevParseHead(process.cwd());
  const seedCassette = loadRecordSeedCassette();
  const handle = await createAnswerBenchRuntime(
    databaseUrl,
    { ...process.env, MNEMORA_LLM: "openai", MNEMORA_EMBEDDING: "openai" },
    { recorder, seedCassette },
  );
  printProviderMode(handle, null);
  try {
    const cases = [...ANSWER_CASE_SET_DEV, ...ANSWER_CASE_SET_EVAL];
    const results = await runAnswerBench(
      handle.runtime,
      handle.llmProvider,
      handle.embeddingProvider,
      handle.judgeLLMProvider,
      cases,
      `answer-record-${runId}`,
    );

    console.log(`\n${formatAnswerTable(results, handle.llmMode)}`);
    console.log("\n--- 追加費用(別ブロック。⛔ 下の入力量の差には含めない) ---");
    console.log(formatAnswerCostTable(results));
    console.log(`\n${formatAnswerInputReduction(results)}`);
    console.log(formatAnswerContentPreservation(results));

    // Issue #498 完了条件4の陽性対照を、この全置換の記録の一部として毎回追記する。`recordAnswer` は毎回空の `CassetteRecorder` から
    // 始まるので、ここに置かないと、次の素の `record answer` で陽性対照の2エントリが新しいカセットから消える。
    const retentionMutation = await recordRetentionMutationPositiveControl(
      handle.runtime,
      handle.llmProvider,
      handle.embeddingProvider,
      handle.judgeLLMProvider,
      cases,
      `answer-record-${runId}`,
    );
    console.log(
      "\n--- Issue #498 完了条件4・回答評価の陽性対照（変異: digest から答えの語を落とす） ---",
    );
    console.log(
      `  ケース: ${retentionMutation.caseId} / 変異後の回答: "${retentionMutation.mutatedAnswer}"\n` +
        `  一次判定: ${retentionMutation.mutatedVerdict} / 二次観測(judge): ` +
        `${retentionMutation.mutatedJudgement.outcome}`,
    );

    if (handle.usageMeter) {
      console.log(`\n${handle.usageMeter.formatReport()}`);
    }
    if (handle.readSeedUsage) {
      console.log(`\n${formatSeedUsageReport(handle.readSeedUsage())}`);
    }

    const jsonPath = process.env.MNEMORA_ANSWER_JSON;
    if (jsonPath) {
      const json = buildAnswerJson({
        results,
        llmMode: handle.llmMode,
        embeddingMode: handle.embeddingMode,
        measuredAt,
        commit,
      });
      writeFileSync(jsonPath, `${JSON.stringify(json, null, 2)}\n`, "utf-8");
      console.log(`\n[answer] 機械可読な結果を書き出した: ${jsonPath}`);
    }
  } finally {
    await handle.close();
  }
}

/**
 * `answer-time-weighting` の記録。`recordAnswer` と同じく毎回新しい tenantId で走らせる。
 * trial は1回だけ記録する。カセットは「プロンプトのハッシュ→応答」の連想配列なので、同じ質問・同じ記憶状態の複数 trial は
 * 同じ鍵に畳まれ、増やしても記録される内容は増えない。
 */
async function recordTimeWeighting(
  databaseUrl: string,
  recorder: CassetteRecorder,
  runId: number,
): Promise<void> {
  console.log("\n########## 記録中: answer-time-weighting ##########");
  // この記録は temperature=0 で固定する。temperature 未指定（既定1.0）は、同じ入力でも `gradeAnswer` の正誤が run ごとに揺れることを
  // 実測した（`bench-results/STAGE3A-NOTES.txt`）。カセットは記録時点の応答を固定して再生するので、揺れの少ない値で録る。
  const seedCassette = loadRecordSeedCassette();
  const handle = await createTimeWeightingBenchRuntime(
    databaseUrl,
    { ...process.env, MNEMORA_LLM: "openai", MNEMORA_EMBEDDING: "openai" },
    { recorder, llmTemperature: 0, seedCassette },
  );
  printProviderMode(handle, null);
  try {
    const cases = [
      ...TIME_WEIGHTING_CASE_SET_DEV,
      ...TIME_WEIGHTING_CASE_SET_EVAL,
      ...TIME_WEIGHTING_CASE_SET_EVAL_UNDATED,
    ];
    const results = await runTimeWeightingBench(
      handle,
      cases,
      `answer-time-weighting-record-${runId}`,
      1,
    );
    const aggregate = aggregateTimeWeightingResults(results);
    console.log(`\n${formatTimeWeightingTable(aggregate, handle.llmMode)}`);
    console.log(formatTimeWeightingKindSummary(aggregate, handle.llmMode));
    if (handle.usageMeter) {
      console.log(`\n${handle.usageMeter.formatReport()}`);
    }
    if (handle.readSeedUsage) {
      console.log(`\n${formatSeedUsageReport(handle.readSeedUsage())}`);
    }
  } finally {
    await handle.close();
  }
}

async function runRecord(target: CassetteTarget): Promise<void> {
  const databaseUrl = requireDatabaseUrl();
  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      "record は本物の OpenAI を叩いて記録する。OPENAI_API_KEY を設定してから実行すること。",
    );
  }

  const recorder = new CassetteRecorder();

  // 記録は必ず新しいテナントで走らせる。`observe()` は `externalId` で重複排除するため、取り込み済みのテナントでは
  // 抽出も埋め込みも呼ばれず、1件も記録されていないカセットができる。
  const runId = Date.now();

  if (target === "retrieval") {
    await recordRetrieval(databaseUrl, recorder, runId);
  } else if (target === "compare") {
    await recordCompare(databaseUrl, recorder, runId);
  } else if (target === "answer") {
    await recordAnswer(databaseUrl, recorder, runId);
  } else {
    await recordTimeWeighting(databaseUrl, recorder, runId);
  }

  const cassette = recorder.toCassette();
  const path = cassettePathFor(target);
  saveCassette(cassette, path);
  console.log(`\n書き出した: ${path}`);
  console.log(`  ${describeCassette(cassette)}`);
  console.log(
    "  ⚠ これはこの時点の API の姿の記録である。モデルが更新されても記録は変わらない——" +
      "乖離は `verify` で確かめること（ADR 0051 の「引き受けた負債」）。",
  );
}

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * 記録が実 API から乖離していないかを測る（ADR 0051 の「覆る条件」を測れる形にしたもの）。
 *
 * 埋め込みだけを照合し、LLM 側は件数の確認に留める。LLM の応答は同じ入力でも揺れるため、照合できないものを照合したふりをしない。
 * 埋め込みもビット単位では再現しない（同じ日・同じモデルで20/152件が不一致、最小コサイン類似度 0.998647）。
 * そのため「完全一致したか」と「乖離したか」を別々に数える。前者は一部が外れるのが普通で、後者だけが記録し直す理由になる。
 */
const DRIFT_COSINE_THRESHOLD = 0.99;
async function runVerify(target: CassetteTarget): Promise<void> {
  if (!process.env.OPENAI_API_KEY) {
    console.error("verify は実 API と記録を突き合わせる。OPENAI_API_KEY を設定すること。");
    process.exitCode = 1;
    return;
  }
  const cassette = loadCassette(cassettePathFor(target));
  console.log(`照合するカセット（${target}）: ${describeCassette(cassette)}`);

  const { createProviders } = await import("./providers.js");
  const { embeddingProvider, usageMeter } = createProviders({
    ...process.env,
    MNEMORA_LLM: "deterministic",
    MNEMORA_EMBEDDING: "openai",
  });

  const entries = Object.values(cassette.embedding.entries);
  const texts = entries.map((e) => e.text);
  const fresh = await embeddingProvider.embed({ tenantId: "cassette-verify" }, texts);

  let worst = { similarity: 1, text: "" };
  let exact = 0;
  let drifted = 0;
  entries.forEach((entry, i) => {
    const similarity = cosine(entry.vector, fresh[i] ?? []);
    if (similarity >= 1 - Number.EPSILON) {
      exact += 1;
    }
    if (similarity < DRIFT_COSINE_THRESHOLD) {
      drifted += 1;
    }
    if (similarity < worst.similarity) {
      worst = { similarity, text: entry.text };
    }
  });

  console.log(`\n埋め込み ${entries.length} 件を実 API と照合した。`);
  console.log(`  完全一致: ${exact} 件（一致しない分は実 API 側の揺らぎ。異常ではない）`);
  console.log(`  最小コサイン類似度: ${worst.similarity.toFixed(9)}`);
  console.log(`  最も離れた入力: ${JSON.stringify(worst.text)}`);
  console.log(`  閾値 ${DRIFT_COSINE_THRESHOLD} を割った件数: ${drifted}`);
  if (drifted > 0) {
    console.log("  🔴 記録が実 API から乖離している。記録し直すこと（ADR 0051）。");
    process.exitCode = 1;
  } else {
    console.log("  ✅ 揺らぎの範囲内。記録は実 API と整合している。");
  }
  console.log(
    `\nLLM（${cassette.llm.model}）の記録 ${Object.keys(cassette.llm.entries).length} 件は照合していない` +
      "——同じ入力でも応答が揺れるため、差が出ても「モデルが変わった」とは言えない。",
  );
  if (usageMeter) {
    console.log(usageMeter.formatReport());
  }
}

/**
 * `freshness`/`decay` を意味的類似度から分離して測る arm。
 *
 * provider は既定で `deterministic` に倒す。ペアの2件は本文が同一なので、`similarity` は構成上定数になり、
 * この測定は provider 層に依らない。カセットの再録も `OPENAI_API_KEY` も要らない。
 * `MNEMORA_LLM`/`MNEMORA_EMBEDDING` が明示されていればそれを尊重する。
 * ただし「想起の質」は主張しない。測るのは時間項が順位を決めているかだけ（AGENTS.md）。
 *
 * `MutableClock` を注入する。`decay-*` probe が `recordedAt` を過去へ振るには、`createExampleRuntime` と `runTimeTermArm` に
 * 同じ `Clock` インスタンスを渡す必要がある。
 */
async function runTimeTerm(): Promise<void> {
  const databaseUrl = requireDatabaseUrl();
  const measuredAt = new Date();
  const commit = tryGitRevParseHead(process.cwd());
  const clock = createMutableClock();
  const handle = await createExampleRuntime(
    databaseUrl,
    {
      ...process.env,
      MNEMORA_LLM: process.env.MNEMORA_LLM ?? "deterministic",
      MNEMORA_EMBEDDING: process.env.MNEMORA_EMBEDDING ?? "deterministic",
    },
    {},
    clock,
  );
  printProviderMode(handle, null);
  try {
    console.log(
      "\n「内容は同一・occurredAt/recordedAt だけ違う」ペアで、" +
        "freshness/decay が順位をどう動かすかを測る。\n",
    );
    const report = await runTimeTermArm({
      armLabel: "time-term",
      tenantIdPrefix: "time-term",
      runtime: handle.runtime,
      memoryStore: handle.memoryStore,
      llmMode: handle.llmMode,
      embeddingMode: handle.embeddingMode,
      clock,
    });
    console.log(formatTimeTermReport(report));

    const jsonPath = process.env.MNEMORA_TIME_TERM_JSON;
    if (jsonPath) {
      const json = buildTimeTermJson({ report, measuredAt, commit });
      writeFileSync(jsonPath, `${JSON.stringify(json, null, 2)}\n`, "utf-8");
      console.log(`\n[time-term] 機械可読な結果を書き出した: ${jsonPath}`);
    }
  } finally {
    await handle.close();
  }
}

/**
 * `validAt` ゲートを測る arm。provider は既定で `deterministic` に倒す（`runTimeTerm()` と同じ理由）。
 * 動かす項は `validFrom`/`validUntil` で `recordedAt` ではないので、`MutableClock` は要らない。
 */
async function runValidity(): Promise<void> {
  const databaseUrl = requireDatabaseUrl();
  const measuredAt = new Date();
  const commit = tryGitRevParseHead(process.cwd());
  const handle = await createExampleRuntime(databaseUrl, {
    ...process.env,
    MNEMORA_LLM: process.env.MNEMORA_LLM ?? "deterministic",
    MNEMORA_EMBEDDING: process.env.MNEMORA_EMBEDDING ?? "deterministic",
  });
  printProviderMode(handle, null);
  try {
    console.log(
      "\n「内容は同一・validFrom/validUntil だけ違う」ペアで、" +
        "validAt ゲートが候補の有無をどう動かすかを測る。\n",
    );
    const report = await runValidityArm({
      armLabel: "validity",
      tenantIdPrefix: "validity",
      runtime: handle.runtime,
      memoryStore: handle.memoryStore,
      llmMode: handle.llmMode,
      embeddingMode: handle.embeddingMode,
    });
    console.log(formatValidityReport(report));

    const jsonPath = process.env.MNEMORA_VALIDITY_JSON;
    if (jsonPath) {
      const json = buildValidityJson({ report, measuredAt, commit });
      writeFileSync(jsonPath, `${JSON.stringify(json, null, 2)}\n`, "utf-8");
      console.log(`\n[validity] 機械可読な結果を書き出した: ${jsonPath}`);
    }
  } finally {
    await handle.close();
  }
}

/**
 * 識別子・固有名詞を含む query の想起を、擬似LLM + ローカル埋め込み（`@mnemora/local-embedding`、鍵もカセットも要らない）で測る。
 * LLM 層は `retrieval` の arm B と同一で、差は埋め込みだけ。
 *
 * 群を別々に集計し、混ぜた単一の MRR を主たる数字にしない（件数は `examples/chat/README.md` と各 probe set が持つ。ここには写さない）。
 * 群2（sparse）は消さない。当初の識別子 probe が全件 hit@1 だった実測自体が発見であり、dense は「難しくして失敗させる」ためではなく
 * 「同じ書式の識別子が多数居る状況を表す」ために足した。
 *
 * `warmup()` を明示的に呼び、失敗を区別する。「HF から取得できなかった」が「想起の質が下がった」に見えてはならない。
 * 失敗したらメトリクスを1つも出さずに打ち切る。
 */
async function runIdentifierProbes(): Promise<void> {
  const databaseUrl = requireDatabaseUrl();
  const runToken = newRunToken();
  const measuredAt = new Date();
  const commit = tryGitRevParseHead(process.cwd());

  const handle = await createExampleRuntime(databaseUrl, {
    ...process.env,
    MNEMORA_LLM: "deterministic",
    MNEMORA_EMBEDDING: "local",
  });
  printProviderMode(handle, null);

  try {
    console.log(
      "\n[identifier-probes] warmup() でモデルの読み込みを先に済ませる" +
        "(取得に失敗したら、ここでメトリクスを出さずに打ち切る)…",
    );
    const warmup = await warmupLocalEmbedding(handle.embeddingProvider);
    const jsonPath = process.env.MNEMORA_IDENTIFIER_PROBE_JSON;
    if (!warmup.ok) {
      console.error(`\n🔴 ${warmup.detail}`);
      console.error(
        "  メトリクスは1件も測っていない(前回の値・既定値・0 へは倒さない)。" +
          "ネットワーク・Hugging Face repo の状態を確認し、再実行すること。",
      );
      process.exitCode = 1;
      if (jsonPath) {
        const json = buildWeightsUnavailableIdentifierProbeJson({
          measuredAt,
          commit,
          detail: warmup.detail,
        });
        writeFileSync(jsonPath, `${JSON.stringify(json, null, 2)}\n`, "utf-8");
        console.log(`\n[identifier-probes] 機械可読な結果(取得失敗)を書き出した: ${jsonPath}`);
      }
      return;
    }
    console.log(`  ${warmup.detail}`);

    const embeddingSpace = handle.embeddingProvider.space;
    console.log(
      `[identifier-probes] embedding space: provider=${embeddingSpace.provider} ` +
        `model=${embeddingSpace.model} dimensions=${embeddingSpace.dimensions}`,
    );

    console.log(
      `\n=== 群1: 既存の日本語意味 probe ${PROBES.length}件(./probe-set.js、変更していない) ===`,
    );
    const japaneseReport = await runRetrievalQualityArm({
      // `haystack=sparse` を label に含める。JSON の `haystackKind` は `"sparse"` を名乗るので、label だけが条件を落とすと、
      // 条件を落とした数字を label の側で作ることになる。
      armLabel: `identifier-probes/japanese(llm=${handle.llmMode}, embedding=${handle.embeddingMode}/${embeddingSpace.model}/${embeddingSpace.dimensions}次元, haystack=sparse)`,
      tenantId: `identifier-probes-jp-${runToken}`,
      runtime: handle.runtime,
      memoryStore: handle.memoryStore,
      llmMode: handle.llmMode,
      embeddingMode: handle.embeddingMode,
      ...(handle.usageMeter !== undefined ? { usageMeter: handle.usageMeter } : {}),
    });
    console.log(formatArmDetail(japaneseReport));

    console.log(
      `\n=== 群2: ASCII 識別子 probe ${IDENTIFIER_PROBES.length}件(./identifier-probe-set.js、haystack=sparse) ===`,
    );
    const identifierSparseReport = await runIdentifierProbeArm({
      armLabel: `identifier-probes/identifiers-sparse(llm=${handle.llmMode}, embedding=${handle.embeddingMode}/${embeddingSpace.model}/${embeddingSpace.dimensions}次元, haystack=sparse)`,
      tenantId: `identifier-probes-id-sparse-${runToken}`,
      runtime: handle.runtime,
      memoryStore: handle.memoryStore,
      llmMode: handle.llmMode,
      embeddingMode: handle.embeddingMode,
      haystackKind: "sparse",
    });
    console.log(formatIdentifierArmReport(identifierSparseReport));

    console.log(
      `\n=== 群3: ASCII 識別子 probe ${IDENTIFIER_PROBES.length}件(./identifier-probe-set.js、haystack=dense) ===`,
    );
    const identifierDenseReport = await runIdentifierProbeArm({
      armLabel: `identifier-probes/identifiers-dense(llm=${handle.llmMode}, embedding=${handle.embeddingMode}/${embeddingSpace.model}/${embeddingSpace.dimensions}次元, haystack=dense)`,
      tenantId: `identifier-probes-id-dense-${runToken}`,
      runtime: handle.runtime,
      memoryStore: handle.memoryStore,
      llmMode: handle.llmMode,
      embeddingMode: handle.embeddingMode,
      haystackKind: "dense",
    });
    console.log(formatIdentifierArmReport(identifierDenseReport));

    console.log(
      `\n=== 群4: 日本語の固有名詞 probe ${JAPANESE_NAME_PROBES.length}件(./japanese-name-probe-set.js、haystack=sparse) ===`,
    );
    const japaneseNameSparseReport = await runIdentifierProbeArm({
      armLabel: `identifier-probes/japanese-names-sparse(llm=${handle.llmMode}, embedding=${handle.embeddingMode}/${embeddingSpace.model}/${embeddingSpace.dimensions}次元, haystack=sparse)`,
      tenantId: `identifier-probes-jp-sparse-${runToken}`,
      runtime: handle.runtime,
      memoryStore: handle.memoryStore,
      llmMode: handle.llmMode,
      embeddingMode: handle.embeddingMode,
      haystackKind: "sparse",
      probeSet: JAPANESE_NAME_PROBE_SET_SPEC,
    });
    console.log(formatIdentifierArmReport(japaneseNameSparseReport));

    console.log(
      `\n=== 群5: 日本語の固有名詞 probe ${JAPANESE_NAME_PROBES.length}件(./japanese-name-probe-set.js、haystack=dense) ===`,
    );
    const japaneseNameDenseReport = await runIdentifierProbeArm({
      armLabel: `identifier-probes/japanese-names-dense(llm=${handle.llmMode}, embedding=${handle.embeddingMode}/${embeddingSpace.model}/${embeddingSpace.dimensions}次元, haystack=dense)`,
      tenantId: `identifier-probes-jp-dense-${runToken}`,
      runtime: handle.runtime,
      memoryStore: handle.memoryStore,
      llmMode: handle.llmMode,
      embeddingMode: handle.embeddingMode,
      haystackKind: "dense",
      probeSet: JAPANESE_NAME_PROBE_SET_SPEC,
    });
    console.log(formatIdentifierArmReport(japaneseNameDenseReport));

    const jpHeadline = armHeadline(japaneseReport);
    console.log(
      "\n=== まとめ(5群は別々——混ぜた単一の MRR は作らない) ===\n" +
        `  日本語意味probe(${jpHeadline.probeCount}件, llm=${handle.llmMode}, ` +
        `embedding=${handle.embeddingMode}/${embeddingSpace.model}/${embeddingSpace.dimensions}次元, ` +
        `haystack=sparse): MRR=${jpHeadline.mrrOverall.toFixed(3)} ` +
        `hit@1=${jpHeadline.hit1Count}/${jpHeadline.probeCount} ` +
        `hit@10=${jpHeadline.hit10Count}/${jpHeadline.probeCount}\n` +
        `  ASCII識別子probe(${identifierSparseReport.probeCount}件, llm=${handle.llmMode}, ` +
        `embedding=${handle.embeddingMode}/${embeddingSpace.model}/${embeddingSpace.dimensions}次元, ` +
        `haystack=sparse): MRR=${identifierSparseReport.mrrOverall.toFixed(3)} ` +
        `hit@1=${identifierSparseReport.hit1Count}/${identifierSparseReport.probeCount} ` +
        `hit@10=${identifierSparseReport.hit10Count}/${identifierSparseReport.probeCount}\n` +
        `  ASCII識別子probe(${identifierDenseReport.probeCount}件, llm=${handle.llmMode}, ` +
        `embedding=${handle.embeddingMode}/${embeddingSpace.model}/${embeddingSpace.dimensions}次元, ` +
        `haystack=dense): MRR=${identifierDenseReport.mrrOverall.toFixed(3)} ` +
        `hit@1=${identifierDenseReport.hit1Count}/${identifierDenseReport.probeCount} ` +
        `hit@10=${identifierDenseReport.hit10Count}/${identifierDenseReport.probeCount}\n` +
        `  日本語固有名詞probe(${japaneseNameSparseReport.probeCount}件, llm=${handle.llmMode}, ` +
        `embedding=${handle.embeddingMode}/${embeddingSpace.model}/${embeddingSpace.dimensions}次元, ` +
        `haystack=sparse): MRR=${japaneseNameSparseReport.mrrOverall.toFixed(3)} ` +
        `hit@1=${japaneseNameSparseReport.hit1Count}/${japaneseNameSparseReport.probeCount} ` +
        `hit@10=${japaneseNameSparseReport.hit10Count}/${japaneseNameSparseReport.probeCount}\n` +
        `  日本語固有名詞probe(${japaneseNameDenseReport.probeCount}件, llm=${handle.llmMode}, ` +
        `embedding=${handle.embeddingMode}/${embeddingSpace.model}/${embeddingSpace.dimensions}次元, ` +
        `haystack=dense): MRR=${japaneseNameDenseReport.mrrOverall.toFixed(3)} ` +
        `hit@1=${japaneseNameDenseReport.hit1Count}/${japaneseNameDenseReport.probeCount} ` +
        `hit@10=${japaneseNameDenseReport.hit10Count}/${japaneseNameDenseReport.probeCount}`,
    );
    console.log(
      `\n(注) ADR 0033 §3: 標本${japaneseReport.probes.length}件・${identifierSparseReport.probeCount}件からは` +
        "失敗率も成功率も統計的に主張しない。" +
        "ここで言えるのは「今回、この母数のうち何件引けたか」までである。",
    );

    if (jsonPath) {
      const json = buildMeasuredIdentifierProbeJson({
        japaneseReport,
        identifierSparseReport,
        identifierDenseReport,
        japaneseNameSparseReport,
        japaneseNameDenseReport,
        embeddingSpace,
        measuredAt,
        commit,
      });
      writeFileSync(jsonPath, `${JSON.stringify(json, null, 2)}\n`, "utf-8");
      console.log(`\n[identifier-probes] 機械可読な結果を書き出した: ${jsonPath}`);
    }
  } finally {
    await handle.close();
  }

  // OpenAI 実埋め込みの4群を追加で走らせる。門ではない。このブロックが例外を投げても、上の local embedding の測定・書き出しは終わっている。
  // `MNEMORA_IDENTIFIER_PROBE_OPENAI_JSON` が指定されていないときは何もしない。
  const openaiJsonPath = process.env.MNEMORA_IDENTIFIER_PROBE_OPENAI_JSON;
  if (openaiJsonPath) {
    try {
      await runIdentifierProbesOpenAiArm(databaseUrl, openaiJsonPath, measuredAt, commit);
    } catch (error) {
      console.error(
        "\n🔴 [identifier-probes/openai] OpenAI arm(recorded)の測定に失敗した" +
          "(⛔ 上の local embedding 測定・このジョブ自体は落とさない):",
        error,
      );
    }
  }
}

/**
 * 識別子・日本語固有名詞 probe の4群を、OpenAI 実埋め込み（カセットの再生）で測る。
 * 門ではない。呼び出し側が例外を握ってログに出すだけで、既存の local embedding 測定には影響させない。
 */
async function runIdentifierProbesOpenAiArm(
  databaseUrl: string,
  jsonPath: string,
  measuredAt: Date,
  commit: string | null,
): Promise<void> {
  const cassette = loadOpenAiArmCassette(IDENTIFIER_OPENAI_CASSETTE_PATH);
  const runToken = newRunToken();
  const handle = await createExampleRuntime(
    databaseUrl,
    { ...process.env, MNEMORA_LLM: "deterministic", MNEMORA_EMBEDDING: "recorded" },
    { cassette },
  );
  try {
    const embeddingSpace = handle.embeddingProvider.space;
    console.log(
      `\n[identifier-probes/openai] embedding space: provider=${embeddingSpace.provider} ` +
        `model=${embeddingSpace.model} dimensions=${embeddingSpace.dimensions}(recorded 再生)`,
    );
    const groupResults: {
      key: string;
      report: Awaited<ReturnType<typeof runIdentifierProbeArm>>;
      embeddingSpace: typeof embeddingSpace;
    }[] = [];
    for (const group of identifierArmGroups()) {
      const armLabel = buildArmLabel(group, {
        llmMode: handle.llmMode,
        embeddingMode: handle.embeddingMode,
        model: embeddingSpace.model,
        dimensions: embeddingSpace.dimensions,
      });
      const report = await runIdentifierProbeArm({
        armLabel,
        tenantId: buildArmTenantId(`identifier-probes-openai-${group.key}`, runToken),
        runtime: handle.runtime,
        memoryStore: handle.memoryStore,
        llmMode: handle.llmMode,
        embeddingMode: handle.embeddingMode,
        haystackKind: group.haystackKind,
        probeSet: group.probeSet,
      });
      console.log(formatIdentifierArmReport(report));
      groupResults.push({ key: group.key, report, embeddingSpace });
    }
    const json = buildOpenAiArmRunJson(groupResults, measuredAt, commit);
    writeFileSync(jsonPath, `${JSON.stringify(json, null, 2)}\n`, "utf-8");
    console.log(`\n[identifier-probes/openai] 機械可読な結果を書き出した: ${jsonPath}`);
  } finally {
    await handle.close();
  }
}

/**
 * `numeral-token-probes` サブコマンド（ADR 0135）。`identifier-probes` が確立した形（擬似LLM + `@mnemora/local-embedding`、
 * 鍵・カセット不要、`warmup()` で失敗を区別、sparse/dense を別々に集計、門にしない）を踏襲する。
 * 別の集合・別の JSON・別の CI ジョブで、`identifier-probes` 自体には触れない。
 *
 * 混ぜた単一の MRR を主たる数字にしない。margin（ADR 0135 §5.5）は hit@1/hit@10 と併記する。
 */
async function runNumeralTokenProbes(): Promise<void> {
  const databaseUrl = requireDatabaseUrl();
  const runToken = newRunToken();
  const measuredAt = new Date();
  const commit = tryGitRevParseHead(process.cwd());

  const handle = await createExampleRuntime(databaseUrl, {
    ...process.env,
    MNEMORA_LLM: "deterministic",
    MNEMORA_EMBEDDING: "local",
  });
  printProviderMode(handle, null);

  try {
    console.log(
      "\n[numeral-token-probes] warmup() でモデルの読み込みを先に済ませる" +
        "(取得に失敗したら、ここでメトリクスを出さずに打ち切る)…",
    );
    const warmup = await warmupLocalEmbedding(handle.embeddingProvider);
    const jsonPath = process.env.MNEMORA_NUMERAL_TOKEN_JSON;
    if (!warmup.ok) {
      console.error(`\n🔴 ${warmup.detail}`);
      console.error(
        "  メトリクスは1件も測っていない(前回の値・既定値・0 へは倒さない)。" +
          "ネットワーク・Hugging Face repo の状態を確認し、再実行すること。",
      );
      process.exitCode = 1;
      if (jsonPath) {
        const json = buildWeightsUnavailableNumeralTokenProbeJson({
          measuredAt,
          commit,
          detail: warmup.detail,
        });
        writeFileSync(jsonPath, `${JSON.stringify(json, null, 2)}\n`, "utf-8");
        console.log(`\n[numeral-token-probes] 機械可読な結果(取得失敗)を書き出した: ${jsonPath}`);
      }
      return;
    }
    console.log(`  ${warmup.detail}`);

    const embeddingSpace = handle.embeddingProvider.space;
    console.log(
      `[numeral-token-probes] embedding space: provider=${embeddingSpace.provider} ` +
        `model=${embeddingSpace.model} dimensions=${embeddingSpace.dimensions}`,
    );

    console.log(
      `\n=== 群1: 数詞・記号索引 probe ${NUMERAL_TOKEN_PROBES.length}件(./numeral-token-probe-set.js、haystack=sparse) ===`,
    );
    const sparseReport = await runIdentifierProbeArm({
      armLabel: `numeral-token-probes/sparse(llm=${handle.llmMode}, embedding=${handle.embeddingMode}/${embeddingSpace.model}/${embeddingSpace.dimensions}次元, haystack=sparse)`,
      tenantId: buildArmTenantId("numeral-token-sparse", runToken),
      runtime: handle.runtime,
      memoryStore: handle.memoryStore,
      llmMode: handle.llmMode,
      embeddingMode: handle.embeddingMode,
      haystackKind: "sparse",
      probeSet: NUMERAL_TOKEN_PROBE_SET_SPEC,
    });
    console.log(formatIdentifierArmReport(sparseReport));

    console.log(
      `\n=== 群2: 数詞・記号索引 probe ${NUMERAL_TOKEN_PROBES.length}件(./numeral-token-probe-set.js、haystack=dense) ===`,
    );
    const denseReport = await runIdentifierProbeArm({
      armLabel: `numeral-token-probes/dense(llm=${handle.llmMode}, embedding=${handle.embeddingMode}/${embeddingSpace.model}/${embeddingSpace.dimensions}次元, haystack=dense)`,
      tenantId: buildArmTenantId("numeral-token-dense", runToken),
      runtime: handle.runtime,
      memoryStore: handle.memoryStore,
      llmMode: handle.llmMode,
      embeddingMode: handle.embeddingMode,
      haystackKind: "dense",
      probeSet: NUMERAL_TOKEN_PROBE_SET_SPEC,
    });
    console.log(formatIdentifierArmReport(denseReport));

    console.log(
      "\n=== まとめ(2群は別々——混ぜた単一の MRR は作らない) ===\n" +
        `  数詞・記号索引probe(${sparseReport.probeCount}件, llm=${handle.llmMode}, ` +
        `embedding=${handle.embeddingMode}/${embeddingSpace.model}/${embeddingSpace.dimensions}次元, ` +
        `haystack=sparse): MRR=${sparseReport.mrrOverall.toFixed(3)} ` +
        `hit@1=${sparseReport.hit1Count}/${sparseReport.probeCount} ` +
        `hit@10=${sparseReport.hit10Count}/${sparseReport.probeCount}\n` +
        `  数詞・記号索引probe(${denseReport.probeCount}件, llm=${handle.llmMode}, ` +
        `embedding=${handle.embeddingMode}/${embeddingSpace.model}/${embeddingSpace.dimensions}次元, ` +
        `haystack=dense): MRR=${denseReport.mrrOverall.toFixed(3)} ` +
        `hit@1=${denseReport.hit1Count}/${denseReport.probeCount} ` +
        `hit@10=${denseReport.hit10Count}/${denseReport.probeCount}`,
    );
    console.log(
      `\n(注) ADR 0033 §3: 標本${sparseReport.probeCount}件からは失敗率も成功率も統計的に` +
        "主張しない。ここで言えるのは「今回、この母数のうち何件引けたか」までである。",
    );

    if (jsonPath) {
      const json = buildMeasuredNumeralTokenProbeJson({
        sparseReport,
        denseReport,
        embeddingSpace,
        measuredAt,
        commit,
      });
      writeFileSync(jsonPath, `${JSON.stringify(json, null, 2)}\n`, "utf-8");
      console.log(`\n[numeral-token-probes] 機械可読な結果を書き出した: ${jsonPath}`);
    }
  } finally {
    await handle.close();
  }

  const openaiJsonPath = process.env.MNEMORA_NUMERAL_TOKEN_OPENAI_JSON;
  if (openaiJsonPath) {
    try {
      await runNumeralTokenProbesOpenAiArm(databaseUrl, openaiJsonPath, measuredAt, commit);
    } catch (error) {
      console.error(
        "\n🔴 [numeral-token-probes/openai] OpenAI arm(recorded)の測定に失敗した" +
          "(⛔ 上の local embedding 測定・このジョブ自体は落とさない):",
        error,
      );
    }
  }
}

async function runNumeralTokenProbesOpenAiArm(
  databaseUrl: string,
  jsonPath: string,
  measuredAt: Date,
  commit: string | null,
): Promise<void> {
  const cassette = loadOpenAiArmCassette(NUMERAL_TOKEN_OPENAI_CASSETTE_PATH);
  const runToken = newRunToken();
  const handle = await createExampleRuntime(
    databaseUrl,
    { ...process.env, MNEMORA_LLM: "deterministic", MNEMORA_EMBEDDING: "recorded" },
    { cassette },
  );
  try {
    const embeddingSpace = handle.embeddingProvider.space;
    console.log(
      `\n[numeral-token-probes/openai] embedding space: provider=${embeddingSpace.provider} ` +
        `model=${embeddingSpace.model} dimensions=${embeddingSpace.dimensions}(recorded 再生)`,
    );
    const groupResults: {
      key: string;
      report: Awaited<ReturnType<typeof runIdentifierProbeArm>>;
      embeddingSpace: typeof embeddingSpace;
    }[] = [];
    for (const group of numeralArmGroups()) {
      const armLabel = buildArmLabel(group, {
        llmMode: handle.llmMode,
        embeddingMode: handle.embeddingMode,
        model: embeddingSpace.model,
        dimensions: embeddingSpace.dimensions,
      });
      const report = await runIdentifierProbeArm({
        armLabel,
        tenantId: buildArmTenantId(`numeral-token-probes-openai-${group.key}`, runToken),
        runtime: handle.runtime,
        memoryStore: handle.memoryStore,
        llmMode: handle.llmMode,
        embeddingMode: handle.embeddingMode,
        haystackKind: group.haystackKind,
        probeSet: group.probeSet,
      });
      console.log(formatIdentifierArmReport(report));
      groupResults.push({ key: group.key, report, embeddingSpace });
    }
    const json = buildOpenAiArmRunJson(groupResults, measuredAt, commit);
    writeFileSync(jsonPath, `${JSON.stringify(json, null, 2)}\n`, "utf-8");
    console.log(`\n[numeral-token-probes/openai] 機械可読な結果を書き出した: ${jsonPath}`);
  } finally {
    await handle.close();
  }
}

/**
 * arm ごとに埋め込み空間を分けない: 埋め込みのテーブルは arm 間で共有され、ベクトルはビット単位で同じになるが、
 * 今の規模では HNSW が発火せず、規模が増えたときの取りこぼしは `relaxed_order`（ADR 0284）で塞がれている
 * （「同じベクトル・10万行・4 arm」は測っていない）。次のときに見直す: (a) 1 arm が1万〜10万行に近づく、
 * (b) #337 の測定で同じベクトルの取りこぼしが見える、(c) `search()` から `relaxed_order` が外れる、
 * (d) CI のジョブがコンテナを使い回す形に変わる。
 *
 * `warmup()` が `ok: false` なら一部の arm だけ測って出さない: `AssociationProbeRunJson` に「一部だけ測れた」を表す枠が無い。
 */
async function runAssociationProbes(): Promise<void> {
  const databaseUrl = requireDatabaseUrl();
  const runToken = newRunToken();
  const measuredAt = new Date();
  const commit = tryGitRevParseHead(process.cwd());

  const handle = await createExampleRuntime(databaseUrl, {
    ...process.env,
    MNEMORA_LLM: "deterministic",
    MNEMORA_EMBEDDING: "local",
  });
  printProviderMode(handle, null);

  try {
    console.log(
      "\n[association-probes] warmup() でモデルの読み込みを先に済ませる" +
        "(取得に失敗したら、ここでメトリクスを出さずに打ち切る)…",
    );
    const warmup = await warmupLocalEmbedding(handle.embeddingProvider);
    if (!warmup.ok) {
      console.error(`\n🔴 ${warmup.detail}`);
      console.error(
        "  メトリクスは1件も測っていない(前回の値・既定値・0 へは倒さない)。" +
          "ネットワーク・Hugging Face repo の状態を確認し、再実行すること。",
      );
      process.exitCode = 1;
      return;
    }
    console.log(`  ${warmup.detail}`);

    const embeddingSpace = handle.embeddingProvider.space;
    console.log(
      `[association-probes] embedding space: provider=${embeddingSpace.provider} ` +
        `model=${embeddingSpace.model} dimensions=${embeddingSpace.dimensions}`,
    );

    console.log("\n=== arm: off(連想枠なし、既定の recall) ===");
    const offReport = await runAssociationArm({
      armLabel: `off: 連想枠なし（既定の recall）(llm=${handle.llmMode}, embedding=${handle.embeddingMode}/${embeddingSpace.model}/${embeddingSpace.dimensions}次元)`,
      tenantId: buildArmTenantId("assoc-off", runToken),
      runtime: handle.runtime,
      memoryStore: handle.memoryStore,
    });
    console.log(
      `  goldReturned=${offReport.goldReturnedCount}/${offReport.probeCount} MRR=${offReport.mrr.toFixed(3)}`,
    );

    console.log("\n=== arm: on(連想枠あり、maxCount=3) ===");
    const on3Report = await runAssociationArm({
      armLabel: `on: 連想枠あり（maxCount=3）(llm=${handle.llmMode}, embedding=${handle.embeddingMode}/${embeddingSpace.model}/${embeddingSpace.dimensions}次元)`,
      tenantId: buildArmTenantId("assoc-on3", runToken),
      runtime: handle.runtime,
      memoryStore: handle.memoryStore,
      association: { maxCount: 3 },
    });
    console.log(
      `  goldReturned=${on3Report.goldReturnedCount}/${on3Report.probeCount} MRR=${on3Report.mrr.toFixed(3)}`,
    );

    console.log("\n=== arm: on(連想枠あり、maxCount=5) ===");
    const on5Report = await runAssociationArm({
      armLabel: `on: 連想枠あり（maxCount=5）(llm=${handle.llmMode}, embedding=${handle.embeddingMode}/${embeddingSpace.model}/${embeddingSpace.dimensions}次元)`,
      tenantId: buildArmTenantId("assoc-on5", runToken),
      runtime: handle.runtime,
      memoryStore: handle.memoryStore,
      association: { maxCount: 5 },
    });
    console.log(
      `  goldReturned=${on5Report.goldReturnedCount}/${on5Report.probeCount} MRR=${on5Report.mrr.toFixed(3)}`,
    );

    console.log("\n=== arm: on(連想枠あり、maxCount=10) ===");
    const on10Report = await runAssociationArm({
      armLabel: `on: 連想枠あり（maxCount=10）(llm=${handle.llmMode}, embedding=${handle.embeddingMode}/${embeddingSpace.model}/${embeddingSpace.dimensions}次元)`,
      tenantId: buildArmTenantId("assoc-on10", runToken),
      runtime: handle.runtime,
      memoryStore: handle.memoryStore,
      association: { maxCount: 10 },
    });
    console.log(
      `  goldReturned=${on10Report.goldReturnedCount}/${on10Report.probeCount} MRR=${on10Report.mrr.toFixed(3)}`,
    );

    const json = buildAssociationProbeRunJson({
      offReport,
      on3Report,
      on5Report,
      on10Report,
      embeddingSpace,
      recallLimit: DEFAULT_RECALL_LIMIT,
      warmup,
      measuredAt,
      commit,
    });

    console.log(`\n${formatAssociationProbeRunReport(json)}`);
    console.log(
      `\n(注) ADR 0033 §3: 標本${offReport.probeCount}件からは統計的に主張しない。` +
        "ここで言えるのは「今回、この母数のうち何件・何文字だったか」までである。",
    );

    const jsonPath = process.env.MNEMORA_ASSOCIATION_JSON;
    if (jsonPath) {
      writeFileSync(jsonPath, `${JSON.stringify(json, null, 2)}\n`, "utf-8");
      console.log(`\n[association-probes] 機械可読な結果を書き出した: ${jsonPath}`);
    }
  } finally {
    await handle.close();
  }
}

/**
 * `consolidation-cost` サブコマンド。`deterministic` LLM + `local` embedding を固定で使う（ADR 0094）。
 * `consolidate()` は LLM を呼ぶが、カセットに consolidation のプロンプトも、統合結果の埋め込みも無く、`recorded` は使えないため。
 */
async function runConsolidationCostCommand(): Promise<void> {
  const databaseUrl = requireDatabaseUrl();
  const options = parseConsolidationCostOptions(process.env);
  const tenantId = `consolidation-cost-${newRunToken()}`;
  const measuredAt = new Date();
  const commit = tryGitRevParseHead(process.cwd());

  const handle = await createExampleRuntime(databaseUrl, {
    ...process.env,
    MNEMORA_LLM: "deterministic",
    MNEMORA_EMBEDDING: "local",
  });
  printProviderMode(handle, null);
  try {
    console.log(
      "\n[consolidation-cost] warmup() でモデルの読み込みを先に済ませる" +
        "(取得に失敗したら、ここでメトリクスを出さずに打ち切る)…",
    );
    const warmup = await warmupLocalEmbedding(handle.embeddingProvider);
    if (!warmup.ok) {
      console.error(`\n🔴 ${warmup.detail}`);
      console.error(
        "  メトリクスは1件も測っていない(前回の値・既定値・0 へは倒さない)。" +
          "ネットワーク・Hugging Face repo の状態を確認し、再実行すること。",
      );
      process.exitCode = 1;
      const jsonPathOnFailure = process.env.MNEMORA_CONSOLIDATION_JSON;
      if (jsonPathOnFailure) {
        const failureJson = buildWeightsUnavailableConsolidationCostRunJson({
          measuredAt,
          commit,
          detail: warmup.detail,
        });
        writeFileSync(jsonPathOnFailure, `${JSON.stringify(failureJson, null, 2)}\n`, "utf-8");
        console.log(
          `\n[consolidation-cost] 機械可読な結果(取得失敗)を書き出した: ${jsonPathOnFailure}`,
        );
      }
      return;
    }
    console.log(`  ${warmup.detail}`);

    const json = await runConsolidationCost({
      runtime: handle.runtime,
      memoryStore: handle.memoryStore,
      embeddingProvider: handle.embeddingProvider,
      pool: handle.pool,
      llmMode: handle.llmMode,
      embeddingMode: handle.embeddingMode,
      tenantId,
      groupSize: options.groupSize,
      budgetLadder: options.budgetLadder,
      recallLimit: options.recallLimit,
      measuredAt,
      commit,
    });

    console.log(`\n${formatConsolidationCostReport(json)}`);

    const jsonPath = process.env.MNEMORA_CONSOLIDATION_JSON;
    if (jsonPath) {
      writeFileSync(jsonPath, `${JSON.stringify(json, null, 2)}\n`, "utf-8");
      console.log(`\n[consolidation-cost] 機械可読な結果を書き出した: ${jsonPath}`);
    }
    // round の途中で例外により打ち切った場合も、ここまでのレポート印字・JSON書き出しは行った上で、終了コードだけ非0にする。測れた分を捨てない。
    process.exitCode = exitCodeForConsolidationCostRun(json);
  } finally {
    await handle.close();
  }
}

/**
 * `archive-sweep-cost` サブコマンド。`consolidation-cost` と同じ理由で `deterministic` LLM + `local` embedding を使う
 * （clock を backdate した filler がカセットに無い入力のため、`recorded` は使えない）。
 * `MutableClock` を注入するのは、filler だけを backdate して掃引を実行時間内に発火させるため。
 */
async function runArchiveSweepCostCommand(decayClock: DecayClock | undefined): Promise<void> {
  const databaseUrl = requireDatabaseUrl();
  const options = parseArchiveSweepCostOptions(process.env);
  const tenantId = `archive-sweep-cost-${newRunToken()}`;
  const measuredAt = new Date();
  const commit = tryGitRevParseHead(process.cwd());
  const clock = createMutableClock();

  const handle = await createExampleRuntime(
    databaseUrl,
    { ...process.env, MNEMORA_LLM: "deterministic", MNEMORA_EMBEDDING: "local" },
    {},
    clock,
  );
  printProviderMode(handle, null);
  printDecayClockNotice(decayClock);
  try {
    console.log(
      "\n[archive-sweep-cost] warmup() でモデルの読み込みを先に済ませる" +
        "(取得に失敗したら、ここでメトリクスを出さずに打ち切る)…",
    );
    const warmup = await warmupLocalEmbedding(handle.embeddingProvider);
    if (!warmup.ok) {
      console.error(`\n🔴 ${warmup.detail}`);
      console.error(
        "  メトリクスは1件も測っていない(前回の値・既定値・0 へは倒さない)。" +
          "ネットワーク・Hugging Face repo の状態を確認し、再実行すること。",
      );
      process.exitCode = 1;
      const jsonPathOnFailure = process.env.MNEMORA_ARCHIVE_SWEEP_JSON;
      if (jsonPathOnFailure) {
        const failureJson = buildWeightsUnavailableArchiveSweepCostRunJson({
          measuredAt,
          commit,
          detail: warmup.detail,
        });
        writeFileSync(jsonPathOnFailure, `${JSON.stringify(failureJson, null, 2)}\n`, "utf-8");
        console.log(
          `\n[archive-sweep-cost] 機械可読な結果(取得失敗)を書き出した: ${jsonPathOnFailure}`,
        );
      }
      return;
    }
    console.log(`  ${warmup.detail}`);

    const json = await runArchiveSweepCost({
      runtime: handle.runtime,
      memoryStore: handle.memoryStore,
      embeddingProvider: handle.embeddingProvider,
      pool: handle.pool,
      clock,
      llmMode: handle.llmMode,
      embeddingMode: handle.embeddingMode,
      tenantId,
      halfLifeHours: options.halfLifeHours,
      marginHours: options.marginHours,
      sweepLimit: options.sweepLimit,
      budgetLadder: options.budgetLadder,
      recallLimit: options.recallLimit,
      measuredAt,
      commit,
      ...(decayClock !== undefined
        ? { decayClock: { store: handle.tenantSettingsStore, clock: decayClock } }
        : {}),
    });

    console.log(`\n${formatArchiveSweepCostReport(json)}`);

    const jsonPath = process.env.MNEMORA_ARCHIVE_SWEEP_JSON;
    if (jsonPath) {
      writeFileSync(jsonPath, `${JSON.stringify(json, null, 2)}\n`, "utf-8");
      console.log(`\n[archive-sweep-cost] 機械可読な結果を書き出した: ${jsonPath}`);
    }
    process.exitCode = exitCodeForArchiveSweepCostRun(json);
  } finally {
    await handle.close();
  }
}

/**
 * `answer` サブコマンド。
 *
 * これは配線の検査であって、回答品質の測定ではない。着地しても回答品質は未評価のまま（`examples/chat/README.md` の `answer` 節）。
 *
 * provider は `compare`/`retrieval` と同じ規律で、`resolveRecordedRun` の返り値をそのまま `createAnswerBenchRuntime` へ渡す。
 * カセットが無い状態で `MNEMORA_LLM=recorded` を指定すると、`createProviders` の `requireCassette` がそのまま落ちる。
 *
 * `createExampleRuntime` を使わない理由は `answer-bench.ts` の `createAnswerBenchRuntime` の docstring を見ること。
 */
async function runAnswer(): Promise<void> {
  const databaseUrl = requireDatabaseUrl();
  const measuredAt = new Date();
  const commit = tryGitRevParseHead(process.cwd());
  const plan = resolveRecordedRun("answer");
  const handle = await createAnswerBenchRuntime(databaseUrl, plan.env, plan.providerOptions);
  const banner = formatAnswerQualityBanner(handle.llmMode);
  if (banner) {
    console.log(banner);
  }
  printProviderMode(handle, plan.plannedSource);
  try {
    console.log(formatAnswerIntro(handle.llmMode));
    const cases = [...ANSWER_CASE_SET_DEV, ...ANSWER_CASE_SET_EVAL];
    const results = await runAnswerBench(
      handle.runtime,
      handle.llmProvider,
      handle.embeddingProvider,
      handle.judgeLLMProvider,
      cases,
      "answer-bench",
    );

    console.log(formatAnswerTable(results, handle.llmMode));
    console.log("\n--- 追加費用(別ブロック。⛔ 下の入力量の差には含めない) ---");
    console.log(formatAnswerCostTable(results));
    console.log(`\n${formatAnswerInputReduction(results)}`);
    console.log(formatAnswerContentPreservation(results));

    const jsonPath = process.env.MNEMORA_ANSWER_JSON;
    if (jsonPath) {
      const json = buildAnswerJson({
        results,
        llmMode: handle.llmMode,
        embeddingMode: handle.embeddingMode,
        measuredAt,
        commit,
      });
      writeFileSync(jsonPath, `${JSON.stringify(json, null, 2)}\n`, "utf-8");
      console.log(`\n[answer] 機械可読な結果を書き出した: ${jsonPath}`);
    }
  } finally {
    await handle.close();
  }
}

function parseTimeWeightingTrials(argv: readonly string[]): number {
  const flag = argv.find((a) => a.startsWith("--trials="));
  if (flag === undefined) {
    return 1;
  }
  const value = Number(flag.slice("--trials=".length));
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`--trials は1以上の整数であること（実際: ${flag}）。`);
  }
  return value;
}

/** `--temperature=N` を argv から読む。省略時は `undefined`（既定は渡さない）。`llmMode !== "openai"` のときは無視される。 */
function parseTimeWeightingTemperature(argv: readonly string[]): number | undefined {
  const flag = argv.find((a) => a.startsWith("--temperature="));
  if (flag === undefined) {
    return undefined;
  }
  const value = Number(flag.slice("--temperature=".length));
  if (!Number.isFinite(value)) {
    throw new Error(`--temperature は数値であること（実際: ${flag}）。`);
  }
  return value;
}

/**
 * `answer-time-weighting` サブコマンド。`answer` とは測る問いが違う。`answer` は配線検査、こちらは `RecallQuery.timeWeighting`（ADR 0300）を
 * 回答の正誤で比べる。`--trials=N`（既定1）と `--dev`（開発用ケース集合に絞る）を argv から読む。
 */
async function runTimeWeighting(): Promise<void> {
  const databaseUrl = requireDatabaseUrl();
  const measuredAt = new Date();
  const commit = tryGitRevParseHead(process.cwd());
  const argv = process.argv.slice(3);
  const trials = parseTimeWeightingTrials(argv);
  const useDevOnly = argv.includes("--dev");
  const temperature = parseTimeWeightingTemperature(argv);

  const plan = resolveRecordedRun("answer-time-weighting");
  const providerOptions =
    temperature !== undefined
      ? { ...plan.providerOptions, llmTemperature: temperature }
      : plan.providerOptions;
  const handle = await createTimeWeightingBenchRuntime(databaseUrl, plan.env, providerOptions);
  const banner = formatTimeWeightingQualityBanner(handle.llmMode);
  if (banner) {
    console.log(banner);
  }
  printProviderMode(handle, plan.plannedSource);
  try {
    console.log(
      "\n記憶を直接書き、reinforce し、壁時計を進めてから、同じ質問を legacy/" +
        `eventAwareFreshness の両方で recall→回答生成→採点する（trials=${trials}` +
        `${temperature !== undefined ? `, temperature=${temperature}` : ""}）。\n` +
        (useDevOnly
          ? "⛔ --dev: 開発用ケース集合のみ（調整に使ってよい側。未使用の評価として報告しないこと）。\n"
          : ""),
    );
    const cases = useDevOnly
      ? TIME_WEIGHTING_CASE_SET_DEV
      : [
          ...TIME_WEIGHTING_CASE_SET_DEV,
          ...TIME_WEIGHTING_CASE_SET_EVAL,
          ...TIME_WEIGHTING_CASE_SET_EVAL_UNDATED,
        ];
    const results = await runTimeWeightingBench(handle, cases, "answer-time-weighting", trials);
    const aggregate = aggregateTimeWeightingResults(results);

    console.log(formatTimeWeightingTable(aggregate, handle.llmMode));
    console.log(formatTimeWeightingKindSummary(aggregate, handle.llmMode));
    if (handle.usageMeter) {
      console.log(`\n${handle.usageMeter.formatReport()}`);
    }

    const jsonPath = process.env.MNEMORA_TIME_WEIGHTING_JSON;
    if (jsonPath) {
      const json = buildTimeWeightingJson({
        results,
        aggregate,
        llmMode: handle.llmMode,
        embeddingMode: handle.embeddingMode,
        measuredAt,
        commit,
      });
      writeFileSync(jsonPath, `${JSON.stringify(json, null, 2)}\n`, "utf-8");
      console.log(`\n[answer-time-weighting] 機械可読な結果を書き出した: ${jsonPath}`);
    }
  } finally {
    await handle.close();
  }
}

/**
 * `answer-trials` サブコマンド（ADR 0301）。`answer` とは別の器。dev ケースだけを、`answer.json` に記録済みのプロンプトから読んだ
 * 同じ記憶集合の上で、描画 A/B ごとに n 回ずつ答えさせ、正答数で見る（1回の試行では揺れが見えない、ADR 0295 追記2）。
 *
 * DB を使わない。材料はカセットの静的な読み出しだけで作る。
 * CI の門にしない。`.github/workflows/ci.yml` には配線せず、手元で回す観測用の CLI（ADR 0301）。
 */
async function runAnswerTrialsCommand(): Promise<void> {
  const result = await runAnswerTrials({ env: process.env });
  console.log(formatAnswerTrialsReport(result));

  const jsonPath = process.env.MNEMORA_ANSWER_TRIALS_JSON;
  if (jsonPath) {
    writeFileSync(jsonPath, `${JSON.stringify(result, null, 2)}\n`, "utf-8");
    console.log(`\n[answer-trials] 機械可読な結果を書き出した: ${jsonPath}`);
  }
  // 未評価（実 API が無い）は exit 0 のまま。「実行できなかった」ことを画面と JSON に明示するのが目的で、鍵の有無で落とす理由にしない。
}

/** `answer-trials-compare` サブコマンド。カセットの sha256 かケースごとの材料指紋が一致しなければ、ずれた箇所を表示して exit 1。 */
async function runAnswerTrialsCompareCommand(argv: string[]): Promise<void> {
  // `pnpm run answer-trials-compare -- a.json b.json` では pnpm が `--` をそのまま渡してくる。パスではないので落とす。
  const paths = argv.filter((a) => a !== "--");
  if (paths.length < 2) {
    console.error(
      "answer-trials-compare には比較対象の JSON パスを2件以上指定すること" +
        "（例: answer-trials-compare a.json b.json）。",
    );
    process.exitCode = 1;
    return;
  }
  const { ok, report } = runAnswerTrialsCompareFromFiles(paths);
  console.log(report);
  // 副作用のある手（exit の判定）を判定と同じ行に繋がない。`ok` を見てからここで明示的に立てる（docs/autonomy.md §4.1）。
  if (!ok) {
    process.exitCode = 1;
  }
}

/**
 * 訂正の口の相手探しの精度を測る（`correction-candidate-arm.ts`）。
 *
 * provider は `identifier-probes` と同じ組み合わせに固定する。LLM は `deterministic`、埋め込みは `local`。鍵を要求しない。
 * `recorded` は使えない。この器のケースはカセットに記録の無い入力で、`recorded` provider は記録に無い入力を例外にする（ADR 0051）。
 * 順位を決めているのは埋め込み（実推論）で、`deterministic` が掛かるのは抽出側。
 *
 * `warmup()` を明示的に呼び、失敗を区別する。「重みを取得できなかった」が「相手探しの精度が低い」に見えてはならない。
 * `-- --dev` の結果を「未使用の評価」として報告しないこと（`docs/autonomy.md` §2.2 の5番）。
 */
async function runCorrectionCandidates(useDevSet: boolean): Promise<void> {
  const databaseUrl = requireDatabaseUrl();
  const runToken = newRunToken();
  const measuredAt = new Date();
  const commit = tryGitRevParseHead(process.cwd());
  const handle = await createExampleRuntime(databaseUrl, {
    ...process.env,
    MNEMORA_LLM: "deterministic",
    MNEMORA_EMBEDDING: "local",
  });
  printProviderMode(handle, null);
  const jsonPath = process.env.MNEMORA_CORRECTION_CANDIDATE_JSON;
  try {
    console.log(
      "\n[correction-candidates] warmup() でモデルの読み込みを先に済ませる" +
        "(取得に失敗したら、ここでメトリクスを出さずに打ち切る)…",
    );
    const warmup = await warmupLocalEmbedding(handle.embeddingProvider);
    if (!warmup.ok) {
      console.error(`\n🔴 ${warmup.detail}`);
      console.error(
        "  メトリクスは1件も測っていない(前回の値・既定値・0 へは倒さない)。" +
          "ネットワーク・Hugging Face repo の状態を確認し、再実行すること。",
      );
      process.exitCode = 1;
      if (jsonPath) {
        const json = buildWeightsUnavailableCorrectionCandidateProbeJson({
          measuredAt,
          commit,
          detail: warmup.detail,
        });
        writeFileSync(jsonPath, `${JSON.stringify(json, null, 2)}\n`, "utf-8");
        console.log(`\n[correction-candidates] 機械可読な結果(取得失敗)を書き出した: ${jsonPath}`);
      }
      return;
    }
    const embeddingSpace = handle.embeddingProvider.space;
    console.log(
      `[correction-candidates] embedding space: provider=${embeddingSpace.provider} ` +
        `model=${embeddingSpace.model} dimensions=${embeddingSpace.dimensions}`,
    );
    const label = useDevSet ? "dev" : "eval";
    console.log(
      `\n[correction-candidates] ケース集合 = ${label}` +
        (useDevSet
          ? "（⛔ 調整に使ってよい側。未使用の評価として報告しないこと）"
          : "（held-out）"),
    );
    const report = await runCorrectionCandidateArm({
      tenantId: `correction-candidates-${label}-${runToken}`,
      runtime: handle.runtime,
      memoryStore: handle.memoryStore,
      llmMode: handle.llmMode,
      embeddingMode: handle.embeddingMode,
      hitCases: useDevSet ? CORRECTION_CASE_SET_DEV : CORRECTION_HIT_CASE_SET_EVAL,
      abstainCases: useDevSet ? [] : CORRECTION_ABSTAIN_CASE_SET_EVAL,
    });
    if (report.ingestDrain.totalFailed > 0) {
      console.error(
        `\n🔴 embed に失敗した件がある(${String(report.ingestDrain.totalFailed)}件)。⛔ この数字は使えない。`,
      );
      process.exitCode = 1;
      return;
    }
    const summary = summarizeCorrectionCandidateReport(report);
    console.log("");
    console.log(formatCorrectionCandidateReport(report, summary));

    if (jsonPath) {
      const json = buildMeasuredCorrectionCandidateProbeJson({
        report,
        summary,
        caseSet: useDevSet ? "dev" : "eval",
        embeddingSpace,
        measuredAt,
        commit,
      });
      writeFileSync(jsonPath, `${JSON.stringify(json, null, 2)}\n`, "utf-8");
      console.log(`\n[correction-candidates] 機械可読な結果を書き出した: ${jsonPath}`);
    }
  } finally {
    await handle.close();
  }
}

function printHelp(write: (text: string) => void = console.log): void {
  write(
    [
      "使い方:",
      "  DATABASE_URL=... pnpm --filter @mnemora/example-chat run chat       # observe/recall の往復・omitted/usage/budget を実演",
      "  DATABASE_URL=... pnpm --filter @mnemora/example-chat run compare    # 会話の長さを変えて経路A/経路Bの量を実測",
      "                                                                      #   OPENAI_API_KEY があれば実 API、無ければ記録の再生(ADR 0052)",
      "                                                                      #   MNEMORA_COMPARE_JSON で機械可読出力",
      "                                                                      #   -- --decay-clock <wall|activity|either> で対象テナントの decay_clock を設定する(ADR 0165、既定は未指定=何も書かない)",
      "  DATABASE_URL=... pnpm --filter @mnemora/example-chat run recall-footprint-calibration-samples",
      "                                                                      # recall-footprint 較正の補助標本(CALIBRATION_SAMPLE_DESIGN の各点、Issue #340・ADR 0314)を生成する",
      "                                                                      #   compare と同じ recorded カセットを再生。MNEMORA_RECALL_FOOTPRINT_CALIBRATION_SAMPLES_JSON で機械可読出力",
      "  DATABASE_URL=... pnpm --filter @mnemora/example-chat run scope      # tenantId/subjectId のスコープを実演",
      "  DATABASE_URL=... pnpm --filter @mnemora/example-chat run explain    # recallId から Runtime.getRecall() で内訳を後から読み戻す(Issue #312)",
      "  DATABASE_URL=... pnpm --filter @mnemora/example-chat run backfill   # observe() の occurredAt が period の絞りに効くことを実演",
      "  DATABASE_URL=... pnpm --filter @mnemora/example-chat run correction # 訂正を含む会話で markContested→resolveContested を実演(Issue #303)",
      "  DATABASE_URL=... pnpm --filter @mnemora/example-chat run retrieval # 意味的関連性の probe set を3 arm(擬似/埋め込みのみ本物/フル本物)で比較",
      "                                                                      #   OPENAI_API_KEY があれば実 API、無ければ記録の再生(ADR 0051)",
      "                                                                      #   MNEMORA_RETRIEVAL_JSON で機械可読出力。MNEMORA_BENCH_CHANNELS=ann,lexical で recall() の channels を選ぶ(ADR 0148、未指定なら既定のまま)",
      "  DATABASE_URL=... pnpm --filter @mnemora/example-chat run time-term # 時間項(freshness/decay)を意味的類似度から分離して測る",
      "                                                                      #   既定は擬似 provider(similarity が構成上定数になるため provider に依らない)",
      "  DATABASE_URL=... pnpm --filter @mnemora/example-chat run validity  # validAt ゲート(Issue #280)が候補の有無をどう動かすかを測る",
      "                                                                      #   既定は擬似 provider。MNEMORA_VALIDITY_JSON で機械可読出力",
      "  pnpm --filter @mnemora/example-chat run embedding-fingerprint",
      "                                                                      # 固定入力に対する embed() の結果を書き出す(DB 不要。Issue #565)",
      "                                                                      #   MNEMORA_EMBEDDING_FINGERPRINT_RAW_JSON で機械可読出力、MNEMORA_EMBEDDING_FINGERPRINT_NUM_THREADS=N で推論スレッド数(sha256/lscpuの合成は scripts/measure-embedding-output-fingerprint.mjs が別途行う)",
      "  DATABASE_URL=... pnpm --filter @mnemora/example-chat run identifier-probes",
      "                                                                      # ASCII識別子・固有名詞を含む probe(Issue #109)を@mnemora/local-embeddingで測る",
      "                                                                      #   鍵・カセット不要。日本語意味probe・ASCII識別子probe・日本語固有名詞probeを、群ごと(sparse/dense haystack)に別々に集計する",
      "  DATABASE_URL=... pnpm --filter @mnemora/example-chat run numeral-token-probes",
      "                                                                      # 単独トークンの数詞・記号インデックス(文字種×共有前置長の行列)を@mnemora/local-embeddingで測る(ADR 0135、Issue #109)",
      "                                                                      #   鍵・カセット不要。sparse/dense haystackを別々に集計し、margin(gold-distractor similarity差)の分布も記録する。MNEMORA_NUMERAL_TOKEN_JSON で機械可読出力",
      "                                                                      #   MNEMORA_NUMERAL_TOKEN_OPENAI_JSON は OpenAI 実埋め込みの追加 arm の結果の書き先",
      "  DATABASE_URL=... pnpm --filter @mnemora/example-chat run association-probes",
      "                                                                      # 連想枠(段3.5、ADR 0151、Issue #291)が想起の質を動かすかを、off と on(maxCount を変えた複数 arm)で比較",
      "                                                                      #   鍵・カセット不要(deterministic LLM + local embedding)。MNEMORA_ASSOCIATION_JSON で機械可読出力",
      "  DATABASE_URL=... pnpm --filter @mnemora/example-chat run consolidation-cost",
      "                                                                      # Runtime.consolidate() の統合が「載る量」をどう動かすかをラウンド制で実測する(Issue #136)",
      "                                                                      #   鍵・カセット不要(deterministic LLM + local embedding)。MNEMORA_CONSOLIDATION_JSON で機械可読出力",
      "                                                                      #   MNEMORA_CONSOLIDATION_GROUP_SIZE(束ねる件数)・MNEMORA_CONSOLIDATION_BUDGET_LADDER(予算の段)・MNEMORA_CONSOLIDATION_RECALL_LIMIT(各段の limit)。不正な値は例外",
      "  DATABASE_URL=... pnpm --filter @mnemora/example-chat run archive-sweep-cost",
      "                                                                      # 掃引(Runtime.sweepArchive)が「載る量」/hit@k をどう動かすかを実測する(Issue #209)",
      "                                                                      #   鍵・カセット不要(deterministic LLM + local embedding)。MNEMORA_ARCHIVE_SWEEP_JSON で機械可読出力",
      "                                                                      #   MNEMORA_ARCHIVE_SWEEP_MARGIN_HOURS(余白の時間)・MNEMORA_ARCHIVE_SWEEP_LIMIT(1回の掃引の上限)・MNEMORA_ARCHIVE_SWEEP_BUDGET_LADDER(予算の段)・MNEMORA_ARCHIVE_SWEEP_RECALL_LIMIT(各段の limit)",
      "                                                                      #   -- --decay-clock <wall|activity|either> で対象テナントの decay_clock を設定する(ADR 0165、既定は未指定=何も書かない)",
      "  DATABASE_URL=... pnpm --filter @mnemora/example-chat run correction-candidates",
      "                                                                      # 訂正の相手探しの精度(Issue #369 (C)、ADR 0291/0321)を測る。hit@k/distractor逆転率/誤爆率/棄権率/margin/intrusionMargin",
      "                                                                      #   鍵・カセット不要(deterministic LLM + local embedding)。-- --dev で開発用ケース集合。MNEMORA_CORRECTION_CANDIDATE_JSON で機械可読出力",
      "  DATABASE_URL=... pnpm --filter @mnemora/example-chat run answer      # naive/mnemora の最終回答・入力量を対で出す(Issue #506)",
      "                                                                      #   🔴 配線の検査であり、回答品質は測っていない(llmMode=deterministic のとき集計を出さない)",
      "                                                                      #   MNEMORA_ANSWER_JSON で機械可読出力",
      "                                                                      #   MNEMORA_ANSWER_CLAIM_KEY=detect で、この経路だけ claim key の検出を opt-in する(専用カセット、ADR 0326)",
      "  DATABASE_URL=... pnpm --filter @mnemora/example-chat run answer-time-weighting",
      "                                                                      # RecallQuery.timeWeighting(legacy/eventAwareFreshness、Issue #690・ADR 0300)を回答の正誤で比べる",
      "                                                                      #   -- --trials=N(既定1)・-- --temperature=N(既定は未指定)・-- --dev で開発用ケース集合のみ。MNEMORA_TIME_WEIGHTING_JSON で機械可読出力",
      "  pnpm --filter @mnemora/example-chat run answer-trials",
      "                                                                      # 同じ記憶集合(examples/chat/cassettes/answer.json の記録済みプロンプト)で",
      "                                                                      #   dev ケース × 描画A(recorded)/B(digest-only) × n回の正答数を見る(Issue #705、ADR 0301)",
      "                                                                      #   DB 不要。OPENAI_API_KEY が無ければ実 API を叩かず『未評価』と明示して exit 0",
      "                                                                      #   MNEMORA_ANSWER_TRIALS_N(既定5)・MNEMORA_ANSWER_TRIALS_RENDERS(既定 recorded,digest-only)・MNEMORA_ANSWER_TRIALS_JSON",
      "  pnpm --filter @mnemora/example-chat run answer-trials-compare -- a.json b.json",
      "                                                                      # answer-trials の結果 JSON を2件以上突き合わせ、カセット sha256・ケースごとの材料指紋が",
      "                                                                      #   一致しなければどこがずれたかを表示して exit 1(Issue #705 完了条件2)",
      "  DATABASE_URL=... OPENAI_API_KEY=... pnpm --filter @mnemora/example-chat run record",
      "                                                                      # retrieval の応答を記録する(ADR 0051)",
      "  DATABASE_URL=... OPENAI_API_KEY=... pnpm --filter @mnemora/example-chat run record:compare",
      "                                                                      # compare の応答を記録する(ADR 0052。LLM 呼び出し回数・所要時間・費用の見積もりは ADR 0019 §3、実測は §7.8)",
      "  DATABASE_URL=... OPENAI_API_KEY=... pnpm --filter @mnemora/example-chat run record:answer",
      "                                                                      # answer(naive/mnemora の最終回答 + judge)の応答を記録する(Issue #506。MNEMORA_ANSWER_JSON も書ける)",
      "  DATABASE_URL=... OPENAI_API_KEY=... pnpm --filter @mnemora/example-chat run record:answer-time-weighting",
      "                                                                      # answer-time-weighting の応答を記録する(Issue #690)",
      "  OPENAI_API_KEY=... pnpm --filter @mnemora/example-chat run verify   # retrieval の記録と実 API の乖離を測る",
      "  OPENAI_API_KEY=... pnpm --filter @mnemora/example-chat run verify:compare",
      "                                                                      # compare の記録と実 API の乖離を測る",
      "  OPENAI_API_KEY=... pnpm --filter @mnemora/example-chat run verify:answer",
      "                                                                      # answer の記録と実 API の乖離を測る",
      "  OPENAI_API_KEY=... pnpm --filter @mnemora/example-chat run verify:answer-time-weighting",
      "                                                                      # answer-time-weighting の記録と実 API の乖離を測る",
      "",
      "  MNEMORA_PROVIDER_SOURCE=recorded|openai  # retrieval/compare/answer/answer-time-weighting/recall-footprint-calibration-samples で「キーがあれば実API」を明示的に上書きする(ADR 0068)",
      "                                                                      #   recorded: キーが在ってもカセットを再生する(誤って課金しない)",
      "                                                                      #   openai  : カセットが在っても実 API を叩く(キーが無ければ落ちる。擬似物へは倒れない)",
      "                                                                      #   未指定なら従来通りキーの有無だけで決まる",
      "  MNEMORA_LEXICAL_STORE=trigram           # 語彙 store を PostgresTrigramLexicalStore(opt-in、pg_trgm)に差し替える。createExampleRuntime を使う全サブコマンドに効く(ADR 0319)",
      "                                                                      #   未指定・空・default は従来どおり PostgresLexicalStore。それ以外は例外",
    ].join("\n"),
  );
}

const HELP_COMMANDS: ReadonlySet<string> = new Set(["--help", "-h", "help"]);

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "chat") {
    await runChat();
  } else if (command === "compare") {
    await runCompare(parseDecayClockFlag(process.argv.slice(3)));
  } else if (command === "recall-footprint-calibration-samples") {
    await runRecallFootprintCalibrationSamples();
  } else if (command === "scope") {
    await runScope();
  } else if (command === "explain") {
    await runExplain();
  } else if (command === "backfill") {
    await runBackfill();
  } else if (command === "correction") {
    await runCorrection();
  } else if (command === "retrieval") {
    await runRetrieval();
  } else if (command === "time-term") {
    await runTimeTerm();
  } else if (command === "validity") {
    await runValidity();
  } else if (command === "embedding-fingerprint") {
    await runEmbeddingFingerprint();
  } else if (command === "identifier-probes") {
    await runIdentifierProbes();
  } else if (command === "numeral-token-probes") {
    await runNumeralTokenProbes();
  } else if (command === "association-probes") {
    await runAssociationProbes();
  } else if (command === "consolidation-cost") {
    await runConsolidationCostCommand();
  } else if (command === "archive-sweep-cost") {
    await runArchiveSweepCostCommand(parseDecayClockFlag(process.argv.slice(3)));
  } else if (command === "correction-candidates") {
    await runCorrectionCandidates(process.argv.slice(3).includes("--dev"));
  } else if (command === "answer") {
    await runAnswer();
  } else if (command === "answer-time-weighting") {
    await runTimeWeighting();
  } else if (command === "answer-trials") {
    await runAnswerTrialsCommand();
  } else if (command === "answer-trials-compare") {
    await runAnswerTrialsCompareCommand(process.argv.slice(3));
  } else if (command === "record") {
    await runRecord(parseCassetteTarget(process.argv[3]));
  } else if (command === "verify") {
    await runVerify(parseCassetteTarget(process.argv[3]));
  } else if (command === undefined || HELP_COMMANDS.has(command)) {
    printHelp();
  } else {
    console.error(`未知のサブコマンド: ${command}`);
    printHelp(console.error);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  const hint = databaseErrorHint(err);
  if (hint !== undefined) {
    console.error(`\n→ ${hint}`);
  }
  process.exitCode = 1;
});

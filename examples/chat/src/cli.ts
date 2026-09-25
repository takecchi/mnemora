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
import { formatRecall } from "./format.js";
import { tryGitRevParseHead } from "./git-info.js";
import { formatIdentifierArmReport, runIdentifierProbeArm } from "./identifier-arm.js";
import { JAPANESE_NAME_PROBE_SET_SPEC } from "./japanese-name-probe-set.js";
import {
  buildMeasuredIdentifierProbeJson,
  buildWeightsUnavailableIdentifierProbeJson,
} from "./identifier-json.js";
import {
  formatCorrectionCandidateReport,
  runCorrectionCandidateArm,
  summarizeCorrectionCandidateReport,
} from "./correction-candidate-arm.js";
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
import { createAnswerBenchRuntime, runAnswerBench } from "./answer-bench.js";
import { ANSWER_CASE_SET_DEV } from "./answer-case-set.dev.js";
import { ANSWER_CASE_SET_EVAL } from "./answer-case-set.eval.js";
import { buildAnswerJson } from "./answer-json.js";
import { recordRetentionMutationPositiveControl } from "./answer-retention-mutation.js";
import {
  formatAnswerContentPreservation,
  formatAnswerCostTable,
  formatAnswerInputReduction,
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
import { formatAnswerTrialsReport, runAnswerTrials } from "./answer-trials.js";

/** `chat` サブコマンドで使う会話の長さ(filler 往復数)。サンプルアプリの裁量値。 */
const DEFAULT_CHAT_FILLER_PAIRS = 8;

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL が設定されていません。mnemora は Postgres + pgvector を要求する " +
        "（docs/roadmap.md 段階2）。examples/chat/README.md の手順でローカル DB を用意し、" +
        "DATABASE_URL を設定してから実行すること。",
    );
  }
  return url;
}

/**
 * **3層すべてを名指しする**（ADR 0051）。
 *
 * ⚠ ここは一度壊れていた——`ProviderMode` に `"recorded"` を足したとき、この関数は
 * 「`openai` でなければ擬似 provider」のままだった。その結果、記録を再生している run が
 * 画面には「決定的な擬似 provider」と出て、**同じ report の別の行（`llm=recorded`）と
 * 矛盾していた。**ADR 0051 が「どちらで走ったかを隠さない」ことを土台にしている以上、
 * これは最も起こしてはならない壊れ方である。**モードを増やすときは必ずここも増やすこと。**
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
 * どの組み合わせで動いているかを必ず画面に出す(黙って擬似物にフォールバックしない、
 * という原則の適用)。`MNEMORA_LLM`/`MNEMORA_EMBEDDING` で LLM と embedding を別々に
 * 上書きできるようになったため、`mode` 1個ではなく `llmMode`/`embeddingMode` を
 * それぞれ表示する。
 *
 * ⭐ **`cassetteIgnored` を引数に畳み込む。オプショナルにしない・既定値を持たせない。**
 * 理由: 「カセットを渡したのに使わなかった」を開示せずに provider バナーを出せる経路を
 * 作らないため（AGENTS.md「形で塞ぐ」）。呼び出し側は必ず自分の handle
 * （`ExampleRuntimeHandle`/`AnswerBenchRuntimeHandle`）が持つ `cassetteIgnored` を渡す
 * ——`providers.ts` の `Providers.cassetteIgnored` の docstring参照。
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
  // 🔴 **Issue #594。** 上の `cassetteIgnored` は `cassette !== undefined` を前提に持つため、
  // `resolveRecordedRun` の `openai` 枝（カセットを読まずに即 return する）を**原理的に見ない**。
  // ⟹ 予定と実測の食い違いは、カセットとは別の検出器で開示する。
  const mismatch = detectPlanActualMismatch(plannedSource, modes);
  if (mismatch !== undefined) {
    console.log(describePlanActualMismatch(mismatch));
  }
}

/**
 * `resolveRecordedRun` の返り値。**カセットを受け取る唯一の経路が、倒した env を必ず
 * 一緒に返す**——「名乗ったのに倒し忘れる」形を書けなくする（Issue #577）。
 */
interface RecordedRunPlan {
  /**
   * provider を構築するときに渡す env。カセットを読めたら `MNEMORA_LLM`/
   * `MNEMORA_EMBEDDING` を `"recorded"` へ倒してある。カセットを読めなかった
   * （`decideProviderSource` が `"openai"` を選んだ）ときは `process.env` そのまま。
   */
  env: NodeJS.ProcessEnv;
  /** `createProviders` に渡す options。カセットが無ければ空オブジェクト。 */
  providerOptions: CreateProvidersOptions;
  /** カセットを読めたか（呼び出し側が arm を組むときに使う。`runRetrieval` が使う）。 */
  cassette: Cassette | undefined;
  /**
   * ⭐ **画面に名乗った「予定」そのもの（Issue #594）。**
   *
   * `resolveRecordedRun` は `[cassette] provider source の予定: …` を**必ず**画面へ出す。
   * ⟹ **その予定を返り値に含めることで、呼び出し側が `printProviderMode` へ渡し忘れる
   * 経路を無くす**——`RecordedRunPlan.env` が Issue #577 に対して同じ形で効いたのと
   * 同じ理由である（名乗ることと、名乗りを検査へ渡すことを、分離できない形にする）。
   */
  plannedSource: ProviderSourceDecision["source"];
}

/**
 * この実行が実 API を使うのか、記録の再生を使うのかを決める（ADR 0051 / 0052 / 0068 ③）。
 *
 * **判定そのものは `decideProviderSource`（`providers.ts`）に委ねる**——ここは
 * その結果を画面へ出し、`"recorded"` ならカセットを読んで、それを実際に使うために
 * 必要な env（`MNEMORA_LLM`/`MNEMORA_EMBEDDING` を `"recorded"` へ倒したもの）まで
 * 一緒に組み立てる薄い配線に留める。
 *
 * ⭐ **名乗ることと env を倒すことを、この関数の中で分離できない形にする（Issue #577）。**
 * 以前の `resolveCassetteForRun` は「記録した応答を再生する」と画面に出しながら
 * `Cassette | undefined` だけを返し、それを実際に `"recorded"` として使うための
 * env の書き換えは呼び出し側の手作業に委ねていた——3箇所の呼び出しのうち `runAnswer`
 * だけがその手作業を忘れ、画面には再生の宣言を出しながら実際には `deterministic` の
 * 擬似 provider で走っていた。`RecordedRunPlan.env` を返り値に含めることで、
 * 呼び出し側が env を組み立て直す必要そのものが無くなる。
 *
 * ⚠ **かつては「キーが在れば無条件に実 API」だった**（`process.env.OPENAI_API_KEY` を
 * 直接見ていた）。そのため `MNEMORA_PROVIDER_SOURCE=recorded` を指定しても、環境に
 * キーが在るだけで意図せず実 API に倒れ、課金が発生し得た——「明示すればカセットを
 * 使える口」がどこにも無かった(ADR 0068 の背景3)。`decideProviderSource` が
 * `MNEMORA_PROVIDER_SOURCE` を最優先で見るようになったことで、この口が塞がる。
 *
 * `cassette` が `undefined` なら実 API を使う、という意味である（挙動は変えていない）。
 */
function resolveRecordedRun(target: CassetteTarget): RecordedRunPlan {
  const decision = decideProviderSource(process.env);
  console.log(
    // 🔴 **この行が名乗るのは「どの source を選んだか」までである（Issue #589）。**
    // `decideProviderSource` は env だけを見る判定であり、**`createProviders` は
    // この判定を一度も読まない**（あちらが見るのは `MNEMORA_LLM`/`MNEMORA_EMBEDDING` と
    // 鍵の有無である）。⟹ **両者は食い違いうる。**【実測】鍵を置いたうえで
    // `MNEMORA_LLM=deterministic` を明示すると、この行は `openai(理由: …実 API)` と出るが、
    // 実際には擬似 provider で走る——**ADR 0068 が自分で踏んだと記録している状態である。**
    // ⟹ だから「予定」と明示し、断定は `printProviderMode` の実測へ寄せる。
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
  // 🔴 **この行は「読んだ」までしか名乗らない（Issue #589）。**
  // かつては `[cassette] 記録した応答を再生する` と書いていた——**だがこの時点では
  // provider をまだ1つも組んでおらず、「再生する」は測っていない予告だった。**
  // ⟹ 実際、`MNEMORA_LLM=deterministic` を明示した実行（ADR 0260 追記で正規の道に
  // なった）では、カセットを読んでも使わない。そこで画面は「再生する」と名乗りながら
  // 擬似 provider で走っていた——**Issue #577 が報告した欠陥そのものである。**
  // ⟹ **名乗ってよいのは、ここで実際に確かめたこと（ファイルを読めた・中身が何件か）
  // だけである。** 「何で走るか」は `printProviderMode` が構築後の実測から出す。
  console.log(`[cassette] カセットを読んだ: ${describeCassette(cassette)}`);
  console.log(
    "  ⚠ これは記録した時点の API の姿である。実 API との乖離は `verify` で確かめること。",
  );
  console.log(
    "  ⚠ この行は「読めた」ことだけを言う。この実行が実際に何で走るかは、下の " +
      "[provider] 行が構築後の実測から出す（ADR 0223 決定5 / Issue #589）。",
  );
  return {
    // 🔴 **明示が在るときは倒さない（Issue #577 続き / ADR 0068）。**
    // 当初この行は無条件に `"recorded"` を焼き込んでいた——**利用者が
    // `MNEMORA_LLM=deterministic` を明示しても黙って上書きし、画面は
    // 「記録した実 API 応答の再生」と名乗って走った。**⟹ ADR 0068 の
    // 「明示した source と、実際に使われる provider が食い違う経路を作らない」に
    // 反しており、#577 が塞いだ欠陥を向きだけ変えて作り直していた。
    //
    // ⚠ **`??` ではなく `||` を使う。**`providers.ts` の `parseModeOverride` が
    // **空文字を「未指定」として扱う**ため、`??` だと `MNEMORA_LLM=""` が
    // 「明示」扱いになり、あちらの規約とずれる。
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
    await ingestConversation(handle.runtime, ctx, conversation);
    console.log(
      `${conversation.userUtterances.length} 件の user 発話を observe() し、tick() で embed を処理した。`,
    );

    // デモ本体は budget-demo.ts に切り出してある（Issue #306）——`__tests__` から
    // 同じ2回の recall() 呼び出しを検査できるようにするためで、ここでの印字は
    // これまでと1バイトも変えていない。
    const { withoutBudget, withBudget } = await runBudgetDemo(handle.runtime, ctx, conversation);

    console.log("\n=== recall()（budget 無し） ===");
    console.log(formatRecall(withoutBudget, "budget 無し"));
    console.log("呼び出し側がプロンプトへ積む文字列（recall() の返り値だけから組み立てる例）:");
    console.log(buildMnemoraPrompt(withoutBudget));

    // ⭐ Issue #301 / ADR 0163: 実際にプロンプトへ積んだ Memory を、使用報告として
    // observe({kind:'memory_usage'}) で mnemora へ伝え返す。これが無いと reinforce
    // が一度も発火せず、使われた記憶と使われなかった記憶が同じ速さで遠ざかる。
    // ここは recall() の測定・表示を終えたあとに呼ぶ——この呼び出しは
    // withoutBudget の usage/omitted/index を一切変えない。
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
    console.log(`naive chars                  : ${naive.chars}`);
    console.log(`mnemora chars (budget 無し)      : ${withoutBudget.usage.chars}`);
    console.log(`mnemora chars (budget あり)      : ${withBudget.usage.chars}`);
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

/**
 * `tenantId`/`subjectId` のスコープを「動く例」で見せるデモ(`src/scope.ts`)。
 * 北極星の主測定(`compare`/`retrieval`)には触れない、独立したデモ実行——
 * `runScopeDemo`/`formatScopeDemo` は `compare.ts`/`retrieval-quality.ts` を import しない。
 */
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

/**
 * `Runtime.getRecall` を「動く例」で見せるデモ(`src/recall-explain.ts`、Issue #312、
 * ADR 0161)。`recall()` の戻り値からは `recallId` だけを使い、別の呼び出しとして
 * `getRecall(ctx, recallId)` を呼んで、永続化された `recalls` 行から内訳を読み戻す。
 * 北極星の主測定(`compare`/`retrieval`)には触れない、独立したデモ実行——
 * `runRecallExplainDemo`/`formatRecallExplainDemo` は `compare.ts`/`retrieval-quality.ts`/
 * `probe-set.ts`/`scenario.ts`/`naive-path.ts` を import しない。
 */
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

/**
 * `observe()` の `occurredAt` を「動く例」で見せるデモ(`src/backfill.ts`、ADR 0037)。
 * 同じ2発話・同じ問い合わせを、`occurredAt` を渡す側と渡さない側の2テナントで走らせ、
 * **同じ問い合わせが取り込み方だけで別の答えを返す**ことを並べて見せる。
 * 北極星の主測定(`compare`/`retrieval`)には触れない、独立したデモ実行。
 */
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
 * 訂正を含む会話シナリオを実演するデモ(`src/correction-demo.ts`、Issue #303 / Issue #369 (C))。
 *
 * 北極星「間違いを正すと、古いほうが先に出てこなくなる」を、`findCorrectionCandidates`
 * （発見の段、ADR 0232）→ 指名の照合（選択の段）→`markContested`（ADR 0134）→`recall`
 * （両方隣接して出る）→`resolveContested`（ADR 0150）→`recall`（古いほうが消える）の
 * 一巡で実演する。`Runtime.markContested`/`resolveContested` は `examples/chat` から
 * これまで一度も呼ばれていなかった（Issue #303 本文）。`Runtime.findCorrectionCandidates`
 * も、ADR 0232 が着地させた時点では本番コードから呼ぶ経路が無かった
 * （[ADR 0235](../../../docs/decisions/0235-correction-demo-explicit-choice.md)
 * がその経路を立てる）。
 *
 * **どの2件が対向し、どちらが勝つかは `correction-scenario.ts` が構造として宣言する。**
 * **どの候補を訂正の相手として指名するかは、この CLI が `CorrectionChoice` として明示的に
 * 渡す**——`scenario.contestedPair.firstExternalId`（「記録済みの採用者の判断」）を渡すだけで、
 * `findCorrectionCandidates` が返した候補の並びからは一切導かない。このコマンドは判定を
 * せず、宣言をそのまま渡すだけ。北極星の主測定(`compare`/`retrieval`)には触れない、
 * 独立したデモ実行。
 *
 * **⚠ Issue #374: 印字するだけでなく、実際に assert する。** このコマンドの
 * dispatch（`main()` の `command === "correction"` 分岐）は、足すまで CI から
 * 一度も呼ばれていなかった——`correction-demo.postgres.test.ts` は
 * `runCorrectionDemo()` を直接 import しており、この dispatch 行を経由しない
 * （dispatch 行を消しても、あのテストは落ちない）。CI の `example-chat` ジョブに
 * `pnpm --filter @mnemora/example-chat run correction` を足すことで、初めて
 * dispatch 行そのものが CI の歯になる。そのうえで、`checkCorrectionDemo()`
 * の7欄 + `checkCorrectionOmission()` の1欄を全部 assert し、1つでも false なら
 * `process.exitCode = 1` にする——`formatCorrectionDemo()` の出力を画面に印字する
 * だけでは、段3（矛盾の解決と必須の同伴取得）が壊れても CI は緑のままだった。
 *
 * **provider 層は `deterministic` を使う（明示の override はしない）。**
 * `requireDatabaseUrl()` 以外に env を渡さないため、`OPENAI_API_KEY` が無い CI では
 * `selectProviderMode` が `deterministic` を選ぶ。`recorded` にしない理由:
 * `examples/chat/cassettes/` には `compare`/`retrieval` の記録しか無く、この
 * デモの発話は記録に無い入力になる（`RecordedLLMProvider`/`RecordedEmbeddingProvider`
 * は記録に無い入力を例外にする）。このデモが確かめる性質（mandatory companion
 * retrieval・resolveContested によるフィルタ）はスコアの質に依存しない構造的な
 * ものなので、`deterministic`（配線・契約の検査用、ADR 0051/`AGENTS.md` の4層表）
 * で足りる——北極星の主測定（`compare`/`retrieval`、`recorded` で走る）には
 * 触れない、という上の doc コメントの独立性とも整合する。
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
    // 🔴 ここで渡す choice は「記録済みの採用者の判断」であり、findCorrectionCandidates が
    // 返す候補の並びからは一切導いていない(candidates[0]を機械的に採らないことの実演)。
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
        "checkCorrectionDemo() の7欄 + checkCorrectionOmission() の1欄、Issue #374)。",
    );
  } finally {
    await handle.close();
  }
}

/**
 * `--decay-clock`（ADR 0165 決めたこと11）が指定されたときだけ、`compare`/
 * `archive-sweep-cost` の実行前に画面へ出す。**未指定なら1行も出ない**——
 * `decay-clock-options.ts`/`compare.ts`/`archive-sweep-cost.ts` が持つ
 * 「省略時は `writeDecayClock` を一度も呼ばない」契約と対になる案内。
 */
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
  // `retrieval` と同じ規律（ADR 0051）: キーがあれば実 API、無ければ記録の再生。
  // **どちらで走ったかは必ず画面に出す。**`resolveRecordedRun` が名乗りと env の
  // 倒しを一緒に返すため、ここでは三項演算子で env を組み立て直す必要が無い。
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

    // ---------------------------------------------------------------------------
    // 機械可読な出力口（Issue #242。`retrieval`/`time-term` と同じ層の env 規約）
    //
    // **`MNEMORA_COMPARE_JSON` が設定されたときだけ書く。未設定なら1バイトも
    // 挙動を変えない**——既存の `MNEMORA_RETRIEVAL_JSON`/`MNEMORA_TIME_TERM_JSON` と
    // 同じ規約（cli.ts 冒頭の各関数のコメント参照）。
    //
    // 組み立ては `compare-json.ts` の純関数 `buildCompareJson` に委ねる——
    // ここでの役割は「どこに書くか」だけである。
    // ---------------------------------------------------------------------------
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
 * PR 本文 (D)。arm A(擬似LLM+擬似embedding)・B(擬似LLM+本物embedding)・
 * C(本物LLM+本物embedding)の3通りを順に走らせ、probe set の順位を比較する。
 *
 * **arm ごとに別のテナントを使う**(PR 本文「実行時の規律」)——`runRetrievalQualityArm`
 * 自体は tenantId を受け取るだけで固定しないため、ここで3つのテナントを渡す。
 *
 * ⚠ **`runToken` ごとに違うテナントになる（ADR 0068）。**かつては3つとも固定文字列
 * （`retrieval-quality-arm-a` 等）だった。DB をリセットしないこの harness では、
 * 2回目の実行が同じテナントへ同じ probe set を `observe()` し直すことになり、
 * externalId の冪等性に当たって新規 observation を1件も作らない——`ingest` の欄が
 * 「今回は測っていない」のに「1回で足りた」という**逆の結論**を印字してしまう
 * （`ArmIngestSummary`/`IngestMeasurement` の docstring 参照）。`newRunToken()`/
 * `buildArmTenantId()`（`retrieval-quality.ts`）を経由することで、通常利用では
 * 毎回新しいテナントを使い、2回目も1回目と同じ結論を出す。
 *
 * B・C は本物の OpenAI(embedding、C はさらに LLM も)を叩く。**CI には載せていない**——
 * `.github/**` は変更していない。本物の API を叩く実行はこのコマンドを手動で叩いたときだけ。
 */
/**
 * arm の定義（ADR 0051 で `source` を足した）。
 *
 * `source` は「本物の API を叩くか、記録した応答を再生するか」だけを切り替える。
 * **arm の意味（どちらが擬似で、どちらが本物由来か）は変えていない**——arm B は
 * 「擬似LLM＋本物由来の埋め込み」のままである。記録は本物の応答そのものなので、
 * ラベルの意味は保たれる。
 */
function buildArmSpecs(
  source: "openai" | "recorded",
  runToken: string,
): {
  armLabel: string;
  tenantId: string;
  llmOverride: ProviderMode;
  embeddingOverride: ProviderMode;
  /**
   * この arm が実 API に触れるか。`record` は**この欄で**対象を選ぶ——
   * tenantId の文字列一致で除外すると、arm の id を変えた瞬間に静かに壊れる。
   */
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

  // **キーがあれば本物、無ければ記録の再生。どちらで走ったかは必ず画面に出す**
  // （黙って別のものへ倒れない、という既存の規律の適用。ADR 0051）。
  // 判定は `compare` と同じ `resolveRecordedRun` に寄せてある（ADR 0052 / 0068 ③）。
  const plan = resolveRecordedRun("retrieval");
  // **実行ごとに新しい tenantId を使う（ADR 0068）。**通常利用で2回続けて走らせても、
  // 2回目が DB に残った前回の記憶を「取り込み済み」として素通りし、`ingest` の欄が
  // 逆の結論を印字しないようにするための唯一の直し方——冪等性(externalId の重複排除)
  // 自体は製品として正しい挙動であり、崩さない。
  const runToken = newRunToken();
  const armSpecs = buildArmSpecs(plan.cassette ? "recorded" : "openai", runToken);

  // **`MNEMORA_BENCH_CHANNELS` を選べるようにする（ADR 0148、Issue #179）。**
  // 未指定なら `undefined`——`runRetrievalQualityArm` は `channels` を渡さず、
  // `packages/core` の既定 `["ann"]` のまま 1 バイトも挙動が変わらない。
  // 明示的に `MNEMORA_BENCH_CHANNELS=ann,lexical` 等を渡した呼び出しだけが、
  // `examples/chat` の `Runtime` に配線済みの `LexicalStore`（`runtime-factory.ts`）
  // を実際に通る構成へ切り替わる。
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

  // ---------------------------------------------------------------------------
  // 機械可読な出力口（PR「retrieval を CI に載せる」）
  //
  // **`MNEMORA_RETRIEVAL_JSON` が設定されたときだけ書く。未設定なら1バイトも
  // 挙動を変えない**——既存の `MNEMORA_PROVIDER_SOURCE`/`MNEMORA_LLM`/`MNEMORA_EMBEDDING`
  // と同じ層の env 規約（cli.ts 冒頭の各関数のコメント参照）。
  //
  // 組み立ては `retrieval-json.ts` の純関数 `buildRetrievalQualityJson` に委ねる——
  // ここでの役割は「どこに書くか」だけであり、「何を書くか」は DB を要求せずに
  // 検査できる形で別ファイルに置く。
  // ---------------------------------------------------------------------------
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
 * **再生する当のもの（`retrieval` の arm B・C）をそのまま走らせて録る。**
 * probe set を読んで「必要そうな入力」を列挙する形は採らない——列挙が漏れると、
 * 再生時に「記録に無い」で落ちる。実行経路そのものが唯一の正しい入力一覧である。
 *
 * **arm B と C の両方を録る必要がある。**arm B は擬似 LLM が作った digest を、
 * arm C は本物の LLM が書き換えた digest を埋め込む——**埋め込みへの入力が arm 間で違う**。
 * arm A は API を一切叩かないため、記録の対象にならない。
 */
/**
 * `retrieval` の arm B・C を実 API で走らせて記録する（ADR 0051）。
 *
 * arm A は API を一切叩かないため記録の対象にならない。arm B と C の**両方**が要る——
 * arm B は擬似 LLM が作った digest を、arm C は本物の LLM が書き換えた digest を
 * 埋め込むので、**埋め込みへの入力が arm 間で違う。**
 */
async function recordRetrieval(
  databaseUrl: string,
  recorder: CassetteRecorder,
  runId: number,
): Promise<void> {
  // **id の文字列一致ではなく、宣言された欄で選ぶ。**
  // `runToken` には `runId` をそのまま使う——直後で `-record-${runId}` を
  // さらに足すため衝突の心配は無く、記録に使ったテナントを runId から追跡できる。
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
 *
 * **`retrieval` より1桁高い。**`DEFAULT_COMPARE_SEQUENCE` の合計 = Σ(fillerPairs+1) 回の
 * LLM 呼び出しが要る（ADR 0019 §3 の見積もりで657回・約8〜15分・約 $0.023）。
 * だからこそ `record` は対象を明示させる（`parseCassetteTarget`）。
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
    // 記録しながら実測もできてしまうので、その場で出す——**この表が
    // 「本物の provider で走らせた compare」そのものである。**
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
 * `answer` を実 API で走らせて記録する（Issue #506 / 親 #498。ADR 0051）。
 *
 * **再生する当のもの（`runAnswer` と同じ実行経路）をそのまま走らせて録る。**
 * 「必要そうな入力を列挙する」形は採らない——`runRecord` docstring と同じ規律。
 * ここでは `createAnswerBenchRuntime` に `MNEMORA_LLM=openai`/`MNEMORA_EMBEDDING=openai`
 * を明示で渡し、`ANSWER_CASE_SET_DEV` + `ANSWER_CASE_SET_EVAL` の全12件を
 * `runAnswerBench` に通す（judge の呼び出しも同じ経路で記録される）。
 *
 * ⚠ **tenantPrefix に `runId` を含め、毎回新しいテナントにする。** `observe()` は
 * `externalId` で重複排除するため、既に取り込み済みのテナントで録ると抽出も埋め込みも
 * 呼ばれず「空のカセット」で `CassetteRecorder.toCassette()` が落ちる（ADR 0051
 * 「引き受けた負債4」——`recordRetrieval`/`recordCompare` と同じ既知の事故を踏まない）。
 */
async function recordAnswer(
  databaseUrl: string,
  recorder: CassetteRecorder,
  runId: number,
): Promise<void> {
  console.log("\n########## 記録中: answer ##########");
  const measuredAt = new Date();
  const commit = tryGitRevParseHead(process.cwd());
  const handle = await createAnswerBenchRuntime(
    databaseUrl,
    { ...process.env, MNEMORA_LLM: "openai", MNEMORA_EMBEDDING: "openai" },
    { recorder },
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

    // 記録しながら実測もできてしまうので、その場で出す（`recordCompare` と同じ規律）。
    console.log(`\n${formatAnswerTable(results, handle.llmMode)}`);
    console.log("\n--- 追加費用(別ブロック。⛔ 削減率からは差し引かない) ---");
    console.log(formatAnswerCostTable(results));
    console.log(`\n${formatAnswerInputReduction(results)}`);
    console.log(formatAnswerContentPreservation(results));

    // ⭐ Issue #498 完了条件4・「回答評価」側の陽性対照（ADR 0236 が未達のまま残した
    // 半分）を、この全置換の記録の一部として毎回追記する——`recordAnswer` は毎回空の
    // `CassetteRecorder` から始まる全置換なので、この呼び出しをここに置かないと、
    // 次に誰かが素の `record answer` を走らせた瞬間にこの陽性対照の2エントリだけが
    // 新しいカセットから消える（`answer-retention-mutation.ts` の docstring参照）。
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

    // ⭐ `record answer` でも `MNEMORA_ANSWER_JSON` が設定されていれば書き出す
    // ——記録と同時に実測結果を機械可読な形でも取りたい、という要望への対応。
    // `llmMode`/`embeddingMode` はここで実際に走った値（`handle.llmMode`/`handle.embeddingMode`、
    // 常に `"openai"`）を使う。
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
 * `answer-time-weighting` の記録（Issue #690 / PR #697）。`recordAnswer` と同じ規律——
 * 毎回新しい tenantId（`runId` を含める）で走らせる。
 *
 * ⚠ **trial は1回だけ記録する。** カセットは「プロンプトのハッシュ→応答」の連想配列
 * なので、同じ質問・同じ記憶状態に対する複数 trial はどのみち同じ鍵に畳まれる
 * （`answer-time-weighting-bench.ts` の docstring・マネージャー指示「trial 間で
 * プロンプトが同じなら LLM 値もキャッシュ再生で同じになる」）——記録時に trial を
 * 増やしても記録される内容は増えない。
 */
async function recordTimeWeighting(
  databaseUrl: string,
  recorder: CassetteRecorder,
  runId: number,
): Promise<void> {
  console.log("\n########## 記録中: answer-time-weighting ##########");
  // 🔴 マネージャー決定（段3b）: この記録は temperature=0 で固定する——段3a の
  // 切り分け（`bench-results/STAGE3A-NOTES.txt`）で、temperature 未指定（既定1.0）は
  // 同じ入力でも gradeAnswer の正誤が run ごとに揺れることを実測した。カセットは
  // 「記録した時点の応答」を固定して再生するものなので、揺れの少ない temperature=0 で
  // 録ることで、再生（CI・cassette-coverage）の判定が安定する。
  const handle = await createTimeWeightingBenchRuntime(
    databaseUrl,
    { ...process.env, MNEMORA_LLM: "openai", MNEMORA_EMBEDDING: "openai" },
    { recorder, llmTemperature: 0 },
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
  } finally {
    await handle.close();
  }
}

/**
 * 実 API の応答を記録してカセットに書き出す（ADR 0051 / 0052）。
 *
 * **再生する当のものをそのまま走らせて録る。**probe set や会話生成を読んで
 * 「必要そうな入力」を列挙する形は採らない——列挙が漏れると再生時に落ちる。
 * 実行経路そのものが唯一の正しい入力一覧である。
 */
async function runRecord(target: CassetteTarget): Promise<void> {
  const databaseUrl = requireDatabaseUrl();
  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      "record は本物の OpenAI を叩いて記録する。OPENAI_API_KEY を設定してから実行すること。",
    );
  }

  const recorder = new CassetteRecorder();

  // ⚠ **記録は必ず新しいテナントで走らせる。**`observe()` は `externalId` で
  // 重複排除するため、既に取り込み済みのテナントで走らせると抽出も埋め込みも呼ばれず、
  // 「1件も記録されていない」カセットができる（実際にこれで一度落ちた）。
  // 記録に必要なのはプロンプトと入力テキストの対応だけであり、それは probe set /
  // 会話生成関数から決まってテナントに依らない。
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
      "乖離は `verify` で確かめること（ADR 0051 の「引き受ける負債」）。",
  );
}

/** コサイン類似度。`verify` が記録と実 API のベクトルを比べるためだけに使う。 */
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
 * 記録が実 API から乖離していないかを測る（ADR 0051 の「覆る条件」を、測れる形にしたもの）。
 *
 * **埋め込みだけを照合する。**`gpt-4o-mini` の応答は同じ入力でも揺れるため、差が出ても
 * 「モデルが変わった」とは言えない——**照合できないものを照合したふりをしない**ので、
 * LLM 側は件数の確認だけに留める。
 *
 * ⚠ **埋め込みも、ビット単位では再現しない（本 PR の実測）。**同じ日・同じモデル
 * （`text-embedding-3-small` / 256次元）に同じ152件を投げ直したところ、
 * **20件が記録と完全一致しなかった**。最小コサイン類似度は **0.998647**。
 * 当初「埋め込みは決定的だから差が出たらモデルが変わった証拠」として `1e-6` を
 * 閾値に置いていたが、それは**この実測で否定された**——実 API 側に揺らぎがある。
 *
 * そこで閾値は `DRIFT_COSINE_THRESHOLD` に置き、**「完全一致したか」と「乖離したか」を
 * 別々に数える。**前者はほぼ常に一部が外れる（それが普通）。後者だけが記録し直す理由になる。
 */
/**
 * これを下回ったら「記録し直すべき乖離」とみなす境。
 *
 * **根拠**: 上記の実測で、同一モデルの揺らぎは最小 0.998647 に収まった（152件、1日、1回）。
 * モデルそのものが替われば、同じ文のベクトルはこれよりはるかに大きく動くと考えられる。
 * **ただし「モデルが替わったときにどこまで下がるか」は測っていない**——この 0.99 は
 * 揺らぎの実測の下に置いた線であって、モデル交代を実際に検出できると確かめた値ではない。
 */
const DRIFT_COSINE_THRESHOLD = 0.99;
async function runVerify(target: CassetteTarget): Promise<void> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("verify は実 API と記録を突き合わせる。OPENAI_API_KEY を設定すること。");
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
    // 「完全一致したか」と「乖離したか」は別の問い。前者が欠けるのは普通のこと
    // （実 API 側の揺らぎ）であり、後者だけが記録し直す理由になる。
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
 * `freshness`/`decay` を意味的類似度から分離して測る arm(PR 本文)。
 *
 * **provider は既定で `deterministic` に倒す。**理由: ペアの2件は本文が厳密に同一なので、
 * `DeterministicEmbeddingProvider` を使う限り `similarity` は構成上定数になる
 * (`time-term-probe-set.ts` の docstring 参照)。この測定は provider 層(擬似か本物か)に
 * 依らない——⟹ カセットの再録も `OPENAI_API_KEY` も要らない。
 * `MNEMORA_LLM`/`MNEMORA_EMBEDDING` が明示されていればそれを尊重する(既存の
 * `retrieval`/`compare` と同じ、上書き優先の規約)。
 *
 * ⚠ **ただし「想起の質」は主張しない**(AGENTS.md「`deterministic` で測った想起の質は、
 * 性能について何も言っていない」)。ここで測るのは「時間項が順位を決めているか」だけであり、
 * 「正しい記憶を引けているか」ではない。
 *
 * **`MutableClock` を注入する。**`decay-*` probe が `recordedAt` を過去へ振るには、
 * `createExampleRuntime` に渡した `Clock` と `runTimeTermArm` に渡す `clock` が
 * **同じインスタンス**でなければならない(`time-term-arm.ts` の
 * `RunTimeTermArmOptions.clock` の docstring 参照)。
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

    // Issue #217: `MNEMORA_TIME_TERM_JSON` が設定されているときだけ機械可読な結果を書く
    // （`retrieval`/`identifier-probes`/`consolidation-cost` と同じ、未設定なら挙動を
    // 変えない規約。ADR 0088「決めたこと」2番）。
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
 * `validAt` ゲート（Issue #280、Issue #202 第2弾）を測る arm(PR 本文)。
 *
 * **provider は既定で `deterministic` に倒す**（`runTimeTerm()` と同じ理由——ペアの
 * 本文が厳密に同一なので `similarity` は構成上定数になり、この測定は provider 層に
 * 依らない。カセットの再録も `OPENAI_API_KEY` も要らない）。
 *
 * **`MutableClock` は要らない**——動かす項は `recordedAt`（壁時計）ではなく
 * `validFrom`/`validUntil`（`observe()` に明示的に渡す `Date`）なので、`time-term` と
 * 違って `Clock` を注入し直す必要がない。
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

    // `MNEMORA_VALIDITY_JSON` が設定されているときだけ機械可読な結果を書く
    // （`time-term`/`retrieval` と同じ、未設定なら挙動を変えない規約。ADR 0088「決めたこと」2番）。
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
 * Issue #109(#106 由来): `retrieval` の probe 7件は**すべて日本語の query**で、
 * ASCII の識別子・固有名詞を含む query が0件だった——#106 の報告者の用途
 * (人名・チャンネル名・社内システム名・案件コード・チケット番号)を、
 * 既存ベンチは1件も測っていなかった。
 *
 * **擬似LLM + ローカル埋め込み(`@mnemora/local-embedding`、鍵もカセットも要らない)。**
 * LLM 層は `retrieval` の arm B(擬似LLM+本物の埋め込み)と同一
 * (`DeterministicLLMProvider`)——差は埋め込みだけであり、
 * `@mnemora/local-embedding` の README が「確かめていないこと」として名指しした
 * 「`@mnemora/openai` と比べて想起の質がどうなるか」を、ここで初めて測る。
 *
 * **3群を別々に集計する。**⛔ 混ぜた単一の MRR を主たる数字にしない。
 *   1. 既存の日本語意味 probe 7件(`./probe-set.js`、変更していない)を、この arm の
 *      embedding(local)で走らせた結果——arm B(embedding=recorded、実質 openai 由来)
 *      との直接比較になる。
 *   2. ASCII 識別子 probe 30件(`./identifier-probe-set.js`)・**識別子が薄い haystack**
 *      (`sparse`。識別子を1件も含まない既定 haystack)。
 *   3. 同じ30 probe を、**識別子が密な haystack**(`dense`。probe と同じ書式ファミリーの
 *      識別子を計60件含む)で走らせた結果——マネージャー指示(#106 の逐語「同じ形式の
 *      別の識別子が近傍に来て埋もれる」の再点検)。
 *
 * ⛔ **群2(sparse)は消さない。**当初12 probe 全件が hit@1 だった実測(`identifier-probe-
 * baseline.json`)自体が発見であり、群3(dense)は「難しくして失敗させる」ためではなく
 * 「#106 が報告した状況(同じ書式の識別子が"多数"居る)を表す」ために足す
 * (`./identifier-probe-set.js` の `DENSE_IDENTIFIER_FAMILIES` の docstring 参照)。
 *
 * **`warmup()` を明示的に呼び、失敗を区別する。**「HF から取得できなかった」が
 * 「想起の質が下がった」に見えてはならない(オーナー代理の懸念)——`warmup()` が
 * 失敗したら、メトリクスを1つも出さずに打ち切る(`local-embedding-warmup.ts` 参照)。
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

    console.log("\n=== 群1: 既存の日本語意味 probe 7件(./probe-set.js、変更していない) ===");
    const japaneseReport = await runRetrievalQualityArm({
      // ⚠ **`haystack=sparse` を label に含める**（他の2群と同じ書式にする）。
      // この群は識別子密度という軸を持たないが、JSON の `haystackKind` は
      // `"sparse"` を名乗り（`identifier-json.ts`）、Job Summary の表にも
      // `sparse` の列が出る。**label だけがその条件を落としていると、
      // 「条件を落とした数字」を label の側で作ることになる。**
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
      "\n=== 群2: ASCII 識別子 probe 30件(./identifier-probe-set.js、haystack=sparse) ===",
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
      "\n=== 群3: ASCII 識別子 probe 30件(./identifier-probe-set.js、haystack=dense) ===",
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
      "\n=== 群4: 日本語の固有名詞 probe 12件(./japanese-name-probe-set.js、haystack=sparse) ===",
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
      "\n=== 群5: 日本語の固有名詞 probe 12件(./japanese-name-probe-set.js、haystack=dense) ===",
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
}

/**
 * `association-probes` サブコマンド(連想枠、ADR 0151、Issue #291)。
 *
 * **`identifier-probes` と同じ provider の組み合わせ**(`deterministic` LLM +
 * `local` 埋め込み。鍵・カセット不要)——差は probe set と arm(`./association-arm.js`)。
 *
 * **同じ会話を、別テナントへ4回 ingest する**(`off` / `on(maxCount=3)` /
 * `on(maxCount=5)` / `on(maxCount=10)`)。`maxCount=10` は、CI 実測(commit `4362333`)で
 * `returnedCount` が全 probe で「10 + maxCount」ちょうどになっていた
 * (連想枠が常に満杯)ことを受け、「gold は枠のすぐ下に居て `maxCount` を増やせば
 * 届くのか、それとも枠を広げても届かないのか」を切り分けるために足した(Issue #291
 * フォローアップ)。arm 間の汚染を断つため、テナントは `buildArmTenantId` で
 * 必ず別々にする(`retrieval-quality.ts` の先例と同じ理由)。
 *
 * ⚠ **テナントを分けても、埋め込みのテーブルは分かれていない**(Issue #363)。
 * 4つの arm は同じ埋め込み空間(同じ `memory_embeddings_*` テーブル)へ同じ会話を
 * ingest する。抽出は1:1(`packages/core/src/extraction.ts:84-97` の
 * `buildExtractionPrompt` / `packages/testkit/src/__fixtures__/deterministic-llm-provider.ts:26-41` の
 * 決定的な抽出)で、embed job は `memory.content` から決定的に埋め込む
 * (`packages/core/src/runtime.ts:2818`)。この arm は `MNEMORA_LLM=deterministic` /
 * `MNEMORA_EMBEDDING=local` 固定(下の `createExampleRuntime` 呼び出し)で、
 * local embedding の決定性(同じ入力に同じベクトル)自体は本物のモデルに対して
 * 実測されている(`packages/local-embedding/src/__tests__/live.local-embedding.test.ts:358-365`。
 * ⚠ CI では走らない実測であり、別のハードウェア・別の onnxruntime 版での再現は
 * 保証されない)。⟹ **4つの arm の埋め込みは、互いにビット単位で同じになる**
 * (推測ではなく上の経路をたどって確認した。1 arm は98行——`ASSOCIATION_HAYSTACK`
 * 62行 + 12 probe × 3、`association-probe-set.ts`)。
 *
 * **起こりうる機構そのものは Issue #671 / PR #673(ADR 0284)が実測で確かめている**:
 * プランナが HNSW の索引スキャンを選んだ場合、`tenant_id` の絞り込みは索引スキャンの
 * 後に効く。そのとき `hnsw.ef_search` の候補の窓が他テナントの重複行で埋まり、
 * この arm の行が窓に入らなくなりうる。**ただし、今のこのベンチの規模(1 arm 約100行)
 * では、この機構はまだ発火していない**——Issue #363 の実測(コメント 5804415910 のセル1・2・2b。home=100行に
 * filler/near-dup を積んだセル)はいずれも自然なプランが Seq Scan であり、HNSW を選ばせるのは
 * クエリ対象テナント*自身*の行数である(ADR 0111 §3.2。同じテナントが10万行に
 * 育って初めて自然に HNSW を選ぶ)。⟹ **候補枠の食い潰しは、今のこの bench の
 * 規模では起きていない。**
 *
 * HNSW が自然に選ばれる規模(home 10万行)まで育つと、既定の
 * `hnsw.iterative_scan=off` では他テナントの near-duplicate が40件
 * (`= kPrime = ef_search`)以上で全滅することが実測されている(Issue #671)。
 * この故障は PR #673(ADR 0284)が `search()` に
 * `hnsw.iterative_scan = relaxed_order` を採用したことで塞がれた——見積もり
 * (⚠推測、未測定)では、このベンチのように同じベクトルが他3 arm に複製される
 * 構造でも、読み捨てる件数は1回の検索あたり約 3×40=120件で、
 * `hnsw.max_scan_tuples`(既定20,000)の天井より2桁小さい。
 * ⚠ **ただし「同じベクトル・10万行・4 arm」の組み合わせは測っていない**——
 * 同じ距離の点が大量にあるときの HNSW の振る舞い自体が未測定である。
 *
 * ⟹ **構造を分ける案(arm ごとに別の埋め込み空間にする等)は、今は要らない。**
 * 次のいずれかが起きたときに開き直す: (a) 1 arm の行数が HNSW を自然に選ぶ規模
 * (目安1万〜10万行)に近づいたとき、(b) #337 の測定で同じベクトルでの取りこぼしが
 * 実際に見えたとき、(c) `search()` から `relaxed_order` が外れたとき(ADR 0284 が
 * 覆ったとき)、(d) CI の `association-probes` ジョブがコンテナを使い回す形に
 * 変わったとき(今は `.github/workflows/ci.yml:1116-1130` のジョブ専用の使い捨て
 * Postgres コンテナを毎回作り直しており、同 `:1161` で毎回マイグレーションを
 * 流している——他の測定との同居や、削除した行が VACUUM まで候補枠を食う交絡
 * (Issue #671)は今の形では当たらない)。詳細と出典は ADR 0158 の
 * 「追記(Issue #671 / PR #673 の実測を受けての整理)」を見ること。
 *
 * **`warmup()` を明示的に呼び、失敗を区別する**(`identifier-probes` と同じ理由)。
 * `ok: false` なら、メトリクスを1つも出さずに打ち切る——この bench の
 * `AssociationProbeRunJson`(`./association-json.js`)は4 arm・3 delta を持つ形で
 * 確定しており、「一部だけ測れた」を表す枠が無い。⟹ 失敗時は JSON も書かない
 * (打ち切ったことは標準エラー出力と `process.exitCode` で伝える)。
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
 * `consolidation-cost` サブコマンド(Issue #136)。
 *
 * **なぜ `deterministic` LLM + `local` embedding か**（仕様書「使う provider 層」節）:
 * `consolidate()` は LLM を呼ぶため `recorded` は使えない(カセットに consolidation の
 * プロンプトが無く、`RecordedLLMProvider` が例外を投げる)。統合結果の新しい content の
 * 埋め込みもカセットに無い。⟹ この2点を避けるため `deterministic` LLM ＋ `local` 埋め込み
 * を固定で使う(`identifier-probes` と同じ組み合わせ、ADR 0094)。
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
    // round の途中で例外により打ち切った場合も、ここまでのレポート印字・JSON書き出しは
    // 上と同じく行った上で、終了コードだけ非0にする(測れた分を捨てない——これが今回の
    // 増分。`weights_unavailable` の経路は上の `return` で既に打ち切っており、ここには来ない)。
    process.exitCode = exitCodeForConsolidationCostRun(json);
  } finally {
    await handle.close();
  }
}

/**
 * `archive-sweep-cost` サブコマンド(Issue #209)。
 *
 * **なぜ `deterministic` LLM + `local` embedding か**: `consolidation-cost` と同じ理由
 * (`archive-sweep-cost.ts` の docstring 参照)——この bench 専用の会話は `retrieval` の
 * カセットに無い入力を含む(clock を backdate した filler)ため、`recorded` は使えない。
 *
 * **なぜ `MutableClock` を注入するか**: filler だけを backdate して掃引を実行時間内に
 * 発火させるため(`archive-sweep-cost.ts` の docstring、`time-term` arm と同じ仕掛け)。
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
 * `answer` サブコマンド(Issue #506 / 親 #498)。
 *
 * 🔴 **これは配線の検査であって、回答品質の測定ではない。** 同じ会話・同じ質問・
 * 同じ回答モデル・同じ採点基準で、naive(全文経路)と mnemora(記憶経路)の最終回答と
 * 入力量を対で出す——着地しても回答品質は未評価のままである(`AGENTS.md` 冒頭)。
 *
 * **provider は `compare`/`retrieval` と同じ規律である**——`resolveRecordedRun` が
 * 名乗り（画面表示）と env の倒し（`MNEMORA_LLM`/`MNEMORA_EMBEDDING` を `"recorded"`
 * へ倒すこと）を一緒に返すため、この関数はその返り値をそのまま
 * `createAnswerBenchRuntime` へ渡すだけでよい。**`record answer`（`recordAnswer`）で
 * カセットを作れる**——作った後は、キーが環境に無ければ自動的に記録を再生する
 * （`decideProviderSource` が `no-key` を選ぶ）。`MNEMORA_LLM=recorded
 * MNEMORA_EMBEDDING=recorded` の明示指定も引き続き効く——`decideProviderSource` は
 * `MNEMORA_PROVIDER_SOURCE` を見るだけで、`MNEMORA_LLM`/`MNEMORA_EMBEDDING` の
 * 個別指定を上書きしない（`selectLLMMode`/`selectEmbeddingMode` 参照）。カセットが
 * 無い状態で `MNEMORA_LLM=recorded` を指定すると、既存の挙動どおり `createProviders` の
 * `requireCassette` がそのまま落ちる。
 *
 * ⚠ **かつてはここが `resolveCassetteForRun` の返り値（`Cassette | undefined`）だけを
 * 読み、env を倒す作業を自分の手で書き忘れていた**（`process.env` をそのまま渡していた）
 * ——画面には「記録した応答を再生する」と出しながら、実際には `deterministic` の
 * 擬似 provider で走っていた（Issue #577）。`resolveRecordedRun` に改名し、
 * `RecordedRunPlan.env` を返り値に含めたことで、この「名乗ったのに倒し忘れる」形は
 * 書けなくなった。
 *
 * `runtime-factory.ts` の `createExampleRuntime` を使わない理由は
 * `answer-bench.ts` の `createAnswerBenchRuntime` の docstring を見ること
 * (呼び出し回数を数える decorator を `createRuntime()` へ渡す前に噛ませる必要があるため)。
 */
async function runAnswer(): Promise<void> {
  const databaseUrl = requireDatabaseUrl();
  const measuredAt = new Date();
  const commit = tryGitRevParseHead(process.cwd());
  // ⭐ `compare`/`retrieval` と同じ配線でカセットを解決する——`resolveRecordedRun` が
  // 名乗りと env の倒しを一緒に返すため、ここで env を組み立て直す必要が無い
  // （Issue #577。以前はここで `process.env` をそのまま渡していたために、
  // 「記録した応答を再生する」と画面に出しながら実際には `deterministic` の
  // 擬似 provider で走っていた）。
  const plan = resolveRecordedRun("answer");
  const handle = await createAnswerBenchRuntime(databaseUrl, plan.env, plan.providerOptions);
  // ⭐ 品質を主張できないモードでは、stdout の先頭で目立たせる(AGENTS.md §5)。
  const banner = formatAnswerQualityBanner(handle.llmMode);
  if (banner) {
    console.log(banner);
  }
  printProviderMode(handle, plan.plannedSource);
  try {
    console.log(
      "\n同じ会話・同じ質問・同じ回答モデル・同じ採点基準で、naive(全文経路)と" +
        "mnemora(記憶経路)の最終回答・入力量を対で出す(Issue #506)。\n" +
        "🔴 これは配線の検査であり、回答品質は測っていない。\n",
    );
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
    console.log("\n--- 追加費用(別ブロック。⛔ 削減率からは差し引かない) ---");
    console.log(formatAnswerCostTable(results));
    console.log(`\n${formatAnswerInputReduction(results)}`);
    console.log(formatAnswerContentPreservation(results));

    // `MNEMORA_ANSWER_JSON` が設定されたときだけ書く。未設定なら1バイトも挙動を
    // 変えない(既存の `MNEMORA_COMPARE_JSON` 等と同じ規約)。
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
 * `--trials=N` を argv から読む。省略時は1（マネージャー決定「既定1、評価は5」——
 * この既定値そのものは変えない。評価時は呼び出し側が `--trials=5` を明示する）。
 */
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

/**
 * `--temperature=N` を argv から読む。省略時は `undefined`（既定は渡さない——
 * `OpenAILLMProvider`/`CreateProvidersOptions` の既定と同じ規律。`llmMode !== "openai"`
 * のときは無視される）。段3b でこの run 自身を temperature=0 に固定して再現性を
 * 上げるために使う（`bench-results/STAGE3A-NOTES.txt` 参照）。
 */
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
 * `answer-time-weighting` サブコマンド（Issue #690 / PR #697）。
 *
 * 🔴 **`answer` サブコマンドとは測る問いが違う。** `answer` は naive/mnemora の配線
 * 検査、こちらは `RecallQuery.timeWeighting`（ADR 0300）を**回答の正誤**で比べる——
 * 記憶を抽出 LLM を通さず直接書き、reinforce し、壁時計を進めてから、同じ質問を
 * `legacy`/`eventAwareFreshness` の両方で recall→回答生成→採点する
 * （`time-weighting-bench.ts` の docstring参照）。
 *
 * provider の解決は `answer`/`compare`/`retrieval` と同じ規律
 * （`resolveRecordedRun`）。`--trials=N`（既定1）と `--dev`（開発用ケース集合に絞る。
 * 既定は dev + eval の両方）を argv から読む。
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
 * `answer-trials` サブコマンド（Issue #705、ADR 0301）。
 *
 * 🔴 **`answer` とは別の器である。** `answer` は12ケースを1回ずつ回して naive/mnemora の
 * 最終回答・入力量を対で出す（配線の検査）。**この器は dev 6件だけを、`examples/chat/cassettes/answer.json`
 * に記録済みの mnemora 経路プロンプトから読んだ**同じ記憶集合**の上で、描画 A（recorded）/
 * B（digest-only）ごとに n 回ずつ答えさせ、正答数（`gradeAnswer` の pass/fail/indeterminate）
 * で見る（ADR 0295 追記2 が見つけた「1回の試行では揺れが見えない」ことへの対応）。
 *
 * ⛔ **DB を使わない。** `DATABASE_URL` は不要——材料はカセットの静的な読み出しだけで作る
 * （`answer-trials-material.ts` は DB・埋め込み・抽出・recall を一切 import しない）。
 *
 * ⛔ **CI の門にしない**（Issue #705 完了条件・#693 の線）。`.github/workflows/ci.yml` には
 * 配線しない——手元で回す観測用の CLI である（ADR 0301）。
 */
async function runAnswerTrialsCommand(): Promise<void> {
  const result = await runAnswerTrials({ env: process.env });
  console.log(formatAnswerTrialsReport(result));

  const jsonPath = process.env.MNEMORA_ANSWER_TRIALS_JSON;
  if (jsonPath) {
    writeFileSync(jsonPath, `${JSON.stringify(result, null, 2)}\n`, "utf-8");
    console.log(`\n[answer-trials] 機械可読な結果を書き出した: ${jsonPath}`);
  }
  // ⭐ 未評価（実 API が無い）は exit 0 のまま——「実行できなかった」ことを画面と JSON に
  // 明示するのが目的であり、実行環境（鍵の有無）を落とす理由にしない（Issue #705 完了条件）。
}

/**
 * `answer-trials-compare` サブコマンド（Issue #705、ADR 0301）。
 *
 * `answer-trials` の実行結果 JSON を2件以上突き合わせ、カセットの sha256 か
 * ケースごとの材料指紋が一致しなければ、どこがずれたかを表示して exit 1。一致すれば
 * 並べて表示して exit 0（Issue #705 完了条件2、ADR 0295 追記2 の見落としの再発防止）。
 */
async function runAnswerTrialsCompareCommand(argv: string[]): Promise<void> {
  // `pnpm run answer-trials-compare -- a.json b.json` では pnpm が `--` をそのまま渡してくる
  // （実測: `--` をファイルとして開こうとして ENOENT）。パスではないので落とす。
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
  // ⭐ 副作用のある手（exit の判定）を判定と同じ行に繋がない——`ok` を見てから
  // ここで明示的に立てる（docs/autonomy.md §4.1）。
  if (!ok) {
    process.exitCode = 1;
  }
}

/**
 * Issue #369 (C)「訂正の口」の相手探しの精度を測る（`correction-candidate-arm.ts`）。
 *
 * **provider は `identifier-probes` と同じ組み合わせに固定する**——LLM は
 * `deterministic`、埋め込みは `local`（ONNX の実推論）。⛔ **鍵を要求しない。**
 * ⚠ `recorded` は使えない——この器のケースはカセットに記録が無い入力であり、
 * `recorded` provider は記録に無い入力を例外にする（ADR 0051）。
 *
 * ⚠ **順位を決めているのは埋め込み（`local` ＝ 実推論）であり、`deterministic` が
 * 掛かるのは抽出側である。**`docs/autonomy.md` §2.2 決定3 の「意味的品質を測るときに
 * `deterministic` stub へ置き換えない」は、この配線では埋め込み側に掛かる
 * （`identifier-probes`/`association-probes`/`consolidation-cost` と同じ前提）。
 *
 * **`warmup()` を明示的に呼び、失敗を区別する**（`identifier-probes` と同じ理由）
 * ——「重みを取得できなかった」が「相手探しの精度が低い」に見えてはならない。
 *
 * `-- --dev` を付けると開発用ケース集合で走る（⛔ その結果を「未使用の評価」として
 * 報告しないこと。`docs/autonomy.md` §2.2 決定5）。
 */
async function runCorrectionCandidates(useDevSet: boolean): Promise<void> {
  const databaseUrl = requireDatabaseUrl();
  const runToken = newRunToken();
  const handle = await createExampleRuntime(databaseUrl, {
    ...process.env,
    MNEMORA_LLM: "deterministic",
    MNEMORA_EMBEDDING: "local",
  });
  printProviderMode(handle, null);
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
      return;
    }
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
    console.log("");
    console.log(
      formatCorrectionCandidateReport(report, summarizeCorrectionCandidateReport(report)),
    );
  } finally {
    await handle.close();
  }
}

function printHelp(): void {
  console.log(
    [
      "使い方:",
      "  DATABASE_URL=... pnpm --filter @mnemora/example-chat run chat       # observe/recall の往復・omitted/usage/budget を実演",
      "  DATABASE_URL=... pnpm --filter @mnemora/example-chat run compare    # 会話の長さを変えて経路A/経路Bの量を実測",
      "                                                                      #   OPENAI_API_KEY があれば実 API、無ければ記録の再生(ADR 0052)",
      "                                                                      #   -- --decay-clock <wall|activity|either> で対象テナントの decay_clock を設定する(ADR 0165、既定は未指定=何も書かない)",
      "  DATABASE_URL=... pnpm --filter @mnemora/example-chat run scope      # tenantId/subjectId のスコープを実演",
      "  DATABASE_URL=... pnpm --filter @mnemora/example-chat run explain    # recallId から Runtime.getRecall() で内訳を後から読み戻す(Issue #312)",
      "  DATABASE_URL=... pnpm --filter @mnemora/example-chat run backfill   # observe() の occurredAt が period の絞りに効くことを実演",
      "  DATABASE_URL=... pnpm --filter @mnemora/example-chat run correction # 訂正を含む会話で markContested→resolveContested を実演(Issue #303)",
      "  DATABASE_URL=... pnpm --filter @mnemora/example-chat run retrieval # 意味的関連性の probe set を3 arm(擬似/埋め込みのみ本物/フル本物)で比較",
      "                                                                      #   OPENAI_API_KEY があれば実 API、無ければ記録の再生(ADR 0051)",
      "  DATABASE_URL=... pnpm --filter @mnemora/example-chat run time-term # 時間項(freshness/decay)を意味的類似度から分離して測る",
      "                                                                      #   既定は擬似 provider(similarity が構成上定数になるため provider に依らない)",
      "  DATABASE_URL=... pnpm --filter @mnemora/example-chat run validity  # validAt ゲート(Issue #280)が候補の有無をどう動かすかを測る",
      "                                                                      #   既定は擬似 provider。MNEMORA_VALIDITY_JSON で機械可読出力",
      "  pnpm --filter @mnemora/example-chat run embedding-fingerprint",
      "                                                                      # 固定入力に対する embed() の結果を書き出す(DB 不要。Issue #565)",
      "                                                                      #   MNEMORA_EMBEDDING_FINGERPRINT_RAW_JSON で機械可読出力(sha256/lscpuの合成は scripts/measure-embedding-output-fingerprint.mjs が別途行う)",
      "  DATABASE_URL=... pnpm --filter @mnemora/example-chat run identifier-probes",
      "                                                                      # ASCII識別子・固有名詞を含む probe(Issue #109)を@mnemora/local-embeddingで測る",
      "                                                                      #   鍵・カセット不要。日本語意味probe7件・識別子probe30件(sparse/dense haystack)を別々に集計する",
      "  DATABASE_URL=... pnpm --filter @mnemora/example-chat run association-probes",
      "                                                                      # 連想枠(段3.5、ADR 0151、Issue #291)が想起の質を動かすかを、off/on(maxCount=3)/on(maxCount=5)の3armで比較",
      "                                                                      #   鍵・カセット不要(deterministic LLM + local embedding)。MNEMORA_ASSOCIATION_JSON で機械可読出力",
      "  DATABASE_URL=... pnpm --filter @mnemora/example-chat run consolidation-cost",
      "                                                                      # Runtime.consolidate() の統合が「載る量」をどう動かすかをラウンド制で実測する(Issue #136)",
      "                                                                      #   鍵・カセット不要(deterministic LLM + local embedding)。MNEMORA_CONSOLIDATION_JSON で機械可読出力",
      "  DATABASE_URL=... pnpm --filter @mnemora/example-chat run archive-sweep-cost",
      "                                                                      # 掃引(Runtime.sweepArchive)が「載る量」/hit@k をどう動かすかを実測する(Issue #209)",
      "                                                                      #   鍵・カセット不要(deterministic LLM + local embedding)。MNEMORA_ARCHIVE_SWEEP_JSON で機械可読出力",
      "                                                                      #   -- --decay-clock <wall|activity|either> で対象テナントの decay_clock を設定する(ADR 0165、既定は未指定=何も書かない)",
      "  DATABASE_URL=... pnpm --filter @mnemora/example-chat run correction-candidates",
      "                                                                      # 訂正の相手探しの精度(Issue #369 (C))を測る。hit@k/distractor逆転率/誤爆率/棄権率",
      "                                                                      #   鍵・カセット不要(deterministic LLM + local embedding)。-- --dev で開発用ケース集合",
      "  DATABASE_URL=... pnpm --filter @mnemora/example-chat run answer      # naive/mnemora の最終回答・入力量を対で出す(Issue #506)",
      "                                                                      #   🔴 配線の検査であり、回答品質は測っていない(llmMode=deterministic のとき集計を出さない)",
      "                                                                      #   MNEMORA_ANSWER_JSON で機械可読出力",
      "  DATABASE_URL=... pnpm --filter @mnemora/example-chat run answer-time-weighting",
      "                                                                      # RecallQuery.timeWeighting(legacy/eventAwareFreshness、Issue #690・ADR 0300)を回答の正誤で比べる",
      "                                                                      #   -- --trials=N(既定1)・-- --temperature=N(既定は未指定)・-- --dev で開発用ケース集合のみ。MNEMORA_TIME_WEIGHTING_JSON で機械可読出力",
      "  pnpm --filter @mnemora/example-chat run answer-trials",
      "                                                                      # 同じ記憶集合(examples/chat/cassettes/answer.json の記録済みプロンプト)で",
      "                                                                      #   dev 6件 × 描画A(recorded)/B(digest-only) × n回の正答数を見る(Issue #705、ADR 0301)",
      "                                                                      #   DB 不要。OPENAI_API_KEY が無ければ実 API を叩かず『未評価』と明示して exit 0",
      "                                                                      #   MNEMORA_ANSWER_TRIALS_N(既定5)・MNEMORA_ANSWER_TRIALS_RENDERS(既定 recorded,digest-only)・MNEMORA_ANSWER_TRIALS_JSON",
      "  pnpm --filter @mnemora/example-chat run answer-trials-compare -- a.json b.json",
      "                                                                      # answer-trials の結果 JSON を2件以上突き合わせ、カセット sha256・ケースごとの材料指紋が",
      "                                                                      #   一致しなければどこがずれたかを表示して exit 1(Issue #705 完了条件2)",
      "  DATABASE_URL=... OPENAI_API_KEY=... pnpm --filter @mnemora/example-chat run record",
      "                                                                      # retrieval の応答を記録する(ADR 0051)",
      "  DATABASE_URL=... OPENAI_API_KEY=... pnpm --filter @mnemora/example-chat run record:compare",
      "                                                                      # compare の応答を記録する(ADR 0052。657回・8〜15分・約$0.023)",
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
      "  MNEMORA_PROVIDER_SOURCE=recorded|openai  # retrieval/compare で「キーがあれば実API」を明示的に上書きする(ADR 0068)",
      "                                                                      #   recorded: キーが在ってもカセットを再生する(誤って課金しない)",
      "                                                                      #   openai  : カセットが在っても実 API を叩く(キーが無ければ落ちる。擬似物へは倒れない)",
      "                                                                      #   未指定なら従来通りキーの有無だけで決まる",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "chat") {
    await runChat();
  } else if (command === "compare") {
    await runCompare(parseDecayClockFlag(process.argv.slice(3)));
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
  } else {
    printHelp();
    if (command !== undefined) {
      process.exitCode = 1;
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

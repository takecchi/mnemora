import type {
  Ctx,
  EmbeddingProvider,
  EmbeddingSpaceId,
  LLMProvider,
  LLMResponse,
  PromptMessage,
  PromptSpec,
  RecallAssociationQuery,
  RecallResult,
  Runtime,
  StructuredRequest,
} from "@mnemora/core";
import { createRuntime, heuristicTokenCounter } from "@mnemora/core";
import type { PostgresClient } from "@mnemora/postgres";
import {
  PostgresEventStore,
  PostgresLexicalStore,
  PostgresMemoryStore,
  PostgresOutboxStore,
  PostgresTenantSettingsStore,
  PostgresVectorStore,
  closePostgresClient,
  createPostgresClient,
  registerEmbeddingSpace,
  runMigrations,
  sha256Hex,
} from "@mnemora/postgres";
import type { AnswerCase, AnswerVerdict } from "./answer-case.js";
import { gradeAnswer } from "./answer-case.js";
import type { ContentPreservationResult } from "./answer-content-preservation.js";
import { checkContentPreserved } from "./answer-content-preservation.js";
import type { AnswerJudgement } from "./answer-judge.js";
import { judgeAnswer, reconcileVerdicts } from "./answer-judge.js";
import type { IngestConversationOptions } from "./mnemora-path.js";
import { buildMnemoraPromptDetail, ingestConversation, queryRecall } from "./mnemora-path.js";
import { naivePrompt } from "./naive-path.js";
import type {
  CreateProvidersOptions,
  EnvLike,
  ProviderMode,
  SeedUsageSummary,
} from "./providers.js";
import { createProviders } from "./providers.js";
import type { Conversation, ConversationTurn } from "./scenario.js";
import type { UsageMeter } from "./usage-meter.js";

export const ANSWER_SYSTEM_PROMPT =
  "以下の会話ログだけを根拠に、簡潔に答えてください。根拠が無ければ『分かりません』と答えてください。";

/** 区切りに空白を入れない。`ANSWER_SYSTEM_PROMPT` 自身が、2文を空白無しで連結する書き方だから。 */
export const CONTESTED_CORRECTION_GUIDANCE =
  "矛盾候補の印がある記憶どうしは、記録順の新しい方を現在の値として答えてください。";

function buildQuestionSuffix(question: string): string {
  return `\n\n質問: ${question}`;
}

/**
 * 両経路がこの同じ関数で入力量を測る。`recall().usage.chars` を入力量として報告しないのは、
 * `complete()` へ実際に渡した量と一致しない（`buildMnemoraPrompt` が目次帯の1行を足す）から。
 */
export function serializePromptSpec(spec: PromptSpec): string {
  const parts: string[] = [];
  if (spec.system !== undefined) {
    parts.push(`system: ${spec.system}`);
  }
  for (const message of spec.messages) {
    parts.push(`${message.role}: ${message.content}`);
  }
  return parts.join("\n");
}

export interface AnswerBenchCallCounts {
  extractionCalls: number;
  answerCalls: number;
}

export class CountingLLMProvider implements LLMProvider {
  private counts: AnswerBenchCallCounts = { extractionCalls: 0, answerCalls: 0 };

  constructor(private readonly inner: LLMProvider) {}

  async complete(ctx: Ctx, req: PromptSpec): Promise<LLMResponse> {
    this.counts.answerCalls += 1;
    return this.inner.complete(ctx, req);
  }

  async completeStructured<T>(ctx: Ctx, req: StructuredRequest<T>): Promise<T> {
    this.counts.extractionCalls += 1;
    return this.inner.completeStructured(ctx, req);
  }

  snapshot(): AnswerBenchCallCounts {
    return { ...this.counts };
  }
}

export class CountingEmbeddingProvider implements EmbeddingProvider {
  readonly space: EmbeddingSpaceId;
  private calls = 0;

  constructor(private readonly inner: EmbeddingProvider) {
    this.space = inner.space;
  }

  async embed(ctx: Ctx, texts: string[]): Promise<number[][]> {
    this.calls += 1;
    return this.inner.embed(ctx, texts);
  }

  snapshot(): number {
    return this.calls;
  }
}

function diffCounts(
  before: AnswerBenchCallCounts,
  after: AnswerBenchCallCounts,
): AnswerBenchCallCounts {
  return {
    extractionCalls: after.extractionCalls - before.extractionCalls,
    answerCalls: after.answerCalls - before.answerCalls,
  };
}

// `runtime-factory.ts` の `createExampleRuntime` を再利用しない。呼び出し回数を数える decorator は
// `createRuntime()` へ渡す前の provider を包む必要があるが、`createExampleRuntime` は provider を
// 内部で直接渡してしまい、差し込む口が無い。

export interface AnswerBenchRuntimeHandle {
  runtime: Runtime;
  llmMode: ProviderMode;
  embeddingMode: ProviderMode;
  llmProvider: CountingLLMProvider;
  embeddingProvider: CountingEmbeddingProvider;
  /**
   * judge 専用の呼び出し回数カウンタ。`llmProvider` と同じ生の provider を包む別インスタンスにする。
   * judge が `llmProvider` を経由すると `answerLLMCalls`（回答生成のみで常に2）が 4 に化けるため。
   */
  judgeLLMProvider: CountingLLMProvider;
  usageMeter?: UsageMeter;
  cassetteIgnored: boolean;
  readSeedUsage?: () => SeedUsageSummary;
  close(): Promise<void>;
}

export async function createAnswerBenchRuntime(
  databaseUrl: string,
  env: EnvLike = process.env,
  providerOptions: CreateProvidersOptions = {},
): Promise<AnswerBenchRuntimeHandle> {
  const client: PostgresClient = createPostgresClient(databaseUrl);
  // `client` を作った後、`close()` を持つ handle を返す前に失敗しうる `await` が続く。ここで reject すると
  // 呼び出し側は handle を受け取れず `close()` できないため、ここで閉じる（`createExampleRuntime` と同じ穴）。
  try {
    await runMigrations(client.pool);

    const created = createProviders(env, providerOptions);
    const llmProvider = new CountingLLMProvider(created.llmProvider);
    const judgeLLMProvider = new CountingLLMProvider(created.llmProvider);
    const embeddingProvider = new CountingEmbeddingProvider(created.embeddingProvider);
    await registerEmbeddingSpace(client.pool, embeddingProvider.space);

    const runtime = createRuntime({
      memoryStore: new PostgresMemoryStore(client.db),
      outboxStore: new PostgresOutboxStore(client.db),
      vectorStore: new PostgresVectorStore(client.db),
      lexicalStore: new PostgresLexicalStore(client.db),
      eventStore: new PostgresEventStore(client.db),
      tenantSettingsStore: new PostgresTenantSettingsStore(client.db),
      llmProvider,
      embeddingProvider,
      hashContent: sha256Hex,
    });

    return {
      runtime,
      llmMode: created.llmMode,
      embeddingMode: created.embeddingMode,
      llmProvider,
      embeddingProvider,
      judgeLLMProvider,
      cassetteIgnored: created.cassetteIgnored,
      ...(created.usageMeter !== undefined ? { usageMeter: created.usageMeter } : {}),
      ...(created.readSeedUsage !== undefined ? { readSeedUsage: created.readSeedUsage } : {}),
      close: () => closePostgresClient(client),
    };
  } catch (err) {
    await closePostgresClient(client).catch(() => {});
    throw err;
  }
}

function toConversation(answerCase: AnswerCase): Conversation {
  const turns: ConversationTurn[] = answerCase.conversation.map((turn, index) => ({
    index,
    role: turn.role,
    text: turn.text,
  }));
  return {
    turns,
    userUtterances: turns.filter((t) => t.role === "user"),
    query: answerCase.question,
  };
}

export interface AnswerPathMeasurement {
  promptSpec: PromptSpec;
  inputChars: number;
  inputEstimatedTokens: number;
  answer: string;
  verdict: AnswerVerdict;
  judgement?: AnswerJudgement;
  reconciled?: AnswerVerdict;
  contentPreservation: ContentPreservationResult;
}

export interface AnswerCaseCost {
  extractionLLMCalls: number;
  embeddingCalls: number;
  answerLLMCalls: number;
  judgeLLMCalls: number;
}

export interface AnswerCaseRunResult {
  case: AnswerCase;
  naive: AnswerPathMeasurement;
  mnemora: AnswerPathMeasurement;
  cost: AnswerCaseCost;
}

function buildPromptMessage(content: string): PromptMessage {
  return { role: "user", content };
}

/** プロンプトの組み立てをテスト側へ写さない（二重定義にしない）ため、ここに1つだけ置く。 */
export function buildNaiveAnswerPromptSpec(answerCase: AnswerCase): PromptSpec {
  const conversation = toConversation(answerCase);
  return {
    system: ANSWER_SYSTEM_PROMPT,
    messages: [
      buildPromptMessage(`${naivePrompt(conversation)}${buildQuestionSuffix(answerCase.question)}`),
    ],
  };
}

/**
 * mnemora 経路の system 文を決める。naive 経路には適用しない。naive のプロンプトは `[矛盾候補:]` の印を
 * 含まないので、読み方の指示を足すのは印が出うる mnemora 側だけにする。
 * 足すかどうかは、フラグそのものではなく `hasContestedCorrectionWording`（実際に非対称文面を出したか）で決める。
 */
export function resolveMnemoraAnswerSystemPrompt(
  hasContestedCorrectionWording: boolean,
  contestedCorrectionGuidance: boolean,
): string {
  if (contestedCorrectionGuidance && hasContestedCorrectionWording) {
    return `${ANSWER_SYSTEM_PROMPT}${CONTESTED_CORRECTION_GUIDANCE}`;
  }
  return ANSWER_SYSTEM_PROMPT;
}

function resolveGroundTurnTexts(answerCase: AnswerCase): string[] {
  return answerCase.grounds.turnIndex.map((index) => {
    const turn = answerCase.conversation[index];
    if (turn === undefined) {
      throw new Error(
        `resolveGroundTurnTexts: case "${answerCase.id}" の grounds.turnIndex=${index} が ` +
          "conversation の範囲外である。",
      );
    }
    return turn.text;
  });
}

/**
 * `EmbeddingSpaceId` から、tenantId に埋め込める短いスラグを作る。
 *
 * 埋め込み空間を tenant に含める理由: 空間が違う run が同じ tenant を共有すると、冪等な `observe` が
 * 抽出をスキップし、片方の空間のテーブルが0行のまま recall が走ってカセットに無いプロンプトが組まれる。
 *
 * `packages/postgres` の `embeddingSpaceTableName` は import しない。あちらは PostgreSQL 識別子の
 * 制約から決めた命名で、ここが要るのは tenantId に挟める短い文字列だけ。
 *
 * `runId` を入れる案は採らない。この関数を使う `runAnswer` は同じ入力で同じ結果が出ることが仕事で、
 * 実行ごとに tenant を変えるとその検査が意味を失い、tenant が積み上がる。
 */
export function describeZeroPresented(
  tenantId: string,
  embeddingSpace: string,
  recall: Pick<RecallResult, "index" | "memories" | "omitted">,
): string | null {
  if (!(recall.index.totalInScope > 0 && recall.memories.length === 0)) {
    return null;
  }
  return [
    `⚠ [answer-bench] ${tenantId}: スコープ内 ${recall.index.totalInScope} 件の記憶が在るのに、0 件しか提示されていない。`,
    `  この実行の埋め込み空間: ${embeddingSpace}`,
    "  ⚠ **これは判定ではない。候補である**:",
    "   (1) 同じ tenant に別の埋め込み空間で先に記憶が入っており、この空間のベクトルが0件",
    "       （observations は (tenant_id, external_id) で冪等なので、2回目の抽出は走らない。Issue #583）",
    "   (2) 予算・減衰・validAt ゲートで候補が落ちた",
    "   (3) 関連度が閾値に届かなかった（答えを控えるべき問いでは、これが正常な姿である）",
    `  この recall の omitted: ${describeOmittedBrief(recall.omitted)}`,
    "  ⛔ どれかは、この行だけでは決まらない（上の omitted が手掛かりになる）。",
  ].join("\n");
}

function describeOmittedBrief(omitted: RecallResult["omitted"]): string {
  if (omitted.length === 0) {
    return "(無し)";
  }
  return omitted
    .map((o) => {
      const fields = o as {
        stage?: unknown;
        reason?: unknown;
        condition?: unknown;
        count?: unknown;
      };
      const detail = [fields.stage, fields.reason, fields.condition]
        .filter((v): v is string => typeof v === "string")
        .join(":");
      const count = typeof fields.count === "number" ? `×${fields.count}` : "";
      return `${o.kind}${detail.length > 0 ? `(${detail})` : ""}${count}`;
    })
    .join(", ");
}

export function embeddingSpaceSlug(space: EmbeddingSpaceId): string {
  const sanitize = (value: string): string =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  return [sanitize(space.provider), sanitize(space.model), String(space.dimensions)]
    .filter((part) => part.length > 0)
    .join("-");
}

export async function runAnswerCase(
  runtime: Runtime,
  llmProvider: CountingLLMProvider,
  embeddingProvider: CountingEmbeddingProvider,
  judgeLLMProvider: CountingLLMProvider,
  answerCase: AnswerCase,
  tenantPrefix: string,
  ingestOptions: IngestConversationOptions = {},
  association?: RecallAssociationQuery | null,
  contestedCorrectionGuidance = true,
): Promise<AnswerCaseRunResult> {
  const embeddingSpace = embeddingSpaceSlug(embeddingProvider.space);
  const ctx: Ctx = { tenantId: `${tenantPrefix}-${embeddingSpace}-${answerCase.id}` };
  const conversation = toConversation(answerCase);
  const questionSuffix = buildQuestionSuffix(answerCase.question);

  const beforeIngestLLM = llmProvider.snapshot();
  const beforeIngestEmb = embeddingProvider.snapshot();
  await ingestConversation(runtime, ctx, conversation, ingestOptions);
  const afterIngestLLM = llmProvider.snapshot();

  const recall = await queryRecall(runtime, ctx, conversation, { association });

  const zeroPresentedWarning = describeZeroPresented(ctx.tenantId, embeddingSpace, recall);
  if (zeroPresentedWarning !== null) {
    console.log(zeroPresentedWarning);
  }

  const afterRecallEmb = embeddingProvider.snapshot();

  const naivePromptSpec: PromptSpec = buildNaiveAnswerPromptSpec(answerCase);
  const mnemoraPromptDetail = buildMnemoraPromptDetail(recall);
  const mnemoraPromptSpec: PromptSpec = {
    system: resolveMnemoraAnswerSystemPrompt(
      mnemoraPromptDetail.hasContestedCorrectionWording,
      contestedCorrectionGuidance,
    ),
    messages: [buildPromptMessage(`${mnemoraPromptDetail.body}${questionSuffix}`)],
  };

  const beforeAnswerLLM = llmProvider.snapshot();
  const naiveResponse = await llmProvider.complete(ctx, naivePromptSpec);
  const mnemoraResponse = await llmProvider.complete(ctx, mnemoraPromptSpec);
  const afterAnswerLLM = llmProvider.snapshot();

  const naiveSerialized = serializePromptSpec(naivePromptSpec);
  const mnemoraSerialized = serializePromptSpec(mnemoraPromptSpec);

  const naiveVerdict = gradeAnswer(naiveResponse.content, answerCase.expected);
  const mnemoraVerdict = gradeAnswer(mnemoraResponse.content, answerCase.expected);

  const naiveContentPreservation = checkContentPreserved(naiveSerialized, answerCase.expected);
  const mnemoraContentPreservation = checkContentPreserved(mnemoraSerialized, answerCase.expected);

  const groundTurnTexts = resolveGroundTurnTexts(answerCase);
  const beforeJudgeLLM = judgeLLMProvider.snapshot();
  const naiveJudgement = await judgeAnswer(judgeLLMProvider, ctx, {
    question: answerCase.question,
    expectedKind: answerCase.expected.kind,
    rationale: answerCase.grounds.rationale,
    groundTurnTexts,
    answer: naiveResponse.content,
  });
  const mnemoraJudgement = await judgeAnswer(judgeLLMProvider, ctx, {
    question: answerCase.question,
    expectedKind: answerCase.expected.kind,
    rationale: answerCase.grounds.rationale,
    groundTurnTexts,
    answer: mnemoraResponse.content,
  });
  const afterJudgeLLM = judgeLLMProvider.snapshot();

  const extractionDiff = diffCounts(beforeIngestLLM, afterIngestLLM);
  const answerDiff = diffCounts(beforeAnswerLLM, afterAnswerLLM);
  const judgeDiff = diffCounts(beforeJudgeLLM, afterJudgeLLM);

  return {
    case: answerCase,
    naive: {
      promptSpec: naivePromptSpec,
      inputChars: naiveSerialized.length,
      inputEstimatedTokens: heuristicTokenCounter.count(naiveSerialized).tokens,
      answer: naiveResponse.content,
      verdict: naiveVerdict,
      judgement: naiveJudgement,
      reconciled: reconcileVerdicts(naiveVerdict, naiveJudgement.outcome),
      contentPreservation: naiveContentPreservation,
    },
    mnemora: {
      promptSpec: mnemoraPromptSpec,
      inputChars: mnemoraSerialized.length,
      inputEstimatedTokens: heuristicTokenCounter.count(mnemoraSerialized).tokens,
      answer: mnemoraResponse.content,
      verdict: mnemoraVerdict,
      judgement: mnemoraJudgement,
      reconciled: reconcileVerdicts(mnemoraVerdict, mnemoraJudgement.outcome),
      contentPreservation: mnemoraContentPreservation,
    },
    cost: {
      extractionLLMCalls: extractionDiff.extractionCalls,
      embeddingCalls: afterRecallEmb - beforeIngestEmb,
      answerLLMCalls: answerDiff.answerCalls,
      judgeLLMCalls: judgeDiff.answerCalls,
    },
  };
}

export async function runAnswerBench(
  runtime: Runtime,
  llmProvider: CountingLLMProvider,
  embeddingProvider: CountingEmbeddingProvider,
  judgeLLMProvider: CountingLLMProvider,
  cases: readonly AnswerCase[],
  tenantPrefix: string,
  ingestOptions: IngestConversationOptions = {},
  association?: RecallAssociationQuery | null,
  contestedCorrectionGuidance = true,
): Promise<AnswerCaseRunResult[]> {
  const results: AnswerCaseRunResult[] = [];
  for (const answerCase of cases) {
    results.push(
      await runAnswerCase(
        runtime,
        llmProvider,
        embeddingProvider,
        judgeLLMProvider,
        answerCase,
        tenantPrefix,
        ingestOptions,
        association,
        contestedCorrectionGuidance,
      ),
    );
  }
  return results;
}

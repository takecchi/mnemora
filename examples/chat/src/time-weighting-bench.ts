import type { Ctx, LLMProvider, NewMemory, RecallAssociationQuery, Runtime } from "@mnemora/core";
import {
  DEFAULT_SCORE_THRESHOLD,
  TIME_WEIGHTING_POLICIES,
  createRuntime,
  heuristicTokenCounter,
  type TimeWeightingPolicy,
} from "@mnemora/core";
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
import { buildNewMemoryFixture } from "@mnemora/testkit";
import type { AnswerVerdict } from "./answer-case.js";
import { gradeAnswer } from "./answer-case.js";
import {
  CountingEmbeddingProvider,
  CountingLLMProvider,
  embeddingSpaceSlug,
} from "./answer-bench.js";
import { clockPastRecentDbWrites, drainEmbedTicks } from "./embed-drain.js";
import { buildMnemoraPrompt } from "./mnemora-path.js";
import { createMutableClock } from "./mutable-clock.js";
import type { MutableClock } from "./mutable-clock.js";
import type {
  CreateProvidersOptions,
  EnvLike,
  ProviderMode,
  SeedUsageSummary,
} from "./providers.js";
import { createProviders } from "./providers.js";
import { scoreTotalOrNull } from "./recalled-score.js";
import type { TimeWeightingCase, TimeWeightingMemorySeed } from "./time-weighting-case.js";
import { assertTimeWeightingCaseWellFormed } from "./time-weighting-case.js";
import type { UsageMeter } from "./usage-meter.js";

/**
 * `answer-bench.ts` と違い抽出 LLM を通さず記憶を直接書く（あちらは取り込み直後に `recall()` するため時間項がほぼ1に張り付く）。
 * `answer-judge.ts`（LLM 採点）は使わない: 問うているのは「`recall()` に正しい記憶が候補として残ったか」という構造的な性質で、一次判定（文字列一致）だけで完結する。
 */

export interface TimeWeightingBenchRuntimeHandle {
  runtime: Runtime;
  memoryStore: PostgresMemoryStore;
  clock: MutableClock;
  llmMode: ProviderMode;
  embeddingMode: ProviderMode;
  llmProvider: CountingLLMProvider;
  embeddingProvider: CountingEmbeddingProvider;
  usageMeter?: UsageMeter;
  cassetteIgnored: boolean;
  readSeedUsage?: () => SeedUsageSummary;
  /** 冪等: 2回目以降は何もせず resolve する。 */
  close(): Promise<void>;
}

export async function createTimeWeightingBenchRuntime(
  databaseUrl: string,
  env: EnvLike = process.env,
  providerOptions: CreateProvidersOptions = {},
): Promise<TimeWeightingBenchRuntimeHandle> {
  const client: PostgresClient = createPostgresClient(databaseUrl);
  // `runtime-factory.ts` と同じ理由: `client` を作った後に失敗しうる `await` が続き、呼び出し側は `try` の外で `await` するので、ここで reject すると `close()` を呼びようがない。
  try {
    await runMigrations(client.pool);

    const created = createProviders(env, providerOptions);
    const llmProvider = new CountingLLMProvider(created.llmProvider);
    const embeddingProvider = new CountingEmbeddingProvider(created.embeddingProvider);
    await registerEmbeddingSpace(client.pool, embeddingProvider.space);

    const memoryStore = new PostgresMemoryStore(client.db);
    // 初期値はどうでもよい（`runTimeWeightingCase` が `recall()` の直前に必ず `set()` する。記憶の作成・reinforce は `Clock` を読まない）。
    const clock = createMutableClock();

    const runtime = createRuntime({
      memoryStore,
      outboxStore: new PostgresOutboxStore(client.db),
      vectorStore: new PostgresVectorStore(client.db),
      lexicalStore: new PostgresLexicalStore(client.db),
      eventStore: new PostgresEventStore(client.db),
      tenantSettingsStore: new PostgresTenantSettingsStore(client.db),
      llmProvider,
      embeddingProvider,
      hashContent: sha256Hex,
      clock,
    });

    return {
      runtime,
      memoryStore,
      clock,
      llmMode: created.llmMode,
      embeddingMode: created.embeddingMode,
      llmProvider,
      embeddingProvider,
      cassetteIgnored: created.cassetteIgnored,
      ...(created.usageMeter !== undefined ? { usageMeter: created.usageMeter } : {}),
      ...(created.readSeedUsage !== undefined ? { readSeedUsage: created.readSeedUsage } : {}),
      close: () => closePostgresClient(client),
    };
  } catch (err) {
    // 元の失敗（`err`）を `close()` 自体の失敗で上書きしない。
    await closePostgresClient(client).catch(() => {});
    throw err;
  }
}

/** `buildNewMemoryFixture` の既定 `contentHash` は固定文字列で、複数件を同じ tenant に書くと冪等キーで衝突するので、実物の SHA-256 へ差し替える。 */
function buildTimeWeightingNewMemory(tenantId: string, seed: TimeWeightingMemorySeed): NewMemory {
  return buildNewMemoryFixture({
    tenantId,
    content: seed.content,
    contentHash: sha256Hex(`${tenantId}:${seed.localId}:${seed.content}`),
    digest: seed.content,
    tags: seed.tags ?? [],
    occurredAt: seed.occurredAt ?? null,
    recordedAt: seed.recordedAt,
    validFrom: seed.validFrom ?? null,
    validUntil: seed.validUntil ?? null,
  });
}

export async function seedTimeWeightingMemories(
  memoryStore: PostgresMemoryStore,
  runtime: Runtime,
  clock: MutableClock,
  ctx: Ctx,
  seeds: readonly TimeWeightingMemorySeed[],
): Promise<Map<string, string>> {
  const memoryIdByLocalId = new Map<string, string>();
  for (const seed of seeds) {
    const input = buildTimeWeightingNewMemory(ctx.tenantId, seed);
    const { memory } = await memoryStore.createMemoryWithOutbox(ctx, input, ["embed"]);
    memoryIdByLocalId.set(seed.localId, memory.id);
  }
  // 埋め込みを処理する直前に `clock` を実時刻へ進める。止めたままだと `available_at <= now` が false になり claim が1件も進まない。
  // `available_at` はマイクロ秒精度で JS の `Date` はミリ秒なので、`clockPastRecentDbWrites` で追い越す。
  clock.set(clockPastRecentDbWrites());
  // 書いた seed 件数を `expectedProcessed` に渡す。止まった `MutableClock` は動かないので、`waitForClockToAdvance` は `false` にして無駄な待ちを避ける。
  await drainEmbedTicks(runtime, ctx, {
    expectedProcessed: seeds.length,
    waitForClockToAdvance: false,
  });

  for (const seed of seeds) {
    const memoryId = memoryIdByLocalId.get(seed.localId);
    if (memoryId === undefined) {
      throw new Error(`seedTimeWeightingMemories: memory "${seed.localId}" を作成できなかった。`);
    }
    for (const at of seed.reinforceAt ?? []) {
      await memoryStore.reinforce(ctx, memoryId, at);
    }
  }
  return memoryIdByLocalId;
}

const ANSWER_SYSTEM_PROMPT =
  "以下に列挙した記憶だけを根拠に、簡潔に答えてください。根拠が無ければ『分かりません』と答えてください。";

function buildQuestionSuffix(question: string): string {
  return `\n\n質問: ${question}`;
}

/** 診断専用の2回目の `recall()` だけが使う極端に低い閾値（below_threshold による除外を実質無効化し、全件を見えるようにする）。回答生成の `recall()` はこの閾値を使わない。 */
const DIAGNOSTIC_SCORE_THRESHOLD = -1_000_000;

export interface TimeWeightingContextDiagnosticEntry {
  localId: string;
  memoryId: string;
  rank: number;
  total: number;
  freshness: number;
  decay: number;
  belowThreshold: boolean;
  enteredContext: boolean;
}

export interface TimeWeightingPolicyResult {
  policy: TimeWeightingPolicy;
  answer: string;
  verdict: AnswerVerdict;
  recallMemoryCount: number;
  prompt: string;
  inputChars: number;
  inputEstimatedTokens: number;
  contextDiagnostics: TimeWeightingContextDiagnosticEntry[];
}

async function collectContextDiagnostics(
  runtime: Runtime,
  ctx: Ctx,
  question: string,
  policy: TimeWeightingPolicy,
  localIdByMemoryId: ReadonlyMap<string, string>,
  association: RecallAssociationQuery | null = null,
): Promise<TimeWeightingContextDiagnosticEntry[]> {
  // association: 省略時は null（この bench の基準線を動かさない）。
  const diagnosticRecall = await runtime.recall(ctx, {
    text: question,
    timeWeighting: policy,
    scoreThreshold: DIAGNOSTIC_SCORE_THRESHOLD,
    association,
  });
  const entries: TimeWeightingContextDiagnosticEntry[] = [];
  diagnosticRecall.memories.forEach((m, index) => {
    const localId = localIdByMemoryId.get(m.memoryId);
    if (localId === undefined) {
      // このケースが直接書いた記憶ではない（連想枠等）。診断の対象外として黙って飛ばす。
      return;
    }
    // affinityMeasured: false には total が無いので、同じく診断の対象外として飛ばす。
    const total = scoreTotalOrNull(m.score);
    if (total === null) {
      return;
    }
    const belowThreshold = total < DEFAULT_SCORE_THRESHOLD;
    entries.push({
      localId,
      memoryId: m.memoryId,
      rank: index + 1,
      total,
      freshness: m.score.freshness,
      decay: m.score.decay,
      belowThreshold,
      enteredContext: !belowThreshold,
    });
  });
  return entries;
}

async function runTimeWeightingPolicy(
  runtime: Runtime,
  llmProvider: LLMProvider,
  ctx: Ctx,
  question: string,
  expected: TimeWeightingCase["expected"],
  policy: TimeWeightingPolicy,
  localIdByMemoryId: ReadonlyMap<string, string>,
  association: RecallAssociationQuery | null = null,
): Promise<TimeWeightingPolicyResult> {
  // association: 省略時は null。この `recall()` の結果は LLM プロンプトへ入り、連想を on にすると recorded cassette に無い入力を作りうる。
  const recall = await runtime.recall(ctx, {
    text: question,
    timeWeighting: policy,
    association,
  });
  const prompt = `${buildMnemoraPrompt(recall)}${buildQuestionSuffix(question)}`;
  const response = await llmProvider.complete(ctx, {
    system: ANSWER_SYSTEM_PROMPT,
    messages: [{ role: "user", content: prompt }],
  });
  const verdict = gradeAnswer(response.content, expected);
  const contextDiagnostics = await collectContextDiagnostics(
    runtime,
    ctx,
    question,
    policy,
    localIdByMemoryId,
    association,
  );
  return {
    policy,
    answer: response.content,
    verdict,
    recallMemoryCount: recall.memories.length,
    prompt,
    inputChars: prompt.length,
    inputEstimatedTokens: heuristicTokenCounter.count(prompt).tokens,
    contextDiagnostics,
  };
}

export interface TimeWeightingTrialResult {
  case: TimeWeightingCase;
  trial: number;
  byPolicy: Record<TimeWeightingPolicy, TimeWeightingPolicyResult>;
}

/** `caseId` から tenantId を作る。embedding 空間ごとに加え trial ごとにも分ける（記憶の書き込みからやり直し、trial を跨いで独立に API を呼ぶことを保証する）。 */
function tenantIdFor(
  tenantPrefix: string,
  spaceSlug: string,
  caseId: string,
  trial: number,
): string {
  return `${tenantPrefix}-${spaceSlug}-${caseId}-t${trial}`;
}

/** 2方針は同じ記憶の状態に対して続けて呼ぶ（`recall()` は読み取りのみで `reportMemoryUsage` を呼ばないので、状態は変わらない）。 */
export async function runTimeWeightingCase(
  handle: TimeWeightingBenchRuntimeHandle,
  timeWeightingCase: TimeWeightingCase,
  tenantPrefix: string,
  trial: number,
  // 省略時は `null`（この bench の基準線を変えない）。
  association: RecallAssociationQuery | null = null,
  // 省略時は `TIME_WEIGHTING_POLICIES`（両方）。変わっていない方針の回答生成コールを無駄に払わずに済むよう、呼び出し側が絞れる。
  policies: readonly TimeWeightingPolicy[] = TIME_WEIGHTING_POLICIES,
): Promise<TimeWeightingTrialResult> {
  assertTimeWeightingCaseWellFormed(timeWeightingCase);
  const ctx: Ctx = {
    tenantId: tenantIdFor(
      tenantPrefix,
      embeddingSpaceSlug(handle.embeddingProvider.space),
      timeWeightingCase.id,
      trial,
    ),
  };

  const memoryIdByLocalId = await seedTimeWeightingMemories(
    handle.memoryStore,
    handle.runtime,
    handle.clock,
    ctx,
    timeWeightingCase.memories,
  );
  const localIdByMemoryId = new Map<string, string>(
    [...memoryIdByLocalId.entries()].map(([localId, memoryId]) => [memoryId, localId]),
  );

  // 記憶の作成・reinforce は `Clock` を読まないので、`Clock` を動かすのはここ1回だけでよい。
  handle.clock.set(timeWeightingCase.recallAt);

  const byPolicy = {} as Record<TimeWeightingPolicy, TimeWeightingPolicyResult>;
  for (const policy of policies) {
    byPolicy[policy] = await runTimeWeightingPolicy(
      handle.runtime,
      handle.llmProvider,
      ctx,
      timeWeightingCase.question,
      timeWeightingCase.expected,
      policy,
      localIdByMemoryId,
      association,
    );
  }

  return { case: timeWeightingCase, trial, byPolicy };
}

export async function runTimeWeightingBench(
  handle: TimeWeightingBenchRuntimeHandle,
  cases: readonly TimeWeightingCase[],
  tenantPrefix: string,
  trials: number,
  association: RecallAssociationQuery | null = null,
): Promise<TimeWeightingTrialResult[]> {
  if (trials < 1) {
    throw new Error(`runTimeWeightingBench: trials は1以上であること（実際: ${trials}）。`);
  }
  const results: TimeWeightingTrialResult[] = [];
  for (const timeWeightingCase of cases) {
    for (let trial = 1; trial <= trials; trial += 1) {
      results.push(
        await runTimeWeightingCase(handle, timeWeightingCase, tenantPrefix, trial, association),
      );
    }
  }
  return results;
}

export interface TimeWeightingAggregateCell {
  caseId: string;
  kind: TimeWeightingCase["kind"];
  policy: TimeWeightingPolicy;
  trials: number;
  passCount: number;
}

/** `passCount` は `verdict === "pass"` のみ。`indeterminate`/`fail` はどちらも正解でない側に畳む。 */
export function aggregateTimeWeightingResults(
  results: readonly TimeWeightingTrialResult[],
): TimeWeightingAggregateCell[] {
  const cells = new Map<string, TimeWeightingAggregateCell>();
  for (const result of results) {
    for (const policy of TIME_WEIGHTING_POLICIES) {
      const key = `${result.case.id}\u0000${policy}`;
      const existing = cells.get(key);
      const passed = result.byPolicy[policy].verdict === "pass";
      if (existing === undefined) {
        cells.set(key, {
          caseId: result.case.id,
          kind: result.case.kind,
          policy,
          trials: 1,
          passCount: passed ? 1 : 0,
        });
      } else {
        existing.trials += 1;
        existing.passCount += passed ? 1 : 0;
      }
    }
  }
  return [...cells.values()];
}

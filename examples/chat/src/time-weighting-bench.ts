import type { Ctx, LLMProvider, NewMemory, Runtime } from "@mnemora/core";
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
import { drainEmbedTicks } from "./embed-drain.js";
import { buildMnemoraPrompt } from "./mnemora-path.js";
import { createMutableClock } from "./mutable-clock.js";
import type { MutableClock } from "./mutable-clock.js";
import type { CreateProvidersOptions, EnvLike, ProviderMode } from "./providers.js";
import { createProviders } from "./providers.js";
import type { TimeWeightingCase, TimeWeightingMemorySeed } from "./time-weighting-case.js";
import { assertTimeWeightingCaseWellFormed } from "./time-weighting-case.js";
import type { UsageMeter } from "./usage-meter.js";

/**
 * `answer-time-weighting` ベンチの本体（Issue #690 / PR #697）。
 *
 * 🔴 **`answer-bench.ts` と何が違うか**: あちらは `ingestConversation`（抽出 LLM を
 * 通す取り込み）を使い、取り込み直後に `recall()` するため時間項がほぼ1に張り付く
 * （`answer-bench.ts` の docstring・PR 本文参照）。このベンチは
 * (1) 記憶を抽出 LLM を通さず直接書き（明示の `recordedAt`/`occurredAt`/`validFrom`/
 * `validUntil`）、(2) 指定した時刻に `reinforce` し、(3) 壁時計（`MutableClock`）を
 * `recallAt` まで進めてから、同じ質問を `timeWeighting: "legacy"` と
 * `"eventAwareFreshness"` の両方で `recall()` する。
 *
 * ⛔ **`answer-judge.ts`（LLM 採点）は使わない。** マネージャー指示は「既存の回答生成で
 * 回答→`gradeAnswer` で正誤」——一次判定（文字列一致）だけで完結させる。理由:
 * このベンチが問うているのは「`recall()` に正しい記憶が候補として残ったか」という
 * 構造的な性質であり、`answer-case.ts` の `gradeAnswer` の docstring が要求する
 * 「答えが短く閉じる質問」という制約とも整合する。
 */

// ---------------------------------------------------------------------------
// Runtime の組み立て（`answer-bench.ts` の `createAnswerBenchRuntime` と同じ構成 +
// `MutableClock` の注入）
// ---------------------------------------------------------------------------

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
  close(): Promise<void>;
}

export async function createTimeWeightingBenchRuntime(
  databaseUrl: string,
  env: EnvLike = process.env,
  providerOptions: CreateProvidersOptions = {},
): Promise<TimeWeightingBenchRuntimeHandle> {
  const client: PostgresClient = createPostgresClient(databaseUrl);
  await runMigrations(client.pool);

  const created = createProviders(env, providerOptions);
  const llmProvider = new CountingLLMProvider(created.llmProvider);
  const embeddingProvider = new CountingEmbeddingProvider(created.embeddingProvider);
  await registerEmbeddingSpace(client.pool, embeddingProvider.space);

  const memoryStore = new PostgresMemoryStore(client.db);
  // ⭐ 初期値はどうでもよい——`runTimeWeightingCase` が各ケースの `recallAt` へ
  // `recall()` の直前に必ず `set()` する。記憶の作成・reinforce は `Clock` を読まない
  // （`NewMemory.recordedAt`/`reinforce(ctx, id, at)` はどちらも呼び出し側が渡す
  // 明示の `Date` であり、`RuntimeDeps.clock` に依らない——`mutable-clock.ts` の
  // docstring と同じ理解）。
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
    close: () => closePostgresClient(client),
  };
}

// ---------------------------------------------------------------------------
// 記憶を直接書く（抽出 LLM を通さない）
// ---------------------------------------------------------------------------

/**
 * `TimeWeightingMemorySeed` から `NewMemory` を組み立てる。`@mnemora/testkit` の
 * `buildNewMemoryFixture`（適合テストが使うのと同じひな型）を土台にし、
 * `contentHash` だけ実物の SHA-256（`sha256Hex`）へ差し替える——同一 tenant 内で
 * 異なる内容の記憶が `(tenant_id, source_observation_id, extractor_version,
 * content_hash)` の冪等キーで衝突しないようにするため（`buildNewMemoryFixture` の
 * 既定 `contentHash` は固定文字列であり、複数件を同じ tenant に書くとこの衝突を踏む）。
 *
 * `provenance` は `imported`（`buildNewMemoryFixture` の既定）のまま——`sourceObservationId`
 * が無いことと整合する（`stated`/`inferred` は実在の Observation を要求する、
 * `packages/postgres/migrations/0001_init.sql` の CHECK 制約）。「抽出 LLM を通さず
 * 直接書く」という設計そのものが imported（取り込み由来）の意味に近い。
 */
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

/**
 * ケースの記憶を直接書き、`reinforceAt` を順番に適用する。**抽出 LLM を一度も呼ばない**
 * ——`memoryStore.createMemoryWithOutbox` に `jobKinds: ["embed"]` だけを積み、
 * `drainEmbedTicks` で埋め込みだけを処理する（`ingestConversation` が `observe()` +
 * `tick()` で行うのと同じ埋め込みの配線を、抽出の段だけ飛ばして再利用する）。
 *
 * `reinforce` は `MemoryStore.reinforce(ctx, id, at)` の `at` にそのまま
 * `seed.reinforceAt` の値を渡す——`Runtime`/`Clock` を経由しない直接呼び出しなので、
 * 壁時計（`MutableClock`）を動かす必要が無い（`createTimeWeightingBenchRuntime` の
 * docstring 参照）。
 */
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
  // 🔴 **埋め込みジョブの `available_at`/`claimed_at` 比較は、DB 側の実時刻
  // （SQL の `now()`）で書かれる——`RuntimeDeps.clock`（このケースでは `MutableClock`）を
  // 読まない。一方 `runtime.tick()` の claim クエリは「いま」を `deps.clock.now()` から
  // 取る（`packages/core/src/runtime.ts`）。⟹ **`clock` を書き込み前の値（構築時点の
  // 実時刻）のまま止めておくと、ジョブ作成の実時刻のほうがわずかに後になり、
  // `available_at <= now` が常に false になって claim が1件も進まない**
  // （本 PR で実際に踏んだ——`totalProcessed` が常に0だった）。
  // ⟹ 埋め込みを処理する直前に `clock` を実時刻へ進めてから `drainEmbedTicks` を呼ぶ。
  // 呼び出し側（`runTimeWeightingCase`）がこの後で `recallAt` へ改めて `set()` する。
  clock.set(new Date());
  // 埋め込みは全件書き終えた後にまとめて処理する——`ingestConversation` と同じ順序
  // （`mnemora-path.ts` の `drainEmbedTicks` 呼び出し）。
  await drainEmbedTicks(runtime, ctx);

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

// ---------------------------------------------------------------------------
// 1ケース・1方針の実行
// ---------------------------------------------------------------------------

const ANSWER_SYSTEM_PROMPT =
  "以下に列挙した記憶だけを根拠に、簡潔に答えてください。根拠が無ければ『分かりません』と答えてください。";

function buildQuestionSuffix(question: string): string {
  return `\n\n質問: ${question}`;
}

/**
 * `runTimeWeightingPolicy` の診断専用 `recall()` が使う `scoreThreshold`
 * （段3a、マネージャー指示「recall で文脈に入った記憶を毎回記録する出力を足せ」）。
 *
 * **実際の回答生成に使う `recall()`（既定の `scoreThreshold`、`DEFAULT_SCORE_THRESHOLD`
 * = 0.1）とは別の、2回目の呼び出しにだけ使う。** 診断の目的は「ケースの各記憶が
 * スコアの上でどう並んだか」を、実際に候補から落ちたかどうかに関わらず**全件**
 * 見えるようにすることであり、極端に低い閾値を渡すことで below_threshold ゲートに
 * よる除外を実質無効化する（`__tests__/time-weighting-bench.postgres.test.ts` が
 * 同じ手法で `score.freshness` を読んでいるのと同じ考え方）。
 * ⛔ **回答生成に使う `recall()` 呼び出し自体はこの閾値を使わない**——プロンプトへ
 * 実際に積まれる記憶の集合は、この診断とは無関係に既定のまま決まる。
 */
const DIAGNOSTIC_SCORE_THRESHOLD = -1_000_000;

/**
 * 診断専用 `recall()` が返した1件の記憶の順位・スコア内訳（段3a）。
 *
 * `localId` は `TimeWeightingMemorySeed.localId`（例: `"old-seat-undated"` /
 * `"current-seat"`）——どちらが「古い予定」でどちらが「現行の予定」かは、この
 * 文字列そのものが名乗る（ケース集合の localId 命名がその説明を兼ねる。新しい
 * enum 欄は足さない）。
 */
export interface TimeWeightingContextDiagnosticEntry {
  localId: string;
  memoryId: string;
  /** 診断用 `recall()`（`DIAGNOSTIC_SCORE_THRESHOLD`）が返した順序での1始まりの順位。 */
  rank: number;
  total: number;
  freshness: number;
  decay: number;
  /** `total < DEFAULT_SCORE_THRESHOLD`——既定の閾値なら below_threshold で落ちるか。 */
  belowThreshold: boolean;
  /** `!belowThreshold` の別名。「文脈に入ったか」をそのまま読める形で持つ。 */
  enteredContext: boolean;
}

export interface TimeWeightingPolicyResult {
  policy: TimeWeightingPolicy;
  answer: string;
  verdict: AnswerVerdict;
  /** `recall().memories` の件数（何件が候補として残ったか）。 */
  recallMemoryCount: number;
  /** `recall()` が実際にプロンプトへ積んだ文字列（デバッグ・監査用）。 */
  prompt: string;
  inputChars: number;
  inputEstimatedTokens: number;
  /**
   * 段3a: このケースの記憶（`localIdByMemoryId` に載っている全件）の順位・スコア内訳。
   * 診断専用の2回目の `recall()`（`DIAGNOSTIC_SCORE_THRESHOLD`）から得る——実際の
   * 回答生成に使った `recall()`（1回目、既定の `scoreThreshold`）の結果には影響しない。
   */
  contextDiagnostics: TimeWeightingContextDiagnosticEntry[];
}

/**
 * 診断専用の2回目の `recall()` を呼び、`localIdByMemoryId` に載っている記憶それぞれの
 * 順位・スコア内訳を返す（段3a）。
 */
async function collectContextDiagnostics(
  runtime: Runtime,
  ctx: Ctx,
  question: string,
  policy: TimeWeightingPolicy,
  localIdByMemoryId: ReadonlyMap<string, string>,
): Promise<TimeWeightingContextDiagnosticEntry[]> {
  const diagnosticRecall = await runtime.recall(ctx, {
    text: question,
    timeWeighting: policy,
    scoreThreshold: DIAGNOSTIC_SCORE_THRESHOLD,
  });
  const entries: TimeWeightingContextDiagnosticEntry[] = [];
  diagnosticRecall.memories.forEach((m, index) => {
    const localId = localIdByMemoryId.get(m.memoryId);
    if (localId === undefined) {
      // このケースが直接書いた記憶ではない（連想枠等、既定では起きない経路）。
      // 診断の対象外として黙って飛ばす——診断は「このケースの記憶」だけを見る。
      return;
    }
    const belowThreshold = m.score.total < DEFAULT_SCORE_THRESHOLD;
    entries.push({
      localId,
      memoryId: m.memoryId,
      rank: index + 1,
      total: m.score.total,
      freshness: m.score.freshness,
      decay: m.score.decay,
      belowThreshold,
      enteredContext: !belowThreshold,
    });
  });
  return entries;
}

/**
 * 1ケースを1方針（`legacy` または `eventAwareFreshness`）で実行する。
 *
 * **`ctx.tenantId` はケース + trial ごとに独立**——呼び出し側（`runTimeWeightingCase`）が
 * 割り当てる。同じ tenant に対して legacy/eventAwareFreshness を続けて呼ぶのは安全
 * （`recall()` は読み取りのみで、このベンチは `reportMemoryUsage` を呼ばないため
 * `reinforce` が誘発されない——`mnemora-path.ts` の `reportMemoryUsage` docstring
 * 「これを呼ばないと reinforce が発火しない」の逆を利用している）。
 */
async function runTimeWeightingPolicy(
  runtime: Runtime,
  llmProvider: LLMProvider,
  ctx: Ctx,
  question: string,
  expected: TimeWeightingCase["expected"],
  policy: TimeWeightingPolicy,
  localIdByMemoryId: ReadonlyMap<string, string>,
): Promise<TimeWeightingPolicyResult> {
  const recall = await runtime.recall(ctx, { text: question, timeWeighting: policy });
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

// ---------------------------------------------------------------------------
// 1ケース（全方針・複数 trial）
// ---------------------------------------------------------------------------

export interface TimeWeightingTrialResult {
  case: TimeWeightingCase;
  trial: number;
  byPolicy: Record<TimeWeightingPolicy, TimeWeightingPolicyResult>;
}

/**
 * `caseId` から tenantId を作る。`answer-bench.ts` の `embeddingSpaceSlug` と同じ理由
 * （埋め込み空間ごとに tenant を分ける）に加え、**trial ごとにも分ける**——
 * 実測モード（`openai`）で trial を跨いで独立に API を呼ぶ（キャッシュしない）ことを、
 * 記憶の書き込みからやり直すことで保証する（マネージャー指示「trial ごとに実際に
 * API を呼ぶこと」）。
 */
function tenantIdFor(
  tenantPrefix: string,
  spaceSlug: string,
  caseId: string,
  trial: number,
): string {
  return `${tenantPrefix}-${spaceSlug}-${caseId}-t${trial}`;
}

/**
 * 1ケースを1 trial ぶん実行する: 記憶を直接書き → reinforce → 壁時計を `recallAt` へ
 * 進める → `legacy`/`eventAwareFreshness` それぞれで recall→回答生成→採点。
 *
 * ⚠ **2方針は同じ記憶の状態に対して呼ぶ**——`legacy` を走らせても記憶やテナントの
 * 状態は変わらない（`recall()` は読み取りのみ、`reportMemoryUsage` を呼ばない）ので、
 * 続けて `eventAwareFreshness` を呼んでも「先に legacy が動いた影響」は無い。
 */
export async function runTimeWeightingCase(
  handle: TimeWeightingBenchRuntimeHandle,
  timeWeightingCase: TimeWeightingCase,
  tenantPrefix: string,
  trial: number,
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

  // recall() の decay/freshness/decayFloor ゲートが読む「いま」をここで確定させる。
  // 記憶の作成・reinforce は明示の Date を渡すだけで Clock を読まないため、
  // このケースを通して Clock を動かすのはここ1回だけでよい。
  handle.clock.set(timeWeightingCase.recallAt);

  const byPolicy = {} as Record<TimeWeightingPolicy, TimeWeightingPolicyResult>;
  for (const policy of TIME_WEIGHTING_POLICIES) {
    byPolicy[policy] = await runTimeWeightingPolicy(
      handle.runtime,
      handle.llmProvider,
      ctx,
      timeWeightingCase.question,
      timeWeightingCase.expected,
      policy,
      localIdByMemoryId,
    );
  }

  return { case: timeWeightingCase, trial, byPolicy };
}

/**
 * 複数ケース × 複数 trial を実行する。**既定は呼び出し側の指定に委ねる**
 * （マネージャー決定: 既定1、評価は5）。
 */
export async function runTimeWeightingBench(
  handle: TimeWeightingBenchRuntimeHandle,
  cases: readonly TimeWeightingCase[],
  tenantPrefix: string,
  trials: number,
): Promise<TimeWeightingTrialResult[]> {
  if (trials < 1) {
    throw new Error(`runTimeWeightingBench: trials は1以上であること（実際: ${trials}）。`);
  }
  const results: TimeWeightingTrialResult[] = [];
  for (const timeWeightingCase of cases) {
    for (let trial = 1; trial <= trials; trial += 1) {
      results.push(await runTimeWeightingCase(handle, timeWeightingCase, tenantPrefix, trial));
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// 集計: 方針 × ケースの正答数/試行数
// ---------------------------------------------------------------------------

export interface TimeWeightingAggregateCell {
  caseId: string;
  kind: TimeWeightingCase["kind"];
  policy: TimeWeightingPolicy;
  trials: number;
  passCount: number;
}

/**
 * `TimeWeightingTrialResult[]` を「方針 × ケース」の正答数/試行数へ畳む。
 *
 * `passCount` は `verdict === "pass"` の件数のみを数える——`indeterminate`/`fail` は
 * どちらも「正しく答えられなかった」側に落ちる（`gradeAnswer` の三分割を、この集計では
 * 二値の合否へさらに畳んでいる。内訳が要る呼び出し側は `results` を直接読むこと）。
 */
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

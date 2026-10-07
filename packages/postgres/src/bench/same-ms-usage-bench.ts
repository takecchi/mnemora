#!/usr/bin/env node
/**
 * `PostgresMemoryStore.reinforce` の WHERE 句（`last_reinforced_at IS NULL OR last_reinforced_at < at`、ADR 0048）は、
 * 等しい `at` での2回目の強化を例外にせず黙って何もしない。同じミリ秒に2回の使用報告が来たとき、活動時計
 * （`decay_clock = 'activity'`）側で `activity_seq` をどれだけ取り逃がすかを実測する手動ベンチ。テストではなく、CI には乗らない。
 *
 * 強化の口（`reinforce`・`reinforceMany`・`recordUsageAndReinforce`）だけ、引数と返り値を記録するためにインスタンス単位で
 * 差し替える（`installReinforceSpy`）。挙動・公開 API・既定値は変えない。
 *
 * 実行: `DATABASE_URL` が本物の Postgres + pgvector を指している状態で `pnpm --filter @mnemora/postgres run bench:same-ms-usage`。
 * 試行回数は環境変数で調整できる（`DEFAULT_TRIALS`）。
 *
 * 結論の限界: 並行だと `at` の一致は起きるが、活動時計の `nowSeq` の取り逃がしは自然な同時実行では観測されなかった。
 * 一方、`at` と `nowSeq` の順序を意図的に逆にすると必ず no-op になり差が失われる（機構としての害は実在する）。
 * 「自然には起きなかった」を「起こりえない」と読み替えないこと。複数プロセス・ネットワーク越しの DB・イベントループが
 * 詰まる環境は確かめていない。
 *
 * 簡略化: シナリオ (a)/(b)/(e)/(f) は ANN 経路を通さず `createRecall` を直接呼ぶ（`handleMemoryUsage` が触るのは
 * `recalls.id` への外部キーだけ。両経路の差は実測していない）。(c)/(d) は `runtime.recall()` を通し、固定ベクトルで毎回同じ Memory を返す。
 */

import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import type { Ctx, EmbeddingProvider, EmbeddingSpaceId, LLMProvider, Memory } from "@mnemora/core";
import { createRuntime, DEFAULT_HALF_LIFE_RECALLS } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { createPostgresClient, type PostgresClient } from "../client.js";
import { runMigrations } from "../migrate.js";
import { registerEmbeddingSpace } from "../vector-space.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import { installReinforceSpy, type ReinforceCallLog } from "./reinforce-spy.js";

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL が設定されていません。本物の Postgres + pgvector を指す接続文字列を" +
        "設定してから実行すること（擬似物では代替しない）。AGENTS.md「手元で Postgres を" +
        "立てる」参照。",
    );
  }
  return url;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`不正な ${name}: "${raw}"（正の整数で指定すること）`);
  }
  return n;
}

const DEFAULT_TRIALS = {
  clockSamples: envInt("BENCH_CLOCK_SAMPLES", 3_000_000),
  recordUsageDedupSameRecall: envInt("BENCH_TRIALS_A", 200),
  recordUsageDedupDuplicateId: envInt("BENCH_TRIALS_B", 200),
  sequentialTight: envInt("BENCH_TRIALS_C_TIGHT", 300),
  sequentialWithLlmGap: envInt("BENCH_TRIALS_C_GAP", 50),
  concurrentTrialsPerN: envInt("BENCH_TRIALS_D", 30),
  concurrentNs: (process.env.BENCH_CONCURRENT_NS ?? "2,8,32")
    .split(",")
    .map((s) => Number(s.trim())),
  restoreOverlap: envInt("BENCH_TRIALS_E", 100),
  forcedReverseCommit: envInt("BENCH_TRIALS_F", 50),
};

const BENCH_EMBEDDING_SPACE: EmbeddingSpaceId = {
  provider: "bench-730",
  model: "fixed-vector",
  dimensions: 3,
};
const FIXED_VECTOR = [1, 0, 0];
const LLM_GAP_MS = envInt("BENCH_LLM_GAP_MS", 300);

function throwingLlm(): LLMProvider {
  return {
    complete: async () => {
      throw new Error("same-ms-usage-bench: LLM は使わない");
    },
    completeStructured: async () => {
      throw new Error("same-ms-usage-bench: LLM は使わない");
    },
  };
}

function throwingEmbeddingProvider(space: EmbeddingSpaceId): EmbeddingProvider {
  return {
    space,
    embed: async () => {
      throw new Error(
        "same-ms-usage-bench: embeddingProvider は使わない（recall には vector を直接渡す）",
      );
    },
  };
}

function dummyOutboxStore() {
  return {
    claimBatch: async () => [],
    complete: async () => {},
    fail: async () => {},
  };
}

function dummyEventStore() {
  return {
    append: async (_ctx: Ctx, e: { kind: string; at?: Date }) => ({
      id: randomUUID(),
      ...e,
      at: e.at ?? new Date(),
    }),
    get: async () => null,
    list: async () => [],
  };
}

interface Rig {
  memoryStore: PostgresMemoryStore;
  vectorStore: PostgresVectorStore;
  tenantSettingsStore: PostgresTenantSettingsStore;
  runtime: ReturnType<typeof createRuntime>;
  reinforceSpy: { setLog: (log: ReinforceCallLog[] | null) => void };
}

function buildRig(client: PostgresClient): Rig {
  const memoryStore = new PostgresMemoryStore(client.db);
  const vectorStore = new PostgresVectorStore(client.db);
  const tenantSettingsStore = new PostgresTenantSettingsStore(client.db);
  // `memoryStore.reinforce` は1回だけ差し替える（`installReinforceSpy`）。`createRuntime` には差し替え後のインスタンスを渡す。
  const reinforceSpy = installReinforceSpy(memoryStore);
  const runtime = createRuntime({
    memoryStore,
    outboxStore: dummyOutboxStore(),
    vectorStore,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    eventStore: dummyEventStore() as any,
    tenantSettingsStore,
    llmProvider: throwingLlm(),
    embeddingProvider: throwingEmbeddingProvider(BENCH_EMBEDDING_SPACE),
    hashContent: (content: string) => `sha256(${content})`,
    // clock は省略して実時計（ミリ秒分解能）を使う。このベンチが測るのは本物の壁時計の下で起きることで、偽の時計を注入すると測る対象が消える。
  });
  return { memoryStore, vectorStore, tenantSettingsStore, runtime, reinforceSpy };
}

function freshCtx(): Ctx {
  return { tenantId: `bench-730-${randomUUID()}` };
}

/** `PostgresMemoryStore.createRecall` を直接呼んで、最小限の recall 行を1件作る。 */
async function seedRecall(
  memoryStore: PostgresMemoryStore,
  ctx: Ctx,
  memoryIds: string[],
  opts: { advanceActivityClock?: boolean } = {},
): Promise<string> {
  return memoryStore.createRecall(ctx, {
    tenantId: ctx.tenantId,
    subjectId: null,
    query: { text: "bench-730" },
    budget: null,
    omitted: [],
    usage: {
      chars: 0,
      estimatedTokens: 0,
      counter: "heuristic",
      byTier: { full: 0, digest: 0, index: 0 },
      indexChars: 0,
    },
    indexBand: { groups: [], totalInScope: 0, countKind: "exact" },
    explain: { stages: [] },
    returnedMemories: memoryIds.map((memoryId) => ({
      memoryId,
      score: { decay: 1, tagMatch: 0, freshness: 1, strength: 1, total: 1 },
      retrievedVia: "ann" as const,
    })),
    advanceActivityClock: opts.advanceActivityClock ?? false,
  });
}

async function createPlainMemory(
  memoryStore: PostgresMemoryStore,
  ctx: Ctx,
  overrides: Parameters<typeof buildNewMemoryFixture>[0] = {},
): Promise<Memory> {
  return memoryStore.createMemory(
    ctx,
    buildNewMemoryFixture({ tenantId: ctx.tenantId, ...overrides }),
  );
}

async function createEmbeddedMemory(
  memoryStore: PostgresMemoryStore,
  vectorStore: PostgresVectorStore,
  ctx: Ctx,
  overrides: Parameters<typeof buildNewMemoryFixture>[0] = {},
): Promise<Memory> {
  const memory = await createPlainMemory(memoryStore, ctx, {
    embeddingStatus: "ready",
    ...overrides,
  });
  await vectorStore.upsert(ctx, BENCH_EMBEDDING_SPACE, memory.id, FIXED_VECTOR);
  return memory;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ClockResolutionResult {
  node: string;
  dateNow: {
    samples: number;
    distinctValues: number;
    sameAsPreviousRate: number;
    elapsedMs: number;
    avgCallsPerMs: number;
  };
  performanceNow: {
    samples: number;
    distinctValues: number;
    minObservedPositiveDiffMs: number;
  };
}

function measureClockResolution(samples: number): ClockResolutionResult {
  let dnSameCount = 0;
  let dnDistinct = 1;
  let dnPrev = Date.now();
  const dnStart = performance.now();
  for (let i = 1; i < samples; i += 1) {
    const v = Date.now();
    if (v === dnPrev) {
      dnSameCount += 1;
    } else {
      dnDistinct += 1;
      dnPrev = v;
    }
  }
  const dnElapsedMs = performance.now() - dnStart;

  let pnDistinct = 1;
  let pnPrev = performance.now();
  let minDiff = Number.POSITIVE_INFINITY;
  for (let i = 1; i < samples; i += 1) {
    const v = performance.now();
    if (v !== pnPrev) {
      const diff = v - pnPrev;
      if (diff > 0 && diff < minDiff) minDiff = diff;
      pnDistinct += 1;
      pnPrev = v;
    }
  }

  return {
    node: process.version,
    dateNow: {
      samples,
      distinctValues: dnDistinct,
      sameAsPreviousRate: dnSameCount / (samples - 1),
      elapsedMs: dnElapsedMs,
      avgCallsPerMs: samples / dnElapsedMs,
    },
    performanceNow: {
      samples,
      distinctValues: pnDistinct,
      minObservedPositiveDiffMs: minDiff,
    },
  };
}

interface DedupResult {
  trials: number;
  firstCallInsertedCount: number[];
  secondCallInsertedCounts: number[];
  allSecondCallsEmpty: boolean;
  reinforceCallsForSecondReport: number;
}

async function scenarioSameRecallReportedTwice(rig: Rig, trials: number): Promise<DedupResult> {
  const secondCallInsertedCounts: number[] = [];
  const firstCallInsertedCount: number[] = [];
  let reinforceCallsForSecondReport = 0;

  for (let i = 0; i < trials; i += 1) {
    const ctx = freshCtx();
    const memory = await createPlainMemory(rig.memoryStore, ctx);
    const recallId = await seedRecall(rig.memoryStore, ctx, [memory.id]);

    const log: ReinforceCallLog[] = [];
    rig.reinforceSpy.setLog(log);

    const first = await rig.runtime.observe(ctx, {
      kind: "memory_usage",
      recallId,
      usedMemoryIds: [memory.id],
    });
    firstCallInsertedCount.push(first.memoryIds.length);
    const logAfterFirst = log.length;

    const second = await rig.runtime.observe(ctx, {
      kind: "memory_usage",
      recallId,
      usedMemoryIds: [memory.id],
    });
    secondCallInsertedCounts.push(second.memoryIds.length);
    reinforceCallsForSecondReport += log.length - logAfterFirst;
  }

  return {
    trials,
    firstCallInsertedCount,
    secondCallInsertedCounts,
    allSecondCallsEmpty: secondCallInsertedCounts.every((n) => n === 0),
    reinforceCallsForSecondReport,
  };
}

async function scenarioDuplicateIdInSingleReport(rig: Rig, trials: number): Promise<DedupResult> {
  const secondCallInsertedCounts: number[] = [];
  const firstCallInsertedCount: number[] = [];

  for (let i = 0; i < trials; i += 1) {
    const ctx = freshCtx();
    const memory = await createPlainMemory(rig.memoryStore, ctx);
    const recallId = await seedRecall(rig.memoryStore, ctx, [memory.id]);

    const result = await rig.runtime.observe(ctx, {
      kind: "memory_usage",
      recallId,
      usedMemoryIds: [memory.id, memory.id, memory.id],
    });
    firstCallInsertedCount.push(result.memoryIds.length);
    secondCallInsertedCounts.push(0); // このシナリオに「2回目」は無い。形を揃えるためのダミー。
  }

  return {
    trials,
    firstCallInsertedCount,
    secondCallInsertedCounts,
    allSecondCallsEmpty: firstCallInsertedCount.every((n) => n === 1),
    reinforceCallsForSecondReport: 0,
  };
}

interface CollisionTrialOutcome {
  memoryId: string;
  calls: ReinforceCallLog[];
  finalLastReinforcedAtMs: number | null;
  finalDecayBaseSeq: number | null;
}

/**
 * `calls`（同じ Memory に対する `reinforce` 呼び出しの列）を集計する。`at` が一致するペアの数と、害（活動時計の seq を
 * 実際に取り逃がしたか）を分けて数える。害は呼び出し単位で判定し、その呼び出しの `nowSeq` が最終的に残った
 * `decay_base_seq` より大きいのに反映されていない場合だけを数える。`at` も `nowSeq` も単調に増える通常経路で古い呼び出しが
 * 負けるのは害ではなく、`at` の順序と `nowSeq` の順序が食い違ったときだけが害になる。
 */
interface CollisionStats {
  memoriesObserved: number;
  totalReinforceCalls: number;
  equalAtPairs: number;
  totalPairs: number;
  differingAtPairs: number;
  // 取り逃がした seq の差（nowSeq - 実際に残った decay_base_seq）。`at` が最終値と一致した、同着で負けた側の損失。
  lostSeqDeltasAtTie: number[];
  // `at` が一致しなかった側（古い at が新しい at に追い越された、逆順コミット）の損失。
  lostSeqDeltasReverseOrder: number[];
}

function analyzeCollisions(outcomes: CollisionTrialOutcome[]): CollisionStats {
  let equalAtPairs = 0;
  let totalPairs = 0;
  let differingAtPairs = 0;
  const lostSeqDeltasAtTie: number[] = [];
  const lostSeqDeltasReverseOrder: number[] = [];
  let totalReinforceCalls = 0;

  for (const outcome of outcomes) {
    totalReinforceCalls += outcome.calls.length;
    const final = outcome.finalLastReinforcedAtMs;
    const finalSeq = outcome.finalDecayBaseSeq;

    for (let i = 0; i < outcome.calls.length; i += 1) {
      for (let j = i + 1; j < outcome.calls.length; j += 1) {
        totalPairs += 1;
        const atA = outcome.calls[i]!.at.getTime();
        const atB = outcome.calls[j]!.at.getTime();
        if (atA === atB) {
          equalAtPairs += 1;
        } else {
          differingAtPairs += 1;
        }
      }
    }

    if (final === null || finalSeq === null) continue;
    for (const call of outcome.calls) {
      if (call.nowSeq === undefined) continue;
      const delta = call.nowSeq - finalSeq;
      if (delta <= 0) continue; // 最終値のほうが進んでいる、または同じ——取り逃がしていない。
      if (call.at.getTime() === final) {
        lostSeqDeltasAtTie.push(delta);
      } else {
        lostSeqDeltasReverseOrder.push(delta);
      }
    }
  }

  return {
    memoriesObserved: outcomes.length,
    totalReinforceCalls,
    equalAtPairs,
    totalPairs,
    differingAtPairs,
    lostSeqDeltasAtTie,
    lostSeqDeltasReverseOrder,
  };
}

async function readFinalState(
  memoryStore: PostgresMemoryStore,
  ctx: Ctx,
  memoryId: string,
): Promise<{ finalLastReinforcedAtMs: number | null; finalDecayBaseSeq: number | null }> {
  const memory = await memoryStore.get(ctx, memoryId);
  return {
    finalLastReinforcedAtMs: memory?.lastReinforcedAt?.getTime() ?? null,
    finalDecayBaseSeq: memory?.decayBaseSeq ?? null,
  };
}

async function scenarioSequential(
  rig: Rig,
  trials: number,
  opts: { gapMs: number; activityClock: boolean },
): Promise<CollisionStats> {
  const outcomes: CollisionTrialOutcome[] = [];

  for (let i = 0; i < trials; i += 1) {
    const ctx = freshCtx();
    if (opts.activityClock) {
      await rig.tenantSettingsStore.setDecayClock(ctx, "activity");
    }
    const memory = await createEmbeddedMemory(rig.memoryStore, rig.vectorStore, ctx, {
      halfLifeRecalls: opts.activityClock ? DEFAULT_HALF_LIFE_RECALLS : undefined,
    });

    const log: ReinforceCallLog[] = [];
    rig.reinforceSpy.setLog(log);

    const recall1 = await rig.runtime.recall(ctx, { vector: FIXED_VECTOR, limit: 1 });
    await rig.runtime.observe(ctx, {
      kind: "memory_usage",
      recallId: recall1.recallId,
      usedMemoryIds: [memory.id],
    });

    if (opts.gapMs > 0) {
      await sleep(opts.gapMs);
    }

    const recall2 = await rig.runtime.recall(ctx, { vector: FIXED_VECTOR, limit: 1 });
    await rig.runtime.observe(ctx, {
      kind: "memory_usage",
      recallId: recall2.recallId,
      usedMemoryIds: [memory.id],
    });

    const final = await readFinalState(rig.memoryStore, ctx, memory.id);
    outcomes.push({ memoryId: memory.id, calls: log, ...final });
  }

  return analyzeCollisions(outcomes);
}

async function scenarioConcurrent(rig: Rig, n: number, trials: number): Promise<CollisionStats> {
  const outcomes: CollisionTrialOutcome[] = [];

  for (let t = 0; t < trials; t += 1) {
    const ctx = freshCtx();
    await rig.tenantSettingsStore.setDecayClock(ctx, "activity");
    const memory = await createEmbeddedMemory(rig.memoryStore, rig.vectorStore, ctx, {
      halfLifeRecalls: DEFAULT_HALF_LIFE_RECALLS,
    });

    const log: ReinforceCallLog[] = [];
    rig.reinforceSpy.setLog(log);

    await Promise.all(
      Array.from({ length: n }, async () => {
        const recall = await rig.runtime.recall(ctx, { vector: FIXED_VECTOR, limit: 1 });
        await rig.runtime.observe(ctx, {
          kind: "memory_usage",
          recallId: recall.recallId,
          usedMemoryIds: [memory.id],
        });
      }),
    );

    const final = await readFinalState(rig.memoryStore, ctx, memory.id);
    outcomes.push({ memoryId: memory.id, calls: log, ...final });
  }

  return analyzeCollisions(outcomes);
}

async function scenarioRestoreOverlap(rig: Rig, trials: number): Promise<CollisionStats> {
  const outcomes: CollisionTrialOutcome[] = [];

  for (let i = 0; i < trials; i += 1) {
    const ctx = freshCtx();
    await rig.tenantSettingsStore.setDecayClock(ctx, "activity");
    const memory = await createPlainMemory(rig.memoryStore, ctx, {
      status: "archived",
      halfLifeRecalls: DEFAULT_HALF_LIFE_RECALLS,
    });
    const recallId = await seedRecall(rig.memoryStore, ctx, [memory.id]);

    const log: ReinforceCallLog[] = [];
    rig.reinforceSpy.setLog(log);

    await Promise.all([
      rig.runtime.restoreArchived(ctx, { memoryId: memory.id }),
      rig.runtime.observe(ctx, {
        kind: "memory_usage",
        recallId,
        usedMemoryIds: [memory.id],
      }),
    ]);

    const final = await readFinalState(rig.memoryStore, ctx, memory.id);
    outcomes.push({ memoryId: memory.id, calls: log, ...final });
  }

  return analyzeCollisions(outcomes);
}

interface ForcedReverseCommitResult {
  trials: number;
  oldAtAlwaysNoOp: boolean;
  seqLossWhenOldAtHadLargerSeq: number[];
}

async function scenarioForcedReverseCommit(
  rig: Rig,
  trials: number,
): Promise<ForcedReverseCommitResult> {
  const seqLossWhenOldAtHadLargerSeq: number[] = [];
  let oldAtAlwaysNoOp = true;

  for (let i = 0; i < trials; i += 1) {
    const ctx = freshCtx();
    await rig.tenantSettingsStore.setDecayClock(ctx, "activity");
    const memory = await createPlainMemory(rig.memoryStore, ctx, {
      halfLifeRecalls: DEFAULT_HALF_LIFE_RECALLS,
    });

    const oldAt = new Date(memory.recordedAt.getTime() + 1000 * 60 * 60);
    const newAt = new Date(memory.recordedAt.getTime() + 1000 * 60 * 60 * 2);
    // 「A（古い at・大きい nowSeq）が、B（新しい at・小さい nowSeq）より後にコミットされる」という、活動時計にとって最悪の組み合わせを
    // 意図的に作る。並行下で seq の進み方と at の発行順が一致する保証は無い（別のクロックである）。
    const oldAtLargerSeq = 500;
    const newAtSmallerSeq = 100;

    await rig.memoryStore.reinforce(ctx, memory.id, newAt, { nowSeq: newAtSmallerSeq });
    const result = await rig.memoryStore.reinforce(ctx, memory.id, oldAt, {
      nowSeq: oldAtLargerSeq,
    });

    if (result.lastReinforcedAt?.getTime() !== newAt.getTime()) {
      oldAtAlwaysNoOp = false;
    }
    if ((result.decayBaseSeq ?? null) !== newAtSmallerSeq) {
      oldAtAlwaysNoOp = false;
    }
    seqLossWhenOldAtHadLargerSeq.push(oldAtLargerSeq - newAtSmallerSeq);
  }

  return { trials, oldAtAlwaysNoOp, seqLossWhenOldAtHadLargerSeq };
}

function estimateDecayImpact(lostSeqDeltas: number[]): {
  count: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p95: number;
  strengthRatioAtP50: number;
  strengthRatioAtP95: number;
  strengthRatioAtMax: number;
} | null {
  if (lostSeqDeltas.length === 0) return null;
  const sorted = [...lostSeqDeltas].sort((a, b) => a - b);
  const pick = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  const strengthRatio = (delta: number) => 0.5 ** (delta / DEFAULT_HALF_LIFE_RECALLS) - 1;
  return {
    count: sorted.length,
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    mean,
    p50: pick(0.5),
    p95: pick(0.95),
    strengthRatioAtP50: strengthRatio(pick(0.5)),
    strengthRatioAtP95: strengthRatio(pick(0.95)),
    strengthRatioAtMax: strengthRatio(sorted[sorted.length - 1]!),
  };
}

function printImpact(label: string, stats: CollisionStats): void {
  const atTie = estimateDecayImpact(stats.lostSeqDeltasAtTie);
  const reverseOrder = estimateDecayImpact(stats.lostSeqDeltasReverseOrder);
  console.log(
    `害の見積もり（${label}）: at一致による損失=${JSON.stringify(atTie)} / 逆順コミットによる損失=${JSON.stringify(reverseOrder)}`,
  );
}

async function main(): Promise<void> {
  const databaseUrl = requireDatabaseUrl();
  console.log(`# Issue #730 same-ms usage bench`);
  console.log(
    `node: ${process.version}, cpus: ${await import("node:os").then((os) => os.cpus().length)}`,
  );
  console.log("");

  console.log("## 1. 時計の分解能（DB 不要）");
  const clockResult = measureClockResolution(DEFAULT_TRIALS.clockSamples);
  console.log(JSON.stringify(clockResult, null, 2));
  console.log("");

  const client = createPostgresClient(databaseUrl);
  try {
    await runMigrations(client.pool);
    await registerEmbeddingSpace(client.pool, BENCH_EMBEDDING_SPACE);
    const rig = buildRig(client);

    console.log(
      `## 2a. 同じ recall を2回報告（${DEFAULT_TRIALS.recordUsageDedupSameRecall} 試行）`,
    );
    const a = await scenarioSameRecallReportedTwice(rig, DEFAULT_TRIALS.recordUsageDedupSameRecall);
    console.log(
      JSON.stringify(
        {
          trials: a.trials,
          allSecondCallsEmpty: a.allSecondCallsEmpty,
          reinforceCallsForSecondReport: a.reinforceCallsForSecondReport,
        },
        null,
        2,
      ),
    );
    console.log("");

    console.log(
      `## 2b. 1回の報告で usedMemoryIds に同じ id が3回重複（${DEFAULT_TRIALS.recordUsageDedupDuplicateId} 試行）`,
    );
    const b = await scenarioDuplicateIdInSingleReport(
      rig,
      DEFAULT_TRIALS.recordUsageDedupDuplicateId,
    );
    console.log(
      JSON.stringify(
        {
          trials: b.trials,
          allFirstCallsInsertedExactlyOne: b.allSecondCallsEmpty,
        },
        null,
        2,
      ),
    );
    console.log("");

    console.log(
      `## 2c-tight. 逐次・LLM 呼び出しなしの最悪条件（wall のみ、${DEFAULT_TRIALS.sequentialTight} 試行）`,
    );
    const cTightWall = await scenarioSequential(rig, DEFAULT_TRIALS.sequentialTight, {
      gapMs: 0,
      activityClock: false,
    });
    console.log(JSON.stringify(cTightWall, null, 2));
    console.log("");

    console.log(
      `## 2c-tight-activity. 逐次・LLM 呼び出しなしの最悪条件（活動時計、${DEFAULT_TRIALS.sequentialTight} 試行）`,
    );
    const cTightActivity = await scenarioSequential(rig, DEFAULT_TRIALS.sequentialTight, {
      gapMs: 0,
      activityClock: true,
    });
    console.log(JSON.stringify(cTightActivity, null, 2));
    printImpact("2c-tight-activity", cTightActivity);
    console.log("");

    console.log(
      `## 2c-gap. 逐次・LLM 相当の遅延あり（${LLM_GAP_MS}ms、活動時計、${DEFAULT_TRIALS.sequentialWithLlmGap} 試行）`,
    );
    const cGap = await scenarioSequential(rig, DEFAULT_TRIALS.sequentialWithLlmGap, {
      gapMs: LLM_GAP_MS,
      activityClock: true,
    });
    console.log(JSON.stringify(cGap, null, 2));
    printImpact("2c-gap", cGap);
    console.log("");

    for (const n of DEFAULT_TRIALS.concurrentNs) {
      console.log(`## 2d. 並行 N=${n}（活動時計、${DEFAULT_TRIALS.concurrentTrialsPerN} 試行）`);
      const d = await scenarioConcurrent(rig, n, DEFAULT_TRIALS.concurrentTrialsPerN);
      console.log(JSON.stringify(d, null, 2));
      printImpact(`2d N=${n}`, d);
      console.log("");
    }

    console.log(
      `## 2e. restoreArchived と使用報告の重なり（活動時計、${DEFAULT_TRIALS.restoreOverlap} 試行）`,
    );
    const e = await scenarioRestoreOverlap(rig, DEFAULT_TRIALS.restoreOverlap);
    console.log(JSON.stringify(e, null, 2));
    printImpact("2e", e);
    console.log("");

    console.log(`## 2f. 強制的な逆順コミットの実演（${DEFAULT_TRIALS.forcedReverseCommit} 試行）`);
    const f = await scenarioForcedReverseCommit(rig, DEFAULT_TRIALS.forcedReverseCommit);
    console.log(
      JSON.stringify(
        {
          trials: f.trials,
          oldAtAlwaysNoOp: f.oldAtAlwaysNoOp,
          seqLossWhenOldAtHadLargerSeq: {
            count: f.seqLossWhenOldAtHadLargerSeq.length,
            allPositive: f.seqLossWhenOldAtHadLargerSeq.every((d) => d > 0),
            sample: f.seqLossWhenOldAtHadLargerSeq.slice(0, 5),
          },
        },
        null,
        2,
      ),
    );
    console.log("");
  } finally {
    await client.pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

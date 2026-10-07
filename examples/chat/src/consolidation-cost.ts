import type {
  Ctx,
  EmbeddingProvider,
  Memory,
  MemoryStore,
  RecallAssociationQuery,
  Runtime,
} from "@mnemora/core";
import type { PostgresClient } from "@mnemora/postgres";
import {
  buildConsolidationCostRunJson,
  buildConsolidationMeanJson,
  buildConsolidationProbeJson,
  buildConsolidationStoreJson,
  describeThrownError,
  emptyOutcomeCounts,
} from "./consolidation-json.js";
import type {
  ConsolidationAbortJson,
  ConsolidationCostRunJson,
  ConsolidationEmbeddingSpaceJson,
  ConsolidationOutcomeCountsJson,
  ConsolidationRecallBudgetRungJson,
  ConsolidationRecallProbeJson,
  ConsolidationRecallUnbudgetedJson,
  ConsolidationRoundConsolidationJson,
  ConsolidationRoundJson,
  ConsolidationStopReason,
  RawProbeMeasurement,
} from "./consolidation-json.js";
import { splitIntoConsolidationGroups } from "./consolidation-group.js";
import { drainEmbedTicks } from "./embed-drain.js";
import { lookupLatestEmbedFailureKind } from "./embed-failure-kind.js";
import {
  DEFAULT_HAYSTACK_SIZE,
  PROBES,
  buildProbeSetConversation,
  goldExternalId,
} from "./probe-set.js";
import type { ProbeUtterance } from "./probe-set.js";
import type { ProviderMode } from "./providers.js";
import { resolveExternalId } from "./provenance-trace.js";

/**
 * `consolidation-cost` サブコマンドのうち、DB/LLM/embedding を要求する側。
 * JSON の組み立て（型・平均・群分けの純関数）は `./consolidation-json.js` に委ね、ここは「何を読むか」「いつ呼ぶか」だけを持つ。
 */

const MAX_ROUNDS = 3;

export interface RunConsolidationCostOptions {
  runtime: Runtime;
  memoryStore: MemoryStore;
  embeddingProvider: EmbeddingProvider;
  pool: PostgresClient["pool"];
  llmMode: ProviderMode;
  embeddingMode: ProviderMode;
  tenantId: string;
  groupSize: number;
  budgetLadder: readonly number[];
  recallLimit: number;
  measuredAt: Date;
  commit: string | null;
  haystackSize?: number;
  /**
   * `recall()` に渡す `association`（測定専用オプション）。省略時は `null`。
   * この bench の基準線を変えないため。明示するのは `bench/association-default-on-measure.ts` だけ。
   */
  association?: RecallAssociationQuery | null;
}

interface StoreSnapshot {
  activeIds: string[];
  json: ConsolidationRoundJson["store"];
}

export async function measureStore(
  memoryStore: MemoryStore,
  ctx: Ctx,
  allIds: readonly string[],
): Promise<StoreSnapshot> {
  const memories = await memoryStore.getMany(ctx, [...allIds]);
  const byStatus = new Map<string, Memory[]>();
  for (const memory of memories) {
    const bucket = byStatus.get(memory.status) ?? [];
    bucket.push(memory);
    byStatus.set(memory.status, bucket);
  }
  const active = byStatus.get("active") ?? [];
  const superseded = byStatus.get("superseded") ?? [];
  // この bench は `forget`/`archive`/`contest` を呼ばないので、active/superseded 以外の status は現れない想定。
  // 現れた場合は `allContentChars` にだけ含め（隠さない）、内訳には計上しない。
  const allContentChars = memories.reduce((sum, m) => sum + m.content.length, 0);
  return {
    activeIds: active.map((m) => m.id),
    json: buildConsolidationStoreJson({
      activeContentsAndDigests: active.map((m) => ({ content: m.content, digest: m.digest })),
      supersededCount: superseded.length,
      allContentChars,
    }),
  };
}

interface RecallMeasurement {
  unbudgeted: ConsolidationRecallUnbudgetedJson;
  budgeted: ConsolidationRecallBudgetRungJson[];
}

async function measureProbe(
  runtime: Runtime,
  memoryStore: MemoryStore,
  ctx: Ctx,
  probeId: string,
  query: string,
  budget: { maxMemoryTokens: number } | undefined,
  limit: number | undefined,
  association: RecallAssociationQuery | null = null,
): Promise<RawProbeMeasurement> {
  const result = await runtime.recall(
    ctx,
    budget !== undefined
      ? { text: query, limit, budget, association }
      : { text: query, association },
  );
  const resolvedExternalIds = await Promise.all(
    result.memories.map((m) => resolveExternalId(memoryStore, ctx, m.memoryId)),
  );
  const goldIndex = resolvedExternalIds.indexOf(goldExternalId(probeId));
  const goldRank = goldIndex === -1 ? null : goldIndex + 1;
  return {
    probeId,
    memoryDigests: result.memories.map((m) => m.digest),
    goldRank,
    totalInScope: result.index.totalInScope,
    omittedKinds: result.omitted.map((o) => o.kind),
    usageChars: result.usage.chars,
    usageEstimatedTokens: result.usage.estimatedTokens,
    usageIndexChars: result.usage.indexChars,
    budgetExceeded: result.usage.budgetExceeded ?? false,
  };
}

export async function measureRecallForRound(
  runtime: Runtime,
  memoryStore: MemoryStore,
  ctx: Ctx,
  activeCount: number,
  budgetLadder: readonly number[],
  recallLimit: number,
  association: RecallAssociationQuery | null = null,
): Promise<RecallMeasurement> {
  const unbudgetedRaw = await Promise.all(
    PROBES.map((probe) =>
      measureProbe(
        runtime,
        memoryStore,
        ctx,
        probe.id,
        probe.query,
        undefined,
        undefined,
        association,
      ),
    ),
  );
  const unbudgetedProbes: ConsolidationRecallProbeJson[] = unbudgetedRaw.map((raw) =>
    buildConsolidationProbeJson(raw, activeCount),
  );

  const budgeted: ConsolidationRecallBudgetRungJson[] = [];
  for (const budgetTokens of budgetLadder) {
    const rungRaw = await Promise.all(
      PROBES.map((probe) =>
        measureProbe(
          runtime,
          memoryStore,
          ctx,
          probe.id,
          probe.query,
          { maxMemoryTokens: budgetTokens },
          recallLimit,
          association,
        ),
      ),
    );
    const rungProbes = rungRaw.map((raw) => buildConsolidationProbeJson(raw, activeCount));
    budgeted.push({
      budgetTokens,
      probes: rungProbes,
      mean: buildConsolidationMeanJson(rungProbes),
    });
  }

  return {
    unbudgeted: { probes: unbudgetedProbes, mean: buildConsolidationMeanJson(unbudgetedProbes) },
    budgeted,
  };
}

function bucketEmbeddingStatus(status: Memory["embeddingStatus"]): "ok" | "pending" | "failed" {
  switch (status) {
    case "ready":
      return "ok";
    case "pending":
      return "pending";
    case "failed":
      return "failed";
    case "skipped":
      // この経路では起きない（embed ジョブが "skipped" を書く分岐は `packages/core` に無い）。観測されたら見失わないよう failed 側へ丸める。
      return "failed";
    default: {
      const exhaustive: never = status;
      throw new Error(`bucketEmbeddingStatus: 未知の embeddingStatus: ${String(exhaustive)}`);
    }
  }
}

export async function measureNewMemoriesEmbedding(
  memoryStore: MemoryStore,
  pool: PostgresClient["pool"],
  ctx: Ctx,
  newMemoryIds: readonly string[],
): Promise<{
  embeddingStatus: { ok: number; pending: number; failed: number };
  embeddingFailureKinds: string[];
}> {
  const memories = await memoryStore.getMany(ctx, [...newMemoryIds]);
  const counts = { ok: 0, pending: 0, failed: 0 };
  const failureKinds = new Set<string>();
  for (const memory of memories) {
    const bucket = bucketEmbeddingStatus(memory.embeddingStatus);
    counts[bucket] += 1;
    if (bucket === "failed") {
      const kind = await lookupLatestEmbedFailureKind(pool, ctx.tenantId, memory.id);
      failureKinds.add(kind ?? "unknown");
    }
  }
  return { embeddingStatus: counts, embeddingFailureKinds: [...failureKinds].sort() };
}

/**
 * 常に `status: "measured"` を返す。重み取得の失敗はこの関数に来る前に `cli.ts` の `warmupLocalEmbedding` で打ち切られる。
 */
export async function runConsolidationCost(
  options: RunConsolidationCostOptions,
): Promise<Extract<ConsolidationCostRunJson, { status: "measured" }>> {
  const ctx: Ctx = { tenantId: options.tenantId };
  const haystackSize = options.haystackSize ?? DEFAULT_HAYSTACK_SIZE;
  const utterances: ProbeUtterance[] = buildProbeSetConversation(haystackSize);

  const allIds: string[] = [];
  const fillerIds: string[] = [];
  for (const utterance of utterances) {
    const observed = await options.runtime.observe(ctx, {
      kind: "utterance",
      text: utterance.text,
      externalId: utterance.externalId,
    });
    allIds.push(...observed.memoryIds);
    if (utterance.kind === "haystack") {
      fillerIds.push(...observed.memoryIds);
    }
  }
  // `allIds` を `drainEmbedTicks` に渡し、available_at との競合で claim 0件のまま黙って抜けないことを検査させる。
  await drainEmbedTicks(options.runtime, ctx, { expectedProcessed: allIds.length });

  const embeddingSpace: ConsolidationEmbeddingSpaceJson = { ...options.embeddingProvider.space };

  const rounds: ConsolidationRoundJson[] = [];

  const round0Store = await measureStore(options.memoryStore, ctx, allIds);
  const round0Recall = await measureRecallForRound(
    options.runtime,
    options.memoryStore,
    ctx,
    round0Store.json.activeCount,
    options.budgetLadder,
    options.recallLimit,
    options.association,
  );
  rounds.push({ round: 0, consolidation: null, store: round0Store.json, recall: round0Recall });

  let candidatePool = [...fillerIds];
  let stoppedAfterRound = 0;
  let stopReason: ConsolidationStopReason = "completed_all_rounds";
  let abort: ConsolidationAbortJson | null = null;

  for (let round = 1; round <= MAX_ROUNDS; round += 1) {
    if (candidatePool.length < 2) {
      stopReason = "insufficient_candidates";
      break;
    }

    // この try は round の本体まるごとを囲む。どの段で例外が起きても、完走した round までの結果を持って
    // `aborted_on_error` で打ち切るため。関数全体を1つの try で囲むと、どの round で死んだかが分からなくなる。
    try {
      const { groups, leftover } = splitIntoConsolidationGroups(candidatePool, options.groupSize);
      const outcomes: ConsolidationOutcomeCountsJson = emptyOutcomeCounts();
      let llmCalls = 0;
      const nextPool: string[] = [];
      const newMemoryIdsThisRound: string[] = [];

      for (const group of groups) {
        const result = await options.runtime.consolidate(ctx, {
          target: { memoryIds: group },
          reason: `consolidation-cost round ${round}`,
        });
        outcomes[result.outcome] += 1;
        llmCalls += result.llmCalls;
        if (result.outcome === "consolidated" && result.consolidatedMemoryId !== null) {
          nextPool.push(result.consolidatedMemoryId);
          newMemoryIdsThisRound.push(result.consolidatedMemoryId);
          allIds.push(result.consolidatedMemoryId);
        } else {
          // この bench では起きない想定。起きた場合は対象を未統合のまま次の round へ持ち越し、黙って消さない。
          nextPool.push(...group);
        }
      }
      candidatePool = [...nextPool, ...leftover];

      // `newMemoryIdsThisRound` の件数を `drainEmbedTicks` に渡し、available_at との競合で claim 0件のまま黙って抜けないことを検査させる。
      await drainEmbedTicks(options.runtime, ctx, {
        expectedProcessed: newMemoryIdsThisRound.length,
      });

      const embedding = await measureNewMemoriesEmbedding(
        options.memoryStore,
        options.pool,
        ctx,
        newMemoryIdsThisRound,
      );

      const store = await measureStore(options.memoryStore, ctx, allIds);
      const recall = await measureRecallForRound(
        options.runtime,
        options.memoryStore,
        ctx,
        store.json.activeCount,
        options.budgetLadder,
        options.recallLimit,
        options.association,
      );

      const consolidation: ConsolidationRoundConsolidationJson = {
        groups: groups.length,
        llmCalls,
        outcomes,
        newMemoryCount: newMemoryIdsThisRound.length,
        embeddingStatus: embedding.embeddingStatus,
        embeddingFailureKinds: embedding.embeddingFailureKinds,
      };

      rounds.push({ round, consolidation, store: store.json, recall });
      // 直前で例外が起きた場合は実行されない。`stoppedAfterRound` は最後に完走した round のままになる。
      stoppedAfterRound = round;
    } catch (error) {
      abort = describeThrownError(error, round);
      stopReason = "aborted_on_error";
      break;
    }
  }

  return buildConsolidationCostRunJson({
    llmMode: options.llmMode,
    embeddingMode: options.embeddingMode,
    embeddingSpace,
    probeCount: PROBES.length,
    haystackSize,
    groupSize: options.groupSize,
    budgetLadder: options.budgetLadder,
    recallLimit: options.recallLimit,
    stoppedAfterRound,
    stopReason,
    rounds,
    measuredAt: options.measuredAt,
    commit: options.commit,
    abort,
  });
}

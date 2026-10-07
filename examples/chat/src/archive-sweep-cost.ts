import type {
  Ctx,
  DecayClock,
  EmbeddingProvider,
  Memory,
  MemoryStore,
  RecallAssociationQuery,
  Runtime,
  TenantSettingsStore,
} from "@mnemora/core";
import { writeDecayClock } from "@mnemora/core";
import type { PostgresClient } from "@mnemora/postgres";
import {
  buildArchiveSweepCostRunJson,
  buildArchiveSweepMeanJson,
  buildArchiveSweepProbeJson,
  buildArchiveSweepStoreJson,
  fillerBackdateMs,
} from "./archive-sweep-json.js";
import type {
  ArchiveSweepCostRunJson,
  ArchiveSweepEmbeddingSpaceJson,
  ArchiveSweepPhaseJson,
  ArchiveSweepRecallJson,
  ArchiveSweepRecallBudgetRungJson,
  ArchiveSweepResultJson,
  RawArchiveSweepProbeMeasurement,
} from "./archive-sweep-json.js";
import { clockPastRecentDbWrites, drainEmbedTicks } from "./embed-drain.js";
import type { MutableClock } from "./mutable-clock.js";
import {
  DEFAULT_HAYSTACK_SIZE,
  PROBES,
  buildProbeSetConversation,
  goldExternalId,
} from "./probe-set.js";
import type { ProviderMode } from "./providers.js";
import { resolveExternalId } from "./provenance-trace.js";

/** `pool` の型は `@mnemora/postgres` から借りる（`pg` への phantom dependency を作らない）。 */
type Pool = PostgresClient["pool"];

export interface RunArchiveSweepCostOptions {
  runtime: Runtime;
  memoryStore: MemoryStore;
  embeddingProvider: EmbeddingProvider;
  pool: Pool;
  /** filler の ingest だけを backdate するために注入する。`createExampleRuntime` の第4引数と同じインスタンスにすること。 */
  clock: MutableClock;
  llmMode: ProviderMode;
  embeddingMode: ProviderMode;
  tenantId: string;
  halfLifeHours: number;
  marginHours: number;
  sweepLimit: number;
  budgetLadder: readonly number[];
  recallLimit: number;
  measuredAt: Date;
  commit: string | null;
  haystackSize?: number;
  decayClock?: { store: TenantSettingsStore; clock: DecayClock };
  association?: RecallAssociationQuery | null;
}

/** この bench 専用テナントの `default_half_life_hours` を設定し、読み戻した実値を返す。`TenantSettingsStore` にこの列を書く口が無く、`packages/core`/`postgres` を変えないため素の SQL で UPSERT する。 */
async function setTenantHalfLifeHours(
  pool: Pool,
  tenantId: string,
  halfLifeHours: number,
): Promise<number> {
  await pool.query(
    `INSERT INTO tenant_settings (tenant_id, default_half_life_hours, updated_at)
       VALUES ($1, $2, now())
     ON CONFLICT (tenant_id) DO UPDATE
       SET default_half_life_hours = EXCLUDED.default_half_life_hours, updated_at = now()`,
    [tenantId, halfLifeHours],
  );
  const result = await pool.query<{ default_half_life_hours: number }>(
    `SELECT default_half_life_hours FROM tenant_settings WHERE tenant_id = $1`,
    [tenantId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(
      `setTenantHalfLifeHours: 書き込んだはずの tenant_settings 行が読めない(tenantId=${tenantId})`,
    );
  }
  return row.default_half_life_hours;
}

interface StoreSnapshot {
  json: ArchiveSweepPhaseJson["store"];
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
  const archived = byStatus.get("archived") ?? [];
  const allContentChars = memories.reduce((sum, m) => sum + m.content.length, 0);
  return {
    json: buildArchiveSweepStoreJson({
      activeContentsAndDigests: active.map((m) => ({ content: m.content, digest: m.digest })),
      supersededCount: superseded.length,
      archivedCount: archived.length,
      allContentChars,
    }),
  };
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
): Promise<RawArchiveSweepProbeMeasurement> {
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
  let omittedArchivedCount = 0;
  for (const omission of result.omitted) {
    if (omission.kind === "filtered" && omission.condition === "archived") {
      omittedArchivedCount += omission.count;
    }
  }
  return {
    probeId,
    memoryDigests: result.memories.map((m) => m.digest),
    goldRank,
    totalInScope: result.index.totalInScope,
    omittedKinds: result.omitted.map((o) => o.kind),
    omittedArchivedCount,
    usageChars: result.usage.chars,
    usageEstimatedTokens: result.usage.estimatedTokens,
    usageIndexChars: result.usage.indexChars,
    budgetExceeded: result.usage.budgetExceeded ?? false,
  };
}

export async function measureRecallForPhase(
  runtime: Runtime,
  memoryStore: MemoryStore,
  ctx: Ctx,
  activeCount: number,
  budgetLadder: readonly number[],
  recallLimit: number,
  association: RecallAssociationQuery | null = null,
): Promise<ArchiveSweepRecallJson> {
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
  const unbudgetedProbes = unbudgetedRaw.map((raw) => buildArchiveSweepProbeJson(raw, activeCount));

  const budgeted: ArchiveSweepRecallBudgetRungJson[] = [];
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
    const rungProbes = rungRaw.map((raw) => buildArchiveSweepProbeJson(raw, activeCount));
    budgeted.push({
      budgetTokens,
      probes: rungProbes,
      mean: buildArchiveSweepMeanJson(rungProbes),
    });
  }

  return {
    unbudgeted: { probes: unbudgetedProbes, mean: buildArchiveSweepMeanJson(unbudgetedProbes) },
    budgeted,
  };
}

export async function runArchiveSweepCost(
  options: RunArchiveSweepCostOptions,
): Promise<Extract<ArchiveSweepCostRunJson, { status: "measured" }>> {
  const ctx: Ctx = { tenantId: options.tenantId };
  if (options.decayClock !== undefined) {
    await writeDecayClock(options.decayClock.store, ctx, options.decayClock.clock);
  }
  const haystackSize = options.haystackSize ?? DEFAULT_HAYSTACK_SIZE;

  const halfLifeHours = await setTenantHalfLifeHours(
    options.pool,
    options.tenantId,
    options.halfLifeHours,
  );
  const backdateMs = fillerBackdateMs(halfLifeHours, options.marginHours);

  const utterances = buildProbeSetConversation(haystackSize);
  const allIds: string[] = [];

  // 1点に凍結する。member ごとに `new Date()` を取り直すと、動かすつもりの無い軸（decay）にミリ秒差のノイズが乗る。
  const realNow = new Date();
  const backdated = new Date(realNow.getTime() - backdateMs);

  for (const utterance of utterances) {
    options.clock.set(utterance.kind === "haystack" ? backdated : realNow);
    const observed = await options.runtime.observe(ctx, {
      kind: "utterance",
      text: utterance.text,
      externalId: utterance.externalId,
    });
    allIds.push(...observed.memoryIds);
  }

  // recall/tick の直前に必ず実時刻へ戻す。さらに +1ms して `available_at` を確実に追い越し、`waitForClockToAdvance: false` で無駄な待ちを避ける。
  // 止まった時計は `.set()` するまで進まないので、既定の再試行（実時計が進むのを待つ）は無意味。
  options.clock.set(clockPastRecentDbWrites());
  await drainEmbedTicks(options.runtime, ctx, {
    expectedProcessed: allIds.length,
    waitForClockToAdvance: false,
  });

  const embeddingSpace: ArchiveSweepEmbeddingSpaceJson = { ...options.embeddingProvider.space };

  const beforeStore = await measureStore(options.memoryStore, ctx, allIds);
  const beforeRecall = await measureRecallForPhase(
    options.runtime,
    options.memoryStore,
    ctx,
    beforeStore.json.activeCount,
    options.budgetLadder,
    options.recallLimit,
    options.association,
  );
  const before: ArchiveSweepPhaseJson = { store: beforeStore.json, recall: beforeRecall };

  const sweepNow = new Date();
  const sweepResult = await options.runtime.sweepArchive(ctx, {
    now: sweepNow,
    limit: options.sweepLimit,
  });
  const sweep: ArchiveSweepResultJson = {
    supported: sweepResult.supported,
    limit: options.sweepLimit,
    archivedCount: sweepResult.archived.length,
    reachedLimit: sweepResult.reachedLimit,
  };

  const afterStore = await measureStore(options.memoryStore, ctx, allIds);
  const afterRecall = await measureRecallForPhase(
    options.runtime,
    options.memoryStore,
    ctx,
    afterStore.json.activeCount,
    options.budgetLadder,
    options.recallLimit,
    options.association,
  );
  const after: ArchiveSweepPhaseJson = { store: afterStore.json, recall: afterRecall };

  return buildArchiveSweepCostRunJson({
    llmMode: options.llmMode,
    embeddingMode: options.embeddingMode,
    embeddingSpace,
    probeCount: PROBES.length,
    haystackSize,
    halfLifeHours,
    budgetLadder: options.budgetLadder,
    recallLimit: options.recallLimit,
    sweep,
    before,
    after,
    measuredAt: options.measuredAt,
    commit: options.commit,
  });
}

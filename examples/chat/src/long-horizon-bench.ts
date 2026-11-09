import type { Ctx, EmbeddingProvider, EmbeddingSpaceId, Runtime } from "@mnemora/core";
import {
  DEFAULT_DECAY_THRESHOLD,
  DEFAULT_HALF_LIFE_HOURS,
  DEFAULT_SCORE_THRESHOLD,
  createRuntime,
  type RecallResult,
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
import { clockPastRecentDbWrites, drainEmbedTicks } from "./embed-drain.js";
import {
  LONG_HORIZON_CHECKPOINT_DAYS,
  LONG_HORIZON_DAYS,
  LONG_HORIZON_FACTS,
  LONG_HORIZON_FILLERS_PER_DAY,
  buildLongHorizonMemorySeeds,
  checkpointTime,
  habitualMentionTimes,
  type LongHorizonFact,
  type LongHorizonFactClass,
  type LongHorizonMemorySeed,
} from "./long-horizon-case-set.js";
import {
  classifyCorrectionOrder,
  classifyGoldOutcome,
  countOutcomes,
  type CorrectionOrder,
  type CountByKind,
  type GoldOutcomeKind,
} from "./long-horizon-outcome.js";
import { buildMnemoraPrompt, reportMemoryUsage } from "./mnemora-path.js";
import { createMutableClock, type MutableClock } from "./mutable-clock.js";
import type { EnvLike, ProviderMode } from "./providers.js";
import { createProviders } from "./providers.js";
import { isAffinityMeasured } from "./recalled-score.js";

/**
 * 4つの条件（arm）。使用報告の有無 × 時間項の方針。
 * - A: 入れたままの既定（`legacy`・使用報告なし）
 * - B: 推奨どおり使用報告を配線（`legacy`・使用報告あり。`examples/chat` の `mnemora-path.ts` と同じ報告の仕方）
 * - C: `eventAwareFreshness`・使用報告なし（ADR 0300 §7 の判断材料）
 * - D: `eventAwareFreshness`・使用報告あり
 */
export const LONG_HORIZON_ARMS = ["A", "B", "C", "D"] as const;
export type LongHorizonArm = (typeof LONG_HORIZON_ARMS)[number];

export const LONG_HORIZON_ARM_SPECS: Record<
  LongHorizonArm,
  { policy: TimeWeightingPolicy; usageReporting: boolean }
> = {
  A: { policy: "legacy", usageReporting: false },
  B: { policy: "legacy", usageReporting: true },
  C: { policy: "eventAwareFreshness", usageReporting: false },
  D: { policy: "eventAwareFreshness", usageReporting: true },
};

/**
 * テナントは3つで足りる。使用報告なしの A と C は同じテナントを共有する: 測定の `recall()` は使用報告を送らず、
 * 壁時計（既定）のテナントでは記憶の状態を変えないので、同じ履歴に2方針で問える。
 * 使用報告ありの B と D は共有できない: 何を報告するかは、その方針の `recall()` が何を返したかで決まり、履歴が方針ごとに分かれる。
 */
const TENANT_GROUPS: readonly { key: string; arms: readonly LongHorizonArm[] }[] = [
  { key: "no-usage", arms: ["A", "C"] },
  { key: "usage-legacy", arms: ["B"] },
  { key: "usage-event-aware", arms: ["D"] },
];

/** 診断用の `recall()` の閾値。閾値による除外を実質無効にして、gold のスコアを必ず読めるようにする。 */
export const DIAGNOSTIC_SCORE_THRESHOLD = -1_000_000;
/**
 * 診断用の `recall()` の件数は、その時点でテナントに書いた記憶の総数以上にする。
 * ⚠ 固定の件数（たとえば200）にしない: 総数より小さいと、候補に上がっているのに順位でその外へ押し出された gold を
 * `not_reached` と取り違える（初版がこれを踏んだ。ADR に記録）。
 */
export function diagnosticRecallLimit(memoriesWritten: number): number {
  return Math.max(1, memoriesWritten);
}

/** 同じ文には同じベクトルを返す。3テナントで同じ文を埋め込み直さないためだけにある（意味は変えない）。 */
class MemoizingEmbeddingProvider implements EmbeddingProvider {
  readonly space: EmbeddingSpaceId;
  private readonly cache = new Map<string, number[]>();
  innerCalls = 0;

  constructor(private readonly inner: EmbeddingProvider) {
    this.space = inner.space;
  }

  async embed(ctx: Ctx, texts: string[]): Promise<number[][]> {
    const missing = [...new Set(texts.filter((t) => !this.cache.has(t)))];
    if (missing.length > 0) {
      this.innerCalls += 1;
      const vectors = await this.inner.embed(ctx, missing);
      missing.forEach((text, i) => {
        this.cache.set(text, vectors[i]!);
      });
    }
    return texts.map((t) => this.cache.get(t)!);
  }
}

export interface LongHorizonRuntimeHandle {
  runtime: Runtime;
  memoryStore: PostgresMemoryStore;
  clock: MutableClock;
  llmMode: ProviderMode;
  embeddingMode: ProviderMode;
  embeddingProvider: EmbeddingProvider;
  close(): Promise<void>;
}

/** LLM は使わない（記憶を直接書き、回答も生成しない）。埋め込みは呼び出し側が `env` で決める。 */
export async function createLongHorizonRuntime(
  databaseUrl: string,
  env: EnvLike,
): Promise<LongHorizonRuntimeHandle> {
  const client: PostgresClient = createPostgresClient(databaseUrl);
  try {
    await runMigrations(client.pool);
    const created = createProviders(env);
    const embeddingProvider = new MemoizingEmbeddingProvider(created.embeddingProvider);
    await registerEmbeddingSpace(client.pool, embeddingProvider.space);
    const memoryStore = new PostgresMemoryStore(client.db);
    const clock = createMutableClock();
    const runtime = createRuntime({
      memoryStore,
      outboxStore: new PostgresOutboxStore(client.db),
      vectorStore: new PostgresVectorStore(client.db),
      lexicalStore: new PostgresLexicalStore(client.db),
      eventStore: new PostgresEventStore(client.db),
      tenantSettingsStore: new PostgresTenantSettingsStore(client.db),
      llmProvider: created.llmProvider,
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
      embeddingProvider,
      close: () => closePostgresClient(client),
    };
  } catch (err) {
    await closePostgresClient(client).catch(() => {});
    throw err;
  }
}

export interface LongHorizonDiagnostic {
  rank: number;
  total: number;
  similarity: number | null;
  lexicalMatch: number | null;
  decay: number;
  freshness: number;
  tagMatch: number;
  strength: number;
}

export interface LongHorizonProbeRecord {
  arm: LongHorizonArm;
  checkpointDay: number;
  factId: string;
  factClass: LongHorizonFactClass;
  /** `superseded` は訂正の古い側。gold ではないが、新旧の順位関係を見るために同じ形で記録する。 */
  role: "gold" | "superseded";
  outcome: GoldOutcomeKind;
  returnedRank: number | null;
  retrievedVia: string | null;
  diagnostic: LongHorizonDiagnostic | null;
  decayFloorAt: string;
  lastReinforcedAt: string | null;
}

export interface LongHorizonQuantityRecord {
  arm: LongHorizonArm;
  checkpointDay: number;
  memoriesWritten: number;
  /** その時点までに書いた記憶の本文を全部積んだ文字数（naive の代理）。 */
  naiveChars: number;
  /** 既定の `recall()` の結果から組んだプロンプトの文字数の、事実ごとの平均。 */
  meanPromptChars: number;
}

export interface LongHorizonOptions {
  facts?: readonly LongHorizonFact[];
  days?: number;
  fillersPerDay?: number;
  checkpointDays?: readonly number[];
  arms?: readonly LongHorizonArm[];
  tenantPrefix: string;
  log?: (line: string) => void;
  /** どの arm の `recall()` にも渡す、時間の重みの下限（ADR 0704）。省略時は渡さない（core の既定）。 */
  timeWeightFloor?: number;
  /** どの arm の既定の `recall()` でも忘却ゲートを外す（`includeFullyDecayed: true`）。省略時は外さない。 */
  includeFullyDecayed?: boolean;
}

export interface LongHorizonReport {
  facts: readonly LongHorizonFact[];
  days: number;
  fillersPerDay: number;
  checkpointDays: readonly number[];
  arms: readonly LongHorizonArm[];
  memoriesWritten: number;
  probes: LongHorizonProbeRecord[];
  quantities: LongHorizonQuantityRecord[];
  usageReports: Record<LongHorizonArm, number>;
}

type TimelineEvent = { kind: "mention"; at: Date } | { kind: "checkpoint"; at: Date; day: number };

function buildTimeline(
  days: number,
  checkpointDays: readonly number[],
  usageReporting: boolean,
): TimelineEvent[] {
  const events: TimelineEvent[] = checkpointDays.map((day) => ({
    kind: "checkpoint",
    at: checkpointTime(day),
    day,
  }));
  if (usageReporting) {
    for (const at of habitualMentionTimes(days)) {
      events.push({ kind: "mention", at });
    }
  }
  return events.sort((a, b) => a.at.getTime() - b.at.getTime());
}

async function writeSeeds(
  handle: LongHorizonRuntimeHandle,
  ctx: Ctx,
  seeds: readonly LongHorizonMemorySeed[],
  memoryIdByLocalId: Map<string, string>,
): Promise<void> {
  if (seeds.length === 0) {
    return;
  }
  for (const seed of seeds) {
    const input = buildNewMemoryFixture({
      tenantId: ctx.tenantId,
      content: seed.content,
      // fixture の既定の `contentHash` は固定文字列で、同じテナントに複数件書くと冪等キーで衝突する。
      contentHash: sha256Hex(`${ctx.tenantId}:${seed.localId}:${seed.content}`),
      digest: seed.content,
      tags: [],
      occurredAt: null,
      recordedAt: seed.recordedAt,
    });
    const { memory } = await handle.memoryStore.createMemoryWithOutbox(ctx, input, ["embed"]);
    memoryIdByLocalId.set(seed.localId, memory.id);
  }
  // 埋め込みの claim は実時刻で進める（`time-weighting-bench.ts` と同じ。止めた時計のままだと claim が1件も進まない）。
  handle.clock.set(clockPastRecentDbWrites());
  await drainEmbedTicks(handle.runtime, ctx, {
    expectedProcessed: seeds.length,
    waitForClockToAdvance: false,
  });
}

export function rankOf(
  recall: RecallResult,
  memoryId: string,
): { rank: number; via: string } | null {
  const index = recall.memories.findIndex((m) => m.memoryId === memoryId);
  if (index < 0) {
    return null;
  }
  return { rank: index + 1, via: recall.memories[index]!.retrievedVia };
}

export function diagnosticOf(recall: RecallResult, memoryId: string): LongHorizonDiagnostic | null {
  const index = recall.memories.findIndex((m) => m.memoryId === memoryId);
  if (index < 0) {
    return null;
  }
  const score = recall.memories[index]!.score;
  if (!isAffinityMeasured(score)) {
    return null;
  }
  return {
    rank: index + 1,
    total: score.total,
    similarity: score.similarity ?? null,
    lexicalMatch: score.lexicalMatch ?? null,
    decay: score.decay,
    freshness: score.freshness,
    tagMatch: score.tagMatch,
    strength: score.strength,
  };
}

function goldLocalIds(fact: LongHorizonFact): { localId: string; role: "gold" | "superseded" }[] {
  const ids: { localId: string; role: "gold" | "superseded" }[] = [
    { localId: `${fact.id}:gold`, role: "gold" },
  ];
  if (fact.factClass === "correction") {
    ids.push({ localId: `${fact.id}:superseded`, role: "superseded" });
  }
  return ids;
}

/**
 * 模擬期間を時刻順に進める。測定・話題の時刻が来るたびに、それまでに記録された記憶を書いてから `Clock` をその時刻に合わせる。
 * ⚠ 記憶の作成と `reinforce` は `Clock` を読まず、`recordedAt` と使用報告の時刻（`Clock` の値）だけで減衰の起点が決まる。
 */
export async function runLongHorizonBench(
  handle: LongHorizonRuntimeHandle,
  options: LongHorizonOptions,
): Promise<LongHorizonReport> {
  const facts = options.facts ?? LONG_HORIZON_FACTS;
  const days = options.days ?? LONG_HORIZON_DAYS;
  const fillersPerDay = options.fillersPerDay ?? LONG_HORIZON_FILLERS_PER_DAY;
  const checkpointDays = options.checkpointDays ?? LONG_HORIZON_CHECKPOINT_DAYS;
  const arms = options.arms ?? LONG_HORIZON_ARMS;
  const log = options.log ?? (() => {});
  const allSeeds = buildLongHorizonMemorySeeds(facts, days, fillersPerDay);
  const habitualFacts = facts.filter((f) => f.factClass === "habitual");
  const recallExtras = {
    ...(options.timeWeightFloor !== undefined ? { timeWeightFloor: options.timeWeightFloor } : {}),
    ...(options.includeFullyDecayed === true ? { includeFullyDecayed: true } : {}),
  };

  const probes: LongHorizonProbeRecord[] = [];
  const quantities: LongHorizonQuantityRecord[] = [];
  const usageReports = { A: 0, B: 0, C: 0, D: 0 } as Record<LongHorizonArm, number>;

  for (const group of TENANT_GROUPS) {
    const groupArms = group.arms.filter((a) => arms.includes(a));
    if (groupArms.length === 0) {
      continue;
    }
    const usageReporting = LONG_HORIZON_ARM_SPECS[groupArms[0]!].usageReporting;
    // 使用報告ありのグループは arm が1つなので、話題に出たときの `recall()` の方針はその arm のもの。
    const mentionPolicy = LONG_HORIZON_ARM_SPECS[groupArms[0]!].policy;
    const ctx: Ctx = { tenantId: `${options.tenantPrefix}-${group.key}` };
    const memoryIdByLocalId = new Map<string, string>();
    let seedCursor = 0;
    let naiveChars = 0;

    const flushUntil = async (at: Date): Promise<void> => {
      const batch: LongHorizonMemorySeed[] = [];
      while (
        seedCursor < allSeeds.length &&
        allSeeds[seedCursor]!.recordedAt.getTime() <= at.getTime()
      ) {
        const seed = allSeeds[seedCursor]!;
        batch.push(seed);
        naiveChars += seed.content.length;
        seedCursor += 1;
      }
      await writeSeeds(handle, ctx, batch, memoryIdByLocalId);
    };

    for (const event of buildTimeline(days, checkpointDays, usageReporting)) {
      await flushUntil(event.at);
      handle.clock.set(event.at);

      if (event.kind === "mention") {
        for (const fact of habitualFacts) {
          const recall = await handle.runtime.recall(ctx, {
            text: fact.question,
            timeWeighting: mentionPolicy,
            ...recallExtras,
          });
          const report = await reportMemoryUsage(handle.runtime, ctx, recall);
          if (report.reported) {
            usageReports[groupArms[0]!] += 1;
          }
        }
        continue;
      }

      log(`[long-horizon] ${group.key} day=${String(event.day)} memories=${String(seedCursor)}`);
      for (const arm of groupArms) {
        const policy = LONG_HORIZON_ARM_SPECS[arm].policy;
        let promptCharsSum = 0;
        for (const fact of facts) {
          const recall = await handle.runtime.recall(ctx, {
            text: fact.question,
            timeWeighting: policy,
            ...recallExtras,
          });
          promptCharsSum += buildMnemoraPrompt(recall).length + fact.question.length;
          const diagnosticRecall = await handle.runtime.recall(ctx, {
            text: fact.question,
            timeWeighting: policy,
            ...recallExtras,
            scoreThreshold: DIAGNOSTIC_SCORE_THRESHOLD,
            includeFullyDecayed: true,
            limit: diagnosticRecallLimit(seedCursor),
            association: null,
          });
          for (const { localId, role } of goldLocalIds(fact)) {
            const memoryId = memoryIdByLocalId.get(localId);
            if (memoryId === undefined) {
              // 訂正の新しい側を植える前の時点。
              continue;
            }
            const memory = await handle.memoryStore.get(ctx, memoryId);
            if (memory === null) {
              throw new Error(
                `runLongHorizonBench: 書いたはずの記憶 "${localId}" を読めなかった。`,
              );
            }
            const returned = rankOf(recall, memoryId);
            const diagnostic = diagnosticOf(diagnosticRecall, memoryId);
            probes.push({
              arm,
              checkpointDay: event.day,
              factId: fact.id,
              factClass: fact.factClass,
              role,
              outcome: classifyGoldOutcome({
                returnedRank: returned?.rank ?? null,
                diagnosticTotal: diagnostic?.total ?? null,
                decayFloorAt: memory.decayFloorAt,
                probeAt: event.at,
                scoreThreshold: DEFAULT_SCORE_THRESHOLD,
              }),
              returnedRank: returned?.rank ?? null,
              retrievedVia: returned?.via ?? null,
              diagnostic,
              decayFloorAt: memory.decayFloorAt.toISOString(),
              lastReinforcedAt: memory.lastReinforcedAt?.toISOString() ?? null,
            });
          }
        }
        quantities.push({
          arm,
          checkpointDay: event.day,
          memoriesWritten: seedCursor,
          naiveChars,
          meanPromptChars: promptCharsSum / facts.length,
        });
      }
    }
  }

  return {
    facts,
    days,
    fillersPerDay,
    checkpointDays,
    arms,
    memoriesWritten: allSeeds.length,
    probes,
    quantities,
    usageReports,
  };
}

/**
 * 既定値からの見立て（実測ではない）。使用報告が無く、タグ一致も無い gold が閾値を割る日。
 * `legacy` では `decay` と `freshness` が同じ半減期で掛かるので、半減期が実質半分になる。
 * どちらの方針でも、忘却ゲートの日（`halfLife × log2(1 / 減衰閾値)`）より後には残らない。
 */
export function predictedFirstMissDay(similarity: number, policy: TimeWeightingPolicy): number {
  const halfLifeDays = DEFAULT_HALF_LIFE_HOURS / 24;
  const gateDay = halfLifeDays * Math.log2(1 / DEFAULT_DECAY_THRESHOLD);
  const effectiveHalfLife = policy === "legacy" ? halfLifeDays / 2 : halfLifeDays;
  const thresholdDay =
    similarity <= DEFAULT_SCORE_THRESHOLD
      ? 0
      : effectiveHalfLife * Math.log2(similarity / DEFAULT_SCORE_THRESHOLD);
  return Math.min(thresholdDay, gateDay);
}

export interface LongHorizonCell {
  arm: LongHorizonArm;
  checkpointDay: number;
  factClass: LongHorizonFactClass;
  total: number;
  counts: CountByKind;
}

/** gold だけを arm × 時点 × 事実の種類で数える。 */
export function aggregateLongHorizon(probes: readonly LongHorizonProbeRecord[]): LongHorizonCell[] {
  const groups = new Map<
    string,
    { key: Omit<LongHorizonCell, "total" | "counts">; kinds: GoldOutcomeKind[] }
  >();
  for (const p of probes) {
    if (p.role !== "gold") {
      continue;
    }
    const key = `${p.arm}|${String(p.checkpointDay)}|${p.factClass}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        key: { arm: p.arm, checkpointDay: p.checkpointDay, factClass: p.factClass },
        kinds: [],
      };
      groups.set(key, group);
    }
    group.kinds.push(p.outcome);
  }
  return [...groups.values()].map((g) => ({
    ...g.key,
    total: g.kinds.length,
    counts: countOutcomes(g.kinds),
  }));
}

export interface CorrectionOrderCell {
  arm: LongHorizonArm;
  checkpointDay: number;
  counts: Record<CorrectionOrder, number>;
}

export function aggregateCorrectionOrders(
  probes: readonly LongHorizonProbeRecord[],
): CorrectionOrderCell[] {
  const byKey = new Map<
    string,
    { gold?: LongHorizonProbeRecord; superseded?: LongHorizonProbeRecord }
  >();
  for (const p of probes) {
    if (p.factClass !== "correction") {
      continue;
    }
    const key = `${p.arm}|${String(p.checkpointDay)}|${p.factId}`;
    const entry = byKey.get(key) ?? {};
    entry[p.role] = p;
    byKey.set(key, entry);
  }
  const cells = new Map<string, CorrectionOrderCell>();
  for (const entry of byKey.values()) {
    if (entry.gold === undefined || entry.superseded === undefined) {
      continue;
    }
    const key = `${entry.gold.arm}|${String(entry.gold.checkpointDay)}`;
    let cell = cells.get(key);
    if (cell === undefined) {
      cell = {
        arm: entry.gold.arm,
        checkpointDay: entry.gold.checkpointDay,
        counts: { new_above_old: 0, old_above_new: 0, new_only: 0, old_only: 0, neither: 0 },
      };
      cells.set(key, cell);
    }
    cell.counts[classifyCorrectionOrder(entry.gold.returnedRank, entry.superseded.returnedRank)] +=
      1;
  }
  return [...cells.values()];
}

import type {
  Ctx,
  MemoryStore,
  RecallAssociationQuery,
  RecalledMemory,
  RecalledScore,
  Runtime,
} from "@mnemora/core";
import { clockPastRecentDbWrites, drainEmbedTicks } from "./embed-drain.js";
import type { MutableClock } from "./mutable-clock.js";
import type { ProviderMode } from "./providers.js";
import { resolveExternalId } from "./provenance-trace.js";
import { formatScoreValue, formatTermSpreads, computeTermSpreads } from "./retrieval-quality.js";
import type { TermSpread } from "./retrieval-quality.js";
import {
  TIME_PROBES,
  buildTimeTermConversation,
  newerExternalId,
  olderExternalId,
} from "./time-term-probe-set.js";
import type { TimeProbe } from "./time-term-probe-set.js";

/**
 * ペアの本文は厳密に同一にし、時間項以外を動かさない。probe ごとに時刻を1点へ凍結するので、`recordedAt` を明示しない probe では `decay` の幅は厳密に 0 になる（ADR 0033 が測った実時間の幅とは別の条件）。
 * probe ごとに別テナントを使う。他の候補に押し出される可能性や他 probe との語彙的な競合を消すためで、現実らしさは捨てて分離を採る（現実らしさは `probe-set.ts` 側が担う）。
 */

/**
 * ペアの total 差を「時間項が順位を決めていない」と読む上限。裁量値で、この数自体を裏付ける実測は無い。
 * ミリ秒差の残り（decay 側、1 から 1e-7 程度）より十分大きく、`realistic` probe の freshness 差（0.05 前後）より十分小さい、という桁の比較だけで決めた。
 */
export const TIE_EPSILON = 1e-4;

export type PairOutcome =
  | "newer-ranked-higher"
  | "older-ranked-higher"
  | "tied"
  | "newer-not-returned"
  | "older-not-returned"
  | "neither-returned"
  | "collapsed";

export interface PairMember {
  rank: number;
  score: RecalledScore;
  digest: string;
}

/**
 * 純関数。返らなかったものを 0 に潰さない。`collapsed` は呼び出し側が判定して渡す（潰れたペアは「片方が返ってこない」形で現れ、`rank` の比較では `older-not-returned` と区別できない）。
 * `newer.rank === older.rank` の分岐は置かない（構造上届かず、検査できない経路を増やさない）。
 */
export function classifyPairOutcome(
  newer: PairMember | null,
  older: PairMember | null,
  options: { tieEpsilon?: number; pairCollapsed?: boolean } = {},
): PairOutcome {
  if (options.pairCollapsed === true) {
    return "collapsed";
  }
  const tieEpsilon = options.tieEpsilon ?? TIE_EPSILON;
  if (newer === null && older === null) {
    return "neither-returned";
  }
  if (newer === null) {
    return "newer-not-returned";
  }
  if (older === null) {
    return "older-not-returned";
  }
  // affinityMeasured: false には total が無いので、順位だけで決める（2件の rank は一致しないので "tied" にならない）。
  if (newer.score.affinityMeasured === false || older.score.affinityMeasured === false) {
    return newer.rank < older.rank ? "newer-ranked-higher" : "older-ranked-higher";
  }
  const diff = newer.score.total - older.score.total;
  if (Math.abs(diff) <= tieEpsilon) {
    return "tied";
  }
  return newer.rank < older.rank ? "newer-ranked-higher" : "older-ranked-higher";
}

export interface TimeProbeOutcome {
  probeId: string;
  outcome: PairOutcome;
  newer: PairMember | null;
  older: PairMember | null;
  similarityGapWithinPair: number | null;
  freshnessGapWithinPair: number | null;
  freshnessRatio: number | null;
  decayRatio: number | null;
  totalRatio: number | null;
  omittedKinds: string[];
  totalInScope: number;
  termSpreads: TermSpread[];
}

function ratio(
  newer: PairMember | null,
  older: PairMember | null,
  pick: (score: RecalledScore) => number | undefined,
): number | null {
  if (newer === null || older === null) {
    return null;
  }
  const olderValue = pick(older.score);
  const newerValue = pick(newer.score);
  if (olderValue === undefined || newerValue === undefined) {
    return null;
  }
  return olderValue / newerValue;
}

function similarityGap(newer: PairMember | null, older: PairMember | null): number | null {
  if (newer === null || older === null) {
    return null;
  }
  const a = newer.score.affinityMeasured === false ? undefined : newer.score.similarity;
  const b = older.score.affinityMeasured === false ? undefined : older.score.similarity;
  if (a === undefined || b === undefined) {
    return null;
  }
  return Math.abs(a - b);
}

function freshnessGap(newer: PairMember | null, older: PairMember | null): number | null {
  if (newer === null || older === null) {
    return null;
  }
  return Math.abs(newer.score.freshness - older.score.freshness);
}

export interface TimeTermArmReport {
  armLabel: string;
  llmMode: ProviderMode;
  embeddingMode: ProviderMode;
  now: Date;
  probes: TimeProbeOutcome[];
}

export interface RunTimeTermArmOptions {
  armLabel: string;
  tenantIdPrefix: string;
  runtime: Runtime;
  memoryStore: MemoryStore;
  llmMode: ProviderMode;
  embeddingMode: ProviderMode;
  now?: Date;
  /** `createExampleRuntime` に渡した `MutableClock` と同じインスタンスでなければならない（別インスタンスは `Runtime` 内部の `recordedAt` に反映されない）。省略すると `decay-*` probe は分離できない結果になる。 */
  clock?: MutableClock;
  /** 省略時は `null`（この arm の基準線を動かさない）。 */
  association?: RecallAssociationQuery | null;
}

function toPairMember(memory: RecalledMemory, index: number): PairMember {
  return { rank: index + 1, score: memory.score, digest: memory.digest };
}

async function runOneProbe(
  probe: TimeProbe,
  options: RunTimeTermArmOptions,
  now: Date,
): Promise<TimeProbeOutcome> {
  const ctx: Ctx = { tenantId: `${options.tenantIdPrefix}-${probe.id}` };
  const utterances = buildTimeTermConversation(probe, now);
  // member ごとに `new Date()` を取り直さない（ミリ秒差が残り、`decay` に測るつもりの無い幅が入る）。
  const realNow = new Date();

  let expectedEmbedJobs = 0;
  for (const utterance of utterances) {
    // member を observe する直前に必ず Clock を置く。「明示しないときは何もしない」にすると、片方だけ `recordedAt` を持つ probe を足したとき、もう片方が前の member の過去時刻を引き継ぐ。
    options.clock?.set(utterance.recordedAt ?? realNow);
    const observed = await options.runtime.observe(ctx, {
      kind: "utterance",
      text: utterance.text,
      externalId: utterance.externalId,
      ...(utterance.occurredAt !== null ? { occurredAt: utterance.occurredAt } : {}),
    });
    expectedEmbedJobs += observed.memoryIds.length;
  }

  // recall の直前に必ず実時刻へ戻す（`recall()` の `now` も `clock.now()` 由来）。戻す先は `realNow` ではなく、いま取り直した実時刻でなければならない。
  // 止まった `MutableClock` は `.set()` するまで動かないので、ここで先に +1ms して確実に追い越し、`waitForClockToAdvance: false` で無駄な待ちを避ける。
  if (options.clock !== undefined) {
    options.clock.set(clockPastRecentDbWrites());
  }

  await drainEmbedTicks(options.runtime, ctx, {
    expectedProcessed: expectedEmbedJobs,
    waitForClockToAdvance: options.clock === undefined,
  });

  // `text` 以外を渡さない（既定の limit・閾値・overFetchFactor のまま測る）。ただし association は `options.association ?? null` を優先する:
  // 連想枠が既定 on でも、省略した呼び出しではこの arm の基準線を動かさない。
  const result = await options.runtime.recall(ctx, {
    text: probe.query,
    association: options.association ?? null,
  });

  const resolvedExternalIds = await Promise.all(
    result.memories.map((m) => resolveExternalId(options.memoryStore, ctx, m.memoryId)),
  );
  const newerIndex = resolvedExternalIds.indexOf(newerExternalId(probe.id));
  const olderIndex = resolvedExternalIds.indexOf(olderExternalId(probe.id));
  const newer = newerIndex === -1 ? null : toPairMember(result.memories[newerIndex]!, newerIndex);
  const older = olderIndex === -1 ? null : toPairMember(result.memories[olderIndex]!, olderIndex);

  // `totalInScope < 2` はペアが潰れたことを意味する（この arm は probe ごとに専用テナント）。今は起きないが、dedupe や矛盾検出が入れば起きる。
  // そのとき `older-not-returned` へ黙って読み替えないよう独立して見る。`> 2` は異常ではない（1発話から複数の Memory を作りうる）ので見ない。
  const pairCollapsed = result.index.totalInScope < 2;

  return {
    probeId: probe.id,
    outcome: classifyPairOutcome(newer, older, { pairCollapsed }),
    newer,
    older,
    similarityGapWithinPair: similarityGap(newer, older),
    freshnessGapWithinPair: freshnessGap(newer, older),
    freshnessRatio: ratio(newer, older, (s) => s.freshness),
    decayRatio: ratio(newer, older, (s) => s.decay),
    totalRatio: ratio(newer, older, (s) => (s.affinityMeasured === false ? undefined : s.total)),
    omittedKinds: result.omitted.map((o) => o.kind),
    totalInScope: result.index.totalInScope,
    termSpreads: computeTermSpreads(result.memories),
  };
}

export async function runTimeTermArm(options: RunTimeTermArmOptions): Promise<TimeTermArmReport> {
  const now = options.now ?? new Date();
  const probes: TimeProbeOutcome[] = [];
  for (const probe of TIME_PROBES) {
    probes.push(await runOneProbe(probe, options, now));
  }
  return {
    armLabel: options.armLabel,
    llmMode: options.llmMode,
    embeddingMode: options.embeddingMode,
    now,
    probes,
  };
}

function formatRatio(value: number | null): string {
  return value === null ? "(片方が返っていない)" : formatScoreValue(value);
}

function formatPairMember(label: "newer" | "older", member: PairMember | null): string {
  if (member === null) {
    return `  ${label}: (返っていない)`;
  }
  const s = member.score;
  if (s.affinityMeasured === false) {
    return (
      `  ${label}: #${member.rank} total=n/a（affinityMeasured: false、連想枠経由で` +
      `比較可能ではない） = decay ${formatScoreValue(s.decay)} × ` +
      `tagMatch ${formatScoreValue(s.tagMatch)} × freshness ${formatScoreValue(s.freshness)} × ` +
      `strength ${formatScoreValue(s.strength)}  ${member.digest}`
    );
  }
  const similarity =
    s.similarity === undefined ? "(ANN 経由でない)" : formatScoreValue(s.similarity);
  return (
    `  ${label}: #${member.rank} total=${formatScoreValue(s.total)} = ` +
    `similarity ${similarity} × decay ${formatScoreValue(s.decay)} × ` +
    `tagMatch ${formatScoreValue(s.tagMatch)} × freshness ${formatScoreValue(s.freshness)} × ` +
    `strength ${formatScoreValue(s.strength)}  ${member.digest}`
  );
}

export function formatTimeTermReport(report: TimeTermArmReport): string {
  const lines: string[] = [];
  lines.push(`=== time-term arm ${report.armLabel} ===`);
  lines.push(`provider: llm=${report.llmMode} / embedding=${report.embeddingMode}`);
  lines.push(`now: ${report.now.toISOString()}`);
  for (const p of report.probes) {
    lines.push(
      `  - ${p.probeId}: outcome=${p.outcome} ` +
        `omitted=[${p.omittedKinds.join(",")}] totalInScope=${p.totalInScope}`,
    );
    lines.push(formatPairMember("newer", p.newer));
    lines.push(formatPairMember("older", p.older));
    lines.push(
      `  similarityGapWithinPair=${formatRatio(p.similarityGapWithinPair)} ` +
        `freshnessGapWithinPair=${formatRatio(p.freshnessGapWithinPair)}`,
    );
    lines.push(
      `  freshnessRatio=${formatRatio(p.freshnessRatio)} decayRatio=${formatRatio(p.decayRatio)} ` +
        `totalRatio=${formatRatio(p.totalRatio)}`,
    );
    lines.push(`  項ごとの値の幅(返った候補全体): ${formatTermSpreads(p.termSpreads)}`);
  }
  return lines.join("\n");
}

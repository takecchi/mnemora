import type {
  Ctx,
  MemoryStore,
  RecallAssociationQuery,
  RecalledMemory,
  Runtime,
} from "@mnemora/core";
import {
  ASSOCIATION_PROBES,
  associationAnchorExternalId,
  associationDistractorExternalId,
  associationGoldExternalId,
  buildAssociationProbeSetConversation,
} from "./association-probe-set.js";
import type { AssociationProbe } from "./association-probe-set.js";
import { drainEmbedTicks } from "./embed-drain.js";
import { resolveExternalId } from "./provenance-trace.js";

/** 連想枠が想起の質を動かすかを測る arm。`recall()` には `text` と `association` 以外を渡さない。閾値・limit・overFetchFactor は `packages/core` の既定のまま。 */

export interface AssociationProbeOutcome {
  probeId: string;
  category: AssociationProbe["category"];
  goldRank: number | null;
  anchorRank: number | null;
  distractorRank: number | null;
  goldRetrievedVia: "ann" | "lexical" | "mandatory_companion" | "association" | null;
  goldAssociationOf: string | null;
  goldAnchoredOnProbeAnchor: boolean;
  returnedCount: number;
  memoryChars: number;
  associationChars: number;
  hit1: boolean;
  hit10: boolean;
  goldReturned: boolean;
  reciprocalRank: number;
  stageSkipped: string | null;
  associationFrame: AssociationFrameEntry[];
  repeatFrameIdentical: boolean;
  repeatGoldRankSame: boolean;
}

export interface AssociationFrameEntry {
  externalId: string;
  rank: number;
  role: "own-gold" | "own-anchor" | "own-distractor" | "other-probe" | "haystack" | "unknown";
  anchorExternalId: string | null;
}

function classifyAssociationFrameRole(
  currentProbeId: string,
  externalId: string,
  haystackExternalIds: ReadonlySet<string>,
): AssociationFrameEntry["role"] {
  if (externalId === associationGoldExternalId(currentProbeId)) {
    return "own-gold";
  }
  if (externalId === associationAnchorExternalId(currentProbeId)) {
    return "own-anchor";
  }
  if (externalId === associationDistractorExternalId(currentProbeId)) {
    return "own-distractor";
  }
  for (const probe of ASSOCIATION_PROBES) {
    if (probe.id === currentProbeId) {
      continue;
    }
    if (
      externalId === associationGoldExternalId(probe.id) ||
      externalId === associationAnchorExternalId(probe.id) ||
      externalId === associationDistractorExternalId(probe.id)
    ) {
      return "other-probe";
    }
  }
  if (haystackExternalIds.has(externalId)) {
    return "haystack";
  }
  return "unknown";
}

function associationExternalIdSequence(
  memories: readonly RecalledMemory[],
  resolvedExternalIds: readonly (string | null)[],
): string[] {
  const ids: string[] = [];
  for (let i = 0; i < memories.length; i += 1) {
    const memory = memories[i]!;
    if (memory.retrievedVia !== "association") {
      continue;
    }
    ids.push(resolvedExternalIds[i] ?? memory.memoryId);
  }
  return ids;
}

export interface AssociationArmReport {
  armLabel: string;
  associationEnabled: boolean;
  associationMaxCount: number | null;
  probeCount: number;
  ingestedCount: number;
  goldReturnedCount: number;
  hit1Count: number;
  hit10Count: number;
  goldViaAssociationCount: number;
  mrr: number;
  returnedMemoryTotal: number;
  memoryCharsTotal: number;
  associationCharsTotal: number;
  stageSkippedReasons: Record<string, number>;
  associationFrameRoles: Record<string, number>;
  repeatFrameIdenticalCount: number;
  repeatGoldRankSameCount: number;
  probes: AssociationProbeOutcome[];
}

export interface RunAssociationArmOptions {
  runtime: Runtime;
  memoryStore: MemoryStore;
  tenantId: string;
  armLabel: string;
  /** 渡さなければ連想枠は走らない。`packages/core` の既定が何であっても、この arm 自身が `association: null` を明示して真の off を担保する。 */
  association?: { maxCount: number };
  haystackSize?: number;
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * `AssociationArmReport.associationEnabled` を `recall()` へ渡す `association` から決める純関数。`null`/`undefined` はどちらも off。
 * `!= null`（緩い等価比較）は両方を弾くために意図して使っている。
 * `runAssociationArm` 本体は Postgres を要求して重いので、判定だけを切り出して export した。呼び出し側がこの関数を
 * 呼んでいることは、`association-arm.test.ts` がソースを読んで固定する。
 */
export function computeAssociationEnabled(association: RecallAssociationQuery | null): boolean {
  return association != null;
}

export async function runAssociationArm(
  options: RunAssociationArmOptions,
): Promise<AssociationArmReport> {
  const ctx: Ctx = { tenantId: options.tenantId };
  const utterances = buildAssociationProbeSetConversation(options.haystackSize);

  let expectedEmbedJobs = 0;
  for (const utterance of utterances) {
    const observed = await options.runtime.observe(ctx, {
      kind: "utterance",
      text: utterance.text,
      externalId: utterance.externalId,
    });
    expectedEmbedJobs += observed.memoryIds.length;
  }

  await drainEmbedTicks(options.runtime, ctx, { expectedProcessed: expectedEmbedJobs });

  // "off" arm では `null` を明示する。`undefined` にしてキー自体を渡さないと、`packages/core` の既定が on の今は黙って on になる。
  const association: RecallAssociationQuery | null = options.association
    ? { maxCount: options.association.maxCount }
    : null;

  const haystackExternalIds = new Set(
    utterances.filter((u) => u.kind === "haystack").map((u) => u.externalId),
  );

  const probes: AssociationProbeOutcome[] = [];
  for (const probe of ASSOCIATION_PROBES) {
    // `text`/`association` 以外を渡さない。`association` は `null` も含めて常に渡す。条件付き spread にすると "off" arm でキーを落とし、既定の on になる。
    const result = await options.runtime.recall(ctx, {
      text: probe.query,
      association,
    });

    const resolvedExternalIds = await Promise.all(
      result.memories.map((m) => resolveExternalId(options.memoryStore, ctx, m.memoryId)),
    );
    const goldExternalIdValue = associationGoldExternalId(probe.id);
    const anchorExternalIdValue = associationAnchorExternalId(probe.id);
    const distractorExternalIdValue = associationDistractorExternalId(probe.id);

    const goldIndex = resolvedExternalIds.indexOf(goldExternalIdValue);
    const anchorIndex = resolvedExternalIds.indexOf(anchorExternalIdValue);
    const distractorIndex = resolvedExternalIds.indexOf(distractorExternalIdValue);

    const goldRank = goldIndex === -1 ? null : goldIndex + 1;
    const anchorRank = anchorIndex === -1 ? null : anchorIndex + 1;
    const distractorRank = distractorIndex === -1 ? null : distractorIndex + 1;

    const goldMemory = goldIndex === -1 ? null : result.memories[goldIndex]!;
    const goldRetrievedVia = goldMemory ? goldMemory.retrievedVia : null;

    let goldAssociationOf: string | null = null;
    if (goldMemory && goldMemory.associationOf !== undefined) {
      const resolved = await resolveExternalId(options.memoryStore, ctx, goldMemory.associationOf);
      goldAssociationOf = resolved ?? goldMemory.associationOf;
    }
    const goldAnchoredOnProbeAnchor =
      goldRetrievedVia === "association" && goldAssociationOf === anchorExternalIdValue;

    const stageSkippedEntry = result.omitted.find(
      (o) => o.kind === "stage_skipped" && o.stage === "association",
    );
    const stageSkipped =
      stageSkippedEntry && stageSkippedEntry.kind === "stage_skipped"
        ? stageSkippedEntry.reason
        : null;

    const associationFrame: AssociationFrameEntry[] = [];
    for (let i = 0; i < result.memories.length; i += 1) {
      const memory = result.memories[i]!;
      if (memory.retrievedVia !== "association") {
        continue;
      }
      const externalId = resolvedExternalIds[i] ?? memory.memoryId;
      let anchorExternalId: string | null = null;
      if (memory.associationOf !== undefined) {
        const resolvedAnchor = await resolveExternalId(
          options.memoryStore,
          ctx,
          memory.associationOf,
        );
        anchorExternalId = resolvedAnchor ?? memory.associationOf;
      }
      associationFrame.push({
        externalId,
        rank: i + 1,
        role: classifyAssociationFrameRole(probe.id, externalId, haystackExternalIds),
        anchorExternalId,
      });
    }

    const resultRepeat = await options.runtime.recall(ctx, {
      text: probe.query,
      association,
    });
    const resolvedExternalIdsRepeat = await Promise.all(
      resultRepeat.memories.map((m) => resolveExternalId(options.memoryStore, ctx, m.memoryId)),
    );
    const goldIndexRepeat = resolvedExternalIdsRepeat.indexOf(goldExternalIdValue);
    const goldRankRepeat = goldIndexRepeat === -1 ? null : goldIndexRepeat + 1;
    const repeatGoldRankSame = goldRank === goldRankRepeat;

    const associationFrameExternalIds = associationFrame.map((entry) => entry.externalId);
    const associationFrameExternalIdsRepeat = associationExternalIdSequence(
      resultRepeat.memories,
      resolvedExternalIdsRepeat,
    );
    const repeatFrameIdentical =
      associationFrameExternalIds.length === associationFrameExternalIdsRepeat.length &&
      associationFrameExternalIds.every((id, i) => id === associationFrameExternalIdsRepeat[i]);

    probes.push({
      probeId: probe.id,
      category: probe.category,
      goldRank,
      anchorRank,
      distractorRank,
      goldRetrievedVia,
      goldAssociationOf,
      goldAnchoredOnProbeAnchor,
      returnedCount: result.memories.length,
      memoryChars: result.usage.chars,
      associationChars: result.usage.byTier.association ?? 0,
      hit1: goldRank === 1,
      hit10: goldRank !== null && goldRank <= 10,
      goldReturned: goldRank !== null,
      reciprocalRank: goldRank !== null ? 1 / goldRank : 0,
      stageSkipped,
      associationFrame,
      repeatFrameIdentical,
      repeatGoldRankSame,
    });
  }

  const stageSkippedReasons: Record<string, number> = {};
  const associationFrameRoles: Record<string, number> = {};
  for (const p of probes) {
    if (p.stageSkipped !== null) {
      stageSkippedReasons[p.stageSkipped] = (stageSkippedReasons[p.stageSkipped] ?? 0) + 1;
    }
    for (const entry of p.associationFrame) {
      associationFrameRoles[entry.role] = (associationFrameRoles[entry.role] ?? 0) + 1;
    }
  }

  return {
    armLabel: options.armLabel,
    associationEnabled: computeAssociationEnabled(association),
    associationMaxCount: options.association?.maxCount ?? null,
    probeCount: probes.length,
    ingestedCount: utterances.length,
    goldReturnedCount: probes.filter((p) => p.goldReturned).length,
    hit1Count: probes.filter((p) => p.hit1).length,
    hit10Count: probes.filter((p) => p.hit10).length,
    goldViaAssociationCount: probes.filter((p) => p.goldRetrievedVia === "association").length,
    mrr: average(probes.map((p) => p.reciprocalRank)),
    returnedMemoryTotal: probes.reduce((sum, p) => sum + p.returnedCount, 0),
    memoryCharsTotal: probes.reduce((sum, p) => sum + p.memoryChars, 0),
    associationCharsTotal: probes.reduce((sum, p) => sum + p.associationChars, 0),
    stageSkippedReasons,
    associationFrameRoles,
    repeatFrameIdenticalCount: probes.filter((p) => p.repeatFrameIdentical).length,
    repeatGoldRankSameCount: probes.filter((p) => p.repeatGoldRankSame).length,
    probes,
  };
}

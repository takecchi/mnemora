import type { Ctx, MemoryStore, Runtime } from "@mnemora/core";
import { drainEmbedTicks } from "./embed-drain.js";
import { IDENTIFIER_PROBE_SET_SPEC } from "./identifier-arm.js";
import type { IdentifierHaystackKind } from "./identifier-probe-set.js";
import { JAPANESE_NAME_PROBE_SET_SPEC } from "./japanese-name-probe-set.js";
import { NUMERAL_TOKEN_PROBE_SET_SPEC } from "./numeral-token-probe-set.js";
import {
  PROBES,
  buildProbeSetConversation,
  distractorExternalId as semanticDistractorExternalId,
  goldExternalId as semanticGoldExternalId,
} from "./probe-set.js";
import type { ProbeUtterance } from "./probe-set.js";
import { resolveExternalId } from "./provenance-trace.js";
import { requireMeasuredTotal } from "./recalled-score.js";
import type { CapturedProbeCandidates } from "./synthetic-score-noise.js";

/**
 * `./synthetic-score-noise.js` の合成ノイズを掛けるための候補の捕捉（DB 依存の側）。
 *
 * `runIdentifierProbeArm`/`runRetrievalQualityArm` を呼び直さないのは、それらが `recall()` の結果からその場で
 * 順位を確定させ、候補全体の生スコアを外に出さないため。合成ノイズは `recall()` が返したスコアを後から並べ替え直すことでしか掛けられない。
 * `recall()` は1回しか呼ばず、捕まえた候補集合を純関数で何度でも並べ替える。
 */

export type LocalNoiseGroupKey =
  | "japanese"
  | "identifiersSparse"
  | "identifiersDense"
  | "japaneseNamesSparse"
  | "japaneseNamesDense"
  | "numeralSparse"
  | "numeralDense";

export interface LocalNoiseProbeSetSpec {
  probes: readonly { id: string; query: string }[];
  buildConversation: (
    haystackSize: number | undefined,
    haystackKind: IdentifierHaystackKind,
  ) => ProbeUtterance[];
  goldExternalId: (probeId: string) => string;
  distractorExternalId: (probeId: string) => string;
}

const JAPANESE_SEMANTIC_PROBE_SET_SPEC: LocalNoiseProbeSetSpec = {
  probes: PROBES.map((p) => ({ id: p.id, query: p.query })),
  buildConversation: (haystackSize) => buildProbeSetConversation(haystackSize),
  goldExternalId: semanticGoldExternalId,
  distractorExternalId: semanticDistractorExternalId,
};

export interface LocalNoiseGroupDescriptor {
  key: LocalNoiseGroupKey;
  probeSet: LocalNoiseProbeSetSpec;
  haystackKind: IdentifierHaystackKind;
}

export const LOCAL_NOISE_GROUPS: readonly LocalNoiseGroupDescriptor[] = [
  { key: "japanese", probeSet: JAPANESE_SEMANTIC_PROBE_SET_SPEC, haystackKind: "sparse" },
  { key: "identifiersSparse", probeSet: IDENTIFIER_PROBE_SET_SPEC, haystackKind: "sparse" },
  { key: "identifiersDense", probeSet: IDENTIFIER_PROBE_SET_SPEC, haystackKind: "dense" },
  { key: "japaneseNamesSparse", probeSet: JAPANESE_NAME_PROBE_SET_SPEC, haystackKind: "sparse" },
  { key: "japaneseNamesDense", probeSet: JAPANESE_NAME_PROBE_SET_SPEC, haystackKind: "dense" },
  { key: "numeralSparse", probeSet: NUMERAL_TOKEN_PROBE_SET_SPEC, haystackKind: "sparse" },
  { key: "numeralDense", probeSet: NUMERAL_TOKEN_PROBE_SET_SPEC, haystackKind: "dense" },
];

export interface CaptureGroupResult {
  observationCount: number;
  ticks: number;
  totalProcessed: number;
  totalFailed: number;
  probes: CapturedProbeCandidates[];
}

/** 1群を ingest し、probe ごとに `recall()` を1回呼んで候補全体を捕まえる。`text` 以外の recall オプションは渡さない（閾値・limit・overFetchFactor は一切変えない）。 */
export async function captureGroupCandidates(
  runtime: Runtime,
  memoryStore: MemoryStore,
  ctx: Ctx,
  group: LocalNoiseGroupDescriptor,
): Promise<CaptureGroupResult> {
  const utterances = group.probeSet.buildConversation(undefined, group.haystackKind);

  let expectedEmbedJobs = 0;
  for (const utterance of utterances) {
    const observed = await runtime.observe(ctx, {
      kind: "utterance",
      text: utterance.text,
      externalId: utterance.externalId,
    });
    expectedEmbedJobs += observed.memoryIds.length;
  }
  const drain = await drainEmbedTicks(runtime, ctx, { expectedProcessed: expectedEmbedJobs });

  const probes: CapturedProbeCandidates[] = [];
  for (const probe of group.probeSet.probes) {
    // association: null — 連想枠が既定 on でも、この arm の基準線を動かさない。
    const result = await runtime.recall(ctx, { text: probe.query, association: null });
    const resolvedExternalIds = await Promise.all(
      result.memories.map((m) => resolveExternalId(memoryStore, ctx, m.memoryId)),
    );
    probes.push({
      probeId: probe.id,
      goldExternalId: group.probeSet.goldExternalId(probe.id),
      distractorExternalId: group.probeSet.distractorExternalId(probe.id),
      candidates: result.memories.map((m, i) => ({
        externalId: resolvedExternalIds[i] ?? null,
        score: requireMeasuredTotal(m.score),
      })),
    });
  }

  return {
    observationCount: utterances.length,
    ticks: drain.ticks,
    totalProcessed: drain.totalProcessed,
    totalFailed: drain.totalFailed,
    probes,
  };
}

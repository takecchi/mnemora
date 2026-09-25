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
import type { CapturedProbeCandidates } from "./synthetic-score-noise.js";

/**
 * Issue #109 の残債（`docs/decisions/` 新設 ADR、ADR 0316「引き受けた負債」1番）——
 * `local` 埋め込みの識別子系5群＋数詞2群（ADR 0316 が「既存5+2群」と呼ぶもの）に対して、
 * `./synthetic-score-noise.js` の合成ノイズを掛けるための**候補の捕捉**（DB 依存の側）。
 *
 * ⛔ **`identifier-arm.ts`/`retrieval-quality.ts`/`probe-set.ts`/`identifier-probe-set.ts`/
 * `japanese-name-probe-set.ts`/`numeral-token-probe-set.ts` には1文字も触れていない。**
 * ここは既存の `ArmProbeSetSpec`（と `probe-set.ts` の同型の関数群）を import して使うだけ
 * である——`openai-arm-probe-groups.ts` が OpenAI arm のために行ったのと同じ形（新しい
 * ファイルで新しい組み合わせを作るだけで、既存 probe 集合・既存 arm 関数には触れない）。
 *
 * **なぜ `runIdentifierProbeArm`/`runRetrievalQualityArm` を呼び直さないか**: それらの
 * 関数は `recall()` の結果からその場で goldRank/hit@1 を計算して確定させてしまい、
 * 候補全体の生スコア（`RecalledMemory.score.total`）を外に出さない。合成ノイズは
 * 「本物の `recall()` が返したスコアを、後から並べ替え直す」ことでしか掛けられない
 * （マネージャー指示 1「注入点はスコア」）ため、ここで**候補集合そのもの**
 * （`externalId` と `score.total` のペア）を捕まえる、別の・より薄い経路を用意する。
 * **`recall()` はここでも1回しか呼ばない**——OpenAI arm（ADR 0316）のように round ごとに
 * 再度 embed するのではなく、1回捕まえた候補集合を `synthetic-score-noise.ts` の純関数で
 * 何度でも安く並べ替え直す（同じ埋め込み・同じ recall 結果に対する反実仮想であるため、
 * 何度も recall() を呼び直す必要が無い）。
 */

export type LocalNoiseGroupKey =
  | "japanese"
  | "identifiersSparse"
  | "identifiersDense"
  | "japaneseNamesSparse"
  | "japaneseNamesDense"
  | "numeralSparse"
  | "numeralDense";

/**
 * `ArmProbeSetSpec`（`identifier-arm.ts`）の**部分型**。`category` を要求しない
 * ——このモジュールは MRR/hit@1 の計算にしか候補を使わないため。既存の
 * `IDENTIFIER_PROBE_SET_SPEC`/`JAPANESE_NAME_PROBE_SET_SPEC`/`NUMERAL_TOKEN_PROBE_SET_SPEC`
 * はそのままここへ渡せる（構造的部分型）。
 */
export interface LocalNoiseProbeSetSpec {
  probes: readonly { id: string; query: string }[];
  buildConversation: (
    haystackSize: number | undefined,
    haystackKind: IdentifierHaystackKind,
  ) => ProbeUtterance[];
  goldExternalId: (probeId: string) => string;
  distractorExternalId: (probeId: string) => string;
}

/**
 * `identifier-probes` サブコマンドの「群1」（既存の日本語意味 probe 7件、`probe-set.ts`）を、
 * `LocalNoiseProbeSetSpec` の形に合わせるだけの薄いラッパー。**`probe-set.ts` 自体には
 * 触れていない**——`buildProbeSetConversation` は `haystackKind` を持たないので、
 * ここで引数を1つ捨てるだけである（`cli.ts` がこの群を常に `haystack=sparse` として
 * 扱っているのと同じ扱い）。
 */
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

/**
 * `identifier-probes`（5群）+ `numeral-token-probes`（2群）＝ ADR 0316 が「既存5+2群」と
 * 呼ぶ7群。**`cli.ts` の `runIdentifierProbes`/`runNumeralTokenProbes` が実際に回す
 * 群と同じ組み合わせ**（`probeSet`/`haystackKind` の対応）。
 */
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

/**
 * 1群を ingest し、probe ごとに本物の `runtime.recall()` を1回呼んで、候補全体
 * （`externalId`・`score.total`）を捕まえる。**`text` 以外の recall オプションは渡さない**
 * （既存 arm と同じ規律——閾値・limit・overFetchFactor は一切変えない）。
 */
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
    const result = await runtime.recall(ctx, { text: probe.query });
    const resolvedExternalIds = await Promise.all(
      result.memories.map((m) => resolveExternalId(memoryStore, ctx, m.memoryId)),
    );
    probes.push({
      probeId: probe.id,
      goldExternalId: group.probeSet.goldExternalId(probe.id),
      distractorExternalId: group.probeSet.distractorExternalId(probe.id),
      candidates: result.memories.map((m, i) => ({
        externalId: resolvedExternalIds[i] ?? null,
        score: m.score.total,
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

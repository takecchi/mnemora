import type { Ctx, MemoryStore, Runtime } from "@mnemora/core";
import { drainEmbedTicks } from "./embed-drain.js";
import type { DrainResult } from "./embed-drain.js";
import type { ProviderMode } from "./providers.js";
import {
  DEFAULT_HAYSTACK_SIZE,
  PROBES,
  buildProbeSetConversation,
  distractorExternalId,
  goldExternalId,
} from "./probe-set.js";
import { formatNoApiCallsNotice } from "./usage-meter.js";
import type { UsageMeter } from "./usage-meter.js";

/**
 * probe ごとの順位を測る(PR 本文 (D))。
 *
 * **memory → observation の系譜の辿り方(この PR で一番難しかった点)**:
 * 本物の LLM は発話を書き換えて記憶を作る(要約・言い換え)ため、
 * `recall().memories[].digest`/`memoryId` から「どの発話が元になったか」を
 * **文字列一致では判定できない**。`packages/core`/`packages/postgres` を変更せずに
 * 辿れる経路として、以下の**公開 interface のみ**を使う:
 *
 *   `recall().memories[i].memoryId`
 *     → `memoryStore.get(ctx, memoryId)` (`MemoryStore` interface、既存)
 *     → `Memory.sourceObservationId`(`buildNewMemoryFromCandidate` が
 *        `provenanceKind` の stated/inferred どちらでも常に元の Observation の id を
 *        設定している——`packages/core/src/extraction.ts` で確認済み)
 *     → `memoryStore.getObservation(ctx, sourceObservationId)` (`MemoryStore` interface、既存)
 *     → `Observation.externalId`(`observe()` に渡した `gold-<id>`/`distractor-<id>`/
 *        `filler-NNNN`)
 *
 * `provenance.basis.observationIds`(`InferredProvenance`)ではなく `Memory` 直下の
 * `sourceObservationId` を選んだ理由: 後者は `stated`/`inferred` どちらの分岐でも
 * `buildNewMemoryFromCandidate` が無条件に設定する単一の値であり、
 * provenance の判別ユニオンで分岐する必要がない(`provenance.basis` は `inferred` にしか
 * 無く、かつ配列であるため「1つの Memory は1つの Observation から生まれる」という
 * Phase 1 の実際の抽出フロー(1 Observation → N Memory 候補、1候補 → 1 Memory)には
 * `sourceObservationId` のほうが素直に対応する)。**Phase 2 の consolidate/reflected**
 * (複数の Memory から1つを合成する)が入ると `sourceObservationId` は
 * 存在しなくなりうるが、Phase 1 の範囲(roadmap.md 「いまの状態」)ではまだ実装されて
 * いないため、この経路で確認できないケースは無い。
 *
 * この経路が辿れないケース(`sourceObservationId` が無い、`getObservation` が null を
 * 返す)は `null` を返す——**辿れないことを黙って別の何かに読み替えない**(例:
 * 文字列一致にフォールバックする、等はしない)。
 */
export async function resolveExternalId(
  memoryStore: MemoryStore,
  ctx: Ctx,
  memoryId: string,
): Promise<string | null> {
  const memory = await memoryStore.get(ctx, memoryId);
  if (!memory || !memory.sourceObservationId) {
    return null;
  }
  const observation = await memoryStore.getObservation(ctx, memory.sourceObservationId);
  return observation?.externalId ?? null;
}

// ---------------------------------------------------------------------------
// outbox を干上がるまで処理する(PR 本文「実行時の規律」)
//
// `drainEmbedTicks`/`DrainResult` の実体は `./embed-drain.js` に移した——
// `mnemora-path.ts` の `ingestConversation`(主測定である `compare` 経路)にも
// 同じ罠があったため、共有モジュールへ切り出した(docs/decisions/0021 参照)。
// ここでは import した名前をそのまま re-export し、この関数を
// `./retrieval-quality.js` から import している既存コードとの互換を保つ。
// ---------------------------------------------------------------------------

export { drainEmbedTicks };
export type { DrainResult };

// ---------------------------------------------------------------------------
// probe ごとの指標
// ---------------------------------------------------------------------------

export interface ProbeOutcome {
  probeId: string;
  lexicalControl: boolean;
  /** `recall().memories` の中の gold の順位(1始まり)。居なければ null。 */
  goldRank: number | null;
  distractorRank: number | null;
  hit1: boolean;
  /** 既定の limit(10件)に残ったか。`memories` は既定で最大10件しか返らないため、
   *  goldRank !== null であることと同値。 */
  hit10: boolean;
  /** 話題は合っているが答えが違う記憶(distractor)が gold より上に来たか。
   *  gold が返らず distractor だけ返った場合も「beats gold」として扱う(最悪のケース)。 */
  distractorBeatsGold: boolean;
  reciprocalRank: number;
  omittedKinds: string[];
  totalInScope: number;
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

// ---------------------------------------------------------------------------
// arm 単位の実行
// ---------------------------------------------------------------------------

export interface RunRetrievalQualityArmOptions {
  armLabel: string;
  tenantId: string;
  runtime: Runtime;
  memoryStore: MemoryStore;
  llmMode: ProviderMode;
  embeddingMode: ProviderMode;
  /** `llmMode`/`embeddingMode` のどちらかが `"openai"` のときに渡す。 */
  usageMeter?: UsageMeter;
  /** 既定は `DEFAULT_HAYSTACK_SIZE`(`DEFAULT_TICK_LIMIT`=50 を超える件数)。 */
  haystackSize?: number;
}

export interface ArmIngestSummary {
  observationCount: number;
  drain: DrainResult;
  /** 既定の `tick()` を1回だけ呼ぶ実装(`ingestConversation`)だったら、
   *  この arm では止まっていたはずか。 */
  singleTickWouldHaveStalled: boolean;
}

export interface ArmReport {
  armLabel: string;
  tenantId: string;
  llmMode: ProviderMode;
  embeddingMode: ProviderMode;
  ingest: ArmIngestSummary;
  probes: ProbeOutcome[];
  mrrOverall: number;
  mrrLexicalControl: number;
  mrrNonLexical: number;
  /** usage-meter のレポート、または擬似 provider の場合の明示的な注記。 */
  usageReport: string;
}

/**
 * 1つの provider の組み合わせ(arm)について、probe set を ingest し、
 * probe ごとに `recall()` を1回投げて順位を測る。
 *
 * **パラメータは既定のまま変えない**(PR 本文「実行時の規律」)——`recall()` には
 * `text` 以外を渡さない。閾値・limit・overFetchFactor は `packages/core` の既定値を
 * そのまま使う。
 */
export async function runRetrievalQualityArm(
  options: RunRetrievalQualityArmOptions,
): Promise<ArmReport> {
  const ctx: Ctx = { tenantId: options.tenantId };
  const utterances = buildProbeSetConversation(options.haystackSize ?? DEFAULT_HAYSTACK_SIZE);

  for (const utterance of utterances) {
    await options.runtime.observe(ctx, {
      kind: "utterance",
      text: utterance.text,
      externalId: utterance.externalId,
    });
  }

  const drain = await drainEmbedTicks(options.runtime, ctx);

  const probes: ProbeOutcome[] = [];
  for (const probe of PROBES) {
    const result = await options.runtime.recall(ctx, { text: probe.query });
    const resolvedExternalIds = await Promise.all(
      result.memories.map((m) => resolveExternalId(options.memoryStore, ctx, m.memoryId)),
    );
    const goldIndex = resolvedExternalIds.indexOf(goldExternalId(probe.id));
    const distractorIndex = resolvedExternalIds.indexOf(distractorExternalId(probe.id));
    const goldRank = goldIndex === -1 ? null : goldIndex + 1;
    const distractorRank = distractorIndex === -1 ? null : distractorIndex + 1;
    const distractorBeatsGold =
      distractorRank !== null && (goldRank === null || distractorRank < goldRank);

    probes.push({
      probeId: probe.id,
      lexicalControl: probe.lexicalControl === true,
      goldRank,
      distractorRank,
      hit1: goldRank === 1,
      hit10: goldRank !== null,
      distractorBeatsGold,
      reciprocalRank: goldRank !== null ? 1 / goldRank : 0,
      omittedKinds: result.omitted.map((o) => o.kind),
      totalInScope: result.index.totalInScope,
    });
  }

  const lexicalProbes = probes.filter((p) => p.lexicalControl);
  const nonLexicalProbes = probes.filter((p) => !p.lexicalControl);

  return {
    armLabel: options.armLabel,
    tenantId: options.tenantId,
    llmMode: options.llmMode,
    embeddingMode: options.embeddingMode,
    ingest: {
      observationCount: utterances.length,
      drain,
      singleTickWouldHaveStalled: drain.firstTickProcessed < drain.totalProcessed,
    },
    probes,
    mrrOverall: average(probes.map((p) => p.reciprocalRank)),
    mrrLexicalControl: average(lexicalProbes.map((p) => p.reciprocalRank)),
    mrrNonLexical: average(nonLexicalProbes.map((p) => p.reciprocalRank)),
    usageReport: options.usageMeter ? options.usageMeter.formatReport() : formatNoApiCallsNotice(),
  };
}

// ---------------------------------------------------------------------------
// 表示
// ---------------------------------------------------------------------------

function formatRank(rank: number | null): string {
  return rank === null ? "(無し)" : String(rank);
}

/** arm ごとの詳細(probe 単位の内訳・ingest の内訳・usage レポート)。 */
export function formatArmDetail(report: ArmReport): string {
  const lines: string[] = [];
  lines.push(`=== arm ${report.armLabel}(tenant=${report.tenantId}) ===`);
  lines.push(`provider: llm=${report.llmMode} / embedding=${report.embeddingMode}`);
  lines.push(
    `ingest: observations=${report.ingest.observationCount} ` +
      `ticks=${report.ingest.drain.ticks} ` +
      `firstTickProcessed=${report.ingest.drain.firstTickProcessed} ` +
      `totalProcessed=${report.ingest.drain.totalProcessed} ` +
      `totalFailed=${report.ingest.drain.totalFailed}`,
  );
  lines.push(
    report.ingest.singleTickWouldHaveStalled
      ? "  ⚠ 既定の tick() を1回だけ呼ぶ実装だったら、この arm では " +
          `${report.ingest.drain.totalProcessed - report.ingest.drain.firstTickProcessed} 件が` +
          "埋め込まれないまま残っていたはず(背景2)。"
      : "  (この arm では既定の tick() 1回で全件処理できる件数だった)",
  );
  for (const p of report.probes) {
    lines.push(
      `  - ${p.probeId}${p.lexicalControl ? "[lexicalControl]" : ""}: ` +
        `goldRank=${formatRank(p.goldRank)} hit@1=${p.hit1} hit@10=${p.hit10} ` +
        `distractorRank=${formatRank(p.distractorRank)} distractorBeatsGold=${p.distractorBeatsGold} ` +
        `omitted=[${p.omittedKinds.join(",")}] totalInScope=${p.totalInScope}`,
    );
  }
  lines.push(
    `MRR: 全体=${report.mrrOverall.toFixed(3)} ` +
      `lexicalControl=${report.mrrLexicalControl.toFixed(3)} ` +
      `非語彙=${report.mrrNonLexical.toFixed(3)}`,
  );
  lines.push(report.usageReport);
  return lines.join("\n");
}

/** probe ごとに、3 arm を並べて goldRank/distractorRank を比較する表。 */
export function formatProbeComparisonTable(reports: ArmReport[]): string {
  const header = [
    "probe",
    "lexical",
    ...reports.flatMap((r) => [
      `${r.armLabel}:goldRank`,
      `${r.armLabel}:hit@1`,
      `${r.armLabel}:hit@10`,
      `${r.armLabel}:distractorRank`,
      `${r.armLabel}:distractorBeatsGold`,
    ]),
  ];
  const sep = header.map(() => "---");
  const probeIds = reports[0]?.probes.map((p) => p.probeId) ?? [];
  const rows = probeIds.map((probeId) => {
    const first = reports[0]?.probes.find((p) => p.probeId === probeId);
    const cells = [probeId, String(first?.lexicalControl ?? false)];
    for (const report of reports) {
      const p = report.probes.find((x) => x.probeId === probeId);
      cells.push(
        p ? formatRank(p.goldRank) : "-",
        p ? String(p.hit1) : "-",
        p ? String(p.hit10) : "-",
        p ? formatRank(p.distractorRank) : "-",
        p ? String(p.distractorBeatsGold) : "-",
      );
    }
    return cells;
  });
  return [
    `| ${header.join(" | ")} |`,
    `|${sep.join("|")}|`,
    ...rows.map((r) => `| ${r.join(" | ")} |`),
  ].join("\n");
}

/** arm ごとの ingest・MRR のまとめ表。 */
export function formatArmSummaryTable(reports: ArmReport[]): string {
  const header =
    "| arm | llmMode | embeddingMode | observations | ticks | 初回tick処理数 | 合計処理数 | " +
    "既定tick1回なら止まっていたか | MRR(全体) | MRR(lexicalControl) | MRR(非語彙) |";
  const sep = "|---|---|---|---|---|---|---|---|---|---|---|";
  const rows = reports.map((r) => {
    const stalled = r.ingest.singleTickWouldHaveStalled ? "はい" : "いいえ";
    return (
      `| ${r.armLabel} | ${r.llmMode} | ${r.embeddingMode} | ${r.ingest.observationCount} | ` +
      `${r.ingest.drain.ticks} | ${r.ingest.drain.firstTickProcessed} | ` +
      `${r.ingest.drain.totalProcessed} | ${stalled} | ${r.mrrOverall.toFixed(3)} | ` +
      `${r.mrrLexicalControl.toFixed(3)} | ${r.mrrNonLexical.toFixed(3)} |`
    );
  });
  return [header, sep, ...rows].join("\n");
}

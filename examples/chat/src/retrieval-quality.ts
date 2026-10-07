import type {
  Ctx,
  MemoryStore,
  RecallAssociationQuery,
  RecallChannel,
  RecalledMemory,
  RecalledScore,
  Runtime,
} from "@mnemora/core";
import { DEFAULT_RECALL_CHANNELS, RECALL_CHANNELS } from "@mnemora/core";
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
import { resolveExternalId } from "./provenance-trace.js";
import { scoreTotalOrNull } from "./recalled-score.js";
import { formatNoApiCallsNotice } from "./usage-meter.js";
import type { UsageMeter } from "./usage-meter.js";

/**
 * probe ごとの順位を測る。memory → observation の系譜は文字列一致では判定できない（本物の LLM は発話を書き換えて記憶を作る）ので、
 * `./provenance-trace.js` の `resolveExternalId` に在る。`compare.ts` も同じ経路を必要とするため共有部品として降ろし、ここでは互換のため re-export する。
 */
export { resolveExternalId };

// `drainEmbedTicks`/`DrainResult` の実体は `./embed-drain.js`。主測定の経路にも同じ罠があるため共有モジュールにあり、既存コードとの互換のためここで re-export する。

export { drainEmbedTicks };
export type { DrainResult };

// 記録と印字だけを足す。閾値・重み・limit・overFetchFactor は一切変えない（見栄えの良い数字のために測る条件を選び直さない）。

/** `total` を含めない: `total` は他の項の積で、「どの項が順位を決めたか」を問う対象ではない。 */
export const SCORE_TERMS = ["similarity", "decay", "tagMatch", "freshness", "strength"] as const;
export type ScoreTerm = (typeof SCORE_TERMS)[number];

/** `similarity` は `AffinityUnmeasuredScore` には欄そのものが無い。値は変えず、同じ `undefined` を型が許す形で返すだけ。 */
function getScoreTerm(score: RecalledMemory["score"], term: ScoreTerm): number | undefined {
  switch (term) {
    case "similarity":
      return score.affinityMeasured === false ? undefined : score.similarity;
    case "decay":
      return score.decay;
    case "tagMatch":
      return score.tagMatch;
    case "freshness":
      return score.freshness;
    case "strength":
      return score.strength;
  }
}

/**
 * 返ってきた候補の集合の中で、その項が取った値の幅。これが順位の説明の本体で、幅が 0 の項は順位付けに寄与していない
 * （重みが小さいのではなく、候補間で差が付いていない）。
 */
export interface TermSpread {
  term: ScoreTerm;
  presentCount: number;
  min: number | null;
  max: number | null;
  spread: number | null;
  /**
   * その項を持つ候補が実際に何通りの値を取ったか。幅（`max - min`）とは別の主張で、幅は両端の距離だけを言い、中間に何個の値が在るかを言わない。
   * `decay` は幅が 1e-7 桁でも通り数は候補数ぶんあるが、`tagMatch`/`strength` は通り数が1で、重みを触っても順位は動かない。
   * 「重みが小さい」と「項が動いていない」を区別するには、幅ではなく通り数が要る。
   */
  distinctCount: number;
}

/** 項を持つ候補が0件のときに `spread` を 0 と書かない（「差が無かった」と「測る対象が無かった」は別物）。 */
export function computeTermSpreads(memories: readonly RecalledMemory[]): TermSpread[] {
  return SCORE_TERMS.map((term) => {
    const values = memories
      .map((memory) => getScoreTerm(memory.score, term))
      .filter((value): value is number => value !== undefined);
    if (values.length === 0) {
      return { term, presentCount: 0, min: null, max: null, spread: null, distinctCount: 0 };
    }
    const min = Math.min(...values);
    const max = Math.max(...values);
    return {
      term,
      presentCount: values.length,
      min,
      max,
      spread: max - min,
      distinctCount: new Set(values).size,
    };
  });
}

/**
 * `decay` と `freshness` を同じ候補行の中で1件ずつ厳密比較する。幅が一致しても両端が一致しているだけで、行ごとの一致を含意しない
 * （間接証拠でしかない）ので、行ごとの厳密等価を直接数える。
 */
export function computeDecayFreshnessRowwise(
  memories: readonly RecalledMemory[],
): DecayFreshnessRowwise {
  const rows = memories.length;
  let equalRows = 0;
  for (const memory of memories) {
    if (memory.score.decay === memory.score.freshness) {
      equalRows += 1;
    }
  }
  return { rows, equalRows, differentRows: rows - equalRows };
}

export interface DecayFreshnessRowwise {
  rows: number;
  equalRows: number;
  differentRows: number;
}

export type ScoredRole = "gold" | "distractor" | "top1";

export interface ProbeScoreDetail {
  roles: ScoredRole[];
  rank: number;
  digest: string;
  score: RecalledScore;
}

/**
 * gold・distractor・1位の3つについて、スコア内訳を取り出す。返らなかったものは含めない（gold が `limit` の外に落ちていれば、
 * 0 や「不明」を捏造しない。理由は `omittedKinds` が答える）。
 *
 * 2つの順位は位置引数ではなくオブジェクトで受ける。どちらも `number | null` なので、位置だと取り違えても型が通り、
 * gold と distractor の役が入れ替わったまま出力される。範囲外の順位を弾く番人は置かない（呼び出し側は `indexOf` から作るので
 * 構造上出てこない。別の `recall()` の順位を混ぜれば添字が外れて例外になり、黙って別の記憶を返すより良い）。
 */
export interface ProbeRanks {
  goldRank: number | null;
  distractorRank: number | null;
}

export function collectScoreDetails(
  memories: readonly RecalledMemory[],
  ranks: ProbeRanks,
): ProbeScoreDetail[] {
  const rolesByRank = new Map<number, ScoredRole[]>();
  const addRole = (rank: number | null, role: ScoredRole): void => {
    if (rank === null) {
      return;
    }
    const roles = rolesByRank.get(rank) ?? [];
    roles.push(role);
    rolesByRank.set(rank, roles);
  };
  addRole(ranks.goldRank, "gold");
  addRole(ranks.distractorRank, "distractor");
  addRole(memories.length > 0 ? 1 : null, "top1");

  return [...rolesByRank.keys()]
    .sort((a, b) => a - b)
    .map((rank) => {
      const memory = memories[rank - 1]!;
      return {
        roles: rolesByRank.get(rank)!,
        rank,
        digest: memory.digest,
        score: memory.score,
      };
    });
}

export interface ProbeOutcome {
  probeId: string;
  lexicalControl: boolean;
  goldRank: number | null;
  distractorRank: number | null;
  hit1: boolean;
  hit10: boolean;
  /** gold が返らず distractor だけ返った場合も「beats gold」として扱う（最悪のケース）。 */
  distractorBeatsGold: boolean;
  reciprocalRank: number;
  omittedKinds: string[];
  totalInScope: number;
  scoreDetails: ProbeScoreDetail[];
  termSpreads: TermSpread[];
  /**
   * この probe で `recall()` が実際に返した候補行数。`SCORE_TERMS` は `lexicalMatch` を含まないので、語彙チャンネルが1行も通っていないのか、
   * 通っているが値が無いのかを `termSpreads` だけでは区別できない。この欄と `lexicalMatchRows` を並べて、その区別を行数として残す。
   */
  recalledRows: number;
  /** `examples/chat` のベンチは `channels` を渡さない（既定 `["ann"]`）ので、現状は 0 のまま推移する。欠陥ではなく構成の反映。 */
  lexicalMatchRows: number;
  decayFreshnessRowwise: DecayFreshnessRowwise;
  /** 省略した既存の呼び出しでは常に 0（連想枠を off にしているため）。 */
  associationRows?: number;
  /**
   * 最下位の `score.total`。gold の順位に余裕があっても、スコアでは最下位候補と紙一重のことがあるため、`retrieval-rank-listing` の一覧に出す欄。
   * 既存の欄の意味を変えない追加で、この欄を門に使う歯は無い。
   */
  lastRecalledScore?: number | null;
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

// テナントを毎回変える。arm ごとに固定の tenantId だと、2回目の実行は `observe()` の externalId 冪等性に当たって新規 observation を作らず、
// `ingest` の欄が「測っていないのに1回で足りた」と逆の結論を印字する（順位は DB に前回の記憶が残るので正しく出続け、数字を見ていても気付けない）。
// 冪等性自体は製品として正しいので崩さない。引き受ける負債: 実行のたびに DB へテナントが増え、掃除しない（ADR 0068）。

let runTokenCounter = 0;

/** 2回呼べば必ず違う値を返す。`Date.now()` 単体だと同一ミリ秒内で衝突しうるので、プロセス内カウンタを足す。 */
export function newRunToken(): string {
  runTokenCounter += 1;
  return `${Date.now().toString(36)}-${runTokenCounter}`;
}

/** `armKey` は arm を区別する安定した鍵で、`armLabel`（見出し文言）とは独立に保つ（見出しを変えても tenantId が変わらないように）。 */
export function buildArmTenantId(armKey: string, runToken: string): string {
  return `retrieval-quality-arm-${armKey}-${runToken}`;
}

// 既定は変えない: `MNEMORA_BENCH_CHANNELS` を指定しない呼び出しは `parseBenchChannels` が `undefined` を返し、`recall()` に `channels` を渡さず `packages/core` の既定に委ねる。

/**
 * 未指定・空文字なら `undefined`。値は `RECALL_CHANNELS` の値だけを受け付け、一覧をここに書き写さない。
 * 未知の値は例外にする——黙って無視すると、typo が「既定のまま静かに ann だけで走った」に化ける。
 */
export function parseBenchChannels(
  value: string | undefined,
): readonly RecallChannel[] | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  const values = value.split(",").map((v) => v.trim());
  for (const v of values) {
    if (!(RECALL_CHANNELS as readonly string[]).includes(v)) {
      throw new Error(
        `MNEMORA_BENCH_CHANNELS の要素は ${RECALL_CHANNELS.map((c) => `"${c}"`).join(" / ")} の` +
          `いずれかであること(カンマ区切り)。渡された値: "${value}"`,
      );
    }
  }
  return values as RecallChannel[];
}

export interface RunRetrievalQualityArmOptions {
  armLabel: string;
  tenantId: string;
  runtime: Runtime;
  memoryStore: MemoryStore;
  llmMode: ProviderMode;
  embeddingMode: ProviderMode;
  usageMeter?: UsageMeter;
  haystackSize?: number;
  /** 省略時は `recall()` 自身の既定のまま（既存の呼び出しの挙動を変えない）。 */
  channels?: readonly RecallChannel[];
  /** 省略時は `null`——この arm の基準線は連想枠の既定 on/off の影響を受けない。`association-default-on-measure.ts` だけが明示的に渡す。 */
  association?: RecallAssociationQuery | null;
}

/** observe() の `extraction` の内訳。冪等な再送（`created === false`）では `"skipped"` が返る（＝「今回は何も取り込んでいない」という信号）ので、捨てずに数える。 */
export interface ExtractionOutcomeCounts {
  ok: number;
  skipped: number;
  llmFailedWholeObservation: number;
}

/**
 * この run が実際に ingest を測ったか。`"replayed"` は新規が0件で、`ingest` の数字はこの run のものではない（前回以前の値が DB に残っているだけ）。
 * `boolean` に潰さない: 2値では `"partial"` を表現できず、どちらかへ寄せて嘘になる。
 */
export type IngestMeasurement = "measured" | "replayed" | "partial";

function classifyIngestMeasurement(counts: ExtractionOutcomeCounts): IngestMeasurement {
  const created = counts.ok + counts.llmFailedWholeObservation;
  if (counts.skipped === 0) {
    return "measured";
  }
  return created === 0 ? "replayed" : "partial";
}

export interface ArmIngestSummary {
  observationCount: number;
  drain: DrainResult;
  extractionCounts: ExtractionOutcomeCounts;
  measurement: IngestMeasurement;
  /**
   * `measurement === "replayed"` のときは `null`。このとき `drain` は空の測定で、そこから「1回で足りた」を導くのは、
   * 測っていないことを「足りた」と言い換える誤り。`boolean | null` で2つが同じ顔にならないようにする。
   */
  singleTickWouldHaveStalled: boolean | null;
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
  usageReport: string;
  /** 実際に `recall()` へ渡した（または既定へ委ねた）チャンネル。省略した呼び出しでも、実際に使われた既定値が入る（数字と条件を同じオブジェクトから離さない）。 */
  channels: readonly RecallChannel[];
}

/** `recall()` には `text` 以外を渡さない。閾値・limit・overFetchFactor は `packages/core` の既定値をそのまま使う。 */
export async function runRetrievalQualityArm(
  options: RunRetrievalQualityArmOptions,
): Promise<ArmReport> {
  const ctx: Ctx = { tenantId: options.tenantId };
  const utterances = buildProbeSetConversation(options.haystackSize ?? DEFAULT_HAYSTACK_SIZE);

  // `ObserveResult` を捨てない。`extraction` の内訳を数え、この run が実際に何を取り込んだか（measurement）を後で判定する材料にする。
  const extractionCounts: ExtractionOutcomeCounts = {
    ok: 0,
    skipped: 0,
    llmFailedWholeObservation: 0,
  };
  // `observed.memoryIds`（冪等な再送では空配列）も積算して `drainEmbedTicks` に渡す（claim 0件のまま黙って抜けさせない）。
  let expectedEmbedJobs = 0;
  for (const utterance of utterances) {
    const observed = await options.runtime.observe(ctx, {
      kind: "utterance",
      text: utterance.text,
      externalId: utterance.externalId,
    });
    switch (observed.extraction) {
      case "ok":
        extractionCounts.ok += 1;
        break;
      case "skipped":
        extractionCounts.skipped += 1;
        break;
      case "llm_failed_whole_observation":
        extractionCounts.llmFailedWholeObservation += 1;
        break;
    }
    expectedEmbedJobs += observed.memoryIds.length;
  }
  const measurement = classifyIngestMeasurement(extractionCounts);

  const drain = await drainEmbedTicks(options.runtime, ctx, {
    expectedProcessed: expectedEmbedJobs,
  });

  const probes: ProbeOutcome[] = [];
  for (const probe of PROBES) {
    // association: options.association ?? null — 連想枠が既定 on でも、省略した既存の呼び出しでは基準線を動かさない。
    const result = await options.runtime.recall(ctx, {
      text: probe.query,
      ...(options.channels !== undefined ? { channels: [...options.channels] } : {}),
      association: options.association ?? null,
    });
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
      scoreDetails: collectScoreDetails(result.memories, { goldRank, distractorRank }),
      termSpreads: computeTermSpreads(result.memories),
      recalledRows: result.memories.length,
      lexicalMatchRows: result.memories.filter(
        (m) => m.score.affinityMeasured !== false && m.score.lexicalMatch !== undefined,
      ).length,
      decayFreshnessRowwise: computeDecayFreshnessRowwise(result.memories),
      associationRows: result.memories.filter((m) => m.retrievedVia === "association").length,
      lastRecalledScore: (() => {
        const last = result.memories.at(-1);
        return last === undefined ? null : scoreTotalOrNull(last.score);
      })(),
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
      extractionCounts,
      measurement,
      singleTickWouldHaveStalled:
        measurement === "replayed" ? null : drain.firstTickProcessed < drain.totalProcessed,
    },
    probes,
    mrrOverall: average(probes.map((p) => p.reciprocalRank)),
    mrrLexicalControl: average(lexicalProbes.map((p) => p.reciprocalRank)),
    mrrNonLexical: average(nonLexicalProbes.map((p) => p.reciprocalRank)),
    usageReport: options.usageMeter
      ? options.usageMeter.formatReport()
      : formatNoApiCallsNotice({
          llmMode: options.llmMode,
          embeddingMode: options.embeddingMode,
        }),
    channels: options.channels ?? DEFAULT_RECALL_CHANNELS,
  };
}

function formatRank(rank: number | null): string {
  return rank === null ? "(無し)" : String(rank);
}

/** 小さい値を 0.000000 に潰さない。幅が 1e-4 未満で指数表記に倒すのは、「その項は動いていない」を「0 だった」と読み違えさせないため。 */
export function formatScoreValue(value: number): string {
  if (value !== 0 && Math.abs(value) < 1e-4) {
    return value.toExponential(3);
  }
  return value.toFixed(6);
}

/**
 * 丸めない整形。`formatScoreValue`（6桁丸め）を `decay`/`freshness` の生値に流用すると、両者とも `1.000000` に丸められ、
 * 「distinctCount=10 なのに min=max=1.000000」という自己矛盾した表示になる。既存の印字は変えず、こちらを新設した。
 */
export function formatExactScoreValue(value: number): string {
  return String(value);
}

export function formatTermSpreads(spreads: readonly TermSpread[]): string {
  return spreads
    .map((s) =>
      s.spread === null
        ? `${s.term}=(この項を持つ候補が無い)`
        : `${s.term}=${formatScoreValue(s.spread)}`,
    )
    .join(" ");
}

/** 既存の `formatTermSpreads`（幅）とは別の行として足す（別の主張であり、既存の行の文面は変えない）。min/max は丸めない。 */
export function formatTermDistinctCounts(spreads: readonly TermSpread[]): string {
  return spreads
    .map((s) =>
      s.min === null || s.max === null
        ? `${s.term}=(この項を持つ候補が無い)`
        : `${s.term}=${s.distinctCount}通り[${formatExactScoreValue(s.min)}..${formatExactScoreValue(s.max)}]`,
    )
    .join(" ");
}

export function formatDecayFreshnessRowwise(rowwise: DecayFreshnessRowwise): string {
  const suffix = rowwise.differentRows > 0 ? `(違う行が${rowwise.differentRows}件ある)` : "";
  return `${rowwise.equalRows}/${rowwise.rows}行${suffix}`;
}

/** `affinityMeasured: false` は `total`/`similarity` を持たず「掛け算の形」を出せないので、比較可能でないことをそのまま名乗る。 */
export function formatScoreDetail(detail: ProbeScoreDetail): string {
  const s = detail.score;
  if (s.affinityMeasured === false) {
    return (
      `#${detail.rank} [${detail.roles.join(",")}] total=n/a（affinityMeasured: false、` +
      `連想枠経由で比較可能ではない） = decay ${formatScoreValue(s.decay)} × ` +
      `tagMatch ${formatScoreValue(s.tagMatch)} × freshness ${formatScoreValue(s.freshness)} × ` +
      `strength ${formatScoreValue(s.strength)}  ${detail.digest}`
    );
  }
  const similarity =
    s.similarity === undefined ? "(ANN 経由でない)" : formatScoreValue(s.similarity);
  return (
    `#${detail.rank} [${detail.roles.join(",")}] total=${formatScoreValue(s.total)} = ` +
    `similarity ${similarity} × decay ${formatScoreValue(s.decay)} × ` +
    `tagMatch ${formatScoreValue(s.tagMatch)} × freshness ${formatScoreValue(s.freshness)} × ` +
    `strength ${formatScoreValue(s.strength)}  ${detail.digest}`
  );
}

// arm の見出し数字を1箇所で作る。引数は `ArmReport` 1つだけ: 複数の arm を受け取らないので、構造上、別の arm の数字が混ざりようがない
// （arm B の MRR と arm C の hit@10 を束ねて読み違えた実例がある）。

export interface ArmHeadline {
  mrrOverall: number;
  hit1Count: number;
  hit10Count: number;
  probeCount: number;
  recalledRows: number;
  lexicalMatchRows: number;
  termDistinct: ArmTermDistinct[];
  decayFreshnessEqualRows: number;
  decayFreshnessDifferentRows: number;
}

/** `probes[].termSpreads` からのみ導く。別の集計にすると、この関数と `formatArmDetail` の印字が食い違いうる。 */
export interface ArmTermDistinct {
  term: ScoreTerm;
  presentRows: number;
  minDistinctPerProbe: number;
  /** probe ごとの `distinctCount` の最大。これが 1 なら、どの probe でもその項は候補間で1通りしか値を取らない（重みを触っても順位は動かない）。 */
  maxDistinctPerProbe: number;
  min: number | null;
  max: number | null;
}

function computeArmTermDistinct(probes: readonly ProbeOutcome[]): ArmTermDistinct[] {
  return SCORE_TERMS.map((term) => {
    let presentRows = 0;
    // `null` は「まだ1件も見ていない」。先頭の probe がたまたまこの項を持たなくても、最初に見つかった1件を基準に初期化できる（probe の並び順に依存させない）。
    let minDistinctPerProbe: number | null = null;
    let maxDistinctPerProbe: number | null = null;
    let min: number | null = null;
    let max: number | null = null;
    for (const probe of probes) {
      const spread = probe.termSpreads.find((s) => s.term === term);
      if (!spread) {
        continue;
      }
      presentRows += spread.presentCount;
      minDistinctPerProbe =
        minDistinctPerProbe === null
          ? spread.distinctCount
          : Math.min(minDistinctPerProbe, spread.distinctCount);
      maxDistinctPerProbe =
        maxDistinctPerProbe === null
          ? spread.distinctCount
          : Math.max(maxDistinctPerProbe, spread.distinctCount);
      if (spread.min !== null) {
        min = min === null ? spread.min : Math.min(min, spread.min);
      }
      if (spread.max !== null) {
        max = max === null ? spread.max : Math.max(max, spread.max);
      }
    }
    return {
      term,
      presentRows,
      minDistinctPerProbe: minDistinctPerProbe ?? 0,
      maxDistinctPerProbe: maxDistinctPerProbe ?? 0,
      min,
      max,
    };
  });
}

export function armHeadline(report: ArmReport): ArmHeadline {
  return {
    mrrOverall: report.mrrOverall,
    hit1Count: report.probes.filter((p) => p.hit1).length,
    hit10Count: report.probes.filter((p) => p.hit10).length,
    probeCount: report.probes.length,
    recalledRows: report.probes.reduce((sum, p) => sum + p.recalledRows, 0),
    lexicalMatchRows: report.probes.reduce((sum, p) => sum + p.lexicalMatchRows, 0),
    termDistinct: computeArmTermDistinct(report.probes),
    decayFreshnessEqualRows: report.probes.reduce(
      (sum, p) => sum + p.decayFreshnessRowwise.equalRows,
      0,
    ),
    decayFreshnessDifferentRows: report.probes.reduce(
      (sum, p) => sum + p.decayFreshnessRowwise.differentRows,
      0,
    ),
  };
}

function formatFraction(count: number, total: number): string {
  return `${count}/${total}`;
}

export function formatArmDetail(report: ArmReport): string {
  const lines: string[] = [];
  lines.push(`=== arm ${report.armLabel}(tenant=${report.tenantId}) ===`);
  lines.push(`provider: llm=${report.llmMode} / embedding=${report.embeddingMode}`);
  lines.push(`channels: [${report.channels.join(", ")}]`);
  lines.push(
    `ingest: observations=${report.ingest.observationCount} ` +
      `ticks=${report.ingest.drain.ticks} ` +
      `firstTickProcessed=${report.ingest.drain.firstTickProcessed} ` +
      `totalProcessed=${report.ingest.drain.totalProcessed} ` +
      `totalFailed=${report.ingest.drain.totalFailed} ` +
      `measurement=${report.ingest.measurement}`,
  );
  // 測っていない（`"replayed"`）ときは、測っていないと印字する。単純な `? :` で読むと、「測っていない」が `false`（足りた）と同じ文面に潰れる。
  if (report.ingest.measurement === "replayed") {
    lines.push(
      "  (このテナントは既に取り込み済みで、ingest の数字は今回の run のものではない" +
        "——1回で足りたかどうかは測っていない)",
    );
  } else {
    lines.push(
      report.ingest.singleTickWouldHaveStalled === true
        ? "  ⚠ 既定の tick() を1回だけ呼ぶ実装だったら、この arm では " +
            `${report.ingest.drain.totalProcessed - report.ingest.drain.firstTickProcessed} 件が` +
            "埋め込まれないまま残っていたはず(背景2)。"
        : "  (この arm では既定の tick() 1回で全件処理できる件数だった)",
    );
    if (report.ingest.measurement === "partial") {
      lines.push(
        "  ⚠ 一部の observation は冪等な再送だった——上の ingest の数字は新規分だけを反映する。",
      );
    }
  }
  for (const p of report.probes) {
    lines.push(
      `  - ${p.probeId}${p.lexicalControl ? "[lexicalControl]" : ""}: ` +
        `goldRank=${formatRank(p.goldRank)} hit@1=${p.hit1} hit@10=${p.hit10} ` +
        `distractorRank=${formatRank(p.distractorRank)} distractorBeatsGold=${p.distractorBeatsGold} ` +
        `omitted=[${p.omittedKinds.join(",")}] totalInScope=${p.totalInScope}`,
    );
    lines.push(`      項ごとの値の幅(返った候補全体): ${formatTermSpreads(p.termSpreads)}`);
    lines.push(
      `      項ごとの何通りか(返った候補全体): ${formatTermDistinctCounts(p.termSpreads)}`,
    );
    lines.push(
      `      decay===freshness(行ごと厳密等価): ${formatDecayFreshnessRowwise(p.decayFreshnessRowwise)}`,
    );
    for (const detail of p.scoreDetails) {
      lines.push(`      ${formatScoreDetail(detail)}`);
    }
  }
  // `armHeadline()` から作る。`formatArmSummaryTable` と別々に計算すると、2箇所が食い違いうる（実際に読み違いが起きた）。
  const headline = armHeadline(report);
  lines.push(
    `MRR: 全体=${headline.mrrOverall.toFixed(3)} ` +
      `lexicalControl=${report.mrrLexicalControl.toFixed(3)} ` +
      `非語彙=${report.mrrNonLexical.toFixed(3)} ` +
      `hit@1=${formatFraction(headline.hit1Count, headline.probeCount)} ` +
      `hit@10=${formatFraction(headline.hit10Count, headline.probeCount)}`,
  );
  lines.push(report.usageReport);
  return lines.join("\n");
}

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

/** `hit@1`/`hit@10` を MRR と同じ行に並べる。横長の `formatProbeComparisonTable` を経由すると、別の arm の数字を拾い間違える隙間が増える。 */
export function formatArmSummaryTable(reports: ArmReport[]): string {
  const header =
    "| arm | llmMode | embeddingMode | observations | ticks | 初回tick処理数 | 合計処理数 | " +
    "ingest計測 | 既定tick1回なら止まっていたか | MRR(全体) | MRR(lexicalControl) | " +
    "MRR(非語彙) | hit@1 | hit@10 |";
  const sep = "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|";
  const rows = reports.map((r) => {
    // `singleTickWouldHaveStalled` は測っていないとき `null`。「いいえ（足りた）」に潰すと、塞いだはずの欠陥がこの表に戻ってくる。
    const stalled =
      r.ingest.singleTickWouldHaveStalled === null
        ? "(測っていない)"
        : r.ingest.singleTickWouldHaveStalled
          ? "はい"
          : "いいえ";
    const headline = armHeadline(r);
    return (
      `| ${r.armLabel} | ${r.llmMode} | ${r.embeddingMode} | ${r.ingest.observationCount} | ` +
      `${r.ingest.drain.ticks} | ${r.ingest.drain.firstTickProcessed} | ` +
      `${r.ingest.drain.totalProcessed} | ${r.ingest.measurement} | ${stalled} | ` +
      `${headline.mrrOverall.toFixed(3)} | ${r.mrrLexicalControl.toFixed(3)} | ` +
      `${r.mrrNonLexical.toFixed(3)} | ${formatFraction(headline.hit1Count, headline.probeCount)} | ` +
      `${formatFraction(headline.hit10Count, headline.probeCount)} |`
    );
  });
  return [header, sep, ...rows].join("\n");
}

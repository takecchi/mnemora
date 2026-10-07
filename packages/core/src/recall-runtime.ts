import { assertNoProtoAttributesKey } from "./attributes-guard.js";
import { isAbort, runAbortable } from "./abort.js";
import type { Clock } from "./interfaces/clock.js";
import type { Ctx } from "./ctx.js";
import type { EmbeddingProvider } from "./interfaces/embedding-provider.js";
import type { MemoryStore } from "./interfaces/memory-store.js";
import type { RelationStore } from "./interfaces/relation-store.js";
import type { TokenCounter } from "./interfaces/token-counter.js";
import type { VectorFilter, VectorStore, VectorHit } from "./interfaces/vector-store.js";
import type { LexicalStore, LexicalHit } from "./interfaces/lexical-store.js";
import type { DecayClock, TenantSettingsStore } from "./interfaces/tenant-settings-store.js";
import {
  DEFAULT_DECAY_CLOCK,
  DEFAULT_TAXONOMY_MODE,
  readActivitySeq,
  readDecayClock,
  readHasSubjectActivityCounters,
  readSubjectActivitySeqs,
  readTaxonomyMode,
} from "./interfaces/tenant-settings-store.js";
import type { MemoryId } from "./ids.js";
import { NOT_INDEXED_REASONS } from "./recall.js";
import type { StageSkippedCause } from "./recall.js";
import type { Memory } from "./memory.js";
import { classifyValidity } from "./validity.js";
import {
  ANN_TRUNCATION_UNDECIDABLE_LEXICAL_ACTIVE,
  DEFAULT_ASSOCIATION_ANCHOR_COUNT,
  DEFAULT_ASSOCIATION_MIN_SIMILARITY,
  DEFAULT_RECALL_ASSOCIATION,
  DEFAULT_DIGEST_BAND_LIMIT,
  DEFAULT_OVER_FETCH_FACTOR,
  DEFAULT_RECALL_CHANNELS,
  DEFAULT_RECALL_LIMIT,
  DEFAULT_SCORE_THRESHOLD,
  LEXICAL_STORE_UNAVAILABLE_ERROR_PREFIX,
  DIGEST_BAND_MAX_CHARS,
  DIGEST_BAND_MAX_ENTRY_CHARS,
  FILTERED_CONDITION_SCOPE_RELATION,
  RecallQuerySchema,
} from "./recall.js";
import { packDigestBand } from "./digest-band.js";
import type {
  BelowThresholdOmission,
  CountKind,
  IndexBand,
  Omission,
  OverLimitOmission,
  RecallBudget,
  RecallQuery,
  RecallResult,
  RecallScope,
  RecalledMemory,
  RecalledScore,
  ScoreNotComparableOmission,
  ScoreBreakdown,
  StageTrace,
  UnitAssemblyDroppedOmission,
} from "./recall.js";
import { defaultScoringStrategy } from "./strategies/scoring.js";
import { decideAnnTruncation } from "./ann-truncation.js";
import { listRelatedManyIfSupported } from "./relation-level.js";
import { checkedTokenCounter, findBudgetCut } from "./recall-budget-cut.js";
import {
  DEFAULT_RECALL_OUTPUT_VALIDATION,
  validateRecallOutput,
} from "./recall-output-validation.js";
import type { RecallOutputValidationMode } from "./recall-output-validation.js";
import { omitParamsFromError } from "./failure-description.js";
import { sliceAtGraphemeBoundary } from "./text-truncation.js";

export interface RecallRuntimeDeps {
  /** 記憶の読み出しと、段6の `recalls` の記録に使う。 */
  memoryStore: MemoryStore;
  /** ANN チャンネル（段1）と連想枠に使う。 */
  vectorStore: VectorStore;
  /**
   * 段3（必須の同伴取得）が、`contestedWithId` を持たない `contested`（多者間の群のメンバー）の
   * 仲間を辿るのに使う。**省略可能。** 省略すると、そのような候補は単独では unit を組めず
   * `unit_assembly_dropped` として落ちる（そのような候補が現れたときだけ、`omitted` に
   * `stage_skipped { stage: "relation", reason: "relation_store_unavailable" }` を1件積む）。
   */
  relationStore?: RelationStore | undefined;
  /**
   * 忘却ゲート（段1・後置フィルタ）と段2の再スコアが、テナントの `decay_clock` と活動時計の「いま」
   * （`activity_seq`）を読むのに使う。**省略可能。** 省略すると `decay_clock` は `'wall'` 固定として動く（ADR 0165）。
   */
  tenantSettingsStore?: TenantSettingsStore | undefined;
  /**
   * 語彙チャンネル（ADR 0084）。**省略可能。**
   * 省略したまま `channels` に `"lexical"` を渡すと `recall()` は投げる（黙って0件にしない理由は
   * `RecallQuery.channels` の doc）。
   */
  lexicalStore?: LexicalStore | undefined;
  /** クエリの本文を埋め込むのに使う（`RecallQuery.vector` を渡したときは呼ばない）。 */
  embeddingProvider: EmbeddingProvider;
  /** 「今」の時刻（減衰・`validAt` の既定・記録の時刻）。 */
  clock: Clock;
  /** 返却量の予算（`RecallQuery.budget`）の計算に使う。 */
  tokenCounter: TokenCounter;
  /** `recall()` の戻り値の検証の倒れ方（ADR 0098）。省略時は {@link DEFAULT_RECALL_OUTPUT_VALIDATION}（`"report"`）で、投げない。 */
  outputValidation?: RecallOutputValidationMode | undefined;
}

type ScoredCandidate = {
  memory: Memory;
  /**
   * この候補を候補集合へ入れた最初のチャンネル。「このチャンネルだけが見つけた」ではない:
   * ANN と語彙の両方が当てた記憶は `"ann"` になる。語彙も当てたかは `score.lexicalMatch` の有無で見る
   * （単一の値でチャンネルの集合を表そうとしないこと。ADR 0084）。
   */
  retrievedVia: "ann" | "lexical" | "mandatory_companion" | "association";
  companionOf?: MemoryId;
  /** `retrievedVia: "association"` のときだけ在る。どのアンカーから連想したか（ADR 0151）。 */
  associationOf?: MemoryId;
  score: ScoreBreakdown;
};

/**
 * クエリ埋め込みの検証（ベクトル無し・次元違い・非有限値）で投げる内部の例外。
 * `Omission.cause.kind` を決めるためだけにあり、外へは出ない（message も `cause` に載せない）。
 */
class QueryEmbeddingFailure extends Error {
  constructor(
    readonly causeKind: "no_vector" | "dimension_mismatch" | "non_finite",
    message: string,
  ) {
    super(message);
  }
}

const CAUSE_LABEL_MAX = 64;

/**
 * クエリ埋め込みの失敗から `StageSkippedOmission.cause` を作る。**message・cause の本文・ベクトルの値は読まない。**
 * `providerErrorKind` は投げられた値が文字列の `kind` を持つときだけ、`errorName` は `Error` の `name` が
 * 文字列のときだけ（どちらも ${CAUSE_LABEL_MAX} コードユニット以下。書記素の境界で切る）。
 */
function describeQueryEmbeddingFailure(err: unknown): StageSkippedCause {
  if (err instanceof QueryEmbeddingFailure) {
    return { kind: err.causeKind };
  }
  const cause: StageSkippedCause = { kind: "provider_threw" };
  if (typeof err === "object" && err !== null) {
    const kind = (err as { kind?: unknown }).kind;
    if (typeof kind === "string") {
      cause.providerErrorKind = sliceAtGraphemeBoundary(kind, CAUSE_LABEL_MAX);
    }
  }
  if (err instanceof Error && typeof err.name === "string") {
    cause.errorName = sliceAtGraphemeBoundary(err.name, CAUSE_LABEL_MAX);
  }
  return cause;
}

/**
 * `ScoredCandidate.score` を、呼び出し側へ返す形（`RecalledScore`）へ変換する（ADR 0352）。
 * `affinityMeasured === false` のときだけ `total`/`similarity`/`lexicalMatch` を落とす。
 *
 * 判別子は `affinityMeasured` だけにする。`retrievedVia` で判定すると、affinity を測っていない
 * `"mandatory_companion"` の経路を取りこぼしうる。`affinityMeasured` が `undefined`（自作の
 * `ScoringStrategy` が欄を埋めていない）のときは、区別できないので `ScoreBreakdown` のまま返す（ADR 0282）。
 *
 * 内部の順位付け（`compareScoredCandidates`・`partitionByThreshold`・段3.5 の `rankKey`）はこの関数を
 * 経由せず、変換前の `score.total` を読む。
 */
function toRecalledScore(score: ScoreBreakdown): RecalledScore {
  if (score.affinityMeasured !== false) {
    return score;
  }
  const { decay, tagMatch, freshness, strength } = score;
  return { affinityMeasured: false, decay, tagMatch, freshness, strength };
}

/**
 * 数値の降順比較で、`NaN`（ゼロベクトルの cosine 距離。ADR 0040）を必ず最後尾に送る。
 * `b - a` の生の引き算だと、どちらかが `NaN` のとき比較関数の一貫性が崩れ、`NaN` と無関係な
 * 有限値どうしの順序まで `Array.prototype.sort` が壊しうる（未定義動作）。
 * `NaN` どうしは 0 を返し、呼び出し側の次段のタイブレークに委ねる。
 */
function compareDescendingNaNLast(a: number, b: number): number {
  const aComparable = !Number.isNaN(a);
  const bComparable = !Number.isNaN(b);
  if (!aComparable || !bComparable) {
    return aComparable === bComparable ? 0 : aComparable ? -1 : 1;
  }
  if (a === b) return 0;
  return a > b ? -1 : 1;
}

/**
 * 段2（再スコア）の並び順。`score.total` 降順が主キーで、同点のときのタイブレークを明示する。
 *
 * adapter の返却順に依存しない: `Array.prototype.sort` は安定なので、何も足さないと同点候補は adapter が返した順を保つ。
 * `PostgresVectorStore.search()` は決定的に並べる（ADR 0170）が、`lexical` チャンネルや fake 実装が同じ保証を持つとは限らない。
 *
 * 1. `score.total` 降順（`NaN` は最後尾）。
 * 2. 実効時刻（`occurredAt ?? recordedAt`、ADR 0039）降順。どちらかが Invalid Date のときは同点として扱う。
 * 3. `memory.id` 昇順。
 *
 * 限界: `memory.id` がランダムな UUID の adapter（`PostgresMemoryStore`）では、3 まで落ちたとき
 * 決定的だが fresh ingest をまたいで再現するとは限らない（ADR 0170）。
 */
export function compareScoredCandidates(a: ScoredCandidate, b: ScoredCandidate): number {
  const scoreCompare = compareDescendingNaNLast(a.score.total, b.score.total);
  if (scoreCompare !== 0) return scoreCompare;
  const aTime = (a.memory.occurredAt ?? a.memory.recordedAt).getTime();
  const bTime = (b.memory.occurredAt ?? b.memory.recordedAt).getTime();
  if (!Number.isNaN(aTime) && !Number.isNaN(bTime) && aTime !== bTime) return bTime - aTime;
  return a.memory.id < b.memory.id ? -1 : a.memory.id > b.memory.id ? 1 : 0;
}

/**
 * 段2の閾値比較の結果を、網羅的な三分割にする（ADR 0044）。
 *
 * `filter(total >= t)` と `filter(total < t)` の2本を独立に走らせない: この2つは補集合ではなく、
 * `NaN` だと両方 false になり、候補が残らないのに `below_threshold` にも数えられない。
 * 1件につき1回だけ分岐するので、`passed.length + belowThreshold.length + notComparable.length === scored.length`
 * が構造的に成り立つ（呼び出し側が確かめ、`countKind` の名乗りに使う）。
 */
export interface ThresholdPartition {
  /** `total >= threshold` だった候補。 */
  passed: ScoredCandidate[];
  /** `total < threshold` だった候補（`below_threshold` として `omitted` に数える）。 */
  belowThreshold: ScoredCandidate[];
  /** `>= threshold` でも `< threshold` でもなかった候補（実際には `total` が `NaN`）。 */
  notComparable: ScoredCandidate[];
}

/** `scored` を段2の閾値で3つに分ける。入力の順を保つ。 */
export function partitionByThreshold(
  scored: readonly ScoredCandidate[],
  threshold: number,
): ThresholdPartition {
  const passed: ScoredCandidate[] = [];
  const belowThreshold: ScoredCandidate[] = [];
  const notComparable: ScoredCandidate[] = [];
  for (const candidate of scored) {
    const total = candidate.score.total;
    if (total >= threshold) {
      passed.push(candidate);
    } else if (total < threshold) {
      belowThreshold.push(candidate);
    } else {
      // else if の書き忘れではない: total か threshold が NaN のとき、上の2つは両方 false になる。
      notComparable.push(candidate);
    }
  }
  return { passed, belowThreshold, notComparable };
}

/**
 * 三分割の件数の `countKind` を決める（ADR 0044）。
 *
 * `'exact'` をリテラルで書かない: 名乗りは、正確さを知っている場所から引き継ぐ
 * （`count(*) OVER ()` が ef_search 依存の値を返すようになっても名乗りが `'exact'` のままだった件。ADR 0011）。
 * ここで正確さを知っているのは「三分割が網羅であること」なので、実際に数えて確かめる。
 * `partitionByThreshold` が正しい限り `'unknown'` は返らないが、壊れたときに嘘をつかず黙るために分岐を置く。
 */
export function countKindForPartition(
  partition: ThresholdPartition,
  scoredCount: number,
): CountKind {
  const partitioned =
    partition.passed.length + partition.belowThreshold.length + partition.notComparable.length;
  return partitioned === scoredCount ? "exact" : "unknown";
}

/**
 * budget truncation の単位。同伴ペア・群は分割しない（docs/recall.md §8）ので、1つ以上の候補を持つ。
 * 多者間の `contested` 群（`RelationStore` 経由で辿る）は3件以上を持ちうる（ADR 0292、ADR 0381）。
 */
export type Unit = {
  /** この単位に入る候補（同伴ペアなら2件、群なら3件以上、ほかは1件）。切り詰めるときは単位ごと落とす。 */
  members: ScoredCandidate[];
  /** 並び替え・切り詰めの基準スコア。ペア・群の場合は最もスコアが高いメンバーのスコアを使う。 */
  rankScore: number;
};

/**
 * 多者間の `contested` 群のメンバーを1つの単位にまとめるためのグラフ探索（ADR 0381）。
 * `edges`（各 owner の `RelationStore.listRelated` の1段の結果から集めた無向グラフ）を `startId` から辿り、
 * `byId`（この recall で候補として実在する集合）に含まれる id だけを返す。
 * 返す配列には `startId` 自身も含む（長さ1なら仲間が見つからなかった）。
 */
function collectGroupComponent(
  startId: MemoryId,
  edges: ReadonlyMap<MemoryId, ReadonlySet<MemoryId>>,
  byId: ReadonlyMap<MemoryId, ScoredCandidate>,
): MemoryId[] {
  const visited = new Set<MemoryId>([startId]);
  const queue: MemoryId[] = [startId];
  const result: MemoryId[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (byId.has(current)) {
      result.push(current);
    }
    for (const neighbor of edges.get(current) ?? []) {
      if (!visited.has(neighbor)) {
        // ADR 0494: 群のメンバー（`contested` かつ `contestedWithId` なし）でない候補は、辺が張ってあっても群に入れず、
        // そこから先も辿らない。入れると同じ記憶が別の単位と群の両方に入り、結果に2回返る
        // （`RelationStore.link` を直接呼んで `active` な記憶へ辺を張ると起きる）。
        const candidate = byId.get(neighbor);
        if (
          candidate !== undefined &&
          !(
            candidate.memory.status === "contested" &&
            (candidate.memory.contestedWithId ?? null) === null
          )
        ) {
          continue;
        }
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
  }
  return result;
}

/** id の昇順。 */
function compareIds(a: MemoryId, b: MemoryId): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 多者間の群の同伴の並び。`validFrom` の新しい順、同じなら id の順。
 * `validFrom` が無い記憶は新しさの情報が無いものとして最後尾に送る（ADR 0381）。
 */
function compareByValidFromDescThenId(a: Memory, b: Memory): number {
  const aTime =
    a.validFrom === null || a.validFrom === undefined
      ? Number.NEGATIVE_INFINITY
      : a.validFrom.getTime();
  const bTime =
    b.validFrom === null || b.validFrom === undefined
      ? Number.NEGATIVE_INFINITY
      : b.validFrom.getTime();
  if (aTime !== bTime) return bTime - aTime;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function effectiveTokenBudget(budget: RecallBudget | undefined): number | undefined {
  if (!budget) return undefined;
  const candidates = [budget.maxMemoryTokens, budget.promptBudgetTokens].filter(
    (v): v is number => v !== undefined,
  );
  if (candidates.length === 0) return undefined;
  return Math.min(...candidates);
}

/**
 * 段4（予算による切り詰め）の件数の `countKind` を決める（ADR 0045）。
 *
 * `'exact'` をリテラルで書かない（ADR 0044 と同じ規律）。正確さを知っている場所は `slice` ではない:
 * `units.slice(0, cut)` と `units.slice(cut)` が網羅であることは言語の保証で、確かめても同語反復にしかならない。
 * 正確さを決めるのは、その手前の単位を組む繰り返しである。あの繰り返しは `consumed` で重複を避けながら同伴を
 * ペアにするので、対向関係が一対一でない壊れたデータでは、候補がどの単位にも入らないまま消えうる。
 * 消えた候補は返り値にも `budget_dropped` にも現れない。
 * ⟹ 単位が候補を網羅していれば `'exact'`、していなければ `'unknown'` と名乗る。
 *
 * 件数ではなく、単位に入った候補の `memory.id` の集合で数える。1件が二重に入り別の1件が抜けていると、
 * 件数の和だけは合ってしまう。二重に入った候補が無く、異なる id の数が `candidateCount` と等しいときだけ `'exact'`。
 */
export function countKindForUnits(units: readonly Unit[], candidateCount: number): CountKind {
  const covered = units.reduce((sum, unit) => sum + unit.members.length, 0);
  const distinct = distinctMemberIds(units);
  return covered === distinct && distinct === candidateCount ? "exact" : "unknown";
}

function distinctMemberIds(units: readonly Unit[]): number {
  const ids = new Set<string>();
  for (const unit of units) {
    for (const member of unit.members) {
      ids.add(member.memory.id);
    }
  }
  return ids.size;
}

/**
 * 単位が候補を覆えていない件数を返す（ADR 0043）。覆えていれば 0。
 *
 * 二重計上（覆った数が候補数を超える）でも 0 を返す。候補は消えていないので「落ちた」と名乗るのは嘘になる。
 * 差の絶対値ではない（向きが意味を持つ）。二重計上そのものは `countKindForUnits` が `'unknown'` で名乗る（ADR 0045）。
 *
 * 覆えた数は、単位に入った候補の異なる `memory.id` の数で数える。1件が二重に入り別の1件が抜けていても、
 * 抜けた1件を数える。
 */
export function unitAssemblyShortfall(units: readonly Unit[], candidateCount: number): number {
  return Math.max(0, candidateCount - distinctMemberIds(units));
}

/**
 * 必須の同伴取得（docs/recall.md §8）を行う。段3と段3.5（連想）が共有する規則で、違うのは `owners` だけ。
 *
 * - `owners` のうち `memory.contestedWithId` が対向を指すものだけを対象にする。対向が別の経路で結果集合に
 *   居るものは、呼び出し側が先に除いてから渡す。
 * - `survivesAttributesFilter` だけを通す。`subjectId`/`period`/`validAt`/`decayFloorAt` は意図的に検査しない
 *   （同伴取得はそれらの軸を見ない設計。docs/recall.md §8「対向する Memory をスコアに関係なく候補集合へ追加する」）。
 * - 対向自身の `status` が `'contested'` でなければ使わない（forget や直接の status 書き換えで対向が壊れていた場合。
 *   ADR 0087 の「forget した記憶は recall に出ない」を同伴取得も守る）。
 * - `contestedWithId` の相互参照は検査しない（owner 側だけを辿る。ADR 0136）。
 *
 * 見つからなかった・filter で落ちた対向は戻り値に現れない。その owner を Unit に含めるかの判断は呼び出し側が持つ。
 */
async function fetchMandatoryCompanions(
  ctx: Ctx,
  memoryStore: MemoryStore,
  owners: readonly ScoredCandidate[],
  now: Date,
  queryTags: string[],
  timeWeighting: RecallQuery["timeWeighting"],
  decayScoringExtras: (memory: Memory) => {
    decayClock: DecayClock;
    nowSeq: number | undefined;
    decayBaseSeq: number | null | undefined;
    halfLifeRecalls: number | null | undefined;
  },
  survivesAttributesFilter: (memory: Memory) => boolean,
  // companion の subjectId ぶんの `S_x` を先に読む（`decayScoringExtras` が同期的に `effectiveNowSeqFor` を呼ぶため。ADR 0353）。
  ensureSubjectSeqs: (memories: readonly Memory[]) => Promise<void>,
): Promise<ScoredCandidate[]> {
  const companionIds = [
    ...new Set(
      owners
        .map((c) => c.memory.contestedWithId)
        .filter((id): id is MemoryId => id !== null && id !== undefined),
    ),
  ];
  if (companionIds.length === 0) return [];
  const fetched = await memoryStore.getMany(ctx, companionIds);
  await ensureSubjectSeqs(fetched);
  return fetched
    .filter((companionMemory) => survivesAttributesFilter(companionMemory))
    .filter((companionMemory) => companionMemory.status === "contested")
    .map((companionMemory) => {
      const owner = owners.find((c) => c.memory.contestedWithId === companionMemory.id);
      const score = defaultScoringStrategy({
        now,
        tags: companionMemory.tags,
        queryTags,
        occurredAt: companionMemory.occurredAt,
        recordedAt: companionMemory.recordedAt,
        lastReinforcedAt: companionMemory.lastReinforcedAt,
        strength: companionMemory.strength,
        halfLifeHours: companionMemory.halfLifeHours,
        timeWeighting,
        ...decayScoringExtras(companionMemory),
      });
      return {
        memory: companionMemory,
        retrievedVia: "mandatory_companion" as const,
        companionOf: owner?.memory.id,
        score,
      };
    });
}

/**
 * `Runtime.recall` の本体。`query` を {@link RecallQuerySchema} で検査し（合わなければ zod の `ZodError`）、段1〜6を走らせ、記録した結果を返す。
 *
 * - `channels` に `"lexical"` を含むのに `deps.lexicalStore` が無ければ例外を投げる（`RecallRuntimeDeps.lexicalStore`）。
 * - `deps.outputValidation` が `"throw"` で戻り値の検証に落ちたときは `RecallOutputValidationError` を投げる。
 *   検証は段6（記録）の後に走るので、このときも `recalls` の行は書かれている（例外の `recallId` で突き合わせる）。
 * - 「今」は `deps.clock.now()` を1回だけ読んだ値で、減衰・`validAt` の既定・記録の `createdAt` に共通して使う。
 * - `signal` が abort された状態でクエリの埋め込みを待っていると、この呼び出しは reject する（ADR 0359）。
 *   `embedding_provider_unavailable` の omission へは丸めない（中断と「provider が使えなかった」を区別できなくなる）。
 *   段6（`MemoryStore.createRecall`）にはまだ届いていないので、recall の記録も `activity_seq` の前進も起きない。
 */
export async function runRecall(
  ctx: Ctx,
  query: RecallQuery,
  deps: RecallRuntimeDeps,
  signal?: AbortSignal,
): Promise<RecallResult> {
  try {
    // ADR 0497: 壊れた `tokens`（NaN・負・Infinity・数でない）を返す counter は、最初の呼び出しで断る。
    return await runRecallBody(
      ctx,
      query,
      { ...deps, tokenCounter: checkedTokenCounter(deps.tokenCounter) },
      signal,
    );
  } catch (error) {
    // ADR 0430 決定3: 公開の独立関数が投げる例外も、drizzle の `params:`（問いの本文）を落とす。
    throw omitParamsFromError(error);
  }
}

async function runRecallBody(
  ctx: Ctx,
  query: RecallQuery,
  deps: RecallRuntimeDeps,
  signal?: AbortSignal,
): Promise<RecallResult> {
  // ADR 0496: `attributes` のキー `__proto__` は zod が黙って落とす（絞り込みが外れる）ので、parse の前に断る。
  assertNoProtoAttributesKey((query as { attributes?: unknown } | null | undefined)?.attributes);
  const validatedQuery = RecallQuerySchema.parse(query);
  const now = deps.clock.now();
  const stages: StageTrace[] = [];
  const omitted: Omission[] = [];

  const validityGateActive = validatedQuery.includeOutsideValidity !== true;
  const validAt = validatedQuery.validAt ?? now;

  const decayGateActive = validatedQuery.includeFullyDecayed !== true;

  // ゲートが無効（`includeFullyDecayed: true`）でも常に読む: 'wall' 以外の時計は段2の再スコアでも使う（ADR 0165）。
  const decayClock: DecayClock =
    deps.tenantSettingsStore === undefined
      ? DEFAULT_DECAY_CLOCK
      : await readDecayClock(deps.tenantSettingsStore, ctx);
  // 'wall' のテナントでは `tenant_activity` を読まない（`activity_seq` は無意味な 0。ADR 0165）。
  const nowSeq: number | undefined =
    decayClock === "wall" || deps.tenantSettingsStore === undefined
      ? undefined
      : await readActivitySeq(deps.tenantSettingsStore, ctx);

  // subject 単位のカウンタ（`S_x`）を使っていないテナントでは `tenant_subject_activity` を読まない（ADR 0353）。
  const hasSubjectCounters: boolean =
    decayClock === "wall" || deps.tenantSettingsStore === undefined
      ? false
      : await readHasSubjectActivityCounters(deps.tenantSettingsStore, ctx);

  const activityCounting: "tenant" | "subject" = validatedQuery.activityCounting ?? "tenant";

  const subjectSeqCache = new Map<string, number>();
  async function ensureSubjectSeqs(memories: readonly Memory[]): Promise<void> {
    if (!hasSubjectCounters || deps.tenantSettingsStore === undefined) return;
    const missing = [
      ...new Set(
        memories
          .map((m) => m.subjectId)
          .filter((id): id is string => id != null && !subjectSeqCache.has(id)),
      ),
    ];
    if (missing.length === 0) return;
    const result = await readSubjectActivitySeqs(deps.tenantSettingsStore, ctx, missing);
    for (const id of missing) {
      subjectSeqCache.set(id, result[id] ?? 0);
    }
  }

  /**
   * その Memory にとっての「有効ないま」: `T + S_x`（`subjectId` が無い、または `hasSubjectCounters` が false なら `T` のみ）。
   * `activityCounting`（前進の対象を選ぶだけの引数）は見ない。
   * 呼び出し前に `ensureSubjectSeqs` で該当 `subjectId` を読み込むこと。未読の `subjectId` は 0 扱いになり、
   * 忘却の判定が静かに狂う（ADR 0353）。
   */
  function effectiveNowSeqFor(memory: Memory): number | undefined {
    if (nowSeq === undefined) return undefined;
    if (!hasSubjectCounters || memory.subjectId == null) return nowSeq;
    return nowSeq + (subjectSeqCache.get(memory.subjectId) ?? 0);
  }

  const wantsLabelsFilter = validatedQuery.labels !== undefined && validatedQuery.labels.length > 0;
  const wantsTaxonomyGroups = validatedQuery.taxonomyGroups === true;
  let resolvedLabelsFilter: string[] | undefined;
  let resolvedTaxonomyGroupCandidates: string[] | undefined;
  if (wantsLabelsFilter || wantsTaxonomyGroups) {
    const taxonomyMode =
      deps.tenantSettingsStore === undefined
        ? DEFAULT_TAXONOMY_MODE
        : await readTaxonomyMode(deps.tenantSettingsStore, ctx);
    const allLabels = await deps.memoryStore.listLabels?.(ctx);
    if (allLabels !== undefined) {
      const qualifying = new Set(
        allLabels
          .filter((label) => label.status === "registered" || taxonomyMode === "open")
          .map((label) => label.name),
      );
      if (wantsLabelsFilter) {
        // 参加資格のある名前が残らなくても、`undefined`（絞り込み無し）へは倒さず空配列のまま渡す。
        // 空は後段で「何にも一致しない」述語として働く。`undefined` にすると全件を返してしまう
        // （docs/memory-model.md §8、ADR 0323）。
        resolvedLabelsFilter = (validatedQuery.labels ?? []).filter((name) => qualifying.has(name));
      }
      if (wantsTaxonomyGroups) {
        resolvedTaxonomyGroupCandidates = [...qualifying];
      }
    } else if (wantsLabelsFilter) {
      // `listLabels?` を実装しない adapter では、どの名前が `registered` かを知りようが無い。
      // 黙って絞り込みを諦めて全件へ広げない。
      // - 'open' は状態を見ないので、渡された名前をそのまま参加資格ありとして扱う。
      // - 'strict' は検証できないので参加資格ゼロと見なす。'open' 側へ広げると、テナントが明示した
      //   strict の方針を黙って破る。
      resolvedLabelsFilter = taxonomyMode === "open" ? (validatedQuery.labels ?? []) : [];
    }
    // `taxonomyGroups` は `listLabels?` が無ければ生成しない。出力が増えないだけで、`labels` と違って
    // 返すべきでない Memory を返す種類の誤りにならない。
  }

  // `decayClock`/`nowSeq` の読み取りより後に置く: スコープは忘却ゲートの2軸を持って `MemoryStore.aggregateScope` へ
  // 渡る必要があり、2軸は `decay_clock` を読まないと決まらない
  // （`omitted.filtered(decayed)` の件数を、段1の押し下げと同じ述語で数えるため。ADR 0173）。
  const scope: RecallScope = {
    subjectId: ctx.subjectId,
    includeSubjectless: validatedQuery.includeSubjectless,
    occurredAfter: validatedQuery.occurredAfter,
    occurredBefore: validatedQuery.occurredBefore,
    validAt: validityGateActive ? validAt : undefined,
    // 忘却ゲートの軸の唯一の出所。段1（ANN）と段3.5（連想枠）の `VectorFilter` は `gateVectorFilterFields` 経由で
    // この欄を読み、段5の `aggregateScope` は `scope` そのものを受け取る。2箇所で同じ式を書くと、片方だけ直したとき
    // 「落ちた数」と「数えた数」が黙って食い違う（ADR 0038、ADR 0173）。
    decayFloorAtAfter:
      decayGateActive && (decayClock === "wall" || decayClock === "either") ? now : undefined,
    decayFloorSeqAfter:
      decayGateActive && (decayClock === "activity" || decayClock === "either")
        ? nowSeq
        : undefined,
    decayFloorAnyAxis: decayGateActive && decayClock === "either",
    // `hasSubjectCounters` が false のテナントでは常に false: 段1 SQL・aggregateScope・archiveDecayed が
    // T のみの単一パラメータ比較のままになる（プラン族を変えない。ADR 0353）。
    decayFloorSeqUsesSubjectCounters:
      decayGateActive &&
      (decayClock === "activity" || decayClock === "either") &&
      hasSubjectCounters,
    // 空オブジェクトは「絞り込み無し」の `undefined` に正規化し、以降の全箇所が同じ形を見るようにする。
    attributes:
      validatedQuery.attributes !== undefined && Object.keys(validatedQuery.attributes).length > 0
        ? validatedQuery.attributes
        : undefined,
    labels: resolvedLabelsFilter,
    taxonomyGroupCandidates: resolvedTaxonomyGroupCandidates,
  };
  stages.push({
    stage: "scope",
    executed: true,
    detail: {
      subjectId: scope.subjectId ?? null,
      occurredAfter: scope.occurredAfter?.toISOString() ?? null,
      occurredBefore: scope.occurredBefore?.toISOString() ?? null,
      validAt: scope.validAt?.toISOString() ?? null,
      attributes: scope.attributes ?? null,
      labels: scope.labels ?? null,
    },
  });

  const limit = validatedQuery.limit ?? DEFAULT_RECALL_LIMIT;
  const overFetchFactor = validatedQuery.overFetchFactor ?? DEFAULT_OVER_FETCH_FACTOR;
  const kPrime = Math.max(1, Math.round(limit * overFetchFactor));

  const channels = validatedQuery.channels ?? DEFAULT_RECALL_CHANNELS;
  const wantsAnn = channels.includes("ann");
  const wantsLexical = channels.includes("lexical");

  const wallAxisAlive = (memory: Memory): boolean => memory.decayFloorAt > now;

  /**
   * 活動時計の軸。`decayFloorSeq` が NULL ならこの軸には床が無く沈まないので true。`nowSeq` が無い
   * （`decay_clock` が 'wall' で一度も読んでいない）場合も判定できないので、緩い側（true）へ倒す（ADR 0165）。
   */
  const activityAxisAlive = (memory: Memory): boolean => {
    const floorSeq = memory.decayFloorSeq;
    if (floorSeq === undefined || floorSeq === null) return true;
    const effectiveNow = effectiveNowSeqFor(memory);
    if (effectiveNow === undefined) return true;
    return floorSeq > effectiveNow;
  };

  /** 全チャンネル共通の後置フィルタと段1（ANN）の押し下げが、同じ述語を2軸ぶん見る。`'either'` は OR（どちらかが生きていれば通す。最も緩い）。 */
  const survivesDecayGate = (memory: Memory): boolean => {
    if (decayClock === "wall") return wallAxisAlive(memory);
    if (decayClock === "activity") return activityAxisAlive(memory);
    return wallAxisAlive(memory) || activityAxisAlive(memory);
  };

  /**
   * `validAt` ゲートの述語。段1の後置フィルタと段3.5（連想枠）の後置フィルタが同じこの関数を呼ぶ（ADR 0172）。
   * `VectorFilter.validAt` / `LexicalFilter.validAt` が SQL 側で表す述語と同じ境界（左端は包含の `<=`、右端は狭義の `>`）。
   * `scope.validAt` が `undefined`（`includeOutsideValidity: true`）なら no-op。
   * ここでは件数を数えない（exact な件数は `aggregateScope` から取る。`FilteredOmission.condition` の doc）。
   * 述語そのものは `classifyValidity`（`./validity.js`）に集約してあり、`consolidate()`/`reflect()` も呼ぶ。
   */
  const survivesValidityGate = (memory: Memory): boolean => {
    if (scope.validAt === undefined) return true;
    return classifyValidity(memory, scope.validAt) === null;
  };

  /**
   * `subjectId` の後置フィルタ述語（ADR 0286）。段1と段3.5 の後置フィルタが同じこの関数を呼ぶ
   * （実装が2つあると食い違う。ADR 0038）。
   *
   * - `scope.subjectId` が `undefined`（テナント全体）なら常に真。
   * - `memory.subjectId` が一致すれば真。
   * - `scope.includeSubjectless === true` かつ `memory.subjectId` が `null` なら真。
   *
   * adapter が `includeSubjectless` を無視しても安全: 段1の候補には厳密一致する Memory しか来ず、
   * この後置フィルタは絞るだけで、来ていない `subjectId: null` を発生させない（取りこぼしはあっても混入は起きない）。
   */
  const survivesSubjectFilter = (memory: Memory): boolean => {
    if (scope.subjectId === undefined) return true;
    if (memory.subjectId === scope.subjectId) return true;
    return scope.includeSubjectless === true && memory.subjectId === null;
  };

  /**
   * `attributes` の後置フィルタ述語（ADR 0312）。段1と段3.5 が同じこの関数を呼ぶ。
   * AND 等値: `scope.attributes` のキーすべてが同じ値で存在するときだけ真。`undefined` なら常に真。
   * adapter が `VectorFilter.attributes`/`LexicalFilter.attributes` を無視しても、この後置フィルタが絞る
   * （取りこぼしはあっても混入は起きない）。
   */
  const survivesAttributesFilter = (memory: Memory): boolean => {
    if (scope.attributes === undefined) return true;
    const memoryAttributes = memory.attributes ?? {};
    return Object.entries(scope.attributes).every(
      ([key, value]) => memoryAttributes[key] === value,
    );
  };

  /**
   * `labels`（taxonomy）の後置フィルタ述語（ADR 0323）。段1と段3.5 が同じこの関数を呼ぶ。
   * OR: `scope.labels` のいずれかが `tags` に含まれれば真。`undefined` なら常に真。
   * `scope.labels` は参加資格を解決済みの名前だけを持ち、`labels.name` は `tags` からしか作られないので、
   * `memory_labels` を見ずに `tags` だけで判定できる（ADR 0323 決定1）。
   * adapter が無視しても、この後置フィルタが絞る。
   * 必須の同伴取得（段3）ではこの述語を呼ばない（`tags` 自体が同伴取得を素通しするのと同じ理由。ADR 0323 決定3）。
   */
  const survivesLabelsFilter = (memory: Memory): boolean => {
    if (scope.labels === undefined) return true;
    const labels = scope.labels;
    return memory.tags.some((tag) => labels.includes(tag));
  };

  /**
   * `status` の後置検査（ADR 0432）。`VectorFilter.status` は検索の時点でしか効かず、`search()` から `getMany` までの間に
   * `sweepArchive`・`forget`・supersede が入った記憶が混ざる。今の `status` を見て落とす（返す件数が減るだけで、新しい throw は無い）。
   * 落とした件数は数えない: archived・forgotten・superseded は段5の `aggregateScope` が `filtered(...)` として厳密に数えるので、
   * ここで足すと二重計上になる（ADR 0172、ADR 0173）。
   */
  const survivesStatusGate = (memory: Memory): boolean =>
    memory.status === "active" || memory.status === "contested";

  /**
   * 段1（ANN）と段3.5（連想枠）の `VectorFilter` へ渡す、ゲートの欄だけの断片。1箇所で作って両方が同じものを撒く。
   * ゲートを増やすときは、ここに足す（段3.5 だけ取り残されると、減衰しきった記憶や期限切れの記憶が連想枠から返る。ADR 0172）。
   *
   * 式を持たず、欄はすべて `scope` から取る。段5の `aggregateScope` が同じ `scope` を受け取って「ゲートが落とした件数」を
   * 数えるので、押し下げ（ここ）と集約（段5）が構造的に同じ述語を見る。ここに式を書き戻すと、「段1で落ちた数」と
   * 「集約が数えた数」が黙って食い違いうる（ADR 0173）。ゲートを増やすときは、`RecallScope` に欄を足し、ここでその欄を撒き、
   * `aggregateScope` の述語に同じものを足す（3点で1つ）。
   *
   * 後置フィルタの代わりではない。`survivesDecayGate` / `survivesValidityGate` が両段の後置に残っており、
   * adapter が filter を適用する契約（ADR 0034）を守らなかった場合の多層防御になっている。
   */
  const gateVectorFilterFields: Pick<
    VectorFilter,
    | "decayFloorAtAfter"
    | "decayFloorSeqAfter"
    | "decayFloorAnyAxis"
    | "decayFloorSeqUsesSubjectCounters"
    | "validAt"
  > = {
    decayFloorAtAfter: scope.decayFloorAtAfter,
    decayFloorSeqAfter: scope.decayFloorSeqAfter,
    decayFloorAnyAxis: scope.decayFloorAnyAxis,
    decayFloorSeqUsesSubjectCounters: scope.decayFloorSeqUsesSubjectCounters,
    validAt: scope.validAt,
  };

  const decayScoringExtras = (
    memory: Memory,
  ): {
    decayClock: DecayClock;
    nowSeq: number | undefined;
    decayBaseSeq: number | null | undefined;
    halfLifeRecalls: number | null | undefined;
  } => ({
    decayClock,
    nowSeq: effectiveNowSeqFor(memory),
    decayBaseSeq: memory.decayBaseSeq,
    halfLifeRecalls: memory.halfLifeRecalls,
  });

  // 配線されていない語彙チャンネルを明示的に要求されたら投げる（ADR 0084）。黙って0件を返さない:
  // 「探したが無かった」ではなく「探せる状態になっていない」で、degrade させると呼び出し側は
  // 使っているつもりで一度も使えていないことに気づけない。
  const lexicalStore = deps.lexicalStore;
  if (wantsLexical && lexicalStore === undefined) {
    throw new Error(
      LEXICAL_STORE_UNAVAILABLE_ERROR_PREFIX +
        "pass RuntimeDeps.lexicalStore, or drop 'lexical' from RecallQuery.channels",
    );
  }

  const embeddableText = validatedQuery.text?.trim();
  let queryVector = validatedQuery.vector;
  let candidateGenerationExecuted = false;
  let annHits: VectorHit[] = [];
  let lexicalHits: LexicalHit[] = [];
  let lexicalExecuted = false;

  // 「クエリに引ける中身が無い」は段の性質なので、チャンネルが2本走っても omission は1つだけ（ADR 0008）。
  const pushEmptyQuerySkipOnce = (): void => {
    const already = omitted.some(
      (o) =>
        o.kind === "stage_skipped" &&
        o.stage === "candidate_generation" &&
        o.reason === "empty_query_content",
    );
    if (!already) {
      omitted.push({
        kind: "stage_skipped",
        stage: "candidate_generation",
        reason: "empty_query_content",
      });
    }
  };

  if (wantsAnn && queryVector === undefined) {
    if (embeddableText) {
      try {
        const [vector] = await runAbortable(signal, (raced) =>
          deps.embeddingProvider.embed(ctx, [embeddableText], { signal: raced }),
        );
        // ベクトルを返さなかった（`[]`、配列でない要素）ときも「provider が使えない」として名乗る
        // （黙って ANN の段を飛ばさない）。`Float32Array` などの数値の型付き配列も配列と同じく受ける（ADR 0452）。
        const plainVector = toPlainVector(vector);
        if (plainVector === undefined) {
          throw new QueryEmbeddingFailure(
            "no_vector",
            "embedding provider returned no vector for the query",
          );
        }
        // `space.dimensions` と違う長さも `embedding_provider_unavailable` に丸める。vectorStore まで届くと
        // `score_not_comparable` と記録され、理由の名前が provider によって変わる（ADR 0393）。
        if (plainVector.length !== deps.embeddingProvider.space.dimensions) {
          throw new QueryEmbeddingFailure(
            "dimension_mismatch",
            `embedding provider returned a query vector of the wrong dimension: expected ${deps.embeddingProvider.space.dimensions} dimensions, got ${plainVector.length}`,
          );
        }
        // 有限性も同じ（ADR 0393）。
        const badIndex = plainVector.findIndex((x) => !Number.isFinite(x));
        if (badIndex !== -1) {
          throw new QueryEmbeddingFailure(
            "non_finite",
            `embedding provider returned a query vector containing a non-finite value at index ${badIndex} (${String(plainVector[badIndex])})`,
          );
        }
        queryVector = plainVector;
      } catch (err) {
        // abort は `embedding_provider_unavailable` に丸めず投げ直す（ADR 0359）。
        if (isAbort(signal)) {
          throw err;
        }
        omitted.push({
          kind: "stage_skipped",
          stage: "candidate_generation",
          reason: "embedding_provider_unavailable",
          cause: describeQueryEmbeddingFailure(err),
        });
      }
    } else {
      pushEmptyQuerySkipOnce();
    }
  }

  if (wantsAnn && queryVector !== undefined) {
    annHits = await deps.vectorStore.search(ctx, deps.embeddingProvider.space, queryVector, {
      limit: kPrime,
      filter: {
        tenantId: ctx.tenantId,
        status: ["active", "contested"],
        subjectId: scope.subjectId,
        includeSubjectless: scope.includeSubjectless,
        attributes: scope.attributes,
        labels: scope.labels,
        excludeProvenanceKinds: validatedQuery.excludeProvenanceKinds,
        occurredAfter: scope.occurredAfter,
        occurredBefore: scope.occurredBefore,
        // ゲートの欄は `gateVectorFilterFields` から撒く。ここへ直接書き足すと連想枠だけが取り残される（ADR 0172）。
        ...gateVectorFilterFields,
      },
    });
    candidateGenerationExecuted = true;
  }

  // `annStageTrace` に参照を残す: `eligible`（段5の `aggregate` が要る）がまだ計算できず、detail をここで確定できない。
  // 段5の後で同じオブジェクトへキーを追記する（ADR 0285）。
  let annStageTrace: StageTrace | undefined;
  if (wantsAnn) {
    annStageTrace = {
      stage: "candidate_generation",
      executed: candidateGenerationExecuted,
      // decayGate: 適用されたかどうかだけを名乗る。件数は `omitted.filtered(condition:'decayed')`（ADR 0173）。
      // ANN が k' の窓の中で落とした件数ではない（窓の内側は ADR 0011 の限界として不明）。
      detail: {
        channel: "ann",
        kPrime,
        hits: annHits.length,
        decayGate: decayGateActive ? "pushed_down" : "disabled",
        clock: decayClock,
        validityGate: validityGateActive ? "pushed_down" : "disabled",
      },
    };
    stages.push(annStageTrace);
  }

  // 語彙チャンネルは埋め込みを作らない: `channels` が `["lexical"]` だけなら、埋め込み provider を一度も呼ばない。
  if (wantsLexical && lexicalStore !== undefined) {
    if (embeddableText) {
      lexicalHits = await lexicalStore.search(ctx, embeddableText, {
        limit: kPrime,
        filter: {
          tenantId: ctx.tenantId,
          status: ["active", "contested"],
          subjectId: scope.subjectId,
          includeSubjectless: scope.includeSubjectless,
          attributes: scope.attributes,
          labels: scope.labels,
          excludeProvenanceKinds: validatedQuery.excludeProvenanceKinds,
          occurredAfter: scope.occurredAfter,
          occurredBefore: scope.occurredBefore,
          validAt: scope.validAt,
        },
      });
      lexicalExecuted = true;
    } else {
      // vector だけを渡された場合もここへ来る——**ベクタは語彙チャンネルに渡せない。**
      pushEmptyQuerySkipOnce();
    }
    stages.push({
      stage: "candidate_generation",
      executed: lexicalExecuted,
      // `LexicalFilter` は `decayFloorAtAfter` を持たないので、全チャンネル共通の後置フィルタで同じ述語を掛ける
      // （語彙チャンネルだけ減衰しきった記憶が返り続ける非対称を消す。ADR 0153）。
      detail: {
        channel: "lexical",
        kPrime,
        hits: lexicalHits.length,
        decayGate: decayGateActive ? "post_filtered" : "disabled",
        clock: decayClock,
        validityGate: validityGateActive ? "pushed_down" : "disabled",
      },
    });
  }

  // 窓が埋まったかを覚えるだけで、`omitted` へは積まない（ADR 0069）。`annHits.length >= kPrime` は
  // 「スコープが k' 以上ある」としか言わず、損したかを言わない。損失が起こりえたかは、段2〜段4 が終わって
  // k 位の total が出るまで判定できない。判定は `withinLimit` を作った直後の `decideAnnTruncation`。
  const annWindowFilled = candidateGenerationExecuted && annHits.length >= kPrime && kPrime > 0;

  const rawById = new Map<MemoryId, { distance?: number; lexicalCoverage?: number }>();
  const candidateIds: MemoryId[] = [];
  for (const hit of annHits) {
    const found = rawById.get(hit.memoryId);
    if (found === undefined) {
      rawById.set(hit.memoryId, { distance: hit.distance });
      candidateIds.push(hit.memoryId);
    } else if (found.distance === undefined) {
      found.distance = hit.distance;
    }
  }
  for (const hit of lexicalHits) {
    const found = rawById.get(hit.memoryId);
    if (found === undefined) {
      rawById.set(hit.memoryId, { lexicalCoverage: hit.coverage });
      candidateIds.push(hit.memoryId);
    } else if (found.lexicalCoverage === undefined) {
      found.lexicalCoverage = hit.coverage;
    }
  }

  const fetchedMemories =
    candidateIds.length > 0 ? await deps.memoryStore.getMany(ctx, candidateIds) : [];
  const memoriesById = new Map(fetchedMemories.map((m) => [m.id, m]));
  await ensureSubjectSeqs(fetchedMemories);

  const excludeKinds = new Set(validatedQuery.excludeProvenanceKinds ?? []);
  const filteredCandidates: { memory: Memory; distance?: number; lexicalCoverage?: number }[] = [];
  for (const memoryId of candidateIds) {
    const raw = rawById.get(memoryId);
    if (raw === undefined) continue; // 起こらない（candidateIds は rawById から作った）。
    const memory = memoriesById.get(memoryId);
    if (!memory) continue; // getMany は存在しない/クロステナントの id を静かに落とす契約。
    // 後置フィルタ。段1の filter にも同じ述語を渡しているが、ここでも見る: `VectorFilter` は adapter が適用する契約
    // （ADR 0034）でも、正しさの責任は後段にも置く多層防御である。段1の絞りは over-fetch の窓（k'）を無駄にしない最適化。
    // 期間の境界（両端とも包含）は ADR 0039 の規則そのもので、段1へ渡す `VectorFilter.occurredAfter`/`occurredBefore`
    // と同じでなければならない。ここだけ変えると「何が返るか」と「omitted が何と言うか」が食い違う。
    // 落とした分を `filtered` として個別に数えない: 件数は段5の集約から出す（複数経路から出すと食い違う。ADR 0011）。
    if (!survivesSubjectFilter(memory)) continue;
    if (!survivesAttributesFilter(memory)) continue;
    if (!survivesLabelsFilter(memory)) continue;
    if (!survivesStatusGate(memory)) continue;
    const effectiveTime = memory.occurredAt ?? memory.recordedAt;
    if (scope.occurredAfter && effectiveTime < scope.occurredAfter) continue;
    if (scope.occurredBefore && effectiveTime > scope.occurredBefore) continue;
    if (excludeKinds.has(memory.provenance.kind)) continue;
    if (!survivesValidityGate(memory)) continue;
    // 全チャンネル共通の忘却ゲート（ADR 0153）。ANN の候補は段1で押し下げ済みなので、通常はここでは何も落とさない。
    // ここでは数えない: 件数は段5の `aggregateScope` から取る。両方から数えると二重計上になる（ADR 0173）。
    if (decayGateActive && !survivesDecayGate(memory)) {
      continue;
    }
    filteredCandidates.push({
      memory,
      distance: raw.distance,
      lexicalCoverage: raw.lexicalCoverage,
    });
  }

  // -------------------------------------------------------------------
  // 段2: 再スコア（索引不要。docs/recall.md §2 段2・§7）
  // -------------------------------------------------------------------
  const queryTags = validatedQuery.tags ?? [];
  const scored: ScoredCandidate[] = filteredCandidates.map(
    ({ memory, distance, lexicalCoverage }) => {
      const similarity = distance === undefined ? undefined : 1 - distance;
      // adapter が返した rank は流さない: 尺度が adapter ごとに違い、コサイン類似度と比較できない（ADR 0084）。
      // `lexicalMatch` は coverage をそのまま使う（ADR 0092）。
      const lexicalMatch = lexicalCoverage;
      const score = defaultScoringStrategy({
        now,
        similarity,
        lexicalMatch,
        tags: memory.tags,
        queryTags,
        occurredAt: memory.occurredAt,
        recordedAt: memory.recordedAt,
        lastReinforcedAt: memory.lastReinforcedAt,
        strength: memory.strength,
        halfLifeHours: memory.halfLifeHours,
        // 省略時は `undefined` のまま渡し、`defaultScoringStrategy` が解決する（既定値の唯一の出所は scoring.ts）。
        timeWeighting: validatedQuery.timeWeighting,
        ...decayScoringExtras(memory),
      });
      return {
        memory,
        retrievedVia: distance === undefined ? ("lexical" as const) : ("ann" as const),
        score,
      };
    },
  );
  scored.sort(compareScoredCandidates);

  const scoreThreshold = validatedQuery.scoreThreshold ?? DEFAULT_SCORE_THRESHOLD;
  const partition = partitionByThreshold(scored, scoreThreshold);
  const { passed, belowThreshold, notComparable } = partition;
  // `'exact'` をリテラルで書かない（ADR 0044）。
  const rescoreCountKind = countKindForPartition(partition, scored.length);

  if (belowThreshold.length > 0) {
    omitted.push({
      kind: "below_threshold",
      count: belowThreshold.length,
      countKind: rescoreCountKind,
      nearMisses: belowThreshold
        .slice(0, 5)
        .map((c) => ({ memoryId: c.memory.id, score: c.score.total })),
    });
  }

  if (notComparable.length > 0) {
    omitted.push({
      kind: "score_not_comparable",
      count: notComparable.length,
      countKind: rescoreCountKind,
    });
  }

  const withinLimit = passed.slice(0, limit);
  const overLimit = passed.slice(limit);
  if (overLimit.length > 0) {
    omitted.push({
      kind: "over_limit",
      stage: "rescore",
      count: overLimit.length,
      countKind: rescoreCountKind,
    });
  }

  // `ann_truncated` の判定は段1ではなくここで行う: 比較の基準になる「k 位の total」は、閾値と limit を通したあとにしか無い（ADR 0069）。
  if (annWindowFilled && lexicalExecuted) {
    // 語彙チャンネルが走った run では ADR 0069 の上界が前提として成り立たない
    // （`ANN_TRUNCATION_UNDECIDABLE_LEXICAL_ACTIVE` の doc）。判定を試みずに判定不能と名乗る。
    // 試みて `provably_safe` が返ると、成り立っていない前提の上で沈黙することになる。
    omitted.push({
      kind: "ann_truncated",
      countKind: "unknown",
      certainty: "undecidable",
      undecidableReason: ANN_TRUNCATION_UNDECIDABLE_LEXICAL_ACTIVE,
    });
  } else if (annWindowFilled) {
    const lastAnnHit = annHits[annHits.length - 1];
    const verdict = decideAnnTruncation({
      strategy: defaultScoringStrategy,
      queryTags,
      // 段2が `1 - distance` で similarity を作っているのと同じ変換にする。別の式だと判定と実際のスコアが食い違う。
      lastAnnSimilarity: lastAnnHit === undefined ? Number.NaN : 1 - lastAnnHit.distance,
      lastReturnedTotal:
        withinLimit.length >= limit ? (withinLimit[limit - 1]?.score.total ?? null) : null,
      scoreThreshold,
    });
    // `provably_safe` のときは何も積まない。沈黙は値ではなく不在で表す（積むと `undecidable` と同じ形になる）。
    if (verdict.kind === "loss_possible") {
      omitted.push({
        kind: "ann_truncated",
        countKind: "unknown",
        certainty: "loss_possible",
        safetyRatio: verdict.safetyRatio,
        assumptions: verdict.assumptions,
      });
    } else if (verdict.kind === "undecidable") {
      omitted.push({
        kind: "ann_truncated",
        countKind: "unknown",
        certainty: "undecidable",
        undecidableReason: verdict.reason,
      });
    }
  }

  // 語彙チャンネルの打ち切り（ADR 0084）。`ann_truncated` と同じ札に潰さない: あちらは損失可能性の判定まで作り込んだ札で、こちらにその機構は無い。
  if (lexicalExecuted && kPrime > 0 && lexicalHits.length >= kPrime) {
    omitted.push({ kind: "lexical_truncated", countKind: "unknown" });
  }

  stages.push({
    stage: "rescore",
    executed: filteredCandidates.length > 0,
    detail: {
      scored: scored.length,
      passedThreshold: passed.length,
      notComparable: notComparable.length,
      withinLimit: withinLimit.length,
    },
  });

  const presentIds = new Set(withinLimit.map((c) => c.memory.id));
  const contestedNeedingCompanion = withinLimit.filter(
    (c) =>
      c.memory.status === "contested" &&
      c.memory.contestedWithId &&
      !presentIds.has(c.memory.contestedWithId),
  );
  // 必須の同伴取得は `getMany` だけで候補を取るので、ANN/語彙の後置フィルタを経由しない。`survivesAttributesFilter` を通して、
  // 絞り込みの外に在る Memory が同伴として紛れ込まないようにする（ADR 0312）。落とすと、下の単位組み立てが
  // 「対向が見つからない contested」と同じ扱いで対象の contested 候補ごと単位に含めない（`unit_assembly_dropped`）。
  // 規則は `fetchMandatoryCompanions` の doc を見ること。段3.5 と共有しており、ここで書き直さない。
  const companions: ScoredCandidate[] = await fetchMandatoryCompanions(
    ctx,
    deps.memoryStore,
    contestedNeedingCompanion,
    now,
    queryTags,
    validatedQuery.timeWeighting,
    decayScoringExtras,
    survivesAttributesFilter,
    ensureSubjectSeqs,
  );

  // 多者間の `contested` 群の同伴取得（ADR 0292、ADR 0381）。`contestedWithId` を持たない `contested`
  // （3件以上の群のメンバー）は、上の `fetchMandatoryCompanions`（`contestedWithId` の直接参照だけを見る2者専用の規則）では拾えない。
  // `resolveContestedGroup?` の CAS が群を関係の行で連結した全員として扱うのに揃え、`RelationStore.listRelated` を幅優先で辿る。
  //
  // - `deps.relationStore` が無ければ、そのような候補が実際に在るときだけ `stage_skipped { stage: "relation", ... }` を積む。
  // - `status !== 'contested'` の id（群を離れたメンバー）は、辺を記録しても、そこから先は辿らない。
  // - 処理順は id の昇順に固定する（`related` も次の段の frontier も）。`listRelated`・`getMany` の返す順は契約が規定せず、
  //   同じ段で複数の親から届く companion の `companionOf` を「id の小さい親」に決定的にするため。
  // - 群ごとに探索し、群ごとに切る。全体を合わせた数で切ると、後から見つかった群が丸ごと落ちる。
  // - 切った分は群ごとに1件の `over_limit { stage: "relation" }` に積む。探索が尽きていれば `countKind: "exact"`、
  //   安全弁で打ち切ったなら `"lower_bound"`（その先に候補が在るかもしれない）。
  const groupOwners = withinLimit.filter(
    (c) => c.memory.status === "contested" && (c.memory.contestedWithId ?? null) === null,
  );
  const relationEdges = new Map<MemoryId, Set<MemoryId>>();
  const addRelationEdge = (a: MemoryId, b: MemoryId): void => {
    if (!relationEdges.has(a)) relationEdges.set(a, new Set());
    relationEdges.get(a)!.add(b);
    if (!relationEdges.has(b)) relationEdges.set(b, new Set());
    relationEdges.get(b)!.add(a);
  };
  const groupCompanions: ScoredCandidate[] = [];
  // 段3.5 の連想の候補から外す、`relationMaxCount` を超えて切った群のメンバーの id（同じ記憶を連想側でもう一度数えない。ADR 0494）。
  const relationOverLimitIds = new Set<MemoryId>();
  // 切られた id → その群の `over_limit(relation)`（同じ参照）。段3.5 の必須の同伴取得が切られた候補を取り戻したとき、その群の count から差し引く。
  const relationOverLimitEntryById = new Map<MemoryId, OverLimitOmission>();
  if (groupOwners.length > 0) {
    if (deps.relationStore === undefined) {
      omitted.push({
        kind: "stage_skipped",
        stage: "relation",
        reason: "relation_store_unavailable",
      });
    } else {
      const relationStore = deps.relationStore;
      const presentAfterPairs = new Set([...presentIds, ...companions.map((c) => c.memory.id)]);
      // 訪れた id の上限（探索自体を止める安全弁）。`maxCount` の10倍は「上限より遥かに多く辿れば、validFrom 最新の maxCount 件を
      // ほぼ確実に含む」という実務的な安全域で、厳密な保証ではない。超える巨大な群は `countKind` を `"lower_bound"` に倒す
      // （ADR 0292、ADR 0396）。
      const relationMaxCount =
        validatedQuery.relationMaxCount ?? DEFAULT_RECALL_ASSOCIATION.maxCount;
      const EXPLORATION_VISIT_LIMIT = relationMaxCount * 10;
      // どれかの群の探索で既に訪れた id。同じ群の owner が複数候補に居ても2回目は探索しない。
      const visitedAll = new Set<MemoryId>();
      // 発見元（どの id から最初に辿り着いたか）。`companionOf` に使う。複数ホップ先の companion でも説明可能性の欄を空にしない（ADR 0381）。
      const discoveredVia = new Map<MemoryId, MemoryId>();
      // 上限と探索の安全弁は群ごとに効かせる。全体を合わせた数で切ると、後から見つかった群が丸ごと落ちて、
      // 対立する記憶を並べて出す約束が群の見つかった順で破れる（ADR 0381）。
      for (const owner of groupOwners) {
        if (visitedAll.has(owner.memory.id)) continue;
        visitedAll.add(owner.memory.id);
        const groupVisited = new Set<MemoryId>([owner.memory.id]);
        let frontier: MemoryId[] = [owner.memory.id];
        const discoveredMemories: Memory[] = [];
        let explorationTruncated = false;
        while (frontier.length > 0 && !explorationTruncated) {
          const nextIds: MemoryId[] = [];
          // `RelationStore.listRelatedMany?` があれば、この段の frontier を1往復で取る（ADR 0402）。どちらでも、下の処理は同じ順に
          // 同じことをする（安全弁で止まった位置より後ろの起点の結果は捨て、辺も記録しない）。
          const batched = await listRelatedManyIfSupported(
            relationStore,
            ctx,
            frontier,
            "contradicts",
          );
          for (const [frontierIndex, id] of frontier.entries()) {
            if (explorationTruncated) break;
            // `listRelated` の返す順は契約が規定しない。`memoryId` の昇順に並べ、複数の親から届く companion の発見元を
            // 「id の小さい親」に決定的にする。比較は `compareByValidFromDescThenId` と同じ文字列比較
            // （Postgres の uuid 列と `getMany` は小文字で返すので、綴りの揺れで順が変わらない）。
            const fetched =
              batched?.[frontierIndex] ?? (await relationStore.listRelated(ctx, id, "contradicts"));
            const related = [...fetched].sort((x, y) => compareIds(x.memoryId, y.memoryId));
            for (const r of related) {
              addRelationEdge(id, r.memoryId);
              if (groupVisited.has(r.memoryId) || visitedAll.has(r.memoryId)) continue;
              // 1件たどるごとに安全弁を確かめる（訪れた数が EXPLORATION_VISIT_LIMIT を超えないように）。
              if (groupVisited.size >= EXPLORATION_VISIT_LIMIT) {
                explorationTruncated = true;
                break;
              }
              groupVisited.add(r.memoryId);
              visitedAll.add(r.memoryId);
              discoveredVia.set(r.memoryId, id);
              nextIds.push(r.memoryId);
            }
          }
          if (nextIds.length === 0) break;
          const fetchedLevel = await deps.memoryStore.getMany(ctx, nextIds);
          const nextFrontier: MemoryId[] = [];
          for (const m of fetchedLevel) {
            if (m.status !== "contested") {
              // 今の status の門: 群を離れたメンバーからは先を探索しない。
              continue;
            }
            nextFrontier.push(m.id);
            if (!presentAfterPairs.has(m.id)) {
              discoveredMemories.push(m);
            }
          }
          // `getMany` の返す順も規定されない。次の段の親の処理順を id 昇順に固定する（先に処理した親が発見元になる）。
          frontier = nextFrontier.sort(compareIds);
        }
        if (discoveredMemories.length === 0) continue;
        const eligible = discoveredMemories.filter((m) => survivesAttributesFilter(m));
        const sorted = [...eligible].sort(compareByValidFromDescThenId);
        const capped = sorted.slice(0, relationMaxCount);
        const overLimitRelationCount = sorted.length - capped.length;
        for (const cut of sorted.slice(relationMaxCount)) relationOverLimitIds.add(cut.id);
        if (overLimitRelationCount > 0) {
          const relationEntry: OverLimitOmission = {
            kind: "over_limit",
            stage: "relation",
            count: overLimitRelationCount,
            countKind: explorationTruncated ? "lower_bound" : "exact",
          };
          omitted.push(relationEntry);
          for (const cut of sorted.slice(relationMaxCount)) {
            relationOverLimitEntryById.set(cut.id, relationEntry);
          }
        }
        await ensureSubjectSeqs(capped);
        for (const companionMemory of capped) {
          // 発見元をそのまま `companionOf` に使う。owner 自身でも他の companion 経由でも「実際に辿った経路上の1つ前の id」で同じ意味（ADR 0381）。
          const companionOf = discoveredVia.get(companionMemory.id);
          const score = defaultScoringStrategy({
            now,
            tags: companionMemory.tags,
            queryTags,
            occurredAt: companionMemory.occurredAt,
            recordedAt: companionMemory.recordedAt,
            lastReinforcedAt: companionMemory.lastReinforcedAt,
            strength: companionMemory.strength,
            halfLifeHours: companionMemory.halfLifeHours,
            timeWeighting: validatedQuery.timeWeighting,
            ...decayScoringExtras(companionMemory),
          });
          groupCompanions.push({
            memory: companionMemory,
            retrievedVia: "mandatory_companion",
            companionOf,
            score,
          });
        }
      }
    }
  }
  const allCompanions = [...companions, ...groupCompanions];

  stages.push({
    stage: "contradiction_resolution",
    executed: true,
    detail: { companionsAdded: allCompanions.length },
  });

  // 隣接性の不変条件（docs/memory-model.md §5 機構3）: 対向関係にある Memory は提示順で必ず隣接させる。
  // 単位（Unit）を組み、budget 切り詰め（段4）は単位ごとに行う（ペアを分割しない。docs/recall.md §8）。
  const allCandidates = [...withinLimit, ...allCompanions];
  const byId = new Map(allCandidates.map((c) => [c.memory.id, c]));
  const consumed = new Set<MemoryId>();
  const units: Unit[] = [];
  for (const candidate of withinLimit) {
    if (consumed.has(candidate.memory.id)) continue;
    consumed.add(candidate.memory.id);
    const companionId = candidate.memory.contestedWithId ?? null;
    const companion =
      companionId !== null && !consumed.has(companionId) ? byId.get(companionId) : undefined;
    if (companion && companion.retrievedVia === "mandatory_companion") {
      consumed.add(companion.memory.id);
      units.push({ members: [candidate, companion], rankScore: candidate.score.total });
    } else if (companion) {
      consumed.add(companion.memory.id);
      units.push({
        members: [candidate, companion],
        rankScore: Math.max(candidate.score.total, companion.score.total),
      });
    } else if (candidate.memory.status === "contested" && companionId === null) {
      // `contestedWithId` を持たない contested: 多者間の群のメンバー、または対向を持たない壊れた contested。
      // `relationEdges` を辿って、この recall の候補集合に実在する仲間を集める（ADR 0381）。
      const componentIds = collectGroupComponent(candidate.memory.id, relationEdges, byId);
      if (componentIds.length > 1) {
        // 見せる順: 起点を先頭に、残りは `validFrom` の新しい順→id の順。`collectGroupComponent` がたどる順は
        // 関係の行の挿入順や store の返し方で変わりうるので、見せる順には使わない。
        const [head, ...rest] = componentIds.map((id) => byId.get(id)!);
        const members = [
          head!,
          ...rest.sort((x, y) => compareByValidFromDescThenId(x.memory, y.memory)),
        ];
        for (const member of members) {
          consumed.add(member.memory.id);
        }
        units.push({
          members,
          rankScore: Math.max(...members.map((m) => m.score.total)),
        });
      }
      // 仲間が見つからなかった（自分だけ。`relationStore` 未配線、関係の行が無い場合を含む）ときは、
      // 下の「対向が見つからない contested」と同じく単位を組まず consumed のまま落とす（`unitAssemblyShortfall` が検出する）。
    } else if (candidate.memory.status === "contested") {
      // 対向が見つからない `contested`（`contestedWithId` は在るが companion が見つからない/不適格）は、単位を組まず
      // consumed のまま落とす。`unitAssemblyShortfall` が検出し、`unit_assembly_dropped` として報告される。
      // 争われている主張を、争われていない顔で単独で出すくらいなら、何も出さない（ADR 0136、docs/recall.md §8）。
    } else {
      units.push({ members: [candidate], rankScore: candidate.score.total });
    }
  }
  units.sort((a, b) => b.rankScore - a.rankScore);
  // 段4の件数がどれだけ正確かは、この時点で決まっている（ADR 0045）。
  const unitsCountKind = countKindForUnits(units, allCandidates.length);

  // 単位を組む繰り返しから候補が漏れたら黙らない（ADR 0043）。
  // 今日この分岐が通るのは、`MemoryStore` を `Runtime` を経由せず直接叩いた場合（`updateStatus(id, "contested")` 単体など。
  // ADR 0046）か、`Runtime.forget()` が片側だけを `forgotten` にして対向の `contested` が残った場合（ADR 0087。
  // 段3が引く companion の status 検査で弾かれ、単独の contested を落とす分岐へ合流する）に限る。
  // 二重計上のときに出さない判断は `unitAssemblyShortfall` が持つ。
  const unitsShortfall = unitAssemblyShortfall(units, allCandidates.length);
  if (unitsShortfall > 0) {
    omitted.push({
      kind: "unit_assembly_dropped",
      count: unitsShortfall,
      // 二重計上が同時に起きていれば、その分だけ消失が隠れる。⟹ 下限しか言えない。
      countKind: "lower_bound",
    });
  }

  // 段3.5: 連想（既定 on、`null` で明示的に off。docs/recall.md §9、ADR 0151、ADR 0337）。
  // クエリで引けた記憶（アンカー）の近傍を、アンカーを起点に同じコサイン類似度で引く。
  //
  // 段1ではなく段3の隣に置く理由: 連想の候補は定義上クエリに当たらないので、段1に置くと必ず段2の
  // `below_threshold` で落ちる。「スコアに関係なく候補へ足す」経路は段3（必須の同伴取得）が既に持っており、
  // 連想はその一般化である。
  const associationQuery =
    validatedQuery.association === null
      ? undefined
      : (validatedQuery.association ?? DEFAULT_RECALL_ASSOCIATION);
  const associationUnits: Unit[] = [];
  // 段2で `over_limit(stage:"rescore")` に回された候補が、段3.5 の候補プールに入ったが席に着けなかった場合の id
  // （過取得の窓の外に居た分と、`rankedCandidates` には居たが `selectedCandidates` に入らなかった分）。
  // 下の `overLimitAssociationCount` が数えている集合そのもので、別の基準を作らない（ADR 0203）。
  const overLimitAssociationSeatlessIds = new Set<MemoryId>();
  // 段3.5 で席に着いたが、対向が取れずに Unit ごと落ちた（`unit_assembly_dropped` に数えた）候補の id。
  // 下の排他性の後処理が、段2の札から差し引くのに使う。
  const associationAssemblyDroppedIds = new Set<MemoryId>();
  // 段3.5 の trace。`stages.push` はこのブロックを抜けたところで1回だけ行う。off のときは push 自体をしない
  // （`candidate_generation` のチャンネルが要求されていないときに trace を積まないのと同じ。docs/recall.md §2）。
  let associationExecuted = false;
  const associationDetail = { anchors: 0, hits: 0, selected: 0 };
  if (associationQuery !== undefined) {
    if (deps.vectorStore.getVectors === undefined) {
      // 連想を求めているのに、adapter が `getVectors?` に対応していない。
      omitted.push({
        kind: "stage_skipped",
        stage: "association",
        reason: "vector_store_lacks_get_vectors",
      });
    } else {
      // `.bind` で `this` を固定してから切り出す: `FakeVectorStore.getVectors` のような通常のクラスメソッドは、
      // `const f = obj.method; f(...)` の形で呼ぶと `this` が外れる。
      const getVectors = deps.vectorStore.getVectors.bind(deps.vectorStore);
      const anchorCount = associationQuery.anchorCount ?? DEFAULT_ASSOCIATION_ANCHOR_COUNT;
      const minSimilarity = associationQuery.minSimilarity ?? DEFAULT_ASSOCIATION_MIN_SIMILARITY;
      // アンカーは「クエリに実際に当たった」候補（`withinLimit`）から取る。`companions` を起点にすると、
      // クエリに当たっていない候補からさらに連想する不透明な連鎖になる。
      const anchors = withinLimit.slice(0, anchorCount);
      associationDetail.anchors = anchors.length;
      if (anchors.length === 0) {
        omitted.push({ kind: "stage_skipped", stage: "association", reason: "no_anchor" });
      } else {
        // 「探して0件だった」場合も含め、実際に検索まで進んだこと自体を `true` として名乗る（`rescore` と同じ約束。docs/recall.md §2）。
        associationExecuted = true;
        const anchorIds = anchors.map((a) => a.memory.id);
        const anchorVectorList = await getVectors(ctx, deps.embeddingProvider.space, anchorIds);
        // `VectorStore.getVectors` は返す順序が `memoryIds` と一致しなくてよい契約。`memoryId` をキーに引き直し、
        // `anchorIds`（スコア降順で確定済み）の順で処理する。`anchorVectorList` を直接 for-of すると、複数アンカーの近傍が
        // 重なったとき「最初に当たったアンカー」が adapter の返す順序（Postgres ではランダムな UUID の主キー順）に左右され、
        // ingest のたびに結果が変わる（ADR 0167）。
        const anchorVectorById = new Map(anchorVectorList.map((v) => [v.memoryId, v]));
        // 除外集合: 既に返る集合（`withinLimit` + `allCompanions`）、`relationMaxCount` で切った群のメンバー、アンカー自身。
        const excludeIds = new Set<MemoryId>([
          ...withinLimit.map((c) => c.memory.id),
          ...allCompanions.map((c) => c.memory.id),
          ...relationOverLimitIds,
          ...anchorIds,
        ]);
        // 複数アンカーから同じ記憶が浮上しても、`associationOf` は最初に当たったアンカーだけを記録する（ADR 0151）。
        // 「最初」は `anchorIds`（スコア降順）の順で決め、adapter の返す順序には依存しない。
        const seen = new Set<MemoryId>();
        const associationHits: { memoryId: MemoryId; anchorId: MemoryId; similarity: number }[] =
          [];
        // 段1の ANN 検索と同一の境界の filter で呼ぶ（忘却ゲートと `validAt` ゲートを含む）。ゲートは `gateVectorFilterFields` から
        // そのまま撒き、列挙を散文で数え直さない（数え直した結果、2つのゲートが抜けたことがある。ADR 0172）。
        // `limit` は over-fetch 済みの `kPrime` を流用する（除外・閾値で落ちる分の余裕。新しい係数を定義しない）。
        // この filter はどのアンカーに対しても同一の値（アンカーごとに変わるのはクエリベクトルだけ）なので、
        // `VectorStore.searchMany?` に過不足なく渡せる。束ねる/束ねない両方の経路で同じオブジェクトを使う。
        const associationFilter: VectorFilter = {
          tenantId: ctx.tenantId,
          status: ["active", "contested"],
          subjectId: scope.subjectId,
          includeSubjectless: scope.includeSubjectless,
          attributes: scope.attributes,
          labels: scope.labels,
          excludeProvenanceKinds: validatedQuery.excludeProvenanceKinds,
          occurredAfter: scope.occurredAfter,
          occurredBefore: scope.occurredBefore,
          ...gateVectorFilterFields,
        };
        // adapter が返さなかったアンカーは、束ねる/束ねないどちらの経路でも検索対象から外す。
        const anchorsWithVectors: { anchorId: MemoryId; vector: number[] }[] = [];
        for (const anchorId of anchorIds) {
          const anchor = anchorVectorById.get(anchorId);
          if (anchor) anchorsWithVectors.push({ anchorId, vector: anchor.vector });
        }
        const hitsByAnchorId = new Map<MemoryId, VectorHit[]>();
        if (deps.vectorStore.searchMany !== undefined && anchorsWithVectors.length > 0) {
          // 全アンカーを1回の往復（`searchMany`）に束ねる。`.bind` で `this` を固定する（`getVectors` と同じ理由）。
          const searchMany = deps.vectorStore.searchMany.bind(deps.vectorStore);
          const hitsByKey = await searchMany(
            ctx,
            deps.embeddingProvider.space,
            anchorsWithVectors.map(({ anchorId, vector }) => ({ key: anchorId, vector })),
            { limit: kPrime, filter: associationFilter },
          );
          for (const { anchorId } of anchorsWithVectors) {
            // `VectorStore.searchMany?` の契約で、渡した key は必ず Map に現れる。`?? []` はその契約が破られた場合の多層防御。
            hitsByAnchorId.set(anchorId, hitsByKey.get(anchorId) ?? []);
          }
        } else {
          // adapter が `searchMany` を実装していない経路（往復数はアンカー数に比例するが、結果は束ねた場合と同じ。ADR 0151）。
          for (const { anchorId, vector } of anchorsWithVectors) {
            const hits = await deps.vectorStore.search(ctx, deps.embeddingProvider.space, vector, {
              limit: kPrime,
              filter: associationFilter,
            });
            hitsByAnchorId.set(anchorId, hits);
          }
        }
        for (const anchorId of anchorIds) {
          const hits = hitsByAnchorId.get(anchorId);
          if (!hits) continue; // adapter が返さなかった（存在しない/削除された等）
          for (const hit of hits) {
            if (excludeIds.has(hit.memoryId) || seen.has(hit.memoryId)) continue;
            const similarity = 1 - hit.distance;
            if (!(similarity >= minSimilarity)) continue;
            seen.add(hit.memoryId);
            associationHits.push({
              memoryId: hit.memoryId,
              anchorId,
              similarity,
            });
          }
        }
        // アンカーとの類似度降順に並べる。同点のときは、明示のタイブレークを足さず `vectorStore.search()` の返す順に委ねる
        // （`Array.prototype.sort` は安定なので `associationHits` の挿入順が保たれる。ADR 0170）。
        // `VectorStore.search()` が同点時の順序まで adapter の責務と定めており、ここに memoryId 等での再タイブレークを重ねると、
        // adapter が確定した意味のある順序（`recorded_at` に基づく）を無関係な UUID の辞書順で上書きしてしまう。
        // 段2の `scored.sort` と違う選択: あちらは `lexical` の tie-break が不完全なので多層防御を足したが、こちらは Memory を
        // 取得する前で `occurredAt`/`recordedAt` を持たず、足すには追加の DB 往復が要る。
        // この sort 自体は変えない: 下の過取得の前置きを決める順序であり、同点時に adapter へ委ねる規律の土台でもある。
        // 席をどう埋めるかは、この sort の後で決める。`NaN` だけを最後尾へ送る。
        associationHits.sort((a, b) => compareDescendingNaNLast(a.similarity, b.similarity));
        associationDetail.hits = associationHits.length;
        // 席を埋める前に過取得する（段1の kPrime と同じ理由・同じ係数 `overFetchFactor`）。
        // `Math.max` で下限を `maxCount` に留めるのは、`overFetchFactor < 1` で返る件数が減る退行を防ぐため。
        const rankFetchCount = Math.max(
          associationQuery.maxCount,
          Math.round(associationQuery.maxCount * overFetchFactor),
        );
        const rankFetchHits = associationHits.slice(0, rankFetchCount);
        const associationMemories =
          rankFetchHits.length > 0
            ? await deps.memoryStore.getMany(
                ctx,
                rankFetchHits.map((h) => h.memoryId),
              )
            : [];
        const associationMemoriesById = new Map(associationMemories.map((m) => [m.id, m]));
        // 段1と同じ理由で、先に `ensureSubjectSeqs` を呼ぶ（ADR 0353）。
        await ensureSubjectSeqs(associationMemories);
        // 席は「アンカー類似度 × decay × tagMatch × freshness × strength」の順位で埋める。アンカー類似度だけで埋めると、
        // decay/strength 等が席の取り合いに効かない。`rankedCandidates` は、下の多層防御を生き延び順位が組める候補だけを持つ。
        // 順位キーは `hit.similarity` と `score.total` の積。
        const rankedCandidates: {
          hit: (typeof rankFetchHits)[number];
          memory: Memory;
          score: ScoreBreakdown;
          rankKey: number;
        }[] = [];
        for (const hit of rankFetchHits) {
          const memory = associationMemoriesById.get(hit.memoryId);
          // スコアを組めない（順位キーが作れない）候補は順位にも載せない。
          if (!memory) continue;
          // 多層防御: `VectorFilter` は adapter が適用する契約（ADR 0034）でも、ここでも見る。
          // この防御は席が決まる前に走るので、落ちた分は別の候補が埋める（`maxCount` は超えない）。
          // adapter が契約を破ったときにだけ落とすので、何件増えるかは測っていない。
          if (!survivesSubjectFilter(memory)) continue;
          if (!survivesAttributesFilter(memory)) continue;
          if (!survivesLabelsFilter(memory)) continue;
          // ADR 0432 AL-1: 段1と同じ述語（`survivesStatusGate`）。ここでも数えない。
          if (!survivesStatusGate(memory)) continue;
          const effectiveTime = memory.occurredAt ?? memory.recordedAt;
          if (scope.occurredAfter && effectiveTime < scope.occurredAfter) continue;
          if (scope.occurredBefore && effectiveTime > scope.occurredBefore) continue;
          if (excludeKinds.has(memory.provenance.kind)) continue;
          // 段1の後置ループと同じ述語（`survivesValidityGate` / `survivesDecayGate`）を呼ぶ。ここで述語を書き直すと、
          // 段1と段3.5 の境界が食い違う（ADR 0172）。`includeFullyDecayed: true` の opt-out は連想枠でも効く。
          // `survivesDecayGate` は 'activity'/'either' のテナントでは活動時計の軸も見る。壁時計だけを見る述語を書き下すと、
          // 連想枠だけが壁時計のまま取り残される（ADR 0165）。
          //
          // 落ちた件数はここでは数えない。連想用 `search()` も同じ欄を押し下げているので、通常この後置は1件も落とさず、
          // 落ちるのは adapter が ADR 0034 の契約を破ったときだけ。件数は段5の `aggregateScope` が名乗る（`countKind: "exact"`）。
          // 集約が数えるのは「scope 内で減衰しきっていた件数」という集合の大きさで、どの段が落としたかではないので、
          // 数えるのは段5の1箇所だけでなければならない。ここや段1の後置で足し込むと二重計上になる（ADR 0173）。
          if (!survivesValidityGate(memory)) continue;
          if (decayGateActive && !survivesDecayGate(memory)) continue;
          // アンカーとの類似度を `score.similarity`（クエリとの類似度の枠）に入れない: 嘘になる（ADR 0151）。
          // `mandatory_companion`（段3）と同じく similarity/lexicalMatch を渡さず、decay × tagMatch × freshness × strength だけで
          // スコアする（affinity は中立の1に退化する。`strategies/scoring.ts`）。スコアを合成しない規約を引き継ぐ。
          const score = defaultScoringStrategy({
            now,
            tags: memory.tags,
            queryTags,
            occurredAt: memory.occurredAt,
            recordedAt: memory.recordedAt,
            lastReinforcedAt: memory.lastReinforcedAt,
            strength: memory.strength,
            halfLifeHours: memory.halfLifeHours,
            timeWeighting: validatedQuery.timeWeighting,
            ...decayScoringExtras(memory),
          });
          // 席の取り合いは `hit.similarity`（アンカーとの近さ）と `score.total` の積で決める。
          // この積は返り値の `score` には出さない（`score.similarity` を偽らない）。保つのはこのローカルな `rankKey` だけ。
          rankedCandidates.push({ hit, memory, score, rankKey: hit.similarity * score.total });
        }
        // 順位キーで並べ替え、maxCount 件だけ席を埋める。`sort` は安定なので、同点は `rankFetchHits` の順を保つ。
        // `NaN`（ゼロベクトル由来。ADR 0040）だけを最後尾へ送る。
        rankedCandidates.sort((a, b) => compareDescendingNaNLast(a.rankKey, b.rankKey));
        const selectedCandidates = rankedCandidates.slice(0, associationQuery.maxCount);
        associationDetail.selected = selectedCandidates.length;
        // 席に着けなかった分を over_limit として名乗る（ADR 0188）。`associationHits` は既にゲート・除外集合・minSimilarity を
        // 通過した候補集合そのもので、DB へ問い合わせ直さないので、捨てた件数は JS 側で確定しており `countKind: "exact"`。
        //
        // 数えるのは「`associationHits.slice(maxCount)` の長さ」ではなく、次の2つの和である:
        //   (a) 過取得の窓の外に居た候補（`associationHits.length - rankFetchHits.length`）。
        //   (b) 順位付けに上がって席を競り負けた分（`rankedCandidates.length - selectedCandidates.length`）。
        // 席を `similarity × score.total` の順位で埋めるので、類似度順では maxCount 位より後ろの候補が席に着くことがある。
        // 類似度順の長さのまま数えると、返した記憶を「席に着けなかった」と名乗ってしまう（ADR 0203 が `below_threshold` で閉じた穴と同族）。
        // `over_limit` は memoryId を持たないので個体単位では検出できず、数え方の側で閉じる。
        // 多層防御（上の `survivesValidityGate`/`survivesDecayGate` ほか）で落ちた分はどちらにも入れない:
        // 段5の `aggregateScope` が `filtered(...)` として数えており、足すと二重計上になる（ADR 0172、ADR 0173）。
        const overLimitAssociationCount =
          associationHits.length -
          rankFetchHits.length +
          (rankedCandidates.length - selectedCandidates.length);
        if (overLimitAssociationCount > 0) {
          omitted.push({
            kind: "over_limit",
            stage: "association",
            count: overLimitAssociationCount,
            countKind: "exact",
          });
        }
        // 上の (a)(b) と同じ2つの内訳を id で積み直す。後段で「段2の `overLimit` に居て、ここで
        // `over_limit(stage:"association")` に数えられた」候補を id で突き合わせる唯一の材料になる（ADR 0203）。
        const selectedCandidateIds = new Set(selectedCandidates.map((c) => c.memory.id));
        for (const hit of associationHits.slice(rankFetchCount)) {
          overLimitAssociationSeatlessIds.add(hit.memoryId);
        }
        for (const candidate of rankedCandidates) {
          if (!selectedCandidateIds.has(candidate.memory.id)) {
            overLimitAssociationSeatlessIds.add(candidate.memory.id);
          }
        }
        // 連想枠が選んだ contested な候補にも、段3と同じ必須の同伴取得規則をかける（`fetchMandatoryCompanions`）。
        // 対向が取れなければ、その contested 候補ごと Unit を組まず落とす: 争われている主張を、
        // 争われていない顔で単独で出さない（docs/recall.md §8、ADR 0151）。
        //
        // 対向が既に他の経路で結果集合に含まれる場合は新しく取得しない（同じ Memory を2回返して
        // `memories`/`omitted` の排他性を壊さないため）:
        // (a) 段3の結果（`units`）に既に居る。`excludeIds` が連想の候補生成から除外しているので理論上は到達しないが、多層防御として残す。
        // (b) 連想枠自身が両側を選んでいた（別々のアンカーから浮上した場合）。新規取得せず、2件を1つの Unit にまとめて
        //     段4で分割されないようにする（`retrievedVia` は書き換えない）。
        const unitsMemberIds = new Set(units.flatMap((u) => u.members.map((m) => m.memory.id)));
        const selectedById = new Map(selectedCandidates.map((c) => [c.memory.id, c]));
        const asAssociationMember = (c: (typeof selectedCandidates)[number]): ScoredCandidate => ({
          memory: c.memory,
          retrievedVia: "association" as const,
          associationOf: c.hit.anchorId,
          score: c.score,
        });

        const needingCompanionFetch: ScoredCandidate[] = [];
        for (const candidate of selectedCandidates) {
          if (candidate.memory.status !== "contested") continue;
          const companionId = candidate.memory.contestedWithId;
          if (!companionId) continue; // 片側だけの contested。取得を試みるまでもなく落とす
          if (unitsMemberIds.has(companionId)) continue; // (a)
          if (selectedById.has(companionId)) continue; // (b)
          needingCompanionFetch.push(asAssociationMember(candidate));
        }
        const fetchedAssociationCompanions = await fetchMandatoryCompanions(
          ctx,
          deps.memoryStore,
          needingCompanionFetch,
          now,
          queryTags,
          validatedQuery.timeWeighting,
          decayScoringExtras,
          survivesAttributesFilter,
          ensureSubjectSeqs,
        );
        const fetchedAssociationCompanionByOwnerId = new Map(
          fetchedAssociationCompanions
            .filter(
              (c): c is ScoredCandidate & { companionOf: MemoryId } => c.companionOf !== undefined,
            )
            .map((c) => [c.companionOf, c]),
        );

        const associationConsumed = new Set<MemoryId>();
        let associationUnitAssemblyShortfall = 0;
        for (const candidate of selectedCandidates) {
          if (associationConsumed.has(candidate.memory.id)) continue;
          associationConsumed.add(candidate.memory.id);
          const member = asAssociationMember(candidate);

          if (candidate.memory.status !== "contested") {
            associationUnits.push({ members: [member], rankScore: candidate.rankKey });
            continue;
          }

          const companionId = candidate.memory.contestedWithId;

          if (companionId && unitsMemberIds.has(companionId)) {
            // (a) 段3の結果に既に居る（多層防御）。`contestedWith` は下の排他性契約のブロックが budget 切り詰め後の集合を見て付ける。
            associationUnits.push({ members: [member], rankScore: candidate.rankKey });
            continue;
          }

          const companionInBatch = companionId ? selectedById.get(companionId) : undefined;
          if (companionInBatch && !associationConsumed.has(companionInBatch.memory.id)) {
            // (b) 連想枠自身が両側を選んでいた。
            associationConsumed.add(companionInBatch.memory.id);
            associationUnits.push({
              members: [member, asAssociationMember(companionInBatch)],
              rankScore: Math.max(candidate.rankKey, companionInBatch.rankKey),
            });
            continue;
          }

          const fetchedCompanion = fetchedAssociationCompanionByOwnerId.get(candidate.memory.id);
          if (fetchedCompanion) {
            associationUnits.push({
              members: [member, fetchedCompanion],
              // 連想は `units` の後ろに連結するので、予算（段4）が「後ろから cut する」とき最初に落ちる。association 側は連結後に
              // 再ソートされないので、この配列への push 順（`rankKey` 降順）が落ちる順を決める。
              rankScore: candidate.rankKey,
            });
            continue;
          }

          // 対向が取れなかった（forget 済み・存在しない・片側だけの contested・
          // attributes の絞り込みで外れた、等）。段3と同じ判断——Unit ごと落とす。
          associationUnitAssemblyShortfall += 1;
          associationAssemblyDroppedIds.add(candidate.memory.id);
        }
        if (associationUnitAssemblyShortfall > 0) {
          // 段3と同じ札・同じ countKind（ADR 0043）。`UnitAssemblyDroppedOmission` は stage を持たないので、
          // 段3が積んでいればその件数に足し、同じ kind のエントリを2件に割らない（`find` で1件を読む呼び手が取りこぼさないように）。
          const existingIndex = omitted.findIndex((o) => o.kind === "unit_assembly_dropped");
          if (existingIndex !== -1) {
            const existing = omitted[existingIndex] as UnitAssemblyDroppedOmission;
            omitted[existingIndex] = {
              ...existing,
              count: existing.count + associationUnitAssemblyShortfall,
            };
          } else {
            omitted.push({
              kind: "unit_assembly_dropped",
              count: associationUnitAssemblyShortfall,
              countKind: "lower_bound",
            });
          }
        }
      }
    }
    stages.push({ stage: "association", executed: associationExecuted, detail: associationDetail });
  }

  // 段4: 予算による切り詰め（docs/recall.md §8、§9.5）。
  // 連想の候補（`associationUnits`）は予算の内側に置き、`units` の後ろに連結する。「後ろから cut する」切り詰めが
  // 連想を優先して落とし、クエリで引けたものを押し出さない。目次帯とは違い連想枠は digest 本文を持つ実トークンなので、
  // 「予算の対象外」という先例はここへ適用しない。
  const allUnits = [...units, ...associationUnits];
  const budget = validatedQuery.budget;
  let keptUnits = allUnits;
  // 段4の `fits` と、呼び出し側が実際に受け取る量（連結して1回だけ数える。`memoryTokens` と同じ数え方）は別の式で、
  // 加法的には一致しない。件数の多い digest ほど per-unit の `Math.ceil` の積み重ねが実量を上回り、予算に余りがあるのに
  // `budget_dropped` で落ちることがある。切り詰めの判定・件数・omitted はここでは変えない（ADR 0097 が「段4の強制を連結側へ寄せる」を却下）。
  // 足すのは、「連結して測り直したら落とさなくても収まっていたか」を trace（任意欄）に出す観測口だけ。
  let droppedFitsWhenConcatenated: boolean | undefined;
  if (budget) {
    const maxMemoryChars = budget.maxMemoryChars;
    const maxTokens = effectiveTokenBudget(budget);
    const cut = findBudgetCut(allUnits, { maxMemoryChars, maxTokens }, deps.tokenCounter);
    keptUnits = allUnits.slice(0, cut);
    const droppedUnits = allUnits.slice(cut);
    const droppedCount = droppedUnits.reduce((sum, u) => sum + u.members.length, 0);
    if (droppedCount > 0) {
      // `'exact'` をリテラルで書かない（ADR 0045）。`associationUnits` は1候補=1 Unit で構築しており取りこぼしが構造的に起きないので、
      // `unitsCountKind` をそのまま流用しても精度の名乗りは変わらない。
      omitted.push({ kind: "budget_dropped", count: droppedCount, countKind: unitsCountKind });

      // `allUnits` 全件の digest を、`memoryTokens` と同じやり方（連結して1回だけ数える）で測り直す。収まっていれば、
      // per-unit ceil の積み重ねだけが原因で落としたことになる（ADR 0097）。
      const allDigests = allUnits.flatMap((u) => u.members.map((m) => m.memory.digest));
      const concatenated = allDigests.join("\n");
      const concatenatedCharsOk =
        maxMemoryChars === undefined || concatenated.length <= maxMemoryChars;
      const concatenatedTokensOk =
        maxTokens === undefined || deps.tokenCounter.count(concatenated).tokens <= maxTokens;
      droppedFitsWhenConcatenated = concatenatedCharsOk && concatenatedTokensOk;
    }
  }

  stages.push({
    stage: "budget_truncation",
    executed: true,
    detail: {
      budgetApplied: budget !== undefined,
      unitsKept: keptUnits.length,
      ...(droppedFitsWhenConcatenated !== undefined ? { droppedFitsWhenConcatenated } : {}),
    },
  });

  // `contestedWith` を付けるかどうかの判定に使う、budget 切り詰め後の最終的な返却集合（ADR 0335）。
  // `keptUnits` の確定前だと、まだ落ちるかもしれない相手を「居る」と数えてしまう。
  const keptMemoryIds = new Set(
    keptUnits.flatMap((unit) => unit.members.map((member) => member.memory.id)),
  );

  // `basisLost` の解決（ADR 0342）。budget 切り詰め後に実際に返る `inferred` の記憶の `basis.memoryIds` を集め、
  // `MemoryStore.getMany` を1回だけ呼ぶ（0件なら呼ばない）。書き込み時の事前計算はしない。
  //
  // 「失われている」は次のいずれか: getMany の結果に無い（存在しない/他テナント/形式不正）／`status === "forgotten"`／
  // `purgedAt` が非 `null`。`archived`/`superseded`/`contested` は本文が残り復帰経路があるので失われていない扱い
  // （docs/memory-model.md §11）。
  // `basis.observationIds` は確かめない: Observation は追記専用で forget/purge の経路が無く、一括取得口も無い（ADR 0342）。
  const inferredBasisMemoryIds = new Set<MemoryId>();
  for (const unit of keptUnits) {
    for (const member of unit.members) {
      if (member.memory.provenance.kind === "inferred") {
        for (const basisMemoryId of member.memory.provenance.basis.memoryIds) {
          inferredBasisMemoryIds.add(basisMemoryId);
        }
      }
    }
  }
  const lostBasisMemoryIds = new Set<MemoryId>();
  if (inferredBasisMemoryIds.size > 0) {
    const basisMemories = await deps.memoryStore.getMany(ctx, [...inferredBasisMemoryIds]);
    const basisMemoriesById = new Map(basisMemories.map((m) => [m.id, m]));
    for (const basisMemoryId of inferredBasisMemoryIds) {
      const basisMemory = basisMemoriesById.get(basisMemoryId);
      // 見つからないこと自体が「失われている」（`getMany` は存在しない/クロステナントの id を静かに落とす契約）。
      if (
        !basisMemory ||
        basisMemory.status === "forgotten" ||
        (basisMemory.purgedAt ?? null) !== null
      ) {
        lostBasisMemoryIds.add(basisMemoryId);
      }
    }
  }

  const finalMemories: RecalledMemory[] = keptUnits.flatMap((unit) =>
    unit.members.map((member) => {
      const recalled: RecalledMemory = {
        memoryId: member.memory.id,
        digest: member.memory.digest,
        retrievedVia: member.retrievedVia,
        // リテラルを書かない。値はその Memory の provenance から引き継ぐ（出どころが変わったら名乗りも変わる。ADR 0011）。
        provenanceKind: member.memory.provenance.kind,
        // affinity を測っていない候補（連想枠・必須の同伴取得）は、比較可能でない値を持たない形で返す。内部表現 `member.score` は変えない（ADR 0352）。
        score: toRecalledScore(member.score),
        // 常に値か null を書く。「無い（null）」と「頼まなかった／書き忘れた（undefined）」を実行時に混ぜないため（ADR 0289）。
        // speaker は StatedProvenance にしか無いので、それ以外では常に null。
        speaker:
          member.memory.provenance.kind === "stated"
            ? (member.memory.provenance.speaker ?? null)
            : null,
        subjectId: member.memory.subjectId ?? null,
        recordedAt: member.memory.recordedAt,
        // 「述べられていない」を推測で埋めない（ADR 0298）。
        occurredAt: member.memory.occurredAt ?? null,
        // `Memory.attributes` が `undefined` の古い行・adapter でも `{}` に揃える。
        attributes: member.memory.attributes ?? {},
      };
      if (member.companionOf !== undefined) {
        recalled.companionOf = member.companionOf;
      }
      if (member.associationOf !== undefined) {
        recalled.associationOf = member.associationOf;
      }
      // 同伴取得（companionOf）を経由したかを問わず、矛盾する2件が自然に両方とも候補に入ったときも両側へ対称に付ける（ADR 0335）。
      // 相手が budget 切り詰め後の `keptMemoryIds` に実在するときだけ付ける（切り詰めで落ちた・連想枠経由で単独になった・
      // 相手が forget 済みの場合は付かない）。
      if (
        member.memory.status === "contested" &&
        member.memory.contestedWithId &&
        keptMemoryIds.has(member.memory.contestedWithId)
      ) {
        recalled.contestedWith = member.memory.contestedWithId;
      }
      // `basis.memoryIds` の少なくとも1件が `lostBasisMemoryIds` に当たるときだけ付ける。それ以外はキー自体を出さない（ADR 0342）。
      if (
        member.memory.provenance.kind === "inferred" &&
        member.memory.provenance.basis.memoryIds.some((id) => lostBasisMemoryIds.has(id))
      ) {
        recalled.basisLost = true;
      }
      return recalled;
    }),
  );

  // 排他性契約（ADR 0203）: `omitted` は「返さなかった」記憶の集合である（docs/recall.md §1）。
  //
  // 段2が `below_threshold` として確定させた記憶を、段3.5（連想）や段3（必須の同伴取得）が後から候補集合へ昇格させることがある
  // （連想の除外集合は below_threshold を含まないので、一度落ちた記憶を拾い直せる。これは意図した挙動）。
  // 段2の確定をそのまま残すと、同じ memoryId が `memories` と `omitted` の両方に載り、「返したのに落ちたと名乗る」ことになる。
  //
  // 「段2で確定し、以降は積み上げるだけ」（docs/recall.md §3）という規約を破らず、確定を書き換えるのではなく、
  // 実際に返した集合と突き合わせて矛盾を解消する後処理として置く。
  //
  // memoryId 単位で突き合わせられるのは、段2の内部状態が memoryId を持つ kind だけ（`below_threshold` の `nearMisses`、
  // 内部の `overLimit`、`notComparable`）。`budget_dropped` 等にはこの前提が当たらない。
  //
  // 取り下げの条件は「`finalMemories` へ実際に返ったか」ではなく、「段3の必須同伴取得（`companions`）か段3.5 の連想
  // （`associationUnits`）で候補集合に戻ったか」。戻った候補が段4の予算で改めて落ちると `budget_dropped` に数えられるので、
  // 取り下げないと同じ1件が `below_threshold` と `budget_dropped` の両方に載る。「最後にその候補を落とした段で1回だけ数える」。
  // 段3.5 の候補プールに入ったが席に着けなかった候補（`overLimitAssociationSeatlessIds`）も、段3.5 が
  // `over_limit(stage:"association")` に数えているので取り下げる。
  const returnedMemoryIds = new Set(finalMemories.map((m) => m.memoryId));
  // 多者間の群の同伴取得（`groupCompanions`）も、2者間（`companions`）と同じ「段3で候補集合に戻った」扱いにする（ADR 0381）。
  const mandatoryCompanionIds = new Set(allCompanions.map((c) => c.memory.id));
  const associationUnitIds = new Set(
    associationUnits.flatMap((u) => u.members.map((m) => m.memory.id)),
  );
  // 段3.5 で席を競り負けて `over_limit(stage:"association")` に数えた候補が、同じ段3.5 の必須の同伴取得で対向として
  // `associationUnits` に入ることがある。件数は席が決まった時点で既に積まれているので、ここで差し引く（ADR 0203）。
  const seatlessPulledIntoUnits = [...overLimitAssociationSeatlessIds].filter((id) =>
    associationUnitIds.has(id),
  );
  if (seatlessPulledIntoUnits.length > 0) {
    const assocIndex = omitted.findIndex(
      (o) => o.kind === "over_limit" && o.stage === "association",
    );
    if (assocIndex !== -1) {
      const existing = omitted[assocIndex] as OverLimitOmission;
      const remainingCount = existing.count - seatlessPulledIntoUnits.length;
      if (remainingCount > 0) {
        omitted[assocIndex] = { ...existing, count: remainingCount };
      } else {
        omitted.splice(assocIndex, 1);
      }
    }
  }

  // 段3で群の上限に切られて `over_limit(stage:"relation")` に数えた候補が、段3.5 の必須の同伴取得（`getMany` による id 引き。
  // 除外集合 `relationOverLimitIds` が効かない）で `associationUnits` に戻ることがある。戻った先で返れば `memories` に、
  // 段4の予算で落ちれば `budget_dropped` に数えられるので、その群の count から差し引く（ADR 0203）。0件になった札は残さない。
  // 差し引くのは `associationUnits` に実際に入った id だけ。
  const relationPulledByEntry = new Map<OverLimitOmission, number>();
  for (const id of relationOverLimitIds) {
    if (!associationUnitIds.has(id)) continue;
    const entry = relationOverLimitEntryById.get(id);
    if (entry === undefined) continue;
    relationPulledByEntry.set(entry, (relationPulledByEntry.get(entry) ?? 0) + 1);
  }
  for (const [entry, pulled] of relationPulledByEntry) {
    const index = omitted.indexOf(entry);
    if (index === -1) continue;
    const remainingCount = entry.count - pulled;
    if (remainingCount > 0) {
      omitted[index] = { ...entry, count: remainingCount };
    } else {
      omitted.splice(index, 1);
    }
  }

  const promotedFromBelowThreshold = belowThreshold.filter(
    (c) =>
      returnedMemoryIds.has(c.memory.id) ||
      mandatoryCompanionIds.has(c.memory.id) ||
      associationUnitIds.has(c.memory.id) ||
      overLimitAssociationSeatlessIds.has(c.memory.id) ||
      associationAssemblyDroppedIds.has(c.memory.id) ||
      relationOverLimitIds.has(c.memory.id),
  );
  if (promotedFromBelowThreshold.length > 0) {
    const promotedIds = new Set(promotedFromBelowThreshold.map((c) => c.memory.id));
    const belowThresholdIndex = omitted.findIndex(
      (o): o is BelowThresholdOmission => o.kind === "below_threshold",
    );
    if (belowThresholdIndex !== -1) {
      const existing = omitted[belowThresholdIndex] as BelowThresholdOmission;
      const remainingCount = existing.count - promotedFromBelowThreshold.length;
      const remainingNearMisses = existing.nearMisses?.filter((n) => !promotedIds.has(n.memoryId));
      if (remainingCount > 0) {
        omitted[belowThresholdIndex] = {
          ...existing,
          count: remainingCount,
          ...(remainingNearMisses !== undefined ? { nearMisses: remainingNearMisses } : {}),
        };
      } else {
        // 全件昇格した。0件の omission は積まない作法に揃える。
        omitted.splice(belowThresholdIndex, 1);
      }
    }
  }

  // 段2で `score_not_comparable` に数えた候補（`notComparable`、total が NaN。ADR 0040、ADR 0044）も、段3・段3.5 で候補集合に
  // 戻りうる。below_threshold と同じ判定で取り下げ、「最後にその候補を落とした段で1回だけ数える」を守る（ADR 0203）。
  // 段3.5 で席に着けなかった候補（`overLimitAssociationSeatlessIds`）は `over_limit(association)` 側に1回だけ残す
  // （比較不能は席順の最後尾なので、席が足りないと真っ先にここへ来る）。
  const promotedFromNotComparable = notComparable.filter(
    (c) =>
      returnedMemoryIds.has(c.memory.id) ||
      mandatoryCompanionIds.has(c.memory.id) ||
      associationUnitIds.has(c.memory.id) ||
      overLimitAssociationSeatlessIds.has(c.memory.id) ||
      associationAssemblyDroppedIds.has(c.memory.id) ||
      relationOverLimitIds.has(c.memory.id),
  );
  if (promotedFromNotComparable.length > 0) {
    const notComparableIndex = omitted.findIndex((o) => o.kind === "score_not_comparable");
    if (notComparableIndex !== -1) {
      const existing = omitted[notComparableIndex] as ScoreNotComparableOmission;
      const remainingCount = existing.count - promotedFromNotComparable.length;
      if (remainingCount > 0) {
        omitted[notComparableIndex] = { ...existing, count: remainingCount };
      } else {
        omitted.splice(notComparableIndex, 1);
      }
    }
  }

  // 段2で `passed.slice(limit)` により `over_limit(stage:"rescore")` へ回された候補（上の `overLimit`。まだ生きている
  // `ScoredCandidate[]`）が、段3の必須の同伴取得（`companions`）・段3.5 の連想（`associationUnits`）のいずれかで候補集合に戻る、
  // または段3.5 の候補プールで席に着けず `over_limit(stage:"association")` に数えられることがある。
  // below_threshold と同型の矛盾（「返したのに落ちた、または二重に落ちたと名乗る」）なので、`over_limit(stage:"rescore")` の勘定から外す。
  //
  // 対象は、`overLimit` に居て、かつ (a) 段3の必須同伴取得（`companions`）か (b) 段3.5 の連想（`associationUnits`）に居るか
  // (c) 段3.5 の候補プールで `over_limit(stage:"association")` に実際に数えられた（`overLimitAssociationSeatlessIds`）id。
  // 「戻った先で最終的に `finalMemories` へ返ったか」は問わない。`returnedMemoryIds.has(...)` を AND で課すと、戻った候補が
  // 段4の予算で改めて落ちたときに取り下げが起きず、`over_limit(stage:"rescore")` と `budget_dropped` の両方に数えられる（ADR 0203）。
  //
  // (a)(b) は、その先で段4の予算に落ちれば `budget_dropped` に数えられ、残れば `memories` に載る。`companions`/`associationUnits` の
  // members は、段4の後必ず `finalMemories` か `budget_dropped` のどちらかに入る（それ以外に消える経路が無い）ので、この入れ替えは安全。
  // (c) は席に着けなかった時点で `over_limit(stage:"association")` に1回だけ残る（「最後に落とした段で1回だけ数える」）。
  // `overLimitAssociationSeatlessIds` は `over_limit(stage:"association")` の count を構成する2つの式と同じ集合で、
  // 多層防御で落ちた分は入らない（段5の `aggregateScope` が `filtered(...)` として数えており、差し引くと二重計上になる。ADR 0173）。
  //
  // `over_limit(stage:"association")` 自身の count はここでは変えない。差し引くのは常に `over_limit(stage:"rescore")` 側だけ。
  // 差し引く数は、`overLimit` に居て実際に (a)(b)(c) のいずれかに当たった id の数だけ。総数で数えると、無関係な over_limit の
  // count を誤って減らす。
  const promotedFromOverLimit = overLimit.filter(
    (c) =>
      mandatoryCompanionIds.has(c.memory.id) ||
      associationUnitIds.has(c.memory.id) ||
      overLimitAssociationSeatlessIds.has(c.memory.id) ||
      associationAssemblyDroppedIds.has(c.memory.id) ||
      relationOverLimitIds.has(c.memory.id),
  );
  if (promotedFromOverLimit.length > 0) {
    const overLimitRescoreIndex = omitted.findIndex(
      (o): o is OverLimitOmission => o.kind === "over_limit" && o.stage === "rescore",
    );
    if (overLimitRescoreIndex !== -1) {
      const existing = omitted[overLimitRescoreIndex] as OverLimitOmission;
      const remainingCount = existing.count - promotedFromOverLimit.length;
      if (remainingCount > 0) {
        omitted[overLimitRescoreIndex] = { ...existing, count: remainingCount };
      } else {
        // 全件昇格した。below_threshold と同じ作法で 0件の omission を残さない。
        omitted.splice(overLimitRescoreIndex, 1);
      }
    }
  }

  // 連想枠が返した digest の合計文字数。`associationQuery` が undefined（`null` で明示的に off）でない限り `usage.byTier` に載せる（ADR 0151、ADR 0337）。
  const associationChars = finalMemories
    .filter((m) => m.retrievedVia === "association")
    .reduce((sum, m) => sum + m.digest.length, 0);

  // 段5: 目次帯の構築（docs/recall.md §5）。
  // digestBand は「スコープ内に在るが `memories` に返していないもの」の要旨。`memories` に入った分は `RecalledMemory.digest` に
  // 在るので、`finalMemories` の memoryId を除外して集約を取る。
  const digestBandLimit = validatedQuery.digestBandLimit ?? DEFAULT_DIGEST_BAND_LIMIT;
  // "skip" は `AggregateScopeOptions.scopeAggregate` へそのまま渡すだけ。値の解釈は `MemoryStore` 実装側の仕事（ADR 0384）。
  const scopeAggregateMode = validatedQuery.scopeAggregate ?? "exact";
  const aggregate = await deps.memoryStore.aggregateScope(ctx, scope, {
    digestBand: {
      limit: digestBandLimit,
      excludeMemoryIds: finalMemories.map((m) => m.memoryId),
    },
    // 段1の ANN から除外した kind を集約へも渡す（ADR 0390）。
    ...(validatedQuery.excludeProvenanceKinds !== undefined &&
    validatedQuery.excludeProvenanceKinds.length > 0
      ? { excludeProvenanceKinds: validatedQuery.excludeProvenanceKinds }
      : {}),
    scopeAggregate: scopeAggregateMode,
  });
  // `aggregateScope` の `digests` は adapter が組み立てる。`scope.attributes`/`scope.labels` を無視する adapter だと、
  // 絞り込みの外に在る Memory の digest が目次帯へ紛れ込み、LLM のプロンプトに混ざる。段1・段3の後置フィルタと同じ多層防御を置く:
  // 絞り込みが在るときだけ、帯に載る候補を `getMany` で引き直して検査し、通らないもの・引けなかったものを落とす（ADR 0312、ADR 0323）。
  let scopedDigests = aggregate.digests;
  let digestEligibleCount = aggregate.digestEligible.count;
  let digestEligibleCountKind = aggregate.digestEligible.countKind;
  if (
    (scope.attributes !== undefined || scope.labels !== undefined) &&
    aggregate.digests.length > 0
  ) {
    const digestMemoriesById = new Map(
      (
        await deps.memoryStore.getMany(
          ctx,
          aggregate.digests.map((d) => d.memoryId),
        )
      ).map((m) => [m.id, m]),
    );
    scopedDigests = aggregate.digests.filter((d) => {
      const memory = digestMemoriesById.get(d.memoryId);
      return (
        memory !== undefined && survivesAttributesFilter(memory) && survivesLabelsFilter(memory)
      );
    });
    const droppedCount = aggregate.digests.length - scopedDigests.length;
    if (droppedCount > 0) {
      // `aggregate.digestEligible.count` は adapter 側の絞り込みが計算した総数で、見えている `digests`（帯の候補ページ）の外にも
      // 同種の取りこぼしが在るかもしれない。検算できるのは見えている分だけなので、引いた値は真の資格件数より大きい可能性が
      // あり、件数の正確さを僭称しない（ADR 0008）ために `'unknown'` にする。
      digestEligibleCount = Math.max(0, aggregate.digestEligible.count - droppedCount);
      digestEligibleCountKind = "unknown";
    }
  }
  const packedDigestBand = packDigestBand(scopedDigests, digestEligibleCount, {
    limit: digestBandLimit,
    maxChars: DIGEST_BAND_MAX_CHARS,
    maxEntryChars: DIGEST_BAND_MAX_ENTRY_CHARS,
  });
  const indexBand: IndexBand = {
    groups: aggregate.groups,
    totalInScope: aggregate.totalInScope,
    countKind: aggregate.countKind,
    digestBand: packedDigestBand.band,
    digestBandCoverage: {
      shown: packedDigestBand.band.length,
      eligible: digestEligibleCount,
      countKind: digestEligibleCountKind,
      ...(packedDigestBand.limitedBy !== undefined
        ? { limitedBy: packedDigestBand.limitedBy }
        : {}),
    },
  };
  stages.push({
    stage: "index_band",
    // detail に件数を足さない（ADR 0011）。件数は digestBandCoverage が名乗る。同じ意味の件数を2箇所に置くと食い違いうる。
    // `scopeAggregate`（ADR 0384）もここに足さない: 既定の出力（`explain.stages` を含む JSON 全体）が変わってしまう。
    // "skip" が効いたかどうかは `IndexBand.countKind`（`'unknown'`）と `IndexBand.totalInScope`（`0`）で読み解ける。
    executed: true,
    detail: { totalInScope: aggregate.totalInScope },
  });

  if (aggregate.filteredArchived.count > 0) {
    omitted.push({
      kind: "filtered",
      condition: "archived",
      scopeRelation: FILTERED_CONDITION_SCOPE_RELATION.archived,
      count: aggregate.filteredArchived.count,
      countKind: aggregate.filteredArchived.countKind,
    });
  }
  // superseded と forgotten は別々に push する（ADR 0027）。前者は機構の都合（置き換え先を持つ）、後者は利用者が意図した忘却
  // （置き換え先を持たない）で、束ねると次の一手が判定できなくなる。
  if (aggregate.filteredSuperseded.count > 0) {
    omitted.push({
      kind: "filtered",
      condition: "superseded",
      scopeRelation: FILTERED_CONDITION_SCOPE_RELATION.superseded,
      count: aggregate.filteredSuperseded.count,
      countKind: aggregate.filteredSuperseded.countKind,
    });
  }
  if (aggregate.filteredForgotten.count > 0) {
    omitted.push({
      kind: "filtered",
      condition: "forgotten",
      scopeRelation: FILTERED_CONDITION_SCOPE_RELATION.forgotten,
      count: aggregate.filteredForgotten.count,
      countKind: aggregate.filteredForgotten.countKind,
    });
  }
  if (aggregate.filteredPeriod.count > 0) {
    omitted.push({
      kind: "filtered",
      condition: "period",
      scopeRelation: FILTERED_CONDITION_SCOPE_RELATION.period,
      count: aggregate.filteredPeriod.count,
      countKind: aggregate.filteredPeriod.countKind,
    });
  }
  if (aggregate.filteredExpired.count > 0) {
    omitted.push({
      kind: "filtered",
      condition: "expired",
      scopeRelation: FILTERED_CONDITION_SCOPE_RELATION.expired,
      count: aggregate.filteredExpired.count,
      countKind: aggregate.filteredExpired.countKind,
    });
  }
  if (aggregate.filteredNotYetValid.count > 0) {
    omitted.push({
      kind: "filtered",
      condition: "not_yet_valid",
      scopeRelation: FILTERED_CONDITION_SCOPE_RELATION.not_yet_valid,
      count: aggregate.filteredNotYetValid.count,
      countKind: aggregate.filteredNotYetValid.countKind,
    });
  }
  // `aggregate.filteredTaxonomy` は任意フィールド。実装しない adapter では欄そのものが無く、「0件」と同じ扱いにする。
  if (aggregate.filteredTaxonomy !== undefined && aggregate.filteredTaxonomy.count > 0) {
    omitted.push({
      kind: "filtered",
      condition: "taxonomy",
      scopeRelation: FILTERED_CONDITION_SCOPE_RELATION.taxonomy,
      count: aggregate.filteredTaxonomy.count,
      countKind: aggregate.filteredTaxonomy.countKind,
    });
  }
  // 忘却ゲートが落とした件数も、他の `filtered` と同じくこの集約1本から出す（ADR 0173）。押し下げは外さず、同じ述語を持つ `scope` を
  // 集約へ渡して厳密に数える。ANN へ押し下げた分は後置フィルタでは数えられず、既定経路では記憶が名乗りなく消えていた。
  if (aggregate.filteredDecayed.count > 0) {
    omitted.push({
      kind: "filtered",
      condition: "decayed",
      scopeRelation: FILTERED_CONDITION_SCOPE_RELATION.decayed,
      count: aggregate.filteredDecayed.count,
      countKind: aggregate.filteredDecayed.countKind,
    });
  }
  // 理由ごとに1件ずつ返す。pending・failed・skipped は次の一手が変わるので1つに潰さない（ADR 0008）。
  for (const reason of NOT_INDEXED_REASONS) {
    const entry = aggregate.notIndexed[reason];
    if (entry.count > 0) {
      omitted.push({
        kind: "not_indexed",
        reason,
        count: entry.count,
        countKind: entry.countKind,
      });
    }
  }

  // ann_unreached（ADR 0026、ADR 0193）。ここは段5（`aggregate`）に依存する: `eligible` は `aggregate.totalInScope` と
  // `aggregate.notIndexed` が要り、段1の情報だけでは出せない。段5をスキップする経路を実装するなら、ここで鳴らしてはならない
  // （「取りこぼしたかもしれない」と断言する根拠が無い）。
  const notIndexedTotal =
    aggregate.notIndexed.pending.count +
    aggregate.notIndexed.failed.count +
    aggregate.notIndexed.skipped.count;
  // 除外指定（非空）のとき、adapter が `excludedProvenanceIndexedCount` を返したなら、段1が ANN から除外した「索引済みの除外 kind の行」を
  // 分母から引く（ADR 0390）。欄を返さない adapter では undefined で、引かない。
  const exclusionActive =
    validatedQuery.excludeProvenanceKinds !== undefined &&
    validatedQuery.excludeProvenanceKinds.length > 0;
  const excludedIndexed = exclusionActive ? aggregate.excludedProvenanceIndexedCount : undefined;
  const eligible =
    aggregate.totalInScope -
    notIndexedTotal -
    (excludedIndexed !== undefined ? excludedIndexed : 0);
  // 窓が埋まっていない（`annHits.length < kPrime`）ことを条件にしない（ADR 0193）。`sim_k'` は索引が返した k' 番目で真の k' 番目
  // ではなく、近似索引が scope の他の場所へ行っていれば、窓が満杯でも scope 内の真により近い候補を取りこぼしうる。
  // 窓の満杯/未満を問わず「scope 内にまだ見られていない候補が残っているか」だけで判定するので、`ann_truncated` と同時に立ちうる
  // （別の問いに答えている: `ann_truncated` は窓の外が k 位を抜けないと証明できるか、`ann_unreached` は索引が scope の候補を拾いきったか）。
  //
  // `severity` はここで一緒に決める。値は下の `annReturnedFewerThanReachable`（stage detail の診断キー）と同じ式でなければならない
  // （2箇所に条件を書き写すと食い違う。ADR 0288）ので、真偽値 `annWindowUnderfilled` として先に確定させる。
  // 除外指定でも、adapter が除外行の件数を返したときは下限が立つ。`filteredDecayed` は除外行の decayed も数えうるので、
  // 除外行が `eligible` と `filteredDecayed` の両方で引かれ、下限は真の値より小さい側へずれる。偽陽性を出さない側
  // （警告が減るだけ）なので許容する（ADR 0390）。
  const lowerBoundUsable = !exclusionActive || excludedIndexed !== undefined;
  const reachableLowerBound = Math.max(0, eligible - aggregate.filteredDecayed.count);
  const annWindowUnderfilled =
    candidateGenerationExecuted &&
    kPrime > 0 &&
    lowerBoundUsable &&
    reachableLowerBound > 0 &&
    annHits.length < Math.min(kPrime, reachableLowerBound);
  if (
    candidateGenerationExecuted &&
    kPrime > 0 &&
    // scope 内にまだ見られていない候補が残っている。この条件を落とすと、小さい subject で候補が ANN に全部返った場合
    // （候補3件・kPrime 40・hits 3）にも常に鳴る。窓が満杯でも `annHits.length >= eligible` なら鳴らない。
    annHits.length < eligible
  ) {
    omitted.push({
      kind: "ann_unreached",
      countKind: "unknown",
      // ANN 窓が到達可能な下限（`reachableLowerBound`）に届かなかった（`annWindowUnderfilled`）なら "warning"。
      // 窓は満杯で `eligible > kPrime` という構造だけで鳴っているなら "info"（ADR 0288）。
      severity: annWindowUnderfilled ? "warning" : "info",
    });
  }

  // ADR 0285: 「見つからなかった」（真に0件）と「探していない」（scope の候補を一度も見ていない）を、同じ `ann_unreached` の顔で返さない。
  // `Omission` union に `kind` を増やさず、型無しの診断欄 `StageTrace.detail` へキーを足して、ANN が scope 内の候補を取りこぼしたことを名乗る。
  //
  // 分母は「scope 内・埋め込みあり・忘却ゲートを通る行」だが、`eligible` から算術では導けない。
  // - `aggregate.filteredDecayed` は embedding_status を問わず decayed 行を数えるので、`eligible - filteredDecayed` は
  //   「未索引かつ decayed」の行を二重に引き、母数を過小に見積もる。
  // - `eligible` は忘却ゲートを知らない（ADR 0173 は decayed を scope 内に留めると決めた）。`eligible > 0 && annHits.length === 0`
  //   だと、全行が decayed で ANN が正しく0件を返した場合にも真になる（正常な忘却を「探していない」と混同する偽陽性）。
  // - 「判定しない」ではなく「下限で判定する」: `filteredDecayed.count > 0` のとき判定しないと、decayed が正常な運用状態である
  //   本番テナントで診断が恒久的に沈黙する。
  //
  //   `reachableLowerBound = max(0, eligible - aggregate.filteredDecayed.count)`
  //
  // 健全性: 真の母数は `eligible - X`（`X` は scope 内で「埋め込みあり かつ decayed」の行数、未知）。`X` は `filteredDecayed.count` の
  // 部分集合なので `0 <= X <= filteredDecayed.count`。⟹ `trueReachable >= reachableLowerBound`。
  // `annHits.length < min(kPrime, reachableLowerBound)` が真なら `annHits.length < min(kPrime, trueReachable)` も真で、偽陽性は出ない。
  // 限界: `X < filteredDecayed.count` のとき下限は真の母数より小さくなり、索引が取りこぼしていても `annHits.length` が
  // 下限以上に収まると鳴らない（見逃しがありうる。ADR 0285）。
  //
  // 判定は `annHits.length === 0`（真の0件）に限らず `annHits.length < min(kPrime, reachableLowerBound)` へ一般化している:
  // 索引が天井で途中打ち切られた場合も「実在する候補を返しきれなかった」という同じ事象である。
  // 欄名は `annReturnedFewerThanReachable`・`annReachableLowerBound`（下限であることを名前に出す）。値は条件が真のときだけ足す
  // （既定の出力を変えないため。ADR 0084）。
  //
  // `excludeProvenanceKinds` は `aggregate` に現れない次元なので、欄を返さない adapter では下限が真の母数を上回りうる。
  // その場合は判定しない（鳴らさない）。欄を返す adapter では除外指定でも下限が立つ（ADR 0390）。
  //
  // `lowerBoundUsable`・`reachableLowerBound`・`annWindowUnderfilled` は `ann_unreached` の直前に引き上げてある
  // （`severity` が同じ式を要るため）。ここではその真偽値へ `annStageTrace !== undefined` だけを重ねる。
  if (annStageTrace !== undefined && annWindowUnderfilled) {
    annStageTrace.detail = {
      ...annStageTrace.detail,
      annReturnedFewerThanReachable: true,
      annReachableLowerBound: reachableLowerBound,
    };
  }

  // `scopeAggregate: "skip"` で件数が取れなかった（adapter が `countKind: 'unknown'` を返した）とき、`eligible` は 0 になり、
  // `ann_unreached` も `annReturnedFewerThanReachable` も判定できない。「鳴らない」ことが「拾いきった」を意味しなくなるので、
  // ANN の段が実際に走っていたなら、stage detail に `annReachability: "unknown"` と名乗る（ADR 0390）。
  //   - `Omission` union には足さない。`ann_unreached` を countKind 'unknown' で出す案は「届かなかった」と断言する顔になり、
  //     skip では取りこぼしてもいない recall の大半に立つうえ、severity の意味も崩す。
  //   - 要求（`scopeAggregate === "skip"`）だけでなく、返ってきた `countKind`（'unknown'）でも縛る。skip を無視して exact を返す
  //     adapter では何も足さない。
  //   - 診断キーは条件が真のときだけ足す（ADR 0084）。
  if (
    annStageTrace !== undefined &&
    candidateGenerationExecuted &&
    kPrime > 0 &&
    scopeAggregateMode === "skip" &&
    aggregate.countKind === "unknown"
  ) {
    annStageTrace.detail = {
      ...annStageTrace.detail,
      annReachability: "unknown",
    };
  }

  // usage（docs/recall.md §6）: 計測と強制を混同しない。強制は段4で済んでおり、ここでは実際に返した量を測るだけ。
  const digestChars = finalMemories.reduce((sum, m) => sum + m.digest.length, 0);
  const indexBandText = JSON.stringify(indexBand);
  const indexChars = indexBandText.length;
  const totalChars = digestChars + indexChars;
  const memoryTokens = deps.tokenCounter.count(finalMemories.map((m) => m.digest).join("\n"));
  const tokenCount = deps.tokenCounter.count(
    finalMemories.map((m) => m.digest).join("\n") + indexBandText,
  );

  // share の分子は memories tier だけ（目次帯は budget の対象外なので、含めると予算が縛っていない量まで数えて 100% を超える）。
  //
  // `share` は 1 を超えうる。超えたときは `budgetExceeded` が `true` になる（ADR 0097、ADR 0098）。
  // 段4の強制（`fits`/`unitTokens`）は digest ごとに `tokenCounter.count()` を呼んだ合計で判定するが、`share` の分子は
  // `digests.join("\n")` を1回だけ `count()` する。改行区切りの分だけ後者が前者を上回ることがある。
  // 「この応答は全体でいくらかかったか」は別の問いで、`chars` と `indexChars` が答える。
  const tokenBudget = effectiveTokenBudget(budget);
  const usageShareDenominator = tokenBudget ?? budget?.maxMemoryChars;
  const usageShareNumerator = tokenBudget !== undefined ? memoryTokens.tokens : digestChars;

  // budgetExceeded（ADR 0083）。存在条件を `share` と揃える: 「予算が申告されている」の判定に `usageShareDenominator !== undefined`
  // を再利用する（別の式で判定し直すと将来食い違う。ADR 0011）。`budget: {}` は `usageShareDenominator` も `undefined` なので、この欄も無い。
  //
  // `share` からは導出しない（`RecallUsage.budgetExceeded` の doc）。理由は2つ:
  // 1. 強制側（段4の `fits` が呼ぶ `unitTokens`）は digest ごとに `count()` を呼ぶので `Math.ceil` が件数ぶん掛かる。`share` の分子
  //    （連結した1本に `ceil` を1回、連結で増えた改行も含む）とは加法的に一致しない。
  // 2. `share` の分母は `tokenBudget ?? budget?.maxMemoryChars` で、トークン予算が在ると `maxMemoryChars` は分母から消える。
  //    両方申告された場合、chars 次元の充足度は `share` からは読めない。
  // ⟹ 返した memories を、申告された全次元に対して個別に測り直す。
  //
  // トークン数は、段4の `unitTokens` の合計ではなく、計算済みの `memoryTokens`（連結して ceil 1回）を使う。呼び出し側が実際に
  // プロンプトへ積むのは連結された1本で、`unitTokens` の合計はその量を表さない（非CJK20字の digest 2件に `maxMemoryTokens: 10`
  // を渡すと、段4は `5+5=10 <= 10` で両方残すが、連結41字は `ceil(41/4) = 11 > 10`）。これが `budgetExceeded` の存在理由。
  //
  // `maxMemoryChars` はこの不一致が起こらない（強制側も `digestChars` も digest.length の単純な合計）ので、`maxMemoryChars` だけの
  // 経路では常に `false`。それでも判定に含めるのは、他の次元が同時に申告されたときにこの次元を落とさないため
  // （`share` の分母がトークン優先で `maxMemoryChars` を切り捨てるのと同じ落とし穴を繰り返さない）。
  const charsExceeded = budget?.maxMemoryChars !== undefined && digestChars > budget.maxMemoryChars;
  const memoryTokensExceeded =
    budget?.maxMemoryTokens !== undefined && memoryTokens.tokens > budget.maxMemoryTokens;
  const promptTokensExceeded =
    budget?.promptBudgetTokens !== undefined && memoryTokens.tokens > budget.promptBudgetTokens;

  const usage = {
    chars: totalChars,
    estimatedTokens: tokenCount.tokens,
    counter: tokenCount.counter,
    byTier: {
      full: 0,
      digest: digestChars,
      index: indexChars,
      ...(associationQuery !== undefined ? { association: associationChars } : {}),
    },
    indexChars,
    ...(usageShareDenominator !== undefined
      ? {
          share: usageShareNumerator / usageShareDenominator,
          budgetExceeded: charsExceeded || memoryTokensExceeded || promptTokensExceeded,
        }
      : {}),
  };

  // 段6: 記録（docs/recall.md §2、ADR 0008）。必須の段。
  // `stages` に 'record' を、書き込む前に積む。この呼び出しが例外を投げれば `recall()` 自体が例外で終わるので、
  // `explain.stages` が「記録した」と嘘をついたまま呼び出し側に届くことはない。
  stages.push({ stage: "record", executed: true });
  const recallId = await deps.memoryStore.createRecall(ctx, {
    tenantId: ctx.tenantId,
    subjectId: ctx.subjectId ?? null,
    // runtime の注入した時計を渡す（省略すると壁時計になる）。
    createdAt: now,
    query: validatedQuery,
    budget: budget ?? null,
    omitted,
    usage,
    indexBand,
    explain: { stages },
    // 後から再現できないものだけを運ぶ。`digest`/`provenanceKind` は `MemoryStore.get()` から再現できるので含めない（ADR 0155）。
    // `RecallResult`（プロンプトへ向かう側）は太らせない。
    returnedMemories: finalMemories.map((m) => ({
      memoryId: m.memoryId,
      score: m.score,
      retrievedVia: m.retrievedVia,
      ...(m.companionOf !== undefined ? { companionOf: m.companionOf } : {}),
      ...(m.associationOf !== undefined ? { associationOf: m.associationOf } : {}),
    })),
    // `decay_clock != 'wall'` のテナントに限り、この recall がどちらかのカウンタを進める（1単位 = recall() 1回。ADR 0165、ADR 0353）。
    // 既定の 'wall' では false のまま渡り、`tenant_activity`/`tenant_subject_activity` のどちらにも UPDATE が増えない。
    // `activityCounting` が "subject" かつ `ctx.subjectId` が指定されているときだけ subject のカウンタ（S_x）を進める。
    // 絞っていない recall では「誰の」カウンタかという問いが無いので 'tenant' と同じ扱いに倒す。
    advanceActivityClock:
      decayClock === "wall"
        ? false
        : activityCounting === "subject" && ctx.subjectId !== undefined
          ? { scope: "subject" as const, subjectId: ctx.subjectId }
          : true,
  });

  // 出力検証（ADR 0098）。段6（記録）は書き込み済みで、検証はその後に `validateRecallOutput` へ通すだけ。
  // `draft` の値は書き換えない（`usage.share` が 1 を超えていても丸めない。検証で欠陥を隠さない。ADR 0097）。
  const draft: RecallResult = {
    recallId,
    memories: finalMemories,
    omitted,
    index: indexBand,
    usage,
    explain: { stages },
  };
  const outputValidationMode = deps.outputValidation ?? DEFAULT_RECALL_OUTPUT_VALIDATION;
  const outputValidationReport = validateRecallOutput(draft, outputValidationMode, recallId);
  return outputValidationReport === undefined
    ? draft
    : { ...draft, outputValidation: outputValidationReport };
}

/**
 * provider が返したベクトルを普通の `number[]` にする。配列、または数値の型付き配列（`Float32Array` など。`DataView` は除く）なら
 * 配列にして返し、それ以外（`undefined`・オブジェクト・文字列など）は `undefined`（ADR 0452）。要素の検査（次元・有限性）は呼び出し側。
 */
function toPlainVector(value: unknown): number[] | undefined {
  if (Array.isArray(value)) {
    return value as number[];
  }
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    return Array.from(value as unknown as ArrayLike<number>);
  }
  return undefined;
}

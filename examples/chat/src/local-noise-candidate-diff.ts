import type { CapturedProbeCandidates, ScoredCandidate } from "./synthetic-score-noise.js";
import { rankOf } from "./synthetic-score-noise.js";

/**
 * Issue #109（06:58Z のコメント、4番「残っているもの」）の残債——ADR 0322 が測った
 * `local` 埋め込みの sparse/dense 群（`identifiersSparse`/`identifiersDense`、
 * `japaneseNamesSparse`/`japaneseNamesDense`、`numeralSparse`/`numeralDense`）が、
 * σ・seed の全組で完全に一致した理由は**仮説のみで確認していなかった**：
 *
 * > ノイズは (seed, probe 番号, 候補の並び位置) だけで決まるので、dense で足した
 * > distractor が `recall()` の返す候補に入らなければ、結果は完全に一致する。
 * > 群どうしで候補を突き合わせてはいない。
 *
 * このモジュールは、その突き合わせ自体を行う**DB 非依存の純関数**である。
 * `local-noise-arm.ts` の `captureGroupCandidates` が sparse/dense それぞれについて
 * 1回ずつ捕まえた候補集合（`CapturedProbeCandidates[]`）を受け取り、probe ごとに
 * - 候補配列（`externalId`・`score.total`）が sparse/dense で**丸ごと一致するか**
 * - 一致しないなら、どこから食い違うか（先頭から何件は一致するか）
 * - dense にしか現れない `externalId`（sparse に無い候補）があるか、あるならそれが
 *   gold/distractor より上位に来ているか（＝ noise の並べ替えで無視できない位置か）
 * を機械的に出す。**判定・ノイズ注入そのものは行わない**——`synthetic-score-noise.ts`
 * の役割はそのまま、こちらは「入力である候補集合が本当に同じか」だけを見る。
 *
 * `identifier-probe-set.ts`/`japanese-name-probe-set.ts`/`numeral-token-probe-set.ts`
 * の設計（doc コメント参照）により、sparse/dense の filler は**同じ `externalId`
 * 命名規則（`*-filler-NNNN`）を共有しつつ中身のテキストが違う**——かつ dense の
 * filler 件数が sparse より多い群（`numeral`: dense 90 件 / sparse 60 件）がある。
 * ⟹ 「dense にしか無い externalId」は2通りの起き方がある:
 * 1. dense の filler 件数が sparse を上回る分（`numeral` の filler-0060〜0089 など）。
 * 2. sparse では recall() の上位に入らなかった filler が、dense では入った
 *    （中身が違うので埋め込みスコアが変わり得る）。
 * このモジュールはどちらも区別せず「sparse の候補集合に居ない externalId」として
 * まとめて報告する——原因の切り分けは呼び出し側（測定スクリプト・ADR）が行う。
 */

export interface CandidateDiffEntry {
  /** 候補配列の中での位置（0始まり）。sparse/dense で同じ index を並べて比較する。 */
  index: number;
  sparse: ScoredCandidate | null;
  dense: ScoredCandidate | null;
  /** 同じ index で externalId が一致するか。 */
  idMatches: boolean;
  /** 同じ index で externalId も score も一致するか（`Object.is` 相当、NaN は無い前提）。 */
  entryMatches: boolean;
}

export interface ProbeCandidateDiff {
  probeId: string;
  goldExternalId: string;
  distractorExternalId: string;
  sparseCandidateCount: number;
  denseCandidateCount: number;
  /**
   * sparse/dense の候補配列が、件数・順序・`externalId`・`score` まで**丸ごと一致**するか。
   * 一致すれば、この probe に対しては「同じ入力配列に同じノイズ関数を掛けている」ことが
   * 保証される——σ・seed をどう振っても sparse/dense の並べ替え結果は必ず一致する
   * （`applySymmetricScoreNoise` は `(candidates, sigma, seed, streamId)` の純関数であり、
   * 入力が同じなら出力も必ず同じであるため）。
   */
  identical: boolean;
  /** 先頭から何件、(externalId, score) が連続で一致し続けたか（0 = 先頭から食い違う）。 */
  matchingPrefixLength: number;
  goldRankSparse: number | null;
  goldRankDense: number | null;
  distractorRankSparse: number | null;
  distractorRankDense: number | null;
  /** dense の候補集合に居て、sparse の候補集合に居ない externalId（`recall()` が返した順のまま）。 */
  denseOnlyIds: string[];
  /** sparse の候補集合に居て、dense の候補集合に居ない externalId。 */
  sparseOnlyIds: string[];
  /**
   * `denseOnlyIds`（sparse に無い dense 側候補）のうち、dense 側の gold rank・
   * distractor rank のどちらよりも上位（小さい順位）に来ているものが1件でもあるか。
   *
   * これが `true` の probe が1件でもあれば、「dense で足した distractor が
   * `recall()` の返す候補に入らない」という仮説の前提（分の1つ）が崩れる——
   * dense 固有の候補が、判定に効く上位（gold/distractor より上）に実際に入っている
   * ことになる。それでも sparse/dense の最終結果（MRR/hit@1）が一致するとしたら、
   * 別の理由（例: ノイズが並び位置基準で、上位の列自体は変わらない）を探す必要がある。
   */
  denseOnlyRankedAboveGoldOrDistractor: boolean;
  perIndex: CandidateDiffEntry[];
}

function candidateAt(
  candidates: readonly ScoredCandidate[],
  index: number,
): ScoredCandidate | null {
  return candidates[index] ?? null;
}

function entriesEqual(a: ScoredCandidate | null, b: ScoredCandidate | null): boolean {
  if (a === null || b === null) return a === b;
  return a.externalId === b.externalId && a.score === b.score;
}

/**
 * 1 probe 分の sparse/dense 候補集合を突き合わせる。`sparse.probeId !== dense.probeId`
 * は呼び出し側の対応付けの誤りであり、例外にする（黙って比較しない）。
 */
export function diffProbeCandidates(
  sparse: CapturedProbeCandidates,
  dense: CapturedProbeCandidates,
): ProbeCandidateDiff {
  if (sparse.probeId !== dense.probeId) {
    throw new Error(
      `diffProbeCandidates: probeId が一致しない sparse=${sparse.probeId} dense=${dense.probeId}`,
    );
  }
  if (sparse.goldExternalId !== dense.goldExternalId) {
    throw new Error(
      `diffProbeCandidates: probe ${sparse.probeId} の goldExternalId が sparse/dense で違う` +
        `（同じ probe 定義から来ているはず——呼び出し側の対応付けを確認すること）`,
    );
  }

  const maxLength = Math.max(sparse.candidates.length, dense.candidates.length);
  const perIndex: CandidateDiffEntry[] = [];
  let matchingPrefixLength = 0;
  let prefixBroken = false;
  for (let index = 0; index < maxLength; index += 1) {
    const s = candidateAt(sparse.candidates, index);
    const d = candidateAt(dense.candidates, index);
    const entryMatches = entriesEqual(s, d);
    perIndex.push({
      index,
      sparse: s,
      dense: d,
      idMatches: s !== null && d !== null && s.externalId === d.externalId,
      entryMatches,
    });
    if (!prefixBroken) {
      if (entryMatches) {
        matchingPrefixLength += 1;
      } else {
        prefixBroken = true;
      }
    }
  }

  const identical =
    sparse.candidates.length === dense.candidates.length &&
    matchingPrefixLength === sparse.candidates.length;

  const sparseIds = new Set(
    sparse.candidates.map((c) => c.externalId).filter((id): id is string => id !== null),
  );
  const denseIds = new Set(
    dense.candidates.map((c) => c.externalId).filter((id): id is string => id !== null),
  );
  const denseOnlyIds = dense.candidates
    .map((c) => c.externalId)
    .filter((id): id is string => id !== null && !sparseIds.has(id));
  const sparseOnlyIds = sparse.candidates
    .map((c) => c.externalId)
    .filter((id): id is string => id !== null && !denseIds.has(id));

  const goldRankSparse = rankOf(sparse.candidates, sparse.goldExternalId);
  const goldRankDense = rankOf(dense.candidates, dense.goldExternalId);
  const distractorRankSparse = rankOf(sparse.candidates, sparse.distractorExternalId);
  const distractorRankDense = rankOf(dense.candidates, dense.distractorExternalId);

  const relevantDenseRankCeiling = Math.min(
    ...[goldRankDense, distractorRankDense].filter((r): r is number => r !== null),
  );
  const denseOnlyRankedAboveGoldOrDistractor =
    Number.isFinite(relevantDenseRankCeiling) &&
    denseOnlyIds.some((id) => {
      const rank = rankOf(dense.candidates, id);
      return rank !== null && rank < relevantDenseRankCeiling;
    });

  return {
    probeId: sparse.probeId,
    goldExternalId: sparse.goldExternalId,
    distractorExternalId: sparse.distractorExternalId,
    sparseCandidateCount: sparse.candidates.length,
    denseCandidateCount: dense.candidates.length,
    identical,
    matchingPrefixLength,
    goldRankSparse,
    goldRankDense,
    distractorRankSparse,
    distractorRankDense,
    denseOnlyIds,
    sparseOnlyIds,
    denseOnlyRankedAboveGoldOrDistractor,
    perIndex,
  };
}

export interface GroupCandidateDiffSummary {
  /** 群の名前（表示専用。例: `"identifiers"`、`"japaneseNames"`、`"numeral"`）。 */
  group: string;
  probeCount: number;
  /** `identical: true` だった probe 数。 */
  identicalProbeCount: number;
  /** `denseOnlyRankedAboveGoldOrDistractor: true` だった probe の id 一覧。 */
  probesWithDenseOnlyAboveGoldOrDistractor: string[];
  diffs: ProbeCandidateDiff[];
}

/**
 * 群1つ分（sparse/dense のペア）の probe ごとの突き合わせをまとめる。
 * `sparseProbes`/`denseProbes` は同じ probe 集合・同じ順序で捕まえたもの
 * （`local-noise-arm.ts` の `captureGroupCandidates` が返す `probes` 配列、
 * probe 集合の列挙順そのまま）である前提——`probeId` で対応付けるため、順序が
 * 違っていても正しく突き合わせられるが、**件数が違えば例外にする**
 * （片方でしか捕まえていない probe がある、という対応付けの誤りを検出するため）。
 */
export function diffGroupCandidates(
  group: string,
  sparseProbes: readonly CapturedProbeCandidates[],
  denseProbes: readonly CapturedProbeCandidates[],
): GroupCandidateDiffSummary {
  if (sparseProbes.length !== denseProbes.length) {
    throw new Error(
      `diffGroupCandidates(${group}): probe 件数が sparse(${sparseProbes.length}) と ` +
        `dense(${denseProbes.length}) で違う`,
    );
  }
  const denseByProbeId = new Map(denseProbes.map((p) => [p.probeId, p]));
  const diffs: ProbeCandidateDiff[] = sparseProbes.map((sparse) => {
    const dense = denseByProbeId.get(sparse.probeId);
    if (!dense) {
      throw new Error(`diffGroupCandidates(${group}): probe ${sparse.probeId} が dense 側に無い`);
    }
    return diffProbeCandidates(sparse, dense);
  });

  return {
    group,
    probeCount: diffs.length,
    identicalProbeCount: diffs.filter((d) => d.identical).length,
    probesWithDenseOnlyAboveGoldOrDistractor: diffs
      .filter((d) => d.denseOnlyRankedAboveGoldOrDistractor)
      .map((d) => d.probeId),
    diffs,
  };
}

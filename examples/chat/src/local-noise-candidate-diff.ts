import type { CapturedProbeCandidates, ScoredCandidate } from "./synthetic-score-noise.js";
import { rankOf } from "./synthetic-score-noise.js";

/**
 * sparse/dense の候補集合が本当に同じかを突き合わせる DB 非依存の純関数。判定・ノイズ注入は行わない。
 * 「dense にしか無い externalId」は、dense の filler 件数が多い場合と、中身が違うのでスコアが変わって上位に入った場合の
 * 2通りあるが、ここでは区別せずまとめて報告する（原因の切り分けは呼び出し側）。
 */

export interface CandidateDiffEntry {
  index: number;
  sparse: ScoredCandidate | null;
  dense: ScoredCandidate | null;
  idMatches: boolean;
  entryMatches: boolean;
}

export interface ProbeCandidateDiff {
  probeId: string;
  goldExternalId: string;
  distractorExternalId: string;
  sparseCandidateCount: number;
  denseCandidateCount: number;
  /** 丸ごと一致すれば、同じ入力に同じノイズ関数を掛けることになり、σ・seed によらず並べ替え結果は一致する。 */
  identical: boolean;
  matchingPrefixLength: number;
  goldRankSparse: number | null;
  goldRankDense: number | null;
  distractorRankSparse: number | null;
  distractorRankDense: number | null;
  denseOnlyIds: string[];
  sparseOnlyIds: string[];
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

/** `probeId` の不一致は呼び出し側の対応付けの誤りなので、黙って比較せず例外にする。 */
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
  group: string;
  probeCount: number;
  identicalProbeCount: number;
  probesWithDenseOnlyAboveGoldOrDistractor: string[];
  diffs: ProbeCandidateDiff[];
}

/** 群1つ分の突き合わせをまとめる。`probeId` で対応付けるが、件数が違えば例外にする（片方でしか捕まえていない probe がある、という誤りを検出するため）。 */
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

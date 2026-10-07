import type { RecalledScore, ScoreBreakdown } from "@mnemora/core";

/**
 * `affinityMeasured: false`（連想枠・必須の同伴取得）は関連度を測っていない候補なので、`total` を他の候補と比べるのは元から契約違反。
 * 比べられない値は `null` として扱い、黙って `0`/`NaN` に倒さない。
 */

export function isAffinityMeasured(score: RecalledScore): score is ScoreBreakdown {
  return score.affinityMeasured !== false;
}

export function scoreTotalOrNull(score: RecalledScore): number | null {
  return isAffinityMeasured(score) ? score.total : null;
}

/** 必ず測っているはずの場所で `score.total` を読む。`affinityMeasured: false` に当たったら握り潰さず投げる（「無いはず」が崩れているのに数字を作らない）。 */
export function requireMeasuredTotal(score: RecalledScore): number {
  const total = scoreTotalOrNull(score);
  if (total === null) {
    throw new Error(
      "requireMeasuredTotal: score.affinityMeasured is false — this call site assumed a " +
        "measured (ann/lexical) score, but got AffinityUnmeasuredScore. " +
        "association: null のはずが連想枠経由の候補が混ざっていないか確認すること（ADR 0352）。",
    );
  }
  return total;
}

export function assertAffinityMeasured(score: RecalledScore): asserts score is ScoreBreakdown {
  if (score.affinityMeasured === false) {
    throw new Error(
      "assertAffinityMeasured: score.affinityMeasured is false (AffinityUnmeasuredScore) — " +
        "this test expected a measured (ann/lexical) score with total/similarity/lexicalMatch",
    );
  }
}

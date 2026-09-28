import type { RecalledScore, ScoreBreakdown } from "@mnemora/core";

/**
 * `RecalledMemory.score` は `ScoreBreakdown | AffinityUnmeasuredScore` の判別可能な union
 * になった（Issue #548 方向2、[ADR 0351](../../../docs/decisions/0351-association-score-without-total.md)）。
 * `examples/chat` の各ベンチ・デモは、これまで `score.total`（と `similarity`/`lexicalMatch`）を
 * 素朴に読んでいた——ここに集めた小さなヘルパーで、その読み方を1箇所に揃える。
 *
 * **方針**: 連想枠・必須の同伴取得（`affinityMeasured: false`）はもともと「クエリとの関連度を
 * 測っていない」候補であり、`total` を他の候補と比べることが元から契約違反だった
 * （ADR 0246「⛔ これが閉じないもの」2、Issue #548）。ベンチ・デモ側は、比べられない値を
 * 「無い」として扱う（`null`）——黙って `0`/`NaN` などの値に倒さない。
 */

/** `score.affinityMeasured !== false` かどうか（= `ScoreBreakdown` の形を持つかどうか）。 */
export function isAffinityMeasured(score: RecalledScore): score is ScoreBreakdown {
  return score.affinityMeasured !== false;
}

/** `score.total`。`affinityMeasured: false` なら `null`（比較可能な `total` が無いことの合図）。 */
export function scoreTotalOrNull(score: RecalledScore): number | null {
  return isAffinityMeasured(score) ? score.total : null;
}

/**
 * `score.total` を、必ず測っているはず（呼び手が `association: null` を渡している等）の
 * 場所で読む。**`affinityMeasured: false` に当たったら、握り潰さず投げる**——「無いはず」が
 * 崩れていることに気づかず数字を作らない（ベンチの数字を黙って壊さない）。
 */
export function requireMeasuredTotal(score: RecalledScore): number {
  const total = scoreTotalOrNull(score);
  if (total === null) {
    throw new Error(
      "requireMeasuredTotal: score.affinityMeasured is false — this call site assumed a " +
        "measured (ann/lexical) score, but got AffinityUnmeasuredScore. " +
        "association: null のはずが連想枠経由の候補が混ざっていないか確認すること（ADR 0351）。",
    );
  }
  return total;
}

/**
 * `assertAffinityMeasured`（`packages/core/src/__tests__/runtime-fakes.ts` と同じ形）——
 * `examples/chat` 側のテストで、フィクスチャが `ScoreBreakdown` の形だと分かっている値を
 * `RecalledScore` の union から絞り込むのに使う。
 */
export function assertAffinityMeasured(score: RecalledScore): asserts score is ScoreBreakdown {
  if (score.affinityMeasured === false) {
    throw new Error(
      "assertAffinityMeasured: score.affinityMeasured is false (AffinityUnmeasuredScore) — " +
        "this test expected a measured (ann/lexical) score with total/similarity/lexicalMatch",
    );
  }
}

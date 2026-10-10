import type { ScoringStrategy } from "./strategies/scoring.js";
import { isBoundedScoringStrategy } from "./strategies/scoring.js";

/**
 * over-fetch の窓（k'）の外に、本来 top-k に入るべき候補が残っていたかを判定する
 * （[ADR 0069](../../../docs/decisions/0069-ann-truncated-says-nothing-about-loss.md) 案A）。
 *
 * ```
 * R = bar / ( sim_k' × M_max )        R >= 1 なら「窓の外は原理的に top-k へ入れない」
 * ```
 *
 * 根拠: ANN は距離順に返すので、窓の外の候補 c は `sim_c <= sim_k'`。その total は
 * `sim_c × M_c <= sim_k' × M_max` で、これが `bar` 以下なら c は k 位を抜けない。
 * `sim_k'` は**索引が返した** k' 番目であって真の k' 番目ではない。近似索引が scope の他所へ
 * 行っていた場合は上界が破れるが、それは本判定の対象外で、`ann_unreached`
 * （ADR 0025 / 0026、[ADR 0193](../../../docs/decisions/0193-ann-unreached-covers-full-window.md)）が扱う。
 */

/** 判定の結果。**3つの状態を潰さない**（ADR 0008）。 */
export type AnnTruncationVerdict =
  /**
   * 窓の外の候補は原理的に top-k へ入れない、と証明できた。
   * **⟹ 呼び出し側は `ann_truncated` を積まない（沈黙は「不在」で表す）。**
   */
  | { kind: "provably_safe"; safetyRatio: number; assumptions: readonly string[] }
  /** 損失が起こりえた。`safetyRatio` は必ず 1 未満。 */
  | { kind: "loss_possible"; safetyRatio: number; assumptions: readonly string[] }
  /** 判定そのものができなかった。**「損しなかった」ではない。** */
  | { kind: "undecidable"; reason: string };

/** {@link decideAnnTruncation} の入力。 */
export interface DecideAnnTruncationInput {
  /**
   * 段2で使ったスコアリング戦略。**上界の宣言を持たない戦略なら `undecidable` に落ちる**——
   * 黙って既定戦略の上界を当てはめない（別の式のスコアに、既定の上界は当たらない）。
   */
  strategy: ScoringStrategy;
  /** `RecallQuery.tags`。`tagMatch` の上界はここだけで決まる。 */
  queryTags: readonly string[];
  /** ANN が返した最後（k' 位）の similarity（`1 - distance`）。 */
  lastAnnSimilarity: number;
  /**
   * 返した最後（k 位）の `total`。**`limit` に満たなかったら `null`。**
   * `null` のとき比較の基準は `scoreThreshold` になる（閾値を超える候補なら必ず返っていたはずのため）。
   */
  lastReturnedTotal: number | null;
  /** 段2の閾値（`RecallQuery.scoreThreshold` の実効値）。 */
  scoreThreshold: number;
}

function isUsableNumber(v: number): boolean {
  return Number.isFinite(v);
}

/**
 * over-fetch の窓の外に、本来 top-k に入るべき候補が残っていたかを判定する純関数（ADR 0069 案A）。
 * 判定できないときは `undecidable`（「損しなかった」ではない）を返す。例外は投げない。
 * 宣言された上界の `value` が正の有限値でなければ、それも `undecidable` である。
 */
export function decideAnnTruncation(input: DecideAnnTruncationInput): AnnTruncationVerdict {
  if (!isBoundedScoringStrategy(input.strategy)) {
    return {
      kind: "undecidable",
      reason:
        "スコアリング戦略が nonSimilarityUpperBound を宣言していない。" +
        "上界が分からないので、窓の外の候補が top-k へ入れたかどうかを判定できない" +
        "（既定戦略の上界を黙って当てはめない。ADR 0069 §7）。",
    };
  }

  const bound = input.strategy.nonSimilarityUpperBound({ queryTags: input.queryTags });
  if (bound.kind === "undeclared") {
    return {
      kind: "undecidable",
      reason: `スコアリング戦略が上界を宣言できないと申告した: ${bound.reason}`,
    };
  }

  // 分母。`M_max <= 0` や非有限は上界として使えない（0 で割った Infinity を「安全だ」と読ませない）。
  if (!isUsableNumber(bound.value) || bound.value <= 0) {
    return {
      kind: "undecidable",
      reason: `宣言された上界が判定に使えない値である（value=${String(bound.value)}）。`,
    };
  }

  // `sim_k'` は 1 - distance で、コサインは負になりうる。分母が 0 以下でも「窓の外は total を稼げない」
  // とは読まない（負の similarity を掛けた total の順序は、上界の不等式が保証しない）。判定不能に落とす。
  if (!isUsableNumber(input.lastAnnSimilarity) || input.lastAnnSimilarity <= 0) {
    return {
      kind: "undecidable",
      reason:
        `ANN が返した最後の similarity が 0 以下または非有限である（${String(input.lastAnnSimilarity)}）。` +
        "この場合、上界の不等式は total の順序を保証しない。",
    };
  }

  // `lastReturnedTotal` が NaN のときは判定不能。`score_not_comparable`（ADR 0044）の領域で、
  // 閾値を緩めても窓を広げても直らない。
  const bar = input.lastReturnedTotal ?? input.scoreThreshold;
  if (!isUsableNumber(bar)) {
    return {
      kind: "undecidable",
      reason: `比較の基準になる値が非有限である（bar=${String(bar)}）。`,
    };
  }

  const safetyRatio = bar / (input.lastAnnSimilarity * bound.value);
  if (!isUsableNumber(safetyRatio)) {
    return {
      kind: "undecidable",
      reason: `安全余裕が非有限になった（safetyRatio=${String(safetyRatio)}）。`,
    };
  }

  // 境界は `>= 1` が安全側。ちょうど 1 のとき窓の外の候補は k 位と同点までしか届かず、
  // 同点は既存の順序を崩さない。
  return safetyRatio >= 1
    ? { kind: "provably_safe", safetyRatio, assumptions: bound.assumptions }
    : { kind: "loss_possible", safetyRatio, assumptions: bound.assumptions };
}

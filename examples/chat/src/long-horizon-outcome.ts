/**
 * `long-horizon` ベンチの判定: 植えた記憶1件が、ある時点の `recall()` でどうなったか。
 *
 * ⭐ 「出なかった」を1つに潰さない。出なかった理由を、mnemora の既定の経路のどの段で落ちたかで分ける
 * （北極星「知らないことを、知らないと言える」を測る側にも当てる）。
 */

export const GOLD_OUTCOME_KINDS = [
  "returned",
  "decayed",
  "below_threshold",
  "outranked",
  "not_reached",
] as const;

/**
 * - `returned`: 既定の `recall()` が返した（連想枠経由を含む）。
 * - `decayed`: `decay_floor_at` を過ぎ、既定の忘却ゲート（ADR 0153）が段1で落とす。
 * - `below_threshold`: 忘却ゲートは通るが、合計スコアが既定の閾値を割る。
 * - `outranked`: 閾値は越えるが、件数の上限（`limit`）の外に押し出された。
 * - `not_reached`: 閾値も忘却ゲートも外し、件数をテナントの記憶の総数まで広げた診断用の `recall()` でも、候補に上がらなかった。
 */
export type GoldOutcomeKind = (typeof GOLD_OUTCOME_KINDS)[number];

export interface GoldOutcomeInput {
  /** 既定の `recall()` の返り値の中での順位（1始まり）。返っていなければ `null`。 */
  returnedRank: number | null;
  /** 診断用の `recall()` で見つかったときの合計スコア。見つからなければ `null`。 */
  diagnosticTotal: number | null;
  decayFloorAt: Date;
  probeAt: Date;
  scoreThreshold: number;
}

export function classifyGoldOutcome(input: GoldOutcomeInput): GoldOutcomeKind {
  if (input.returnedRank !== null) {
    return "returned";
  }
  // 忘却ゲートは段1（候補を集める段）で効くので、スコアより先に見る。床がちょうど今の記憶はゲートで落ちる（`decay_floor_at > now` だけが通る）。
  if (input.decayFloorAt.getTime() <= input.probeAt.getTime()) {
    return "decayed";
  }
  if (input.diagnosticTotal === null) {
    return "not_reached";
  }
  if (input.diagnosticTotal < input.scoreThreshold) {
    return "below_threshold";
  }
  return "outranked";
}

/** 訂正の新旧の順位関係。 */
export type CorrectionOrder =
  "new_above_old" | "old_above_new" | "new_only" | "old_only" | "neither";

export function classifyCorrectionOrder(
  newRank: number | null,
  oldRank: number | null,
): CorrectionOrder {
  if (newRank !== null && oldRank !== null) {
    return newRank < oldRank ? "new_above_old" : "old_above_new";
  }
  if (newRank !== null) {
    return "new_only";
  }
  if (oldRank !== null) {
    return "old_only";
  }
  return "neither";
}

export interface CountByKind {
  returned: number;
  decayed: number;
  below_threshold: number;
  outranked: number;
  not_reached: number;
}

export function emptyCountByKind(): CountByKind {
  return { returned: 0, decayed: 0, below_threshold: 0, outranked: 0, not_reached: 0 };
}

export function countOutcomes(kinds: readonly GoldOutcomeKind[]): CountByKind {
  const counts = emptyCountByKind();
  for (const kind of kinds) {
    counts[kind] += 1;
  }
  return counts;
}

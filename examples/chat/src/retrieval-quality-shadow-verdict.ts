/**
 * MRR / hit@1 の閾値判定を切り出した純関数。門ではない: 返すのは「合否相当」の値で、呼び出し側は出力に記録するだけで、
 * CI を落とすためには使わない。判定を DB 呼び出しの中に直書きすると歯で測れないので、純関数にした。
 *
 * 閾値は、合成ノイズに対する偽陽性が σ=0.16 まで実測で 0/15 だった組（ADR 0276）。実測値の写しではなく、
 * 人が下した「この基準で判定する」という決定である。probe の件数は焼き込まず、`probeCount` を呼び出し側から受け取る。
 *
 * 測ったのは合成ノイズに対する偽陽性で、正当な変更に対する偽陽性ではない。n=7 のままで、hit@1 の1つ分の余裕を飲み込んでいる。
 */

export const SHADOW_MRR_THRESHOLD = 0.65;

export const SHADOW_HIT1_MIN = 3;

export interface RetrievalQualityShadowVerdictInput {
  mrrOverall: number;
  hit1Count: number;
  probeCount: number;
}

export interface RetrievalQualityShadowVerdict {
  /** CI の合否ではない。呼び出し側が exit code や `expect()` の材料に使わない限り、何もブロックしない。 */
  pass: boolean;
  reasons: string[];
}

/** 境界は `>=`。`reasons` にどちらが原因かを積む（何が下回ったかを出力から読めるように）。 */
export function decideRetrievalQualityShadowVerdict(
  input: RetrievalQualityShadowVerdictInput,
): RetrievalQualityShadowVerdict {
  const reasons: string[] = [];

  const mrrOk = input.mrrOverall >= SHADOW_MRR_THRESHOLD;
  if (!mrrOk) {
    reasons.push(`MRR ${input.mrrOverall} が閾値 ${SHADOW_MRR_THRESHOLD} を下回った`);
  }

  const hit1Ok = input.hit1Count >= SHADOW_HIT1_MIN;
  if (!hit1Ok) {
    reasons.push(
      `hit@1 ${input.hit1Count}/${input.probeCount} が最低 ${SHADOW_HIT1_MIN} を下回った`,
    );
  }

  return { pass: mrrOk && hit1Ok, reasons };
}

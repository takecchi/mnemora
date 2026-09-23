/**
 * `retrieval-quality-regression.postgres.test.ts`(ADR 0227)と*並走*させる、
 * MRR / hit@1 の閾値判定を切り出した純関数(Issue #572「段1」、ADR 0275)。
 *
 * **これは門ではない。**このモジュールが返すのは「合否」ではなく「合否*相当*の値」
 * であり、呼び出し側(`__tests__/retrieval-quality-shadow-verdict.postgres.test.ts`)は
 * その結果を**出力に記録するだけ**で、CI を落とすためには使わない。
 * ⟹ 既存の `retrieval-quality-regression.postgres.test.ts`(`goldRank !== null` だけを
 * 見る歯)は1バイトも変えていない——こちらは別ファイル・別の判定である。
 *
 * **なぜ純関数として切り出すか**: `scripts/publish-dry-run.mjs` の `decideDryRun()`・
 * `scripts/release-version.mjs` の `distTagFor()` と同じ理由——判定を DB 呼び出しや
 * CLI の中に直書きすると、判定そのものを歯で測れない。ここに切り出せば、
 * DB もカセットも要らない歯(`__tests__/retrieval-quality-shadow-verdict.test.ts`)を
 * この関数へ直接当てられる。
 *
 * ## 閾値の出所(Issue #572 の2件目のコメント「⭐ 採る道」)
 *
 * `SHADOW_MRR_THRESHOLD` と `SHADOW_HIT1_MIN` は、Issue #572 のコメント2件目
 * (【実測 2026-09-23】)が示した反実仮想の表——`affinity` へ対称な合成ノイズ
 * `× (1 + σ·ε)` を σ = 11 段 × seed 15 通り = 165 run 注入し、各 σ について
 * 「その門が赤になった run 数 / 15」を数えた表——のうち、次の1行を採ったものである:
 *
 * | 判定 | 無変異 | σ=0.0025〜0.08(MRRの中央値が基準のまま。6段すべて) | σ=0.16 | σ=0.24 |
 * |---|---|---|---|---|
 * | `MRR >= 0.65` | 緑 | 0/15 | 0/15 | 2/15 |
 * | `hit@1 >= 3` | 緑 | 0/15 | 0/15 | 0/15 |
 *
 * ⟹ **σ=0.16(=品質が全く落ちていない帯のすぐ外)まで、合成ノイズに対する偽陽性が
 * 実測で 0/15 だった**組を採用している。
 *
 * ### ⛔ これは「実測値の焼き込み」ではない(`AGENTS.md`「⚠ 数を、道具と生成物に
 * 焼き込まない」との関係)
 *
 * `AGENTS.md` が禁じているのは「`main` が動けば変わる数(件数・行番号・実測順位・sha
 * 等)を道具や生成物に写すこと」である。**下の2定数はそれではない**——
 * 実測順位のベクトル(`1,1,2,6,1,1,2`)や probe 件数(7)を書き写したものではなく、
 * **人(この場合はクローン)が下した「この基準で判定する」という決定そのもの**である。
 * 実測値の写しと決定した基準は別物だ、という区別は
 * [ADR 0275](../../../docs/decisions/0275-retrieval-quality-shadow-verdict-stage1.md)
 * に明記してある——ここでは繰り返さない。
 *
 * ⛔ **probe の件数(7)は焼き込まない。**`SHADOW_HIT1_MIN` の分母は、呼び出し側が
 * `PROBES.length`(`./probe-set.js`)から渡す `probeCount` であり、この関数はそれを
 * 検査対象にしない(受け取った `probeCount` をそのまま `reasons` の文言に使うだけ)。
 *
 * ### ⚠ この判定がまだ答えていないこと
 *
 * - **測ったのは合成ノイズに対する偽陽性であって、「正当な変更」に対する偽陽性ではない**
 *   ([ADR 0275](../../../docs/decisions/0275-retrieval-quality-shadow-verdict-stage1.md)
 *   「測定の射程」)。
 * - **n=7 のままである**——`hit@1` が 4/7 → 3/7 へ動く「1つ分の余裕」を、この関数の
 *   `SHADOW_HIT1_MIN = 3` は明示的に飲み込んでいる。ADR 0088 §2.1 / ADR 0033 §3 の
 *   懸念を解いてはいない。
 */

/** Issue #572 コメント2の反実仮想表で、σ=0.16 まで偽陽性 0/15 だった MRR の下限。 */
export const SHADOW_MRR_THRESHOLD = 0.65;

/** 同じ表で、σ=0.16 まで偽陽性 0/15 だった hit@1 の下限(件数。分母は probeCount)。 */
export const SHADOW_HIT1_MIN = 3;

export interface RetrievalQualityShadowVerdictInput {
  /** `ArmReport.mrrOverall`(または `armHeadline().mrrOverall`)。 */
  mrrOverall: number;
  /** `armHeadline().hit1Count`。 */
  hit1Count: number;
  /** `armHeadline().probeCount`(= `PROBES.length`)。この関数はここから件数を導かない
   *  ——呼び出し側が唯一の出所(`probe-set.ts`)から渡す。 */
  probeCount: number;
}

export interface RetrievalQualityShadowVerdict {
  /**
   * ⛔ これは CI の合否ではない。呼び出し側が exit code や `expect()` の材料に
   * 使わない限り、何もブロックしない(Issue #572「段1」)。
   */
  pass: boolean;
  /** 満たさなかった条件の説明。`pass === true` なら空配列。 */
  reasons: string[];
}

/**
 * MRR と hit@1 のそれぞれについて、`SHADOW_MRR_THRESHOLD` / `SHADOW_HIT1_MIN` 以上かを
 * 判定する。**両方を満たしたときだけ `pass: true`。**
 *
 * 境界は `>=`(閾値ちょうどは合格)。片方だけ満たさない場合も、両方満たさない場合も
 * `pass: false` になり、`reasons` にどちらが原因かを積む——「何が」下回ったかを
 * 出力から読めるようにするため(呼び出し側がそのまま記録に使う)。
 */
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

/**
 * 訂正の口の測定ケースの型（ADR 0232）。
 *
 * 測る問いは、訂正の発話を `recall()` に投げたとき、1位が「訂正された相手」であるか。
 * 「訂正された相手」は、返った `memories[]` のうち、訂正前の事実を述べた発話（gold）から抽出された記憶とし、
 * 系譜（`sourceObservationId` → `Observation.externalId`）で同定する。
 *
 * 限界: 系譜の一致が証明するのは出典への到達だけで、記憶の中身が対象の事実を保っているかは測っていない（`docs/autonomy.md` §2.2 決定2）。
 *
 * ケース集合は `correction-case-set.dev.ts`（調整に使ってよい）と `correction-case-set.eval.ts`（見て調整しない）に割ってある。
 */

export type CorrectionTuningUse = "development" | "held-out";

/**
 * A 群: 訂正すべき相手が実在するケース。hit@k の分母。
 * `gold` と `distractor` は同じ話題・違う主語または値で作る。`distractor` が `gold` より上に来たら、
 * 別人の事実を失効させる向きに壊れているということ。
 */
export interface CorrectionHitCase {
  id: string;
  gold: string;
  distractor: string;
  correction: string;
  /**
   * 期待結果の根拠。現在の実装の出力だけから正解を作らない（§2.2 決定1）。
   * どの発話がどの発話を訂正しているかは、ケースを書いた時点で決まっている。
   */
  grounds: string;
  tuningUse: CorrectionTuningUse;
}

/** B 群: 訂正してはいけないケース。誤爆率・棄権率の分母。否定・曖昧な発言・別人や別期間の事実を誤って失効させない（§2.2 決定1）。 */
export interface CorrectionAbstainCase {
  id: string;
  kind: "negation" | "vague" | "other_person" | "other_period";
  /**
   * 失効させてはいけない、成立し続けている事実。空配列は「守るべき相手そのものが記憶に無い」ことを表す（曖昧な発話）。
   * そのときはどの記憶を1位にしても誤り。
   */
  protectedFacts: string[];
  utterance: string;
  grounds: string;
  tuningUse: CorrectionTuningUse;
}

/** ケース1件ぶんの `observe()` の `externalId`。冪等性の鍵であり、同定の鍵でもある。 */
export const correctionGoldExternalId = (id: string): string => `corr-${id}-gold`;
export const correctionDistractorExternalId = (id: string): string => `corr-${id}-distractor`;
export const correctionProtectedExternalId = (id: string, index: number): string =>
  `corr-abstain-${id}-protected-${String(index)}`;

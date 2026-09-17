/**
 * Issue #369 (C)「訂正の口」の測定ケースの型（[ADR 0232](../../../docs/decisions/0232-correction-candidates-returned-not-chosen.md)）。
 *
 * **測る問い**: 訂正の発話を `recall()` に投げたとき、1位が「訂正された相手」であるか。
 *
 * **「訂正された相手」の定義**（⚠ Issue #369 に定義は無い。この器が置く）:
 *
 * > 1つの訂正ケースで、訂正の発話そのものを `RecallQuery.text` にして `recall()` を
 * > 1回呼んだとき、返った `memories[]` の中の、**訂正前の事実を述べた発話（gold）から
 * > 抽出された記憶**を「訂正された相手」と呼ぶ。同定は系譜
 * > （`sourceObservationId` → `Observation.externalId`）で行う。
 *
 * ⚠ **この定義の限界**: `docs/autonomy.md` §2.2 決定2 のとおり、系譜の一致は
 * **出典への到達だけ**を証明する。「その記憶の中身が訂正対象の事実を保っているか」は
 * この器では測っていない。
 *
 * **ケース集合は2つに割ってある**（§2.2 決定5）——`correction-case-set.dev.ts`（調整に
 * 使ってよい）と `correction-case-set.eval.ts`（⛔ 見て調整しない）。`answer-case-set.
 * dev.ts`/`answer-case-set.eval.ts` と同じ規律・同じ `tuningUse` の語彙である。
 */

export type CorrectionTuningUse = "development" | "held-out";

/**
 * A 群: **訂正すべき相手が実在する**ケース。hit@k の分母になる。
 *
 * `gold` と `distractor` は「同じ話題・違う主語または値」で作る（`probe-set.ts` の
 * `Probe.distractor` と同じ考え方）——`distractor` が `gold` より上に来たら、
 * **「別人の事実を失効させる」向きに壊れている**ということである。
 */
export interface CorrectionHitCase {
  id: string;
  /** 訂正される側。これが「訂正された相手」＝ gold。 */
  gold: string;
  /** 同じ話題・違う主語/値。gold より上に来たら深刻な向きの誤り。 */
  distractor: string;
  /** 訂正の発話。これを `recall(ctx, { text })` の `text` にする。 */
  correction: string;
  /**
   * 期待結果の根拠（§2.2 決定1「根拠は仕様や確認済みの利用例に置き、**現在の実装の
   * 出力だけから正解を作らない**」）。⭐ **どの発話がどの発話を訂正しているかは、
   * ケースを書いた時点で構造として決まっている**——実装が何を返したかは見ていない。
   */
  grounds: string;
  tuningUse: CorrectionTuningUse;
}

/**
 * B 群: ⛔ **訂正してはいけない**ケース。誤爆率・棄権率の分母になる。
 *
 * `docs/autonomy.md` §2.2 決定1 が逐語で要求する4分類を持つ:
 *
 * > 訂正では明示的な訂正だけでなく、**否定・曖昧な発言・別人や別期間の事実を誤って
 * > 失効させないケース**も扱う。
 */
export interface CorrectionAbstainCase {
  id: string;
  kind: "negation" | "vague" | "other_person" | "other_period";
  /**
   * ⛔ **失効させてはいけない、成立し続けている事実。**空配列は「守るべき相手そのものが
   * 記憶に無い」ことを表す（曖昧な発話がこれに当たる）——そのときは
   * **どの記憶を1位にしても誤りである。**
   */
  protectedFacts: string[];
  /** 訂正として宣言されうる発話。これを `recall(ctx, { text })` の `text` にする。 */
  utterance: string;
  grounds: string;
  tuningUse: CorrectionTuningUse;
}

/** ケース1件ぶんの `observe()` の `externalId`。冪等性の鍵であり、同定の鍵でもある。 */
export const correctionGoldExternalId = (id: string): string => `corr-${id}-gold`;
export const correctionDistractorExternalId = (id: string): string => `corr-${id}-distractor`;
export const correctionProtectedExternalId = (id: string, index: number): string =>
  `corr-abstain-${id}-protected-${String(index)}`;

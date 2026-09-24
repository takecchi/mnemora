import type { TimeWeightingCase } from "./time-weighting-case.js";
import { daysBefore, hoursBefore } from "./time-weighting-dates.js";

/**
 * `answer-time-weighting` ベンチの評価用ケース集合（`tuningUse: "held-out"`）。
 *
 * 🔴 **この集合は、実装・スコア式の数値を見て調整しない。** 自然な利用場面として
 * 書き、単独の commit で凍結する。以後この集合を変えたくなったら、まず手を止めて
 * マネージャーへ相談する（`answer-case-set.eval.ts` と同じ規律、Issue #506 §2.2 決定5）。
 *
 * 共通の基準時刻。dev 側（`time-weighting-case-set.dev.ts`）とは独立の値を使う——
 * 「基準時刻の選び方そのものが結果に効く」余地を dev 側の調整から切り離すため。
 */
const T0 = new Date("2026-07-15T09:00:00.000Z");

export const TIME_WEIGHTING_CASE_SET_EVAL: TimeWeightingCase[] = [
  // ---------------------------------------------------------------------
  // 類型A: 古く記録され最近 reinforce された恒常的な事実 vs 新しく記録されたが
  // 一度も reinforce されていない弱い競合記憶。
  // ---------------------------------------------------------------------
  {
    id: "eval-a1-window-seat",
    kind: "reinforced-fact-vs-fresh-weak",
    recallAt: T0,
    memories: [
      {
        localId: "established-preference",
        content: "会議室の席はいつも窓側を希望している。長年の習慣。",
        recordedAt: daysBefore(T0, 450),
        reinforceAt: [daysBefore(T0, 1)],
      },
      {
        localId: "offhand-remark",
        content: "今日はたまたま廊下側の席でもいいかもとつぶやいただけ。",
        recordedAt: hoursBefore(T0, 1),
      },
    ],
    question: "会議室の席はどちら側を用意すればいいですか?",
    expected: { kind: "closed-value", accept: ["窓側"], reject: ["廊下側"] },
    rationale:
      "established-preference は450日前に記録・1日前に reinforce された恒常的な好み" +
      "（occurredAt 無し）。offhand-remark は1時間前の思いつき、一度も reinforce されていない。",
    tuningUse: "held-out",
  },
  {
    id: "eval-a2-doc-tool",
    kind: "reinforced-fact-vs-fresh-weak",
    recallAt: T0,
    memories: [
      {
        localId: "established-preference",
        content: "資料作成にはずっとNotionを使い続けている。長年の習慣。",
        recordedAt: daysBefore(T0, 600),
        reinforceAt: [daysBefore(T0, 3)],
      },
      {
        localId: "offhand-remark",
        content: "今日はふとGoogleドキュメントもいいかもと言っただけ。",
        recordedAt: hoursBefore(T0, 2),
      },
    ],
    question: "資料作成には何のツールを使っていますか?",
    expected: { kind: "closed-value", accept: ["Notion"], reject: ["Google"] },
    rationale:
      "established-preference は600日前に記録・3日前に reinforce。offhand-remark は" +
      "2時間前の思いつき、一度も reinforce されていない。",
    tuningUse: "held-out",
  },

  // ---------------------------------------------------------------------
  // 類型B: 両方とも occurredAt を持つ。古い出来事が新しい出来事より上位に来てはいけない。
  // ---------------------------------------------------------------------
  {
    id: "eval-b1-pet",
    kind: "old-event-not-outrank-new",
    recallAt: T0,
    memories: [
      {
        localId: "old-event",
        content: "10年前は実家で犬を飼っていた。",
        occurredAt: daysBefore(T0, 3650),
        recordedAt: hoursBefore(T0, 1),
        reinforceAt: [hoursBefore(T0, 1)],
      },
      {
        localId: "new-event",
        content: "先週から新しく猫を飼い始めた。",
        occurredAt: daysBefore(T0, 6),
        recordedAt: daysBefore(T0, 6),
        reinforceAt: [daysBefore(T0, 6)],
      },
    ],
    question: "いま飼っているペットは何ですか?",
    expected: { kind: "closed-value", accept: ["猫"], reject: ["犬"] },
    rationale:
      "old-event は出来事時刻が10年前、new-event は先週。両方とも occurredAt を持つため、" +
      "freshness の式は legacy/eventAwareFreshness で変わらない——old-event は古びて" +
      "候補から落ちるはずで、これはどちらの方針でも同じでなければならない。",
    tuningUse: "held-out",
  },
  {
    id: "eval-b2-relocation",
    kind: "old-event-not-outrank-new",
    recallAt: T0,
    memories: [
      {
        localId: "old-event",
        content: "5年前に大阪から引っ越して東京に住み始めた。",
        occurredAt: daysBefore(T0, 1800),
        recordedAt: hoursBefore(T0, 1),
        reinforceAt: [hoursBefore(T0, 1)],
      },
      {
        localId: "new-event",
        content: "先週、東京から福岡へ引っ越した。",
        occurredAt: daysBefore(T0, 5),
        recordedAt: daysBefore(T0, 5),
        reinforceAt: [daysBefore(T0, 5)],
      },
    ],
    question: "いまどこに住んでいますか?",
    expected: { kind: "closed-value", accept: ["福岡"], reject: ["東京"] },
    rationale: "eval-b1-pet と同じ設計——古い出来事（5年前の転居）と新しい出来事（先週の転居）。",
    tuningUse: "held-out",
  },

  // ---------------------------------------------------------------------
  // 類型C: 期限切れの予定が、現行の予定より優先されてはいけない。
  // ---------------------------------------------------------------------
  {
    id: "eval-c1-internet-plan",
    kind: "expired-schedule-not-outrank-current",
    recallAt: T0,
    memories: [
      {
        localId: "expired-schedule",
        content: "インターネットの契約プランはライトプラン。",
        recordedAt: daysBefore(T0, 200),
        validFrom: daysBefore(T0, 200),
        validUntil: daysBefore(T0, 15),
        reinforceAt: [daysBefore(T0, 150)],
      },
      {
        localId: "current-schedule",
        content: "先日、インターネットの契約をスタンダードプランへ切り替えた。",
        recordedAt: daysBefore(T0, 14),
        validFrom: daysBefore(T0, 14),
        reinforceAt: [daysBefore(T0, 14)],
      },
    ],
    question: "いまのインターネット契約プランは何ですか?",
    expected: { kind: "closed-value", accept: ["スタンダード"], reject: ["ライト"] },
    rationale:
      "expired-schedule は15日前に validUntil を迎えて期限切れ。validAt ゲートは" +
      "timeWeighting を参照しないため、どちらの方針でも current-schedule だけが残るはずである。",
    tuningUse: "held-out",
  },
  {
    id: "eval-c2-work-shift",
    kind: "expired-schedule-not-outrank-current",
    recallAt: T0,
    memories: [
      {
        localId: "expired-schedule",
        content: "シフトは早番（9時〜17時）だった。",
        recordedAt: daysBefore(T0, 90),
        validFrom: daysBefore(T0, 90),
        validUntil: daysBefore(T0, 5),
        reinforceAt: [daysBefore(T0, 60)],
      },
      {
        localId: "current-schedule",
        content: "今週から遅番（13時〜21時）に変わった。",
        recordedAt: daysBefore(T0, 4),
        validFrom: daysBefore(T0, 4),
        reinforceAt: [daysBefore(T0, 4)],
      },
    ],
    question: "いまのシフトは早番と遅番のどちらですか?",
    expected: { kind: "closed-value", accept: ["遅番"], reject: ["早番"] },
    rationale:
      "eval-c1-internet-plan と同じ設計——5日前に期限切れになったシフトと、4日前からの現行シフト。",
    tuningUse: "held-out",
  },
];

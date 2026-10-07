import type { TimeWeightingCase } from "./time-weighting-case.js";
import { daysBefore, hoursBefore } from "./time-weighting-dates.js";

/** 開発用ケース集合。調整に使ってよい側（`time-weighting-case-set.eval.ts` と対）。抽出 LLM を通さず記憶を直接書く。 */
const T0 = new Date("2026-06-01T09:00:00.000Z");

export const TIME_WEIGHTING_CASE_SET_DEV: TimeWeightingCase[] = [
  {
    id: "dev-a1-tea-over-coffee",
    kind: "reinforced-fact-vs-fresh-weak",
    recallAt: T0,
    memories: [
      {
        localId: "established-preference",
        content: "この人は打ち合わせの飲み物はいつも紅茶を選ぶ。何年も変わらない習慣。",
        recordedAt: daysBefore(T0, 400),
        reinforceAt: [daysBefore(T0, 1)],
      },
      {
        localId: "offhand-remark",
        content: "今日はたまたま口にしただけかもしれないが、コーヒーの方がいいかもと言っていた。",
        recordedAt: hoursBefore(T0, 2),
      },
    ],
    question: "打ち合わせのとき、この人に出す飲み物は何がいいですか?",
    expected: { kind: "closed-value", accept: ["紅茶"], reject: ["コーヒー"] },
    rationale:
      "established-preference は400日前に記録され、直近1日前に reinforce された恒常的な" +
      "好み（occurredAt 無し）。offhand-remark は2時間前に記録されたばかりで一度も" +
      "reinforce されていない弱い競合記憶。legacy は established-preference の freshness を" +
      "recordedAt の古さで沈め続けるため、below_threshold で落ちて offhand-remark だけが" +
      "残りうる——eventAwareFreshness は occurredAt が無い記憶の freshness を1に固定するため、" +
      "established-preference が残る。",
    tuningUse: "development",
  },
  {
    id: "dev-a2-remote-work-day",
    kind: "reinforced-fact-vs-fresh-weak",
    recallAt: T0,
    memories: [
      {
        localId: "established-rule",
        content: "在宅勤務は毎週火曜日と決めている。長らく変わっていない。",
        recordedAt: daysBefore(T0, 500),
        reinforceAt: [daysBefore(T0, 2)],
      },
      {
        localId: "offhand-remark",
        content: "今日はなんとなく金曜も家で働こうかなと言っただけ。",
        recordedAt: hoursBefore(T0, 3),
      },
    ],
    question: "在宅勤務は何曜日と決まっていますか?",
    expected: { kind: "closed-value", accept: ["火曜"], reject: ["金曜"] },
    rationale:
      "dev-a1-tea-over-coffee と同じ設計——established-rule は500日前に記録・2日前に" +
      "reinforce された恒常的な決め事、offhand-remark は3時間前の思いつき。",
    tuningUse: "development",
  },

  {
    id: "dev-b1-phone-model",
    kind: "old-event-not-outrank-new",
    recallAt: T0,
    memories: [
      {
        localId: "old-event",
        content: "1年ほど前にiPhoneからXperiaへ機種変更した。",
        occurredAt: daysBefore(T0, 400),
        recordedAt: hoursBefore(T0, 1),
        reinforceAt: [hoursBefore(T0, 1)],
      },
      {
        localId: "new-event",
        content: "今日、新しくGalaxyを買って使い始めた。",
        occurredAt: hoursBefore(T0, 2),
        recordedAt: hoursBefore(T0, 2),
        reinforceAt: [hoursBefore(T0, 2)],
      },
    ],
    question: "いま使っているスマホの機種は何ですか?",
    expected: { kind: "closed-value", accept: ["Galaxy"], reject: ["Xperia"] },
    rationale:
      "old-event は出来事時刻が400日前、new-event は2時間前。両方とも occurredAt を持つため、" +
      "freshness の式は legacy/eventAwareFreshness で1文字も変わらない（ADR 0300）——" +
      "old-event は古びて below_threshold で落ち、new-event だけが残るはずで、これは" +
      "どちらの方針でも同じでなければならない。",
    tuningUse: "development",
  },
  {
    id: "dev-b2-current-project",
    kind: "old-event-not-outrank-new",
    recallAt: T0,
    memories: [
      {
        localId: "old-event",
        content: "2年前はアルファプロジェクトを担当していた。",
        occurredAt: daysBefore(T0, 730),
        recordedAt: hoursBefore(T0, 2),
        reinforceAt: [hoursBefore(T0, 2)],
      },
      {
        localId: "new-event",
        content: "先月からベータプロジェクトを担当している。",
        occurredAt: daysBefore(T0, 20),
        recordedAt: daysBefore(T0, 20),
        reinforceAt: [daysBefore(T0, 20)],
      },
    ],
    question: "いまどのプロジェクトを担当していますか?",
    expected: { kind: "closed-value", accept: ["ベータ"], reject: ["アルファ"] },
    rationale: "dev-b1-phone-model と同じ設計——古い出来事（2年前）と新しい出来事（先月）。",
    tuningUse: "development",
  },

  {
    id: "dev-c1-meeting-schedule",
    kind: "expired-schedule-not-outrank-current",
    recallAt: T0,
    memories: [
      {
        localId: "expired-schedule",
        content: "定例会議は水曜日16時から。",
        recordedAt: daysBefore(T0, 60),
        validFrom: daysBefore(T0, 60),
        validUntil: daysBefore(T0, 1),
        reinforceAt: [daysBefore(T0, 30)],
      },
      {
        localId: "current-schedule",
        content: "定例会議は木曜日10時に変更した。今後はこちら。",
        recordedAt: daysBefore(T0, 1),
        validFrom: daysBefore(T0, 1),
        reinforceAt: [daysBefore(T0, 1)],
      },
    ],
    question: "定例会議は何曜日の何時からですか?",
    expected: { kind: "closed-value", accept: ["木曜"], reject: ["水曜"] },
    rationale:
      "expired-schedule は昨日 validUntil を迎えて期限切れ。validAt ゲート（既定 now）は" +
      "timeWeighting を参照しないため、legacy/eventAwareFreshness のどちらでも" +
      "expired-schedule は候補から除かれ、current-schedule だけが残るはずである。",
    tuningUse: "development",
  },
  {
    id: "dev-c2-gym-plan",
    kind: "expired-schedule-not-outrank-current",
    recallAt: T0,
    memories: [
      {
        localId: "expired-schedule",
        content: "ジムの会員プランはベーシックプラン。",
        recordedAt: daysBefore(T0, 100),
        validFrom: daysBefore(T0, 100),
        validUntil: daysBefore(T0, 10),
        reinforceAt: [daysBefore(T0, 90)],
      },
      {
        localId: "current-schedule",
        content: "先週、ジムの会員プランをプレミアムプランへ変更した。",
        recordedAt: daysBefore(T0, 7),
        validFrom: daysBefore(T0, 7),
        reinforceAt: [daysBefore(T0, 7)],
      },
    ],
    question: "いまのジムの会員プランは何ですか?",
    expected: { kind: "closed-value", accept: ["プレミアム"], reject: ["ベーシック"] },
    rationale:
      "dev-c1-meeting-schedule と同じ設計——10日前に期限切れになったプランと、7日前に切り替えた現行プラン。",
    tuningUse: "development",
  },
];

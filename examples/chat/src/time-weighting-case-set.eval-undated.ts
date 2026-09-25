import type { TimeWeightingCase } from "./time-weighting-case.js";
import { daysBefore } from "./time-weighting-dates.js";

/**
 * `answer-time-weighting` ベンチの評価用ケース集合・補足（`tuningUse: "held-out"`）。
 * 段2a（マネージャー決定、Issue #690）。
 *
 * 🔴 **この集合も `time-weighting-case-set.eval.ts` と同じ規律で凍結する**——
 * 実装・スコア式の数値を見て調整していない。自然な利用場面として書き、この commit で
 * 凍結する。以後変更が必要と判断したら、実装側を直さず先にマネージャーへ相談すること。
 *
 * **既存の `eval.ts`（類型A/B/C）とは別ファイルにする理由**: 類型B/Cは両方の記憶に
 * `occurredAt`（Cは`validUntil`も）を持たせた regression guard であり、
 * legacy/eventAwareFreshness で数式レベルの不変条件が効くため「新方針が実際に
 * 退行するか」を測れない。ここに足す類型B'/C'は、**抽出が出来事時刻・期限を
 * 捉えられなかった（`occurredAt`/`validUntil` が無い）古い記憶**を競合させる——
 * eventAwareFreshness が freshness=1 に固定する対象そのものが「本当は古い」場面。
 *
 * 各類型2件、計4件。**各類型のうち1件は、古い側を直近に reinforce する版**
 * （「最近その話題が出た」）にする——reinforce で `decay` も高いままだと、
 * freshness=1（eventAwareFreshness）と組み合わさって初めて legacy より悪化しうる、
 * という組み合わせを実際に踏む。
 */
const T0 = new Date("2026-08-01T09:00:00.000Z");

export const TIME_WEIGHTING_CASE_SET_EVAL_UNDATED: TimeWeightingCase[] = [
  // ---------------------------------------------------------------------
  // 類型B': 古い出来事が occurredAt 無しで記録され、新しい出来事と競合する。
  // ---------------------------------------------------------------------
  {
    id: "eval-undated-b1-department-reinforced",
    kind: "old-event-undated-vs-new",
    recallAt: T0,
    memories: [
      {
        localId: "old-department-undated",
        content: "以前は営業部で働いていた。",
        recordedAt: daysBefore(T0, 500),
        // 最近その話題が出た（例: 昔話をした）ので reinforce された。
        reinforceAt: [daysBefore(T0, 1)],
      },
      {
        localId: "new-department",
        content: "先月、開発部に異動した。",
        occurredAt: daysBefore(T0, 20),
        recordedAt: daysBefore(T0, 20),
        reinforceAt: [daysBefore(T0, 20)],
      },
    ],
    question: "いまどの部署で働いていますか?",
    expected: { kind: "closed-value", accept: ["開発部"], reject: ["営業部"] },
    rationale:
      "old-department-undated は occurredAt を持たず（抽出が異動時期を捉えられなかった" +
      "想定）、500日前に記録されたが直近1日前に reinforce されている。legacy は" +
      "recordedAt の古さで freshness を沈めるが、eventAwareFreshness は freshness を1に" +
      "固定するため、reinforce による高い decay と組み合わさって new-department と" +
      "競合しうる——これが類型B'が測る危険そのものである。",
    tuningUse: "held-out",
  },
  {
    id: "eval-undated-b2-hobby-not-reinforced",
    kind: "old-event-undated-vs-new",
    recallAt: T0,
    memories: [
      {
        localId: "old-hobby-undated",
        content: "学生時代はテニス部に所属していた。",
        recordedAt: daysBefore(T0, 600),
      },
      {
        localId: "new-hobby",
        content: "最近、週末はボルダリングにはまっている。",
        occurredAt: daysBefore(T0, 10),
        recordedAt: daysBefore(T0, 10),
        reinforceAt: [daysBefore(T0, 10)],
      },
    ],
    question: "最近ハマっている趣味は何ですか?",
    expected: { kind: "closed-value", accept: ["ボルダリング"], reject: ["テニス"] },
    rationale:
      "old-hobby-undated も occurredAt を持たないが、一度も reinforce されていない" +
      "（`lastReinforcedAt` は無く `decay` の起点は600日前の recordedAt のまま）。" +
      "eventAwareFreshness で freshness=1 になっても decay 自体が低いままなら、" +
      "eval-undated-b1 ほどには new-hobby と競合しないはずである——reinforce の" +
      "有無が実際に効いているかを対比するための対照ケース。",
    tuningUse: "held-out",
  },

  // ---------------------------------------------------------------------
  // 類型C': 期限切れの予定が occurredAt・validFrom・validUntil のいずれも無く
  // 記録され（抽出が期限を構造化できなかった）、validAt ゲートでは除かれない。
  // ---------------------------------------------------------------------
  {
    id: "eval-undated-c1-seat-floor-reinforced",
    kind: "expired-schedule-undated-vs-current",
    recallAt: T0,
    memories: [
      {
        localId: "old-seat-undated",
        content: "オフィスの座席は3階です。",
        recordedAt: daysBefore(T0, 300),
        // 最近また座席の話題が出た（例: 来客案内で聞かれた）ので reinforce された。
        reinforceAt: [daysBefore(T0, 2)],
      },
      {
        localId: "current-seat",
        content: "先週、座席が5階に移動した。",
        occurredAt: daysBefore(T0, 6),
        recordedAt: daysBefore(T0, 6),
        validFrom: daysBefore(T0, 6),
        reinforceAt: [daysBefore(T0, 6)],
      },
    ],
    question: "いまのオフィスの座席は何階ですか?",
    expected: { kind: "closed-value", accept: ["5階"], reject: ["3階"] },
    rationale:
      "old-seat-undated は occurredAt も validFrom/validUntil も持たない——抽出が" +
      "この事実を『期限のある予定』として構造化できなかった想定。validFrom/validUntil が" +
      "両方 null の記憶は『いつでも真』として扱われる（`validAt` ゲートでは除かれない）" +
      "ため、除外の頼みの綱は freshness/decay だけになる。300日前の記録・直近2日前の" +
      "reinforce という組み合わせは eval-undated-b1 と同型の危険を、予定（schedule）の" +
      "文脈で踏む。",
    tuningUse: "held-out",
  },
  {
    id: "eval-undated-c2-standup-day-not-reinforced",
    kind: "expired-schedule-undated-vs-current",
    recallAt: T0,
    memories: [
      {
        localId: "old-standup-undated",
        content: "以前のプロジェクトの定例は毎週火曜日だった。",
        recordedAt: daysBefore(T0, 250),
      },
      {
        localId: "current-standup",
        content: "今のプロジェクトの定例は毎週木曜日です。",
        occurredAt: daysBefore(T0, 15),
        recordedAt: daysBefore(T0, 15),
        validFrom: daysBefore(T0, 15),
        reinforceAt: [daysBefore(T0, 15)],
      },
    ],
    question: "いまのプロジェクトの定例は何曜日ですか?",
    expected: { kind: "closed-value", accept: ["木曜"], reject: ["火曜"] },
    rationale:
      "old-standup-undated も validFrom/validUntil・occurredAt のいずれも持たず、" +
      "validAt ゲートでは除かれない。一度も reinforce されていない対照ケース——" +
      "eval-undated-c1 と対にして、reinforce の有無が危険の大小に効いているかを見る。",
    tuningUse: "held-out",
  },
];

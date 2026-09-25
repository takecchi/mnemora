import type { AnswerExpectation } from "./answer-case.js";

/**
 * `answer-time-weighting` ベンチ（Issue #690 / PR #697）が使う型。
 *
 * 🔴 **既存の `answer` ベンチ（`answer-case.ts`）とは何を測るかが違う。** あちらは
 * 「naive と mnemora の回答を、同じ質問・同じ会話で比べる」——**取り込み直後に
 * `recall()` する**ため、時間項（`decay`/`freshness`）はほぼ1に張り付き、
 * `RecallQuery.timeWeighting`（`"legacy"` | `"eventAwareFreshness"`、ADR 0300）の
 * 違いは出ない（`docs/decisions/0300-time-weighting-policy-opt-in.md` §1 の
 * 「occurredAt の無い記憶への freshness の二重減衰」は、時間が経ってから初めて起きる）。
 *
 * このベンチは**時間を実際に進める**——各ケースは、記憶を直接（抽出 LLM を通さず）
 * 明示の `recordedAt`/`occurredAt`/`validFrom`/`validUntil` で書き、指定した時刻に
 * `reinforce` し、その後の時刻（`recallAt`）で `recall()` を2方針（`legacy`/
 * `eventAwareFreshness`）それぞれに対して呼んで、**同じ質問への最終回答が
 * 正しいか**（`gradeAnswer`）を比べる。
 */

/**
 * ケースの類型（マネージャー決定、Issue #690 段1の指示）。
 *
 * - `"reinforced-fact-vs-fresh-weak"`（類型A）: 古く記録され最近 reinforce された
 *   恒常的な事実（`occurredAt` 無し）が、新しく記録されたが弱い（一度も reinforce
 *   されていない）競合記憶に埋もれてはいけない。**legacy はここで失敗しうる**——
 *   ADR 0300 が直そうとしている二重減衰そのものが起きる場面。
 * - `"old-event-not-outrank-new"`（類型B）: 両方の記憶に `occurredAt` がある場合、
 *   古い出来事が新しい出来事より上位に来てはいけない。ADR 0300 の式は
 *   `occurredAt` が在るとき `legacy`/`eventAwareFreshness` で1文字も変わらない
 *   （`scoring.ts` の `computeFreshness` docstring）——⟹ **この類型は regression
 *   guard であり、どちらの方針でも同じく正しく答えられるはずである。**
 * - `"expired-schedule-not-outrank-current"`（類型C）: 期限切れの予定
 *   （`validUntil` が過去）が、現行の予定より優先されてはいけない。`validAt` ゲートは
 *   `timeWeighting` を一切参照しない（`ScoringInput.timeWeighting` docstring）
 *   ——⟹ **これも regression guard**——期限切れの記憶は方針に関係なく
 *   候補から除かれ続けるはずである。
 *
 * **類型B'/C'（段2a、マネージャー決定、`time-weighting-case-set.eval-undated.ts` 専用）**:
 * 類型B/Cは両方の記憶に`occurredAt`（C は `validUntil` も）を持たせており、
 * ADR 0300 の式のとおり legacy/eventAwareFreshness で数式レベルの不変条件が
 * 効くため「新方針で退行するか」を測れない。**本当に危ないのは、抽出が
 * 出来事時刻・期限を捉えられず（`occurredAt`/`validUntil` が無い）、その記憶が
 * 実質「古い出来事・期限切れの予定」であるのに、eventAwareFreshness が
 * freshness を1に固定して持ち上げてしまう場面である。**
 * - `"old-event-undated-vs-new"`（類型B'）: 古い出来事が `occurredAt` 無しで
 *   記録され、新しい出来事と競合する。legacy は `recordedAt` の古さで freshness を
 *   沈めるが、eventAwareFreshness は freshness=1 に固定するため、`reinforce`
 *   （最近その話題が出た）と組み合わさると `decay` も高いまま——**この組み合わせで
 *   初めて、eventAwareFreshness が legacy より悪化しうる。**
 * - `"expired-schedule-undated-vs-current"`（類型C'）: 期限切れの予定が
 *   `occurredAt`/`validFrom`/`validUntil` のいずれも無く記録され（抽出が期限を
 *   構造化できなかった）、`validAt` ゲートでは除かれない（`validFrom`/`validUntil`
 *   が両方 null の記憶は「いつでも真」と扱われる、`recall.ts` の `validAt` docstring）。
 *   ⟹ 除外の頼みの綱は freshness/decay だけになる——類型B'と同じ危険。
 */
export type TimeWeightingCaseKind =
  | "reinforced-fact-vs-fresh-weak"
  | "old-event-not-outrank-new"
  | "expired-schedule-not-outrank-current"
  | "old-event-undated-vs-new"
  | "expired-schedule-undated-vs-current";

/**
 * 直接書き込む1件の記憶。**抽出 LLM を経由しない**——`time-weighting-bench.ts` の
 * `seedTimeWeightingMemories` が `MemoryStore.createMemoryWithOutbox` へそのまま渡す。
 */
export interface TimeWeightingMemorySeed {
  /** ケース内で一意なローカル識別子（ログ・アサーション用。DB の memoryId ではない）。 */
  localId: string;
  content: string;
  tags?: string[];
  /**
   * その出来事・事実がいつのものか（1点、鮮度の起点）。**省略（`undefined`）が
   * 「恒常的な事実・好み」を表す**——`occurredAt` を持つ記憶は `legacy`/
   * `eventAwareFreshness` で freshness の式が変わらない（`TimeWeightingPolicy` docstring）。
   */
  occurredAt?: Date;
  /** 記憶が記録された時刻。 */
  recordedAt: Date;
  /** その事実が真であり続けた期間の始点。省略時は無期限（常に真）。 */
  validFrom?: Date;
  /** その事実が真であり続けた期間の終点。省略時は無期限。過去日付なら「期限切れ」。 */
  validUntil?: Date;
  /**
   * この時刻それぞれで `reinforce` する（時系列順、`recallAt` 以前のものだけ有効）。
   * 省略時は一度も reinforce しない。
   */
  reinforceAt?: Date[];
}

export interface TimeWeightingCase {
  id: string;
  kind: TimeWeightingCaseKind;
  memories: TimeWeightingMemorySeed[];
  question: string;
  expected: AnswerExpectation;
  /** `recall()` と回答生成を行う時点の壁時計（`MutableClock` に注入する）。 */
  recallAt: Date;
  /** なぜこの期待値が正しいか。会話の文面ではなく、直接書いた記憶の設計に対する説明。 */
  rationale: string;
  /**
   * ⭐ 省略不可。`answer-case.ts` の `AnswerCase.tuningUse` と同じ理由
   * （「宣言し忘れた」と「development である」を混同しない）。
   */
  tuningUse: "development" | "held-out";
}

/**
 * ケースの整形が壊れていないかを検査する（DB を要求しない、純粋な事前条件）。
 *
 * - 記憶が1件以上あること。
 * - `recordedAt`/`occurredAt`/`validFrom`/`reinforceAt` の各時刻が `recallAt` 以前であること
 *   ——「未来に書かれた記憶」を recall するケースは意図しない設計ミスである可能性が高い。
 */
export function assertTimeWeightingCaseWellFormed(c: TimeWeightingCase): void {
  if (c.memories.length === 0) {
    throw new Error(`assertTimeWeightingCaseWellFormed: case "${c.id}" に記憶が1件も無い。`);
  }
  for (const m of c.memories) {
    const timesToCheck: [string, Date | undefined][] = [
      ["recordedAt", m.recordedAt],
      ["occurredAt", m.occurredAt],
      ["validFrom", m.validFrom],
    ];
    for (const [label, at] of timesToCheck) {
      if (at !== undefined && at.getTime() > c.recallAt.getTime()) {
        throw new Error(
          `assertTimeWeightingCaseWellFormed: case "${c.id}" の memory "${m.localId}" の ` +
            `${label}（${at.toISOString()}）が recallAt（${c.recallAt.toISOString()}）より後にある。`,
        );
      }
    }
    for (const at of m.reinforceAt ?? []) {
      if (at.getTime() > c.recallAt.getTime()) {
        throw new Error(
          `assertTimeWeightingCaseWellFormed: case "${c.id}" の memory "${m.localId}" の ` +
            `reinforceAt（${at.toISOString()}）が recallAt（${c.recallAt.toISOString()}）より後にある。`,
        );
      }
    }
  }
}

import type { AnswerExpectation } from "./answer-case.js";

/** `answer` ベンチは取り込み直後に `recall()` するので時間項がほぼ1に張り付き、`timeWeighting` の違いが出ない。このベンチは記憶を直接書いて時間を実際に進める。 */

export type TimeWeightingCaseKind =
  | "reinforced-fact-vs-fresh-weak"
  | "old-event-not-outrank-new"
  | "expired-schedule-not-outrank-current"
  | "old-event-undated-vs-new"
  | "expired-schedule-undated-vs-current";

export interface TimeWeightingMemorySeed {
  localId: string;
  content: string;
  tags?: string[];
  /** 省略（`undefined`）が「恒常的な事実・好み」を表す。 */
  occurredAt?: Date;
  recordedAt: Date;
  validFrom?: Date;
  validUntil?: Date;
  /** `MemoryStore.reinforce` は `at` が起点より狭義に新しいときだけ書く。`recordedAt` と同じ時刻の `reinforceAt` は何も書かず、スコアは変わらない。 */
  reinforceAt?: Date[];
}

export interface TimeWeightingCase {
  id: string;
  kind: TimeWeightingCaseKind;
  memories: TimeWeightingMemorySeed[];
  question: string;
  expected: AnswerExpectation;
  recallAt: Date;
  rationale: string;
  /** 省略不可。「宣言し忘れた」と「development である」を混同しないため。 */
  tuningUse: "development" | "held-out";
}

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

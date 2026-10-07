import type { ProviderMode } from "./providers.js";

export type AnswerCategory =
  | "preference" // 好み
  | "schedule-change" // 予定変更
  | "negation" // 否定
  | "other-person" // 別人の事実
  | "other-period" // 別期間の事実
  | "unknown"; // 未知の質問（会話に根拠が無い）

export interface AnswerCaseTurn {
  role: "user" | "assistant";
  text: string;
}

export interface AnswerExpectation {
  kind: "closed-value" | "must-abstain";
  accept: string[];
  reject: string[];
}

/** 実装の出力から正解を作る経路を、型の上で塞ぐ。 */
export interface AnswerGrounds {
  /** 空配列は `category: "unknown"` のときだけ許す。この例外は型に出さず、`assertGroundsPresent` の実行時検査に寄せる。 */
  turnIndex: number[];
  rationale: string;
  spec?: string;
}

export interface AnswerCase {
  id: string;
  category: AnswerCategory;
  conversation: AnswerCaseTurn[];
  question: string;
  expected: AnswerExpectation;
  grounds: AnswerGrounds;
  /** 省略不可（`?` を付けない）。省略と `development` が同じ `undefined` に潰れ、調整に使ってよいかを区別できなくなるため。 */
  tuningUse: "development" | "held-out";
  /** 上限（オラクル）測定用。正解の第三者名を手で埋めており、実運用で mnemora がこの正解を知っている保証は無い。 */
  knownSubjects?: string[];
}

export function assertGroundsPresent(answerCase: AnswerCase): void {
  if (answerCase.grounds.turnIndex.length === 0 && answerCase.category !== "unknown") {
    throw new Error(
      `assertGroundsPresent: case "${answerCase.id}"（category=${answerCase.category}）の ` +
        "grounds.turnIndex が空である。unknown 以外の類は、根拠となるターンを最低1つ挙げること。",
    );
  }
}

export type AnswerVerdict = "pass" | "fail" | "indeterminate";

export function normalizeForGrading(input: string): string {
  return input
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}]/gu, "");
}

/**
 * 一次判定。LLM を呼ばない。`digest` への文字列一致ではなく、答えが短く閉じる質問への最終回答に対する判定。
 * `reject` を `accept` より先に見る（「水曜ですが、もとは金曜でした」を `pass` にしないため）。
 * 空回答は `"indeterminate"` にし、不正解へ倒さない。
 */
export function gradeAnswer(answer: string, expected: AnswerExpectation): AnswerVerdict {
  const normalizedAnswer = normalizeForGrading(answer);
  if (normalizedAnswer.length === 0) {
    return "indeterminate";
  }
  const rejectHit = expected.reject.some((r) => normalizedAnswer.includes(normalizeForGrading(r)));
  if (rejectHit) {
    return "fail";
  }
  const acceptHit = expected.accept.some((a) => normalizedAnswer.includes(normalizeForGrading(a)));
  if (acceptHit) {
    return "pass";
  }
  return "fail";
}

/** 回答品質を主張してよい層か。`deterministic` の LLM は質問に答えない stub なので、その実行は配線の検査にとどまる。 */
export function answerQualityClaimable(llmMode: ProviderMode): boolean {
  return llmMode !== "deterministic";
}

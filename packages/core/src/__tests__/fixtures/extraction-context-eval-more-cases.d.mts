export interface MoreEvalCaseInput {
  subjectId: string;
  speaker: string;
  text: string;
  occurredAt: string | null;
  timeZone: string | null;
  contextMessages: { speaker?: string; text: string }[] | null;
}

export interface MoreEvalCaseExpect {
  includes: string[];
  excludes: string[];
  dateMatch: RegExp | null;
  dateMustNotMatch: RegExp | null;
}

export interface MoreEvalCase {
  id: string;
  category:
    | "i-context-reference"
    | "j-ambiguous-reference"
    | "k-complex-relative-date"
    | "l-long-context-variant";
  rationale: string;
  input: MoreEvalCaseInput;
  expect: MoreEvalCaseExpect;
}

export declare const moreEvalCases: MoreEvalCase[];
export declare const MORE_EVAL_TENANT_ID: string;
export declare const MORE_EVAL_RECORDED_AT: string;

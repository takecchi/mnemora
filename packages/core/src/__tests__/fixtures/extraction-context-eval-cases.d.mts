export interface EvalCaseInput {
  subjectId: string;
  speaker: string;
  text: string;
  occurredAt: string | null;
  timeZone: string | null;
  contextMessages: { speaker?: string; text: string }[] | null;
}

export interface EvalCaseExpect {
  includes: string[];
  excludes: string[];
  dateMatch: RegExp | null;
  dateMustNotMatch: RegExp | null;
}

export interface EvalCase {
  id: string;
  category:
    | "a-contextual-reference"
    | "b-relative-date"
    | "c-other-speaker"
    | "d-no-context-no-fabrication";
  rationale: string;
  input: EvalCaseInput;
  expect: EvalCaseExpect;
}

export declare const evalCases: EvalCase[];
export declare const EVAL_TENANT_ID: string;
export declare const EVAL_RECORDED_AT: string;

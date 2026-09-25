export interface FactorsEvalCaseInput {
  subjectId: string;
  speaker: string;
  text: string;
  occurredAt: string | null;
  timeZone: string | null;
  contextMessages: { speaker?: string; text: string }[] | null;
}

export interface FactorsEvalCaseExpect {
  includes: string[];
  excludes: string[];
  dateMatch: RegExp | null;
  dateMustNotMatch: RegExp | null;
}

export interface FactorsEvalCase {
  id: string;
  topic: "A-meeting-point" | "B-deadline";
  factorVariant:
    | "m0-baseline"
    | "m1-wording"
    | "m2-count-fewer"
    | "m3-count-more"
    | "m4-position-tail"
    | "m5-position-middle";
  rationale: string;
  input: FactorsEvalCaseInput;
  expect: FactorsEvalCaseExpect;
}

export declare const factorsEvalCases: FactorsEvalCase[];
export declare const FACTORS_EVAL_TENANT_ID: string;
export declare const FACTORS_EVAL_RECORDED_AT: string;

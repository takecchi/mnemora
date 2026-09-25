export interface CoverageEvalCaseInput {
  subjectId: string;
  speaker: string;
  text: string;
  occurredAt: string | null;
  timeZone: string | null;
  contextMessages: { speaker?: string; text: string }[] | null;
}

export interface CoverageEvalCaseExpect {
  includes: string[];
  excludes: string[];
  dateMatch: RegExp | null;
  dateMustNotMatch: RegExp | null;
}

export interface CoverageEvalCase {
  id: string;
  category:
    | "e-ambiguous-reference"
    | "f-complex-relative-date"
    | "g-three-plus-speakers"
    | "h-long-context";
  rationale: string;
  input: CoverageEvalCaseInput;
  expect: CoverageEvalCaseExpect;
}

export declare const coverageEvalCases: CoverageEvalCase[];
export declare const COVERAGE_TENANT_ID: string;
export declare const COVERAGE_RECORDED_AT: string;

export interface AgreementEvalCaseInput {
  subjectId: string;
  speaker: string;
  text: string;
  occurredAt: string | null;
  timeZone: string | null;
  contextMessages: { speaker?: string; text: string }[] | null;
}

export interface AgreementEvalCaseExpect {
  includes: string[];
  excludes: string[];
  dateMatch: RegExp | null;
  dateMustNotMatch: RegExp | null;
}

export interface AgreementEvalCase {
  id: string;
  topic: "A-meeting-point" | "B-deadline";
  variant: "control" | "p1-daijoubu" | "p2-sorede" | "p3-ryokai-ikimashou" | "p4-sore-ii";
  rationale: string;
  input: AgreementEvalCaseInput;
  expect: AgreementEvalCaseExpect;
}

export declare const agreementEvalCases: AgreementEvalCase[];
export declare const AGREEMENT_EVAL_TENANT_ID: string;
export declare const AGREEMENT_EVAL_RECORDED_AT: string;

import { describe, expect, it } from "vitest";
import {
  RecallOutputValidationError,
  DEFAULT_RECALL_OUTPUT_VALIDATION,
  validateRecallOutput,
} from "../recall-output-validation.js";
import { RecallResultSchema } from "../recall.js";
import type { RecallResult } from "../recall.js";

/** 検証を通るべき最小の `RecallResult`（`outputValidation` は載せる前の draft）。 */
function validDraft(overrides: Partial<RecallResult> = {}): RecallResult {
  return {
    recallId: "rcl-1",
    memories: [],
    omitted: [],
    index: { groups: [], totalInScope: 0, countKind: "exact" },
    usage: {
      chars: 0,
      estimatedTokens: 0,
      counter: "heuristic",
      byTier: { full: 0, digest: 0, index: 0 },
      indexChars: 0,
    },
    explain: { stages: [{ stage: "scope", executed: true }] },
    ...overrides,
  };
}

describe("validateRecallOutput — 既定", () => {
  it('既定のモードは "report" である（投げるほうを既定にしない。ADR 0098）', () => {
    expect(DEFAULT_RECALL_OUTPUT_VALIDATION).toBe("report");
  });
});

describe('validateRecallOutput — "off" / "report" / "throw" の3状態', () => {
  it('"off" は undefined を返す（「検証していない」——「通った」ではない）', () => {
    expect(validateRecallOutput(validDraft(), "off", "rcl-1")).toBeUndefined();
    expect(validateRecallOutput({ ...validDraft(), recallId: "" }, "off", "rcl-1")).toBeUndefined();
  });

  it("issues は落ちた箇所を全て並べ、各項目の code は zod の issue の code そのもの", () => {
    const draft = validDraft({
      recallId: "", // min(1) 違反
      usage: {
        chars: 0,
        estimatedTokens: 2.5, // int() 違反
        counter: "heuristic",
        byTier: { full: 0, digest: 0, index: 0 },
        indexChars: 0,
      },
    });
    const zodIssues = RecallResultSchema.safeParse(draft).error?.issues ?? [];
    // 前提: zod が2箇所以上を報告している（1箇所では「全て並べる」を縛れない）。
    expect(zodIssues.length).toBeGreaterThanOrEqual(2);

    const report = validateRecallOutput(draft, "report", "rcl-1");

    expect(report?.issues.map(({ path, code }) => ({ path, code }))).toEqual(
      zodIssues.map((issue) => ({ path: issue.path.join("."), code: issue.code })),
    );
    expect(report?.issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining(["recallId", "usage.estimatedTokens"]),
    );
  });

  it('"report" は正しい draft に対して { ok: true, issues: [] } を返す', () => {
    expect(validateRecallOutput(validDraft(), "report", "rcl-1")).toEqual({
      ok: true,
      issues: [],
    });
  });

  it('"report" は落ちても投げない——ok: false と issues を返す', () => {
    const draft = validDraft({
      usage: {
        chars: 0,
        estimatedTokens: 2.5, // int() 違反
        counter: "heuristic",
        byTier: { full: 0, digest: 0, index: 0 },
        indexChars: 0,
      },
    });

    const report = validateRecallOutput(draft, "report", "rcl-1");

    expect(report?.ok).toBe(false);
    expect(report?.issues.map((issue) => issue.path)).toContain("usage.estimatedTokens");
  });

  it('"throw" は落ちたときだけ投げ、issues と recallId を載せる', () => {
    const draft = validDraft({
      usage: {
        chars: 0,
        estimatedTokens: 0,
        counter: "heuristic",
        byTier: { full: 0, digest: 0, index: 0 },
        indexChars: 0,
        share: -0.1, // nonnegative() 違反
      },
    });

    expect(() => validateRecallOutput(draft, "throw", "rcl-7")).toThrow(
      RecallOutputValidationError,
    );

    try {
      validateRecallOutput(draft, "throw", "rcl-7");
      throw new Error("投げなかった");
    } catch (err) {
      expect(err).toBeInstanceOf(RecallOutputValidationError);
      const validationError = err as RecallOutputValidationError;
      expect(validationError.issues.map((issue) => issue.path)).toContain("usage.share");
      expect(validationError.recallId).toBe("rcl-7");
    }
  });

  it('"throw" でも、正しい draft は投げずに { ok: true, issues: [] } を返す', () => {
    expect(validateRecallOutput(validDraft(), "throw", "rcl-1")).toEqual({
      ok: true,
      issues: [],
    });
  });
});

describe("validateRecallOutput — share > 1 は契約違反ではない（ADR 0097）", () => {
  const draftWithShare = (share: number) =>
    validDraft({
      usage: {
        chars: 41,
        estimatedTokens: 11,
        counter: "heuristic",
        byTier: { full: 0, digest: 40, index: 1 },
        indexChars: 1,
        share,
        budgetExceeded: share > 1,
      },
    });

  it("share: 1.1 は ok: true として通る（.max(1) は ADR 0097 で外した）", () => {
    expect(validateRecallOutput(draftWithShare(1.1), "report", "rcl-1")).toEqual({
      ok: true,
      issues: [],
    });
  });

  it("share が負のときだけ落ちる（nonnegative は残っている）", () => {
    const report = validateRecallOutput(draftWithShare(-0.1), "report", "rcl-1");
    expect(report?.ok).toBe(false);
    expect(report?.issues.map((issue) => issue.path)).toContain("usage.share");
  });
});

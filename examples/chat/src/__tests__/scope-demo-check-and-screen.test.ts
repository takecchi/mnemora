import type { RecallResult } from "@mnemora/core";
import { describe, expect, it } from "vitest";
import {
  ALICE_FACT,
  BOB_FACT,
  checkScopeDemo,
  formatScopeDemo,
  type ScopeDemoResult,
} from "../scope.js";

/**
 * `scope` の画面の「はい/いいえ」は `checkScopeDemo` が決める。本物の Postgres を使う歯
 * （`scope.postgres.test.ts`）は判定器の答えだけを見るので、判定器が何を見ても「はい」と言う形に壊れても緑になる。
 * ここでは合成の `RecallResult` で、判定器と画面の判定の両方を DB なしに確かめる。文言は固定しない。
 */

function recalled(digests: string[]): RecallResult {
  return {
    recallId: "recall-1",
    memories: digests.map((digest) => ({ digest }) as unknown as RecallResult["memories"][number]),
    omitted: [],
    index: { groups: [], totalInScope: digests.length, countKind: "exact" },
    usage: {
      chars: 0,
      estimatedTokens: 0,
      counter: "heuristic",
      byTier: { full: 0, digest: 0, index: 0 },
      indexChars: 0,
    },
    explain: { stages: [] },
  };
}

/** README「出力の読み方」どおりの3つの結果。 */
function asDocumented(overrides: Partial<ScopeDemoResult> = {}): ScopeDemoResult {
  return {
    tenantId: "tenant-a",
    otherTenantId: "tenant-b",
    aliceOnly: recalled([ALICE_FACT]),
    tenantWide: recalled([ALICE_FACT, BOB_FACT]),
    otherTenant: recalled([]),
    ...overrides,
  };
}

const countNo = (text: string): number => text.split("いいえ").length - 1;

describe("checkScopeDemo —— 判定は返った digest を見て決まる", () => {
  it("README どおりの結果は、すべての判定が成り立つ", () => {
    expect(Object.values(checkScopeDemo(asDocumented()))).toEqual([true, true, true, true, true]);
  });

  it("subjectId を指定した recall に bob の記憶が混ざれば、「bob が含まれない」は成り立たない", () => {
    const check = checkScopeDemo(asDocumented({ aliceOnly: recalled([ALICE_FACT, BOB_FACT]) }));
    expect(check.aliceOnlyExcludesBob).toBe(false);
    expect(check.aliceOnlyHasAlice).toBe(true);
  });

  it("テナント全体の recall に bob の記憶が無ければ、「bob が含まれる」は成り立たない", () => {
    const check = checkScopeDemo(asDocumented({ tenantWide: recalled([ALICE_FACT]) }));
    expect(check.tenantWideHasBob).toBe(false);
    expect(check.tenantWideHasAlice).toBe(true);
  });

  it("テナント全体の recall に alice の記憶が無ければ、「alice が含まれる」は成り立たない", () => {
    const check = checkScopeDemo(asDocumented({ tenantWide: recalled([BOB_FACT]) }));
    expect(check.tenantWideHasAlice).toBe(false);
    expect(check.tenantWideHasBob).toBe(true);
  });
});

describe("formatScopeDemo —— 画面の判定は判定器の答えに従い、件数と digest を出す", () => {
  it("README どおりの結果では、画面に「いいえ」が1つも出ない", () => {
    expect(countNo(formatScopeDemo(asDocumented()))).toBe(0);
  });

  it("別テナントの recall に記憶が返ったときだけ、画面に「いいえ」が1つ出る", () => {
    const text = formatScopeDemo(asDocumented({ otherTenant: recalled([ALICE_FACT]) }));
    expect(countNo(text)).toBe(1);
  });

  it("3つの recall の件数と、返った digest がそのまま出る", () => {
    const text = formatScopeDemo(asDocumented());
    expect(text).toContain("件数: 1");
    expect(text).toContain("件数: 2");
    expect(text).toContain("件数: 0");
    expect(text).toContain(ALICE_FACT);
    expect(text).toContain(BOB_FACT);
  });
});

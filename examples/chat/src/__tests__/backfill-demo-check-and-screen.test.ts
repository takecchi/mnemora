import type { RecallResult } from "@mnemora/core";
import { describe, expect, it } from "vitest";
import {
  BACKFILL_OLD_FACT,
  BACKFILL_RECENT_FACT,
  checkBackfillDemo,
  formatBackfillDemo,
  type BackfillDemoResult,
} from "../backfill.js";

/**
 * `backfill` の画面の「はい/いいえ」は `checkBackfillDemo` が決める。本物の Postgres を使う歯
 * （`backfill.postgres.test.ts`）は判定器の答えだけを見るので、判定器が緩んでも緑になる。
 * ここでは合成の `RecallResult` で、判定器と、README の出力例に出る情報（件数・digest・`kind:condition`・
 * 「無い」の名指し）の有無を確かめる。文言は固定しない。
 */

type Omission = RecallResult["omitted"][number];

function recalled(digests: string[], omitted: Omission[] = []): RecallResult {
  return {
    recallId: "recall-1",
    memories: digests.map((digest) => ({ digest }) as unknown as RecallResult["memories"][number]),
    omitted,
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

const PERIOD = { kind: "filtered", condition: "period", count: 1 } as unknown as Omission;
const TAXONOMY = { kind: "filtered", condition: "taxonomy", count: 1 } as unknown as Omission;

/** README の出力例どおりの2つの結果。 */
function asDocumented(overrides: Partial<BackfillDemoResult> = {}): BackfillDemoResult {
  return {
    withOccurredAtTenantId: "tenant-with",
    withoutOccurredAtTenantId: "tenant-without",
    cutoff: new Date("2026-10-01T00:00:00.000Z"),
    withOccurredAt: recalled([BACKFILL_RECENT_FACT], [PERIOD]),
    withoutOccurredAt: recalled([BACKFILL_RECENT_FACT, BACKFILL_OLD_FACT]),
    ...overrides,
  };
}

describe("checkBackfillDemo —— period の omission は condition まで見て数える", () => {
  it("README どおりの結果は、すべての判定が成り立つ", () => {
    expect(Object.values(checkBackfillDemo(asDocumented()))).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
  });

  it("period 以外の filtered だけが出たときは、「理由が period として出た」は成り立たない", () => {
    const check = checkBackfillDemo(
      asDocumented({ withOccurredAt: recalled([BACKFILL_RECENT_FACT], [TAXONOMY]) }),
    );
    expect(check.withOccurredAtReportsPeriod).toBe(false);
  });

  it("occurredAt を渡さなかった側に period の omission が出たら、「period の omission は出ない」は成り立たない", () => {
    const check = checkBackfillDemo(
      asDocumented({
        withoutOccurredAt: recalled([BACKFILL_RECENT_FACT, BACKFILL_OLD_FACT], [PERIOD]),
      }),
    );
    expect(check.withoutOccurredAtReportsNothing).toBe(false);
  });
});

describe("formatBackfillDemo —— README の出力例に出る情報を出す", () => {
  it("両側の件数と、返った digest を出す", () => {
    const text = formatBackfillDemo(asDocumented());
    expect(text).toContain("件数: 1");
    expect(text).toContain("件数: 2");
    expect(text).toContain(BACKFILL_RECENT_FACT);
    expect(text).toContain(BACKFILL_OLD_FACT);
  });

  it("omitted は kind と condition の両方を出す（`filtered:period`）", () => {
    expect(formatBackfillDemo(asDocumented())).toContain("filtered:period");
  });

  it("omitted が無い側は、無いことを名指しする", () => {
    expect(formatBackfillDemo(asDocumented())).toContain("(無し)");
  });
});

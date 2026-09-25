import { describe, expect, it } from "vitest";
import {
  computeCorrectionMargin,
  computeIntrusionMargin,
  minProtectedFactScore,
  summarizeCorrectionCandidateReport,
} from "../correction-candidate-arm.js";
import type {
  CorrectionAbstainOutcome,
  CorrectionCandidateReport,
  CorrectionHitOutcome,
} from "../correction-candidate-arm.js";

/**
 * `correction-candidate-arm.ts` の `margin`/`intrusionMargin`（ADR 0291 §5.5、ADR 0321）を
 * 計算する純関数の歯。DB もネットワークも要らない——値を手で組み立てて渡すだけ。
 *
 * ⭐ **この歯が実際に噛むこと自体を、変異試験で示した**（報告に記録）——
 * `computeCorrectionMargin` の減算を加算に変える／`computeIntrusionMargin` の
 * ガード条件を外す（誤爆(浅)でも値を返すようにする）といった変異を入れて、
 * ここの assertion が実際に赤くなることを確認し、`cp` で戻して緑に戻ることまで
 * 確かめた（`identifier-arm-margin.test.ts` と同じ規律）。
 */

describe("computeCorrectionMargin", () => {
  it("goldScore - distractorScore を返す", () => {
    expect(computeCorrectionMargin(0.9, 0.3)).toBeCloseTo(0.6, 10);
  });

  it("goldScore が null なら null", () => {
    expect(computeCorrectionMargin(null, 0.3)).toBeNull();
  });

  it("distractorScore が null なら null", () => {
    expect(computeCorrectionMargin(0.9, null)).toBeNull();
  });

  it("両方 null でも null", () => {
    expect(computeCorrectionMargin(null, null)).toBeNull();
  });

  it("負の margin（distractor が gold を上回る）も表現できる", () => {
    expect(computeCorrectionMargin(0.1, 0.9)).toBeCloseTo(-0.8, 10);
  });
});

describe("minProtectedFactScore", () => {
  it("protectedIds に一致する最小スコアを返す（複数件のうち最も危うい方）", () => {
    const memories = [{ score: { total: 0.9 } }, { score: { total: 0.5 } }];
    const externalIds = ["a", "b"];
    expect(minProtectedFactScore(memories, externalIds, ["a", "b"])).toBeCloseTo(0.5, 10);
  });

  it("protectedIds に1件も一致しなければ null", () => {
    const memories = [{ score: { total: 0.9 } }];
    const externalIds = ["a"];
    expect(minProtectedFactScore(memories, externalIds, ["z"])).toBeNull();
  });

  it("externalId が null の要素は無視する（未解決の候補）", () => {
    const memories = [{ score: { total: 0.9 } }, { score: { total: 0.2 } }];
    const externalIds = [null, "b"];
    expect(minProtectedFactScore(memories, externalIds, ["a", "b"])).toBeCloseTo(0.2, 10);
  });

  it("空配列なら null", () => {
    expect(minProtectedFactScore([], [], ["a"])).toBeNull();
  });
});

describe("computeIntrusionMargin", () => {
  it("深い誤爆（protectedAtTop=true）のとき topScore - protectedFactScore を返す", () => {
    expect(computeIntrusionMargin(0.9, true, 0.7)).toBeCloseTo(0.2, 10);
  });

  it("protectedFacts が1件だけの深い誤爆では0になる（topScore と protectedFactScore が同一の記憶を指すため）", () => {
    // 深い誤爆＝top1が保護対象そのもの ⟹ 保護対象が1件しかなければ
    // protectedFactScore は topScore と同じ値になる。
    expect(computeIntrusionMargin(0.85, true, 0.85)).toBe(0);
  });

  it("誤爆(浅)（protectedAtTop=false、topScore有り）のときは null", () => {
    expect(computeIntrusionMargin(0.9, false, 0.7)).toBeNull();
  });

  it("棄権（topScore=null）のときは null", () => {
    expect(computeIntrusionMargin(null, false, null)).toBeNull();
  });

  it("protectedAtTop=true でも protectedFactScore が null（保護対象が結果に無い）なら null", () => {
    expect(computeIntrusionMargin(0.9, true, null)).toBeNull();
  });
});

/**
 * `summarizeCorrectionCandidateReport` が A群・B群を取り違えないことの歯。
 *
 * ⭐ **この歯の存在理由**: この PR は `correction-case-set.eval.ts` へ A群6件・
 * B群24件を追加した——「B群をA群として数える」ような取り違えは、件数が
 * 15/8 → 21/32 に変わったこの PR でこそ起きやすい（既存の23件だけなら
 * 15≠8ですぐ気づけるが、母数が変わる変更では境界の取り違えに気づきにくい）。
 * `hits`/`abstains` の**件数が異なる**合成 fixture を使うことで、
 * 「`hitCount` が実は `abstains.length` を見ている」ような取り違えを検出する。
 */
function hitOutcome(overrides: Partial<CorrectionHitOutcome> = {}): CorrectionHitOutcome {
  return {
    caseId: "x",
    goldRank: 1,
    distractorRank: 2,
    distractorBeatsGold: false,
    goldScore: 0.9,
    margin: 0.5,
    returned: 3,
    totalInScope: 10,
    omittedKinds: [],
    ...overrides,
  };
}

function abstainOutcome(overrides: Partial<CorrectionAbstainOutcome> = {}): CorrectionAbstainOutcome {
  return {
    caseId: "y",
    kind: "negation",
    protectedAtTop: false,
    abstained: false,
    topScore: 0.5,
    topDigest: "d",
    protectedFactScore: null,
    intrusionMargin: null,
    returned: 1,
    omittedKinds: [],
    ...overrides,
  };
}

describe("summarizeCorrectionCandidateReport（A群/B群の取り違え検出）", () => {
  it("hits/abstains の件数が異なるとき、hitCount/abstainCount を取り違えない", () => {
    const report: CorrectionCandidateReport = {
      tenantId: "t",
      llmMode: "deterministic",
      embeddingMode: "local",
      haystackSize: 0,
      observationCount: 0,
      ingestDrain: { ticks: 1, firstTickProcessed: 0, totalProcessed: 0, totalFailed: 0 },
      hits: [hitOutcome({ caseId: "h1" }), hitOutcome({ caseId: "h2" })],
      abstains: [
        abstainOutcome({ caseId: "a1" }),
        abstainOutcome({ caseId: "a2" }),
        abstainOutcome({ caseId: "a3" }),
      ],
      marginStats: { count: 0, mean: null, stdDev: null, min: null },
      intrusionMarginStats: { count: 0, mean: null, stdDev: null, min: null },
    };
    const summary = summarizeCorrectionCandidateReport(report);
    expect(summary.hitCount).toBe(2);
    expect(summary.abstainCount).toBe(3);
  });

  it("protectedAtTop=true の件だけを protectedAtTopCount に数える（B群をA群として数えない）", () => {
    const report: CorrectionCandidateReport = {
      tenantId: "t",
      llmMode: "deterministic",
      embeddingMode: "local",
      haystackSize: 0,
      observationCount: 0,
      ingestDrain: { ticks: 1, firstTickProcessed: 0, totalProcessed: 0, totalFailed: 0 },
      hits: [],
      abstains: [
        abstainOutcome({ caseId: "deep", protectedAtTop: true }),
        abstainOutcome({ caseId: "shallow", protectedAtTop: false, abstained: false }),
        abstainOutcome({ caseId: "abstained", protectedAtTop: false, abstained: true, topScore: null }),
      ],
      marginStats: { count: 0, mean: null, stdDev: null, min: null },
      intrusionMarginStats: { count: 0, mean: null, stdDev: null, min: null },
    };
    const summary = summarizeCorrectionCandidateReport(report);
    expect(summary.protectedAtTopCount).toBe(1);
    expect(summary.shallowMisfireCount).toBe(1);
    expect(summary.abstainedCount).toBe(1);
  });
});

import type { CorrectionCandidate, Runtime } from "@mnemora/core";
import { describe, expect, it } from "vitest";
import type { CorrectionScenario } from "../correction-scenario.js";
import { CORRECTION_SCENARIO } from "../correction-scenario.js";
import type { CorrectionDemoResult } from "../correction-demo.js";
import {
  checkCorrectionDemo,
  checkCorrectionOmission,
  formatCorrectionDemo,
  runCorrectionDemo,
} from "../correction-demo.js";

interface FakeRuntimeCalls {
  observedExternalIds: string[];
  applyCorrectionCalls: Array<{
    correctedId: string | null;
    correctingId: string;
    resolution: unknown;
    reason: string | undefined;
  }>;
  recallCallCount: number;
  recallQueries: unknown[];
  findCorrectionCandidatesCallCount: number;
  findCorrectionCandidatesArgs: { text: string; excludeMemoryIds?: readonly string[] } | null;
}

function emptyCalls(): FakeRuntimeCalls {
  return {
    observedExternalIds: [],
    applyCorrectionCalls: [],
    recallCallCount: 0,
    recallQueries: [],
    findCorrectionCandidatesCallCount: 0,
    findCorrectionCandidatesArgs: null,
  };
}

function memoryIdFor(externalId: string): string {
  return `${externalId}-memid`;
}

function fakeScore(total: number) {
  return { decay: 1, tagMatch: 1, freshness: 1, strength: 1, total };
}

function defaultDiscoveryCandidates(): CorrectionCandidate[] {
  const originalId = memoryIdFor(CORRECTION_SCENARIO.original.externalId);
  return [
    {
      memoryId: originalId,
      digest: "青",
      recallRank: 1,
      score: fakeScore(0.9),
      retrievedVia: "ann",
    } as unknown as CorrectionCandidate,
  ];
}

function buildFakeRuntime(
  calls: FakeRuntimeCalls,
  discoveryCandidates: CorrectionCandidate[] = defaultDiscoveryCandidates(),
): Runtime {
  let pendingEmbedJobs = 0;
  const observe: Runtime["observe"] = async (_ctx, input) => {
    const externalId = (input as { externalId: string }).externalId;
    calls.observedExternalIds.push(externalId);
    pendingEmbedJobs += 1;
    return {
      observationId: `obs-${externalId}`,
      memoryIds: [memoryIdFor(externalId)],
      extraction: "ok",
      extractionFailure: null,
    } as unknown as Awaited<ReturnType<Runtime["observe"]>>;
  };

  const tick: Runtime["tick"] = async () => {
    const processed = pendingEmbedJobs;
    pendingEmbedJobs = 0;
    return { processed, failed: 0, unsupported: [] } as unknown as Awaited<
      ReturnType<Runtime["tick"]>
    >;
  };

  const findCorrectionCandidates: Runtime["findCorrectionCandidates"] = async (_ctx, input) => {
    calls.findCorrectionCandidatesCallCount += 1;
    calls.findCorrectionCandidatesArgs = input as {
      text: string;
      excludeMemoryIds?: readonly string[];
    };
    return {
      recallId: "correction-candidates-recall",
      candidates: discoveryCandidates,
      omitted: [],
      explain: { stages: [] },
      outcome: discoveryCandidates.length > 0 ? "candidates" : "no_candidates",
      recalledCount: discoveryCandidates.length,
      excludedCount: 0,
    } as unknown as Awaited<ReturnType<Runtime["findCorrectionCandidates"]>>;
  };

  const recall: Runtime["recall"] = async (_ctx, query) => {
    calls.recallCallCount += 1;
    calls.recallQueries.push(query);
    const originalId = memoryIdFor(CORRECTION_SCENARIO.original.externalId);
    const correctionId = memoryIdFor(CORRECTION_SCENARIO.correction.externalId);
    if (calls.recallCallCount === 1) {
      return {
        recallId: "recall-1",
        memories: [
          { memoryId: originalId, digest: "青", retrievedVia: "ann", companionOf: null },
          { memoryId: correctionId, digest: "赤", retrievedVia: "ann", companionOf: null },
        ],
        omitted: [],
        index: { groups: [], totalInScope: 2, countKind: "exact" },
        usage: {
          chars: 0,
          estimatedTokens: 0,
          counter: "heuristic",
          byTier: { full: 0, digest: 0, index: 0 },
          indexChars: 0,
        },
        explain: { stages: [] },
      } as unknown as Awaited<ReturnType<Runtime["recall"]>>;
    }
    if (calls.recallCallCount === 2) {
      const winnerId = memoryIdFor(CORRECTION_SCENARIO.contestedPair.winnerExternalId);
      const loserId = winnerId === originalId ? correctionId : originalId;
      return {
        recallId: "recall-2",
        memories: [
          {
            memoryId: winnerId,
            digest: winnerId === correctionId ? "赤" : "青",
            retrievedVia: "ann",
            companionOf: null,
          },
          {
            memoryId: loserId,
            digest: loserId === correctionId ? "赤" : "青",
            retrievedVia: "mandatory_companion",
            companionOf: winnerId,
          },
        ],
        omitted: [],
        index: { groups: [], totalInScope: 2, countKind: "exact" },
        usage: {
          chars: 0,
          estimatedTokens: 0,
          counter: "heuristic",
          byTier: { full: 0, digest: 0, index: 0 },
          indexChars: 0,
        },
        explain: { stages: [] },
      } as unknown as Awaited<ReturnType<Runtime["recall"]>>;
    }
    const winnerId = memoryIdFor(CORRECTION_SCENARIO.contestedPair.winnerExternalId);
    return {
      recallId: "recall-3",
      memories: [
        {
          memoryId: winnerId,
          digest: winnerId === correctionId ? "赤" : "青",
          retrievedVia: "ann",
          companionOf: null,
        },
      ],
      omitted: [{ kind: "filtered", condition: "superseded", count: 1, countKind: "exact" }],
      index: { groups: [], totalInScope: 1, countKind: "exact" },
      usage: {
        chars: 0,
        estimatedTokens: 0,
        counter: "heuristic",
        byTier: { full: 0, digest: 0, index: 0 },
        indexChars: 0,
      },
      explain: { stages: [] },
    } as unknown as Awaited<ReturnType<Runtime["recall"]>>;
  };

  // applyCorrection の偽物は、core と同じ形の分岐だけを再現する。CAS・イベント書き込みは持たない。
  const applyCorrection: Runtime["applyCorrection"] = async (_ctx, input) => {
    calls.applyCorrectionCalls.push({
      correctedId: input.correctedId === undefined ? null : String(input.correctedId),
      correctingId: String(input.correctingId),
      resolution: input.resolution,
      reason: input.reason,
    });
    if (input.correctedId === undefined) {
      return { kind: "awaiting_choice" } as unknown as Awaited<
        ReturnType<Runtime["applyCorrection"]>
      >;
    }
    const candidate = discoveryCandidates.find((c) => c.memoryId === input.correctedId);
    if (candidate === undefined) {
      return { kind: "not_a_candidate", correctedId: input.correctedId } as unknown as Awaited<
        ReturnType<Runtime["applyCorrection"]>
      >;
    }
    const markResult = { supported: true, outcome: { kind: "contested" } };
    if (input.resolution === undefined) {
      return {
        kind: "contested",
        correctedId: input.correctedId,
        correctingId: input.correctingId,
        chosenRecallRank: candidate.recallRank,
        markResult,
      } as unknown as Awaited<ReturnType<Runtime["applyCorrection"]>>;
    }
    const resolveResult = { supported: true, outcome: { kind: "resolved" } };
    return {
      kind: "resolved",
      correctedId: input.correctedId,
      correctingId: input.correctingId,
      chosenRecallRank: candidate.recallRank,
      markResult,
      resolveResult,
    } as unknown as Awaited<ReturnType<Runtime["applyCorrection"]>>;
  };

  return {
    observe,
    tick,
    findCorrectionCandidates,
    recall,
    applyCorrection,
  } as unknown as Runtime;
}

function recordedChoice(scenario: CorrectionScenario = CORRECTION_SCENARIO) {
  return { chosenExternalId: scenario.contestedPair.firstExternalId };
}

describe("runCorrectionDemo: applyCorrection に渡す id は 指名(choice) と scenario.contestedPair.winnerExternalId の宣言どおり", () => {
  it("既定シナリオ: choice=firstExternalId(original) ⟹ 2回目の applyCorrection に correction の memoryId が winnerId として渡る", async () => {
    const calls = emptyCalls();
    const runtime = buildFakeRuntime(calls);

    const result = await runCorrectionDemo(
      runtime,
      { tenantId: "t" },
      CORRECTION_SCENARIO,
      recordedChoice(),
    );

    const originalId = memoryIdFor(CORRECTION_SCENARIO.original.externalId);
    const correctionId = memoryIdFor(CORRECTION_SCENARIO.correction.externalId);

    expect(calls.observedExternalIds).toEqual([
      CORRECTION_SCENARIO.original.externalId,
      CORRECTION_SCENARIO.correction.externalId,
    ]);

    expect(result.outcome).toBe("resolved");
    expect(result.chosenId).toBe(originalId);
    expect(result.chosenRecallRank).toBe(1);

    expect(calls.applyCorrectionCalls).toHaveLength(2);
    expect(calls.applyCorrectionCalls[0]).toMatchObject({
      correctedId: originalId,
      correctingId: correctionId,
      resolution: undefined,
    });

    expect(calls.applyCorrectionCalls[1]).toMatchObject({
      correctedId: originalId,
      correctingId: correctionId,
      resolution: { kind: "supersede", winnerId: correctionId },
    });

    expect(result.originalId).toBe(originalId);
    expect(result.correctionId).toBe(correctionId);
  });

  it("宣言を逆にする(winnerExternalId=original)と、観測順は変えずとも勝者が入れ替わる — 順序規則ではないことの証明", async () => {
    const reversedScenario: CorrectionScenario = {
      ...CORRECTION_SCENARIO,
      contestedPair: {
        ...CORRECTION_SCENARIO.contestedPair,
        winnerExternalId: CORRECTION_SCENARIO.original.externalId,
      },
    };
    const calls = emptyCalls();
    const runtime = buildFakeRuntime(calls);

    await runCorrectionDemo(
      runtime,
      { tenantId: "t" },
      reversedScenario,
      recordedChoice(reversedScenario),
    );

    const originalId = memoryIdFor(CORRECTION_SCENARIO.original.externalId);

    expect(calls.observedExternalIds[0]).toBe(CORRECTION_SCENARIO.original.externalId);
    expect(calls.applyCorrectionCalls[1]?.resolution).toEqual({
      kind: "supersede",
      winnerId: originalId,
    });
  });

  it("🔑 3回の recall() はすべて limit: 1 で呼ばれる — 段3の必須同伴取得を発火させる条件そのもの(ADR 0162 決定5)", async () => {
    const calls = emptyCalls();
    const runtime = buildFakeRuntime(calls);

    await runCorrectionDemo(runtime, { tenantId: "t" }, CORRECTION_SCENARIO, recordedChoice());

    expect(calls.recallQueries).toHaveLength(3);

    for (const query of calls.recallQueries) {
      expect(query).toEqual({ text: CORRECTION_SCENARIO.query, limit: 1 });
    }
  });

  it("observe() が Memory を作らなかった(memoryIds が空)場合は例外を投げる", async () => {
    const runtime = {
      observe: async () =>
        ({ memoryIds: [] }) as unknown as Awaited<ReturnType<Runtime["observe"]>>,
      tick: async () =>
        ({ processed: 0, failed: 0, unsupported: [] }) as unknown as Awaited<
          ReturnType<Runtime["tick"]>
        >,
    } as unknown as Runtime;

    await expect(
      runCorrectionDemo(runtime, { tenantId: "t" }, CORRECTION_SCENARIO, recordedChoice()),
    ).rejects.toThrow(/Memory を作らなかった/);
  });
});

describe("🔴🔴 採用者の指名が候補1位ではないケース: candidates[0]実装なら赤くなる歯", () => {
  it("指名(originalId)は候補2位。候補1位のdecoyはapplyCorrectionの引数に一度も現れない", async () => {
    const calls = emptyCalls();
    const originalId = memoryIdFor(CORRECTION_SCENARIO.original.externalId);
    const correctionId = memoryIdFor(CORRECTION_SCENARIO.correction.externalId);
    const decoyId = "decoy-memid-should-remain-untouched";
    const discoveryCandidates: CorrectionCandidate[] = [
      {
        memoryId: decoyId,
        digest: "無関係な既存の記憶(守るべき事実)",
        recallRank: 1,
        score: fakeScore(0.95),
        retrievedVia: "ann",
      } as unknown as CorrectionCandidate,
      {
        memoryId: originalId,
        digest: "青",
        recallRank: 2,
        score: fakeScore(0.87),
        retrievedVia: "ann",
      } as unknown as CorrectionCandidate,
    ];
    const runtime = buildFakeRuntime(calls, discoveryCandidates);

    const result = await runCorrectionDemo(
      runtime,
      { tenantId: "t" },
      CORRECTION_SCENARIO,
      recordedChoice(),
    );

    expect(result.outcome).toBe("resolved");
    expect(result.chosenRecallRank).toBe(2);
    expect(result.chosenId).toBe(originalId);

    expect(calls.applyCorrectionCalls).toHaveLength(2);
    for (const call of calls.applyCorrectionCalls) {
      expect(call.correctedId).toBe(originalId);
      expect(call.correctingId).toBe(correctionId);
    }
    expect(JSON.stringify(calls.applyCorrectionCalls)).not.toContain(decoyId);
  });
});

describe("🔴 選んだ根拠が reason 経由で applyCorrection へ渡る(Issue #369)", () => {
  it("候補2位を指名したケース: reason に recallId・chosenRecallRank(=2)・candidates件数・winner が載り、applyCorrection の2回の呼び出しに同じ reason が渡る", async () => {
    const calls = emptyCalls();
    const originalId = memoryIdFor(CORRECTION_SCENARIO.original.externalId);
    const decoyId = "decoy-memid-for-reason-test";
    const discoveryCandidates: CorrectionCandidate[] = [
      {
        memoryId: decoyId,
        digest: "無関係な既存の記憶",
        recallRank: 1,
        score: fakeScore(0.95),
        retrievedVia: "ann",
      } as unknown as CorrectionCandidate,
      {
        memoryId: originalId,
        digest: "青",
        recallRank: 2,
        score: fakeScore(0.87),
        retrievedVia: "ann",
      } as unknown as CorrectionCandidate,
    ];
    const runtime = buildFakeRuntime(calls, discoveryCandidates);

    const result = await runCorrectionDemo(
      runtime,
      { tenantId: "t" },
      CORRECTION_SCENARIO,
      recordedChoice(),
    );

    expect(result.outcome).toBe("resolved");
    expect(result.chosenRecallRank).toBe(2);

    expect(calls.applyCorrectionCalls).toHaveLength(2);
    expect(calls.applyCorrectionCalls[0]?.reason).toBeDefined();
    expect(calls.applyCorrectionCalls[1]?.reason).toBeDefined();
    expect(calls.applyCorrectionCalls[0]?.reason).toBe(calls.applyCorrectionCalls[1]?.reason);

    const reason = calls.applyCorrectionCalls[0]?.reason ?? "";
    expect(reason).toContain("chosenRecallRank=2");
    expect(reason).toContain(`candidates=${discoveryCandidates.length}`);
    expect(reason).toContain("recallId=correction-candidates-recall");
    expect(reason).toContain("winner=correcting");

    expect(reason).not.toContain("0.87");
    expect(reason).not.toContain("0.95");
  });
});

describe("発見の段: findCorrectionCandidates は text=訂正の発話・excludeMemoryIds=[自己] で1回だけ呼ばれる", () => {
  it("引数が correction.text / [correctionId] のとおりである", async () => {
    const calls = emptyCalls();
    const runtime = buildFakeRuntime(calls);
    const correctionId = memoryIdFor(CORRECTION_SCENARIO.correction.externalId);

    await runCorrectionDemo(runtime, { tenantId: "t" }, CORRECTION_SCENARIO, recordedChoice());

    expect(calls.findCorrectionCandidatesCallCount).toBe(1);
    expect(calls.findCorrectionCandidatesArgs).toEqual({
      text: CORRECTION_SCENARIO.correction.text,
      excludeMemoryIds: [correctionId],
    });
  });

  it("choice が無くても findCorrectionCandidates は呼ばれる(候補は棄権せずに常に提示する、ADR 0232 B群実測: 棄権率0/8)", async () => {
    const calls = emptyCalls();
    const runtime = buildFakeRuntime(calls);

    const result = await runCorrectionDemo(runtime, { tenantId: "t" }, CORRECTION_SCENARIO);

    expect(calls.findCorrectionCandidatesCallCount).toBe(1);
    expect(result.discovery.candidates.length).toBeGreaterThan(0);
  });
});

describe("選択を渡さない・指名が候補に無い: 書き込み0件で停止する(ADR 0232 B群の危険を可視化する経路)", () => {
  it("choice が undefined ⟹ outcome=awaiting_choice、applyCorrection/recallは一度も呼ばれない(書き込み0件)", async () => {
    const calls = emptyCalls();
    const runtime = buildFakeRuntime(calls);

    const result = await runCorrectionDemo(runtime, { tenantId: "t" }, CORRECTION_SCENARIO);

    expect(result.outcome).toBe("awaiting_choice");
    expect(result.chosenId).toBeNull();
    expect(result.chosenRecallRank).toBeNull();
    expect(result.beforeMark).toBeNull();
    expect(result.markOutcomeKind).toBeNull();
    expect(result.afterMark).toBeNull();
    expect(result.resolveOutcomeKind).toBeNull();
    expect(result.afterResolve).toBeNull();

    expect(calls.applyCorrectionCalls).toHaveLength(0);
    expect(calls.recallCallCount).toBe(0);

    expect(result.discovery.candidates.length).toBeGreaterThan(0);
  });

  it("choice はあるが指名先が候補一覧に居ない ⟹ outcome=choice_not_in_candidates、書き込み0件", async () => {
    const calls = emptyCalls();
    const decoyOnly: CorrectionCandidate[] = [
      {
        memoryId: "someone-else-entirely",
        digest: "全く別の記憶",
        recallRank: 1,
        score: fakeScore(0.9),
        retrievedVia: "ann",
      } as unknown as CorrectionCandidate,
    ];
    const runtime = buildFakeRuntime(calls, decoyOnly);

    const result = await runCorrectionDemo(
      runtime,
      { tenantId: "t" },
      CORRECTION_SCENARIO,
      recordedChoice(),
    );

    const originalId = memoryIdFor(CORRECTION_SCENARIO.original.externalId);

    expect(result.outcome).toBe("choice_not_in_candidates");
    expect(result.chosenId).toBe(originalId);
    expect(result.chosenRecallRank).toBeNull();
    expect(result.beforeMark).toBeNull();
    expect(result.afterMark).toBeNull();
    expect(result.afterResolve).toBeNull();

    expect(calls.applyCorrectionCalls).toHaveLength(0);
    expect(calls.recallCallCount).toBe(0);
  });

  it("checkCorrectionDemo/checkCorrectionOmission を outcome!=='resolved' の結果に呼ぶと例外になる(書き込みに進んでいない結果へ適用する誤りを防ぐ)", async () => {
    const calls = emptyCalls();
    const runtime = buildFakeRuntime(calls);
    const result = await runCorrectionDemo(runtime, { tenantId: "t" }, CORRECTION_SCENARIO);

    expect(() => checkCorrectionDemo(result)).toThrow(/outcome/);
    expect(() => checkCorrectionOmission(result)).toThrow(/outcome/);
  });

  it("formatCorrectionDemo は outcome=awaiting_choice でも例外を投げず、候補一覧と停止を印字する", async () => {
    const calls = emptyCalls();
    const runtime = buildFakeRuntime(calls);
    const result = await runCorrectionDemo(runtime, { tenantId: "t" }, CORRECTION_SCENARIO);

    const formatted = formatCorrectionDemo(result);
    expect(formatted).toContain("書き込み0件で停止");
    expect(formatted).toContain("選ばなければ何も起きない");
  });
});

describe("checkCorrectionDemo / formatCorrectionDemo: 固定した RecallResult から性質を正しく読む", () => {
  it("北極星の核心: afterResolve に original が居なければ afterResolveOriginalAbsent=true", async () => {
    const calls = emptyCalls();
    const runtime = buildFakeRuntime(calls);
    const result = await runCorrectionDemo(
      runtime,
      { tenantId: "t" },
      CORRECTION_SCENARIO,
      recordedChoice(),
    );
    const check = checkCorrectionDemo(result);

    expect(check.markSucceeded).toBe(true);
    expect(check.resolveSucceeded).toBe(true);
    expect(check.afterMarkBothPresent).toBe(true);
    expect(check.afterMarkCompanionRetrieval).toBe(true);
    expect(check.afterMarkCompanionOfOther).toBe(true);
    expect(check.afterResolveOriginalAbsent).toBe(true);
    expect(check.afterResolveCorrectionPresent).toBe(true);

    const formatted = formatCorrectionDemo(result);
    expect(formatted).toContain("古いほうが消えた: はい");
    expect(formatted).toContain("新しいほうは残った: はい");
  });
});

describe("checkCorrectionDemo: mandatory_companion がどちらに付くかを決め打たない(ADR 0162 決定5、PR #320 の CI 失敗の修正)", () => {
  const originalId = "fixed-original-id";
  const correctionId = "fixed-correction-id";

  function buildResult(
    afterMarkMemories: Array<{
      memoryId: string;
      digest: string;
      retrievedVia: string;
      companionOf: string | null;
    }>,
  ): CorrectionDemoResult {
    const emptyRecall = {
      recallId: "r",
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
      explain: { stages: [] },
    };
    return {
      scenario: CORRECTION_SCENARIO,
      originalId,
      correctionId,
      discovery: {
        recallId: "r",
        candidates: [],
        omitted: [],
        explain: { stages: [] },
        outcome: "no_candidates",
        recalledCount: 0,
        excludedCount: 0,
      },
      outcome: "resolved",
      chosenId: originalId,
      chosenRecallRank: 1,
      beforeMark: emptyRecall,
      markOutcomeKind: "contested",
      afterMark: { ...emptyRecall, memories: afterMarkMemories },
      resolveOutcomeKind: "resolved",
      afterResolve: {
        ...emptyRecall,
        memories: [
          { memoryId: correctionId, digest: "赤", retrievedVia: "ann", companionOf: null },
        ],
      },
    } as unknown as CorrectionDemoResult;
  }

  it("original がアンカー(ann)・correction が mandatory_companion(段2のランキングで correction が limit から落ちた形)", () => {
    const result = buildResult([
      { memoryId: originalId, digest: "青", retrievedVia: "ann", companionOf: null },
      {
        memoryId: correctionId,
        digest: "赤",
        retrievedVia: "mandatory_companion",
        companionOf: originalId,
      },
    ]);
    const check = checkCorrectionDemo(result);

    expect(check.afterMarkCompanionRetrieval).toBe(true);
    expect(check.afterMarkCompanionOfOther).toBe(true);
  });

  it("correction がアンカー(ann)・original が mandatory_companion(実測した Postgres と同じ形ではない方の並び)", () => {
    const result = buildResult([
      {
        memoryId: originalId,
        digest: "青",
        retrievedVia: "mandatory_companion",
        companionOf: correctionId,
      },
      { memoryId: correctionId, digest: "赤", retrievedVia: "ann", companionOf: null },
    ]);
    const check = checkCorrectionDemo(result);

    expect(check.afterMarkCompanionRetrieval).toBe(true);
    expect(check.afterMarkCompanionOfOther).toBe(true);
  });

  it("companionOf がもう片方を指していなければ afterMarkCompanionOfOther は false(壊れた対応を見逃さない)", () => {
    const result = buildResult([
      { memoryId: originalId, digest: "青", retrievedVia: "ann", companionOf: null },
      {
        memoryId: correctionId,
        digest: "赤",
        retrievedVia: "mandatory_companion",
        companionOf: "someone-else-entirely",
      },
    ]);
    const check = checkCorrectionDemo(result);

    expect(check.afterMarkCompanionRetrieval).toBe(true);
    expect(check.afterMarkCompanionOfOther).toBe(false);
  });

  it("どちらも mandatory_companion でなければ afterMarkCompanionRetrieval は false(段3が発火しなかった場合。これが直した回帰)", () => {
    const result = buildResult([
      { memoryId: originalId, digest: "青", retrievedVia: "ann", companionOf: null },
      { memoryId: correctionId, digest: "赤", retrievedVia: "ann", companionOf: null },
    ]);
    const check = checkCorrectionDemo(result);

    expect(check.afterMarkCompanionRetrieval).toBe(false);
    expect(check.afterMarkCompanionOfOther).toBe(false);
  });
});

describe("checkCorrectionOmission: omitted 側から「消えた」と「最初から無かった」を区別する(Issue #374)", () => {
  function buildAfterResolveOnly(
    omitted: Array<{ kind: string; condition?: string; count?: number; countKind?: string }>,
  ): CorrectionDemoResult {
    const emptyRecall = {
      recallId: "r",
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
      explain: { stages: [] },
    };
    return {
      scenario: CORRECTION_SCENARIO,
      originalId: "fixed-original-id",
      correctionId: "fixed-correction-id",
      discovery: {
        recallId: "r",
        candidates: [],
        omitted: [],
        explain: { stages: [] },
        outcome: "no_candidates",
        recalledCount: 0,
        excludedCount: 0,
      },
      outcome: "resolved",
      chosenId: "fixed-original-id",
      chosenRecallRank: 1,
      beforeMark: emptyRecall,
      markOutcomeKind: "contested",
      afterMark: emptyRecall,
      resolveOutcomeKind: "resolved",
      afterResolve: {
        ...emptyRecall,
        memories: [
          { memoryId: "fixed-correction-id", digest: "赤", retrievedVia: "ann", companionOf: null },
        ],
        omitted,
      },
    } as unknown as CorrectionDemoResult;
  }

  it('omitted に condition="superseded"(count>0)が在れば true — 消えた理由が実際に記録されている', () => {
    const result = buildAfterResolveOnly([
      { kind: "filtered", condition: "superseded", count: 1, countKind: "exact" },
    ]);
    expect(checkCorrectionOmission(result).afterResolveOriginalOmittedAsSuperseded).toBe(true);
  });

  it("omitted が空なら false — 「最初から無かった」と区別できない状態(これが直したかった穴そのもの)", () => {
    const result = buildAfterResolveOnly([]);
    expect(checkCorrectionOmission(result).afterResolveOriginalOmittedAsSuperseded).toBe(false);
  });

  it("count=0 の superseded エントリは false 扱い(件数ゼロは「理由が記録されている」とは読まない)", () => {
    const result = buildAfterResolveOnly([
      { kind: "filtered", condition: "superseded", count: 0, countKind: "exact" },
    ]);
    expect(checkCorrectionOmission(result).afterResolveOriginalOmittedAsSuperseded).toBe(false);
  });

  it("condition が別の理由(archived 等)だけでは false — superseded を名指ししない限り通さない(ADR 0027 の区別を保つ)", () => {
    const result = buildAfterResolveOnly([
      { kind: "filtered", condition: "archived", count: 1, countKind: "exact" },
      { kind: "filtered", condition: "forgotten", count: 1, countKind: "exact" },
    ]);
    expect(checkCorrectionOmission(result).afterResolveOriginalOmittedAsSuperseded).toBe(false);
  });
});

import type {
  CorrectionCandidate,
  MarkContestedOptions,
  ResolveContestedOptions,
  Runtime,
} from "@mnemora/core";
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

/**
 * `runCorrectionDemo`/`checkCorrectionDemo`/`formatCorrectionDemo` の歯（Issue #303 / Issue #369 (C)）。
 * DB/LLM/embedding を実物で叩く代わりに、`Runtime` の必要な口だけを最小の偽物で埋める
 * （`consolidation-cost-abort.test.ts` と同じ規律）。
 *
 * **この歯が測っているもの**: `runCorrectionDemo` が
 * - 【発見の段】`findCorrectionCandidates` を正しい引数（`text`/`excludeMemoryIds`）で
 *   1回だけ呼ぶこと。
 * - 【選択の段】`choice`（呼び出し側の明示的な指名）を**候補の並びから一切導かず**、
 *   指名が候補に居るかどうかの照合にしか候補を使わないこと。
 * - `choice` が無い・指名が候補に無い、の2ケースで**書き込みを1件もしない**こと。
 * - `markContested`/`resolveContested` に*どの id を*渡すか——
 *   `scenario.contestedPair` の宣言（`firstExternalId`/`secondExternalId`/
 *   `winnerExternalId`）が、`turns` の並び順や「後に observe したほうが勝つ」という
 *   順序規則を経由せず、**そのまま**呼び出しの引数に反映されることを実測する。
 *
 * **測っていないもの**: `markContested`/`resolveContested`/`recall`/
 * `findCorrectionCandidates` 自体の実装の正しさ（それは `packages/core`/
 * `packages/postgres` の領分であり、この歯の偽 Runtime は固定の戻り値を返すだけ）。
 * 実際の Postgres に対する一巡の実測は `correction-demo.postgres.test.ts` で行う。
 */

interface FakeRuntimeCalls {
  observedExternalIds: string[];
  markContestedArgs: [string, string] | null;
  resolveContestedArgs: [string, string, unknown] | null;
  /** `markContested` に渡った `opts`（4番目の引数）。Issue #369 チェックボックスの歯用。 */
  markContestedOpts: MarkContestedOptions | undefined;
  /** `resolveContested` に渡った `opts`（5番目の引数)。同上。 */
  resolveContestedOpts: ResolveContestedOptions | undefined;
  recallCallCount: number;
  /**
   * `recall()` に実際に渡ったクエリを、呼ばれた順にすべて記録する。
   *
   * 🔑 **`limit` を見るためにこの欄が在る。**`limit: 1` は決定5の核（既定の
   * limit=10 では対の2件が両方とも段2の `withinLimit` に収まり、段3の必須同伴取得が
   * 発火しない）であり、それが失われたことを DB 無しで検出できるようにしておく
   * ——これが無いと、`limit` の退行を捕まえる歯は `correction-demo.postgres.test.ts`
   * （本物の Postgres を要求する）だけになる。
   */
  recallQueries: unknown[];
  /** `findCorrectionCandidates` が呼ばれた回数。 */
  findCorrectionCandidatesCallCount: number;
  /** `findCorrectionCandidates` に実際に渡った引数（最後の呼び出し分）。 */
  findCorrectionCandidatesArgs: { text: string; excludeMemoryIds?: readonly string[] } | null;
}

function emptyCalls(): FakeRuntimeCalls {
  return {
    observedExternalIds: [],
    markContestedArgs: null,
    resolveContestedArgs: null,
    markContestedOpts: undefined,
    resolveContestedOpts: undefined,
    recallCallCount: 0,
    recallQueries: [],
    findCorrectionCandidatesCallCount: 0,
    findCorrectionCandidatesArgs: null,
  };
}

/**
 * externalId → memoryId は `<externalId>-memid` という機械的な対応にする——
 * `observe()` の戻り値からしか得られない、という `correction-demo.ts` の前提をそのまま
 * 反映しつつ、テスト側で「どの externalId の Memory か」を id から読めるようにする。
 */
function memoryIdFor(externalId: string): string {
  return `${externalId}-memid`;
}

function fakeScore(total: number) {
  return { decay: 1, tagMatch: 1, freshness: 1, strength: 1, total };
}

/**
 * `findCorrectionCandidates` の既定の戻り値: `scenario.original` の1件だけを
 * 候補の1位として返す（`correctionId` は呼び出し側が `excludeMemoryIds` で
 * 自己除外している前提を、フィクスチャ側でも素直に反映する）。
 */
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
  const observe: Runtime["observe"] = async (_ctx, input) => {
    const externalId = (input as { externalId: string }).externalId;
    calls.observedExternalIds.push(externalId);
    return {
      observationId: `obs-${externalId}`,
      memoryIds: [memoryIdFor(externalId)],
      extraction: "ok",
      extractionFailure: null,
    } as unknown as Awaited<ReturnType<Runtime["observe"]>>;
  };

  const tick: Runtime["tick"] = async () =>
    ({ processed: 0, failed: 0, unsupported: [] }) as unknown as Awaited<
      ReturnType<Runtime["tick"]>
    >;

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
      // beforeMark: まだ対向が宣言されていないので、通常の recall と同じ形で両方出る。
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
      // afterMark: 両方出て、敗者側(=勝者でないほう)が mandatory_companion として付く。
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
    // afterResolve: 勝者だけが残る。
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

  const markContested: Runtime["markContested"] = async (_ctx, firstId, secondId, opts) => {
    calls.markContestedArgs = [String(firstId), String(secondId)];
    calls.markContestedOpts = opts;
    return {
      supported: true,
      outcome: { kind: "contested" },
    } as unknown as Awaited<ReturnType<Runtime["markContested"]>>;
  };

  const resolveContested: Runtime["resolveContested"] = async (
    _ctx,
    firstId,
    secondId,
    resolution,
    opts,
  ) => {
    calls.resolveContestedArgs = [String(firstId), String(secondId), resolution];
    calls.resolveContestedOpts = opts;
    return {
      supported: true,
      outcome: { kind: "resolved" },
    } as unknown as Awaited<ReturnType<Runtime["resolveContested"]>>;
  };

  return {
    observe,
    tick,
    findCorrectionCandidates,
    recall,
    markContested,
    resolveContested,
  } as unknown as Runtime;
}

/** `scenario.contestedPair.firstExternalId` を「記録済みの採用者の判断」として渡す。 */
function recordedChoice(scenario: CorrectionScenario = CORRECTION_SCENARIO) {
  return { chosenExternalId: scenario.contestedPair.firstExternalId };
}

describe("runCorrectionDemo: markContested/resolveContested に渡す id は 指名(choice) と scenario.contestedPair.winnerExternalId の宣言どおり", () => {
  it("既定シナリオ: choice=firstExternalId(original) ⟹ resolveContested に correction の memoryId が winnerId として渡る", async () => {
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

    // observe() は宣言順(original → correction)で呼ばれる。
    expect(calls.observedExternalIds).toEqual([
      CORRECTION_SCENARIO.original.externalId,
      CORRECTION_SCENARIO.correction.externalId,
    ]);

    expect(result.outcome).toBe("resolved");
    // 🔑 指名(choice)が候補の何位だったかが結果に載る(北極星 問い3)。
    expect(result.chosenId).toBe(originalId);
    expect(result.chosenRecallRank).toBe(1);

    // markContested は指名(chosenId)と correction の2件で呼ばれる。
    expect(calls.markContestedArgs).toEqual([originalId, correctionId]);

    // 🔑 resolveContested の winnerId は contestedPair.winnerExternalId(=correction)が
    // 指す memoryId であり、これは「あとから observe した」からではなく宣言だからである
    // (下の「宣言を逆にすると勝敗も入れ替わる」の歯が、これを順序と切り分けて示す)。
    expect(calls.resolveContestedArgs?.[0]).toBe(originalId);
    expect(calls.resolveContestedArgs?.[1]).toBe(correctionId);
    expect(calls.resolveContestedArgs?.[2]).toEqual({ kind: "supersede", winnerId: correctionId });

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

    // observe() の呼び出し順は変わらない(original が先) — それでも winnerId は original。
    expect(calls.observedExternalIds[0]).toBe(CORRECTION_SCENARIO.original.externalId);
    expect(calls.resolveContestedArgs?.[2]).toEqual({ kind: "supersede", winnerId: originalId });
  });

  it("🔑 3回の recall() はすべて limit: 1 で呼ばれる — 段3の必須同伴取得を発火させる条件そのもの(ADR 0162 決定5)", async () => {
    const calls = emptyCalls();
    const runtime = buildFakeRuntime(calls);

    await runCorrectionDemo(runtime, { tenantId: "t" }, CORRECTION_SCENARIO, recordedChoice());

    // beforeMark / afterMark / afterResolve の3回。
    expect(calls.recallQueries).toHaveLength(3);

    // 🔑 PR #320 の CI 失敗そのものの回帰検査。既定の limit(=10)へ戻すと、対の2件が
    // 両方とも段2の withinLimit に収まってしまい、段3「矛盾の解決と必須の同伴取得」
    // (docs/recall.md §2 段3)が一度も発火しない——afterMarkCompanionRetrieval が
    // false になる。**この歯は DB を要求しない**ので、本物の Postgres が無い環境でも
    // limit の退行を捕まえられる(correction-demo.postgres.test.ts だけが頼りにならない)。
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

/**
 * 🔴🔴 最優先の歯: `runCorrectionDemo` が「候補の1位を機械的に採る」実装であれば
 * 赤くなる（ADR 0232 引き受けた負債1「採用側が候補[0] を機械的に採る実装を書けば、
 * 深い誤爆 75% はそのまま再現する」への応答）。
 *
 * `findCorrectionCandidates` の候補1位を decoy にし、指名(choice)は候補2位の
 * originalId にする。`candidates[0]` を採る実装なら、`markContested`/
 * `resolveContested` は decoy に対して呼ばれてしまうはずである——この歯はそれが
 * **起きないこと**を実測する。
 *
 * ⚠ この歯だけでは「decoy が active のまま残る」ことを DB レベルでは確かめられない
 * （偽 Runtime は状態を持たない）。ここで実測しているのは「decoy の memoryId が
 * markContested/resolveContested の引数に一度も現れない」ことであり、
 * `examples/chat` の書き込み口を偽 Runtime で置き換えている以上、これが
 * 「decoy に触れていない」ことの実測できる範囲である。
 */
describe("🔴🔴 採用者の指名が候補1位ではないケース: candidates[0]実装なら赤くなる歯", () => {
  it("指名(originalId)は候補2位。候補1位のdecoyはmarkContested/resolveContestedの引数に一度も現れない", async () => {
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
    // 指名は候補の1位ではなく2位だった、ということが結果からも読める。
    expect(result.chosenRecallRank).toBe(2);
    expect(result.chosenId).toBe(originalId);

    // 🔴 本体: markContested/resolveContested は指名(originalId)に対して呼ばれ、
    // 候補1位のdecoyは一度も引数に現れない。
    expect(calls.markContestedArgs).toEqual([originalId, correctionId]);
    expect(calls.markContestedArgs).not.toContain(decoyId);
    expect(calls.resolveContestedArgs?.[0]).toBe(originalId);
    expect(calls.resolveContestedArgs?.[1]).toBe(correctionId);
    expect(JSON.stringify(calls.resolveContestedArgs)).not.toContain(decoyId);
  });
});

/**
 * 🔴 Issue #369 チェックボックス: 選んだ根拠（スコア・順位・候補の数・どちらへ倒したか）を
 * `memory_events.meta.note` から辿れるようにする——`markContested`/`resolveContested` の
 * `opts.reason` に実際に載ることを実測する（`meta.note` へ実際に届いたかは DB を要求する
 * ため `correction-demo.postgres.test.ts` 側で見る。ここでは「呼び出しの引数として
 * 渡ったか」までを見る）。
 */
describe("🔴 選んだ根拠が opts.reason 経由で markContested/resolveContested へ渡る(Issue #369)", () => {
  it("候補2位を指名したケース: reason に recallId・chosenRecallRank(=2)・candidates件数・winner が載り、markContested と resolveContested の両方に同じ reason が渡る", async () => {
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

    // 🔴 片方だけにしない: markContested と resolveContested の両方に reason が届く。
    expect(calls.markContestedOpts?.reason).toBeDefined();
    expect(calls.resolveContestedOpts?.reason).toBeDefined();
    expect(calls.markContestedOpts?.reason).toBe(calls.resolveContestedOpts?.reason);

    const reason = calls.markContestedOpts?.reason ?? "";
    expect(reason).toContain("chosenRecallRank=2");
    expect(reason).toContain(`candidates=${discoveryCandidates.length}`);
    expect(reason).toContain("recallId=correction-candidates-recall");
    expect(reason).toContain("winner=correction");

    // 🔴 選んだ根拠にスコアの生値(score.total)は載せない設計判断(ADR 参照)。
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
  it("choice が undefined ⟹ outcome=awaiting_choice、markContested/resolveContested/recallは一度も呼ばれない(書き込み0件)", async () => {
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

    // 🔴 書き込み0件: markContested/resolveContested はそもそも呼ばれない。
    expect(calls.markContestedArgs).toBeNull();
    expect(calls.resolveContestedArgs).toBeNull();
    // 🔴 recall() (beforeMark/afterMark/afterResolve用)も一度も呼ばれない
    // — イベントが増えない・どの Memory の状態も変わらないことの代理指標。
    expect(calls.recallCallCount).toBe(0);

    // それでも候補は提示されている(棄権していない)。
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

    expect(calls.markContestedArgs).toBeNull();
    expect(calls.resolveContestedArgs).toBeNull();
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
    // このフィクスチャでは buildFakeRuntime が「resolveContested の敗者(loser)が
    // mandatory_companion になる」形で afterMark を作っているが、
    // checkCorrectionDemo 自体はそれを前提にしていない(下の
    // 「mandatory_companion がどちらに付くかは決め打たない」参照)。
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

    // `correction` は resolveContested の勝者だが、段2のランキングでは limit から
    // 落ちて mandatory_companion 側に回った——このケースでも正しく検出できること。
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

/**
 * `checkCorrectionOmission`（Issue #374）の歯。DB を要求しない——`RecallResult.omitted`
 * を直接組み立てた固定値から読む、純粋な判定なので、`packages/postgres` を経由しない。
 *
 * **測っているもの**: 北極星 項目6「知らないことを、知らないと言える」——「消えた」
 * （machine の都合で superseded として棚上げされた）と「最初から無かった」を、
 * `omitted` の `condition: "superseded"` の有無で区別できるか。
 */
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

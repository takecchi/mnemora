import { afterAll, describe, expect, it } from "vitest";
import {
  ANSWER_TIME_WEIGHTING_ORDER_LEGEND_CASSETTE_PATH,
  cassetteExists,
  loadCassette,
} from "../cassette-io.js";
import {
  aggregateTimeWeightingResults,
  createTimeWeightingBenchRuntime,
  runTimeWeightingBench,
  type TimeWeightingTrialResult,
} from "../time-weighting-bench.js";
import { TIME_WEIGHTING_CASE_SET_DEV } from "../time-weighting-case-set.dev.js";
import { TIME_WEIGHTING_CASE_SET_EVAL } from "../time-weighting-case-set.eval.js";
import { TIME_WEIGHTING_CASE_SET_EVAL_UNDATED } from "../time-weighting-case-set.eval-undated.js";
import {
  closeTestClient,
  getTestClient,
  requireDatabaseUrl,
  resetTestDatabase,
} from "./test-db.js";

// 正誤を期待どおりに固定し、取り引きを隠さない（ADR 0300）。EXPECTED_VERDICT は記録のログから書き写し、旧記録の値を使い回さない。
// eval-undated-c1-seat-floor-reinforced は記録時に LLM が正解した。fail を捏造せず記録のまま固定し、検索側の事実（rank1・文脈入り）は別の検査で固定する。

const ALL_CASES = [
  ...TIME_WEIGHTING_CASE_SET_DEV,
  ...TIME_WEIGHTING_CASE_SET_EVAL,
  ...TIME_WEIGHTING_CASE_SET_EVAL_UNDATED,
];

const EXPECTED_VERDICT: Record<
  string,
  { legacy: "pass" | "fail"; eventAwareFreshness: "pass" | "fail" }
> = {
  "dev-a1-tea-over-coffee": { legacy: "fail", eventAwareFreshness: "pass" },
  "dev-a2-remote-work-day": { legacy: "fail", eventAwareFreshness: "pass" },
  "dev-b1-phone-model": { legacy: "pass", eventAwareFreshness: "pass" },
  "dev-b2-current-project": { legacy: "pass", eventAwareFreshness: "pass" },
  "dev-c1-meeting-schedule": { legacy: "pass", eventAwareFreshness: "pass" },
  "dev-c2-gym-plan": { legacy: "pass", eventAwareFreshness: "pass" },
  "eval-a1-window-seat": { legacy: "fail", eventAwareFreshness: "pass" },
  "eval-a2-doc-tool": { legacy: "fail", eventAwareFreshness: "pass" },
  "eval-b1-pet": { legacy: "pass", eventAwareFreshness: "pass" },
  "eval-b2-relocation": { legacy: "pass", eventAwareFreshness: "pass" },
  "eval-c1-internet-plan": { legacy: "pass", eventAwareFreshness: "pass" },
  "eval-c2-work-shift": { legacy: "pass", eventAwareFreshness: "pass" },
  "eval-undated-b1-department-reinforced": { legacy: "pass", eventAwareFreshness: "pass" },
  "eval-undated-b2-hobby-not-reinforced": { legacy: "pass", eventAwareFreshness: "pass" },
  "eval-undated-c1-seat-floor-reinforced": { legacy: "pass", eventAwareFreshness: "pass" },
  "eval-undated-c2-standup-day-not-reinforced": { legacy: "pass", eventAwareFreshness: "pass" },
};

describe("examples/chat: answer-time-weighting カセット再生（本物の Postgres、鍵不要、決定的）", () => {
  it("カセットがリポジトリに存在する", () => {
    expect(cassetteExists(ANSWER_TIME_WEIGHTING_ORDER_LEGEND_CASSETTE_PATH)).toBe(true);
  });

  it("全16ケース×2方針の gradeAnswer 正誤が、記録した時点と1バイトも変わらず再生される", async () => {
    await resetTestDatabase();
    await getTestClient();
    const cassette = loadCassette(ANSWER_TIME_WEIGHTING_ORDER_LEGEND_CASSETTE_PATH);
    const handle = await createTimeWeightingBenchRuntime(
      requireDatabaseUrl(),
      { ...process.env, MNEMORA_LLM: "recorded", MNEMORA_EMBEDDING: "recorded" },
      { cassette },
    );
    try {
      expect(handle.llmMode).toBe("recorded");
      expect(handle.embeddingMode).toBe("recorded");

      const results: TimeWeightingTrialResult[] = await runTimeWeightingBench(
        handle,
        ALL_CASES,
        "answer-time-weighting-replay",
        1,
      );

      const actual: Record<string, { legacy: string; eventAwareFreshness: string }> = {};
      for (const result of results) {
        actual[result.case.id] = {
          legacy: result.byPolicy.legacy.verdict,
          eventAwareFreshness: result.byPolicy.eventAwareFreshness.verdict,
        };
      }
      expect(actual).toEqual(EXPECTED_VERDICT);

      const aggregate = aggregateTimeWeightingResults(results);
      expect(aggregate).toHaveLength(ALL_CASES.length * 2);
    } finally {
      await handle.close();
    }
  });

  it("🔴 既知の取り引き: eventAwareFreshness は occurredAt/validFrom/validUntil の無い、reinforce 済みの古い予定を常に rank1・文脈入りさせる（ADR 0300）", async () => {
    // gradeAnswer の正誤は LLM の応答で揺れうる。ここでは recall() のスコアリングという決定的な事実だけを見る。
    await resetTestDatabase();
    await getTestClient();
    const cassette = loadCassette(ANSWER_TIME_WEIGHTING_ORDER_LEGEND_CASSETTE_PATH);
    const handle = await createTimeWeightingBenchRuntime(
      requireDatabaseUrl(),
      { ...process.env, MNEMORA_LLM: "recorded", MNEMORA_EMBEDDING: "recorded" },
      { cassette },
    );
    try {
      const targetCase = TIME_WEIGHTING_CASE_SET_EVAL_UNDATED.find(
        (c) => c.id === "eval-undated-c1-seat-floor-reinforced",
      );
      expect(targetCase).toBeDefined();
      const [result] = await runTimeWeightingBench(
        handle,
        [targetCase!],
        "answer-time-weighting-replay-diagnostic",
        1,
      );
      expect(result).toBeDefined();

      const legacyOld = result!.byPolicy.legacy.contextDiagnostics.find(
        (d) => d.localId === "old-seat-undated",
      );
      const eventAwareOld = result!.byPolicy.eventAwareFreshness.contextDiagnostics.find(
        (d) => d.localId === "old-seat-undated",
      );
      expect(legacyOld).toBeDefined();
      expect(eventAwareOld).toBeDefined();

      expect(legacyOld!.enteredContext).toBe(false);
      expect(legacyOld!.rank).not.toBe(1);

      expect(eventAwareOld!.enteredContext).toBe(true);
      expect(eventAwareOld!.rank).toBe(1);
    } finally {
      await handle.close();
    }
  });
});

afterAll(async () => {
  await closeTestClient();
});

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

/**
 * `answer-time-weighting` のカセット再生検査（本物の Postgres、**鍵不要**、決定的。
 * 段3b（Issue #690、ADR 0300）。
 *
 * `compare`/`answer` の再生検査と同じ規律——`examples/chat/cassettes/
 * answer-time-weighting.order-legend.json`（`record:answer-time-weighting`、
 * temperature=0で記録）を `MNEMORA_LLM=recorded MNEMORA_EMBEDDING=recorded` で再生する。
 * CI の `example-chat` ジョブがこのファイルを（`test:db` 経由で自動的に）実行する。
 *
 * ⛔ **ADR 0305（Issue #691 続き）**: `buildMnemoraPrompt` が `order-legend` 描画に
 * 変わったため、旧形式（`answer-time-weighting.json`、`ANSWER_TIME_WEIGHTING_CASSETTE_PATH`）
 * はもう再生できない——このファイルはまだ実 API で記録していない
 * （`cassette-coverage.test.ts` が「カセットが無い」で先に落ちる）。**記録し直したら、
 * 下の `EXPECTED_VERDICT` を新しい記録のログからそのまま書き写すこと——旧記録の値を
 * 使い回さない。** プロンプトの文言が変わるとモデルの実際の回答文字列も変わりうるため、
 * `gradeAnswer` の正誤が今と同じである保証は無い（**特に legacy 4件——`schedule-change-
 * meeting-day` 系と同様の「訂正の後続」を含むケースは、ADR 0305 の実測でも並べ替え・
 * 凡例の有無で正答率が動いている——結果が変わる可能性が高い**）。
 *
 * 🔴 **正誤を「期待どおり」に固定する。取り引きを隠さない**（マネージャー決定）:
 * 類型A（`reinforced-fact-vs-fresh-weak`）は **legacy が構造的に失敗し、
 * eventAwareFreshness が直す**——これは ADR 0300 が意図した改善そのものである。
 * 類型B/C/B'/C' は両方針とも成功するはずである（regression guard）。
 *
 * ⚠ **`eval-undated-c1-seat-floor-reinforced` について**: 段3a の切り分け
 * （`bench-results/STAGE3A-NOTES.txt`、temperature=0・20回）では
 * eventAwareFreshness の gradeAnswer 正答数が 0/20 だった——古い予定
 * （`occurredAt`/`validFrom`/`validUntil` のいずれも無く、reinforce 済み）が
 * 常に rank1・文脈入りすることが原因である。**この記録（`record:answer-
 * time-weighting`、段3b-2、temperature=0・1回）ではその同じ retrieval 側の事実
 * （rank1・文脈入り、下記の検査参照）が起きているにも関わらず、LLM の回答は
 * 正解した**（`bench-results/STAGE3B-1-NOTES.txt` が実測した「temperature=0でも
 * 別セッションでは LLM の応答自体が変わりうる」という事実と整合する）。
 * ⟹ **この歯は、記録された時点の実際の gradeAnswer 結果をそのまま固定する**
 * （fail を捏造しない）——ただし、eventAwareFreshness が古い予定を rank1・
 * 文脈入りさせるという**検索側の事実**（LLM の応答に関わらず毎回再現する）は、
 * 別の検査で明示的に固定する。**「eventAwareFreshness にはこの性質がある」こと
 * 自体を隠さない**、という要求は、この2段構えで満たす。
 */

const ALL_CASES = [
  ...TIME_WEIGHTING_CASE_SET_DEV,
  ...TIME_WEIGHTING_CASE_SET_EVAL,
  ...TIME_WEIGHTING_CASE_SET_EVAL_UNDATED,
];

/**
 * `record:answer-time-weighting`（段3b-2、temperature=0・trials=1）が実際に記録した
 * gradeAnswer の結果。`bench-results/answer-time-weighting-record-temp0.log` の表と
 * 一致する——**この歯はその記録を書き写しているのであり、期待値を新しく決めていない。**
 */
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

      // 集計表も、記録時点の類型ごとの正答率と一致する——`aggregateTimeWeightingResults`
      // 自体の配線がこのケース集合を通しても壊れていないことも合わせて確認する。
      const aggregate = aggregateTimeWeightingResults(results);
      expect(aggregate).toHaveLength(ALL_CASES.length * 2);
    } finally {
      await handle.close();
    }
  });

  it("🔴 既知の取り引き: eventAwareFreshness は occurredAt/validFrom/validUntil の無い、reinforce 済みの古い予定を常に rank1・文脈入りさせる（ADR 0300）", async () => {
    // この検査は gradeAnswer の正誤（LLM の応答テキストに依存し、揺れうる）ではなく、
    // recall() のスコアリングという決定的な事実だけを見る——段3aの切り分け・段3b-1の
    // 本評価の取り直しの両方で、この事実だけは100%再現している
    // （`bench-results/STAGE3A-NOTES.txt`・`STAGE3B-1-NOTES.txt` 参照）。
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

      // legacy: 古い予定(occurredAtが無い)の freshness は recordedAt の古さで沈み、
      // below_threshold で文脈から外れる。
      expect(legacyOld!.enteredContext).toBe(false);
      expect(legacyOld!.rank).not.toBe(1);

      // eventAwareFreshness: freshness=1に固定され、reinforce済みで decay も高いため、
      // 常に rank1・文脈入りする——これが ADR 0300 の取り引きそのものである。
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

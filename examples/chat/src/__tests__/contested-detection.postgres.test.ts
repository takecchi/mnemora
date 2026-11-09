import { describe, expect, it } from "vitest";
import { runContestedDetection } from "../contested-detection-bench.js";
import { confusionOf, metricsOf } from "../contested-detection-metrics.js";
import { getTestClient, requireDatabaseUrl, resetTestDatabase } from "./test-db.js";

/**
 * 決定的な検出段の、いまの判定をケースごとに固定する（ADR 0703。本物の Postgres）。
 * ⚠ 期待値には、既知の誤検出・見逃しが含まれる（「正しい」判定の表ではなく、測った判定の表）。
 * 検出のコードを変えてこの表が動いたら、どのカテゴリの何が動いたかを見て、表と ADR を更新すること。
 */
const MEASURED: Record<string, boolean> = {
  "conflict-color": true,
  "conflict-residence-same-period": true,
  "conflict-employer": true,
  "conflict-blood-type": true,
  "correction-separate-turn": true,
  "correction-residence": true,
  // 同じ observation の兄弟は検出の対象外（ADR 0377 の既知の損失）
  "correction-same-utterance": false,
  "correction-allergy": true,
  // 本文が違えば矛盾とみなし、意味の同一性を見ない（既知の誤検出）
  "paraphrase-color": true,
  // NFC + trim で同じ本文になるものは除く
  "paraphrase-whitespace": false,
  "paraphrase-residence": true,
  "paraphrase-pet": true,
  "temporal-explicit-periods": false,
  "temporal-explicit-employer": false,
  // 期間を構造化していないと無期限として重なる（ADR 0491、既知の誤検出）
  "temporal-in-text-only": true,
  "temporal-in-text-age": true,
  "non-conflict-other-person": false,
  "non-conflict-other-predicate": false,
  // 同じ述語に複数の値が両立する属性を区別しない（既知の誤検出）
  "non-conflict-multi-valued": true,
  "non-conflict-languages": true,
};

describe("contested-detection: claim key の矛盾検出の決定的な段（oracle 鍵・本物の Postgres）", () => {
  it("ケースごとの判定が、測った表と一致する", async () => {
    await resetTestDatabase();
    await getTestClient();

    const results = await runContestedDetection(requireDatabaseUrl(), {
      tenantPrefix: "contested-detection-test",
    });

    expect(Object.fromEntries(results.map((r) => [r.id, r.detected]))).toEqual(MEASURED);
    expect(metricsOf(confusionOf(results))).toMatchObject({ tp: 7, fp: 7, fn: 1, tn: 5 });
  });
});

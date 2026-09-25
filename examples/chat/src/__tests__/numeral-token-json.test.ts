import { describe, expect, it } from "vitest";
import {
  buildMeasuredNumeralTokenProbeJson,
  buildWeightsUnavailableNumeralTokenProbeJson,
} from "../numeral-token-json.js";
import type { IdentifierArmReport } from "../identifier-arm.js";

/**
 * ADR 0135: `numeral-token-json.ts` の出力口。DB もネットワークも要らない(純関数)。
 * `./identifier-json.test.ts` と同じ狙い——「重みを取得できなかった」と「測ったが
 * 値が悪かった」が型で区別され、前者に0や既定値を混ぜていないことを見る。
 */

function minimalReport(
  haystackKind: "sparse" | "dense",
  overrides: Partial<IdentifierArmReport> = {},
): IdentifierArmReport {
  return {
    armLabel: `numeral-token-${haystackKind}`,
    tenantId: `t-${haystackKind}`,
    llmMode: "deterministic",
    embeddingMode: "local",
    haystackKind,
    ingest: {
      observationCount: 96,
      drain: { ticks: 1, totalProcessed: 96, totalFailed: 0, firstTickProcessed: 96 },
    },
    probes: [],
    mrrOverall: 1,
    hit1Count: 18,
    hit10Count: 18,
    probeCount: 18,
    marginStats: { count: 18, mean: 0.03, stdDev: 0.01, min: -0.0001 },
    ...overrides,
  };
}

describe("buildMeasuredNumeralTokenProbeJson", () => {
  it("sparse/dense の2群それぞれに (provider, model, dimensions)・haystackKind・marginStats を持つ", () => {
    const json = buildMeasuredNumeralTokenProbeJson({
      sparseReport: minimalReport("sparse"),
      denseReport: minimalReport("dense", { mrrOverall: 0.9, hit1Count: 16 }),
      embeddingSpace: { provider: "local", model: "ruri-v3-30m/sym", dimensions: 256 },
      measuredAt: new Date("2026-09-20T00:00:00.000Z"),
      commit: "abc123",
    });
    expect(json.status).toBe("measured");
    if (json.status !== "measured") {
      throw new Error("unreachable");
    }
    const expectedSpace = { provider: "local", model: "ruri-v3-30m/sym", dimensions: 256 };
    expect(json.sparse.embeddingSpace).toEqual(expectedSpace);
    expect(json.dense.embeddingSpace).toEqual(expectedSpace);
    expect(json.sparse.haystackKind).toBe("sparse");
    expect(json.dense.haystackKind).toBe("dense");
    expect(json.sparse.mrrOverall).toBe(1);
    expect(json.dense.mrrOverall).toBe(0.9);
    expect(json.dense.hit1Count).toBe(16);
    expect(json.sparse.marginStats).toEqual({ count: 18, mean: 0.03, stdDev: 0.01, min: -0.0001 });
  });

  it("report.marginStats が無い(型上は optional)ときは count:0 のフォールバックへ倒す", () => {
    const withoutMarginStats = minimalReport("sparse");
    delete (withoutMarginStats as { marginStats?: unknown }).marginStats;
    const json = buildMeasuredNumeralTokenProbeJson({
      sparseReport: withoutMarginStats,
      denseReport: minimalReport("dense"),
      embeddingSpace: { provider: "local", model: "ruri-v3-30m/sym", dimensions: 256 },
      measuredAt: new Date("2026-09-20T00:00:00.000Z"),
      commit: null,
    });
    if (json.status !== "measured") {
      throw new Error("unreachable");
    }
    expect(json.sparse.marginStats).toEqual({ count: 0, mean: null, stdDev: null, min: null });
  });
});

describe("buildWeightsUnavailableNumeralTokenProbeJson", () => {
  it("メトリクスの欄を一切持たない(0/nullで埋めない)", () => {
    const json = buildWeightsUnavailableNumeralTokenProbeJson({
      measuredAt: new Date("2026-09-20T00:00:00.000Z"),
      commit: "abc123",
      detail: "重みを取得できなかったので、値は測っていない: simulated",
    });
    expect(json.status).toBe("weights_unavailable");
    expect(json).not.toHaveProperty("sparse");
    expect(json).not.toHaveProperty("dense");
    if (json.status !== "weights_unavailable") {
      throw new Error("unreachable");
    }
    expect(json.detail).toContain("重みを取得できなかったので、値は測っていない");
  });
});

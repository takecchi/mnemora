import { describe, expect, it } from "vitest";
import { buildOpenAiArmRunJson } from "../openai-arm-json.js";
import type { IdentifierArmReport, IdentifierProbeOutcome } from "../identifier-arm.js";

function makeProbe(overrides: Partial<IdentifierProbeOutcome> = {}): IdentifierProbeOutcome {
  return {
    probeId: "p1",
    category: "person",
    goldRank: 1,
    distractorRank: 2,
    hit1: true,
    hit10: true,
    distractorBeatsGold: false,
    reciprocalRank: 1,
    omittedKinds: [],
    totalInScope: 10,
    scoreDetails: [],
    termSpreads: [],
    margin: 0.1,
    ...overrides,
  };
}

function makeReport(overrides: Partial<IdentifierArmReport> = {}): IdentifierArmReport {
  const probes = overrides.probes ?? [makeProbe()];
  return {
    armLabel: "test-arm",
    tenantId: "t1",
    llmMode: "deterministic",
    embeddingMode: "recorded",
    haystackKind: "sparse",
    ingest: {
      observationCount: 1,
      drain: { ticks: 1, firstTickProcessed: 1, totalProcessed: 1, totalFailed: 0 },
    },
    probes,
    mrrOverall: 1,
    hit1Count: 1,
    hit10Count: 1,
    probeCount: probes.length,
    ...overrides,
  };
}

const EMBEDDING_SPACE = { provider: "openai", model: "text-embedding-3-small", dimensions: 256 };

describe("buildOpenAiArmRunJson", () => {
  it("probeMargins に probeId と margin を probes の順で書き出す", () => {
    const report = makeReport({
      probes: [makeProbe({ probeId: "a", margin: 0.2 }), makeProbe({ probeId: "b", margin: null })],
    });
    const json = buildOpenAiArmRunJson(
      [{ key: "identifiersSparse", report, embeddingSpace: EMBEDDING_SPACE }],
      new Date("2026-09-26T00:00:00.000Z"),
      "abc123",
    );
    const [group] = json.groups;
    expect(group).toBeDefined();
    expect(group?.probeMargins).toEqual([
      { probeId: "a", margin: 0.2 },
      { probeId: "b", margin: null },
    ]);
  });

  it("既存の欄(marginStats・mrrOverall等)は今まで通り書き出す(この変更で壊していない)", () => {
    const report = makeReport({ marginStats: { count: 1, mean: 0.1, stdDev: null, min: 0.1 } });
    const json = buildOpenAiArmRunJson(
      [{ key: "identifiersSparse", report, embeddingSpace: EMBEDDING_SPACE }],
      new Date("2026-09-26T00:00:00.000Z"),
      "abc123",
    );
    const [group] = json.groups;
    expect(group).toBeDefined();
    expect(group?.marginStats).toEqual({ count: 1, mean: 0.1, stdDev: null, min: 0.1 });
    expect(group?.mrrOverall).toBe(1);
    expect(group?.hit1Count).toBe(1);
  });

  it("probes が0件でも空配列を書き出す(欠落ではなく明示的な空)", () => {
    const report = makeReport({
      probes: [],
      probeCount: 0,
      hit1Count: 0,
      hit10Count: 0,
      mrrOverall: 0,
    });
    const json = buildOpenAiArmRunJson(
      [{ key: "identifiersSparse", report, embeddingSpace: EMBEDDING_SPACE }],
      new Date("2026-09-26T00:00:00.000Z"),
      "abc123",
    );
    const [group] = json.groups;
    expect(group).toBeDefined();
    expect(group?.probeMargins).toEqual([]);
  });
});

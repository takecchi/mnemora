import { afterAll, describe, expect, it } from "vitest";
import { createMutableClock } from "../mutable-clock.js";
import { createExampleRuntime } from "../runtime-factory.js";
import { TIE_EPSILON, formatTimeTermReport, runTimeTermArm } from "../time-term-arm.js";
import { TIME_PROBES } from "../time-term-probe-set.js";
import type { TimeProbeOutcome } from "../time-term-arm.js";
import {
  closeTestClient,
  getTestClient,
  requireDatabaseUrl,
  resetTestDatabase,
} from "./test-db.js";

// provider は deterministic に固定する。環境に OPENAI_API_KEY が在っても本物へ倒れない。
// 以下の assert は実測の前に立てた予測。実測が違っても期待値を静かに書き換えて緑にしない（ADR 0058）。
describe("examples/chat: time-term arm(擬似 provider・本物の Postgres)", () => {
  it("8 probe の pair outcome / freshness / decay / similarity / total を実測する", async () => {
    await resetTestDatabase();
    await getTestClient();
    const clock = createMutableClock();
    const handle = await createExampleRuntime(
      requireDatabaseUrl(),
      {
        MNEMORA_LLM: "deterministic",
        MNEMORA_EMBEDDING: "deterministic",
      },
      {},
      clock,
    );
    try {
      expect(handle.llmMode).toBe("deterministic");
      expect(handle.embeddingMode).toBe("deterministic");

      // 過去/未来のリテラル日付は使えない。freshness/decay は注入した MutableClock（実時計と同じ new Date()）が起点なので、now を1回捕まえて8 probe で使い回す。
      const now = new Date();
      const report = await runTimeTermArm({
        armLabel: "time-term-test",
        tenantIdPrefix: "time-term-test",
        runtime: handle.runtime,
        memoryStore: handle.memoryStore,
        llmMode: handle.llmMode,
        embeddingMode: handle.embeddingMode,
        now,
        clock,
      });

      console.log(formatTimeTermReport(report));

      const byId = new Map<string, TimeProbeOutcome>(report.probes.map((p) => [p.probeId, p]));

      expect(report.probes).toHaveLength(TIME_PROBES.length);
      for (const p of report.probes) {
        expect(p.newer).not.toBeNull();
        expect(p.totalInScope).toBe(2);
        expect(p.outcome).not.toBe("collapsed");
      }

      const sameOccurredAt = byId.get("same-occurred-at")!;
      expect(sameOccurredAt.outcome).toBe("tied");
      expect(sameOccurredAt.similarityGapWithinPair).toBe(0);
      expect(sameOccurredAt.totalRatio).not.toBeNull();
      expect(Math.abs(sameOccurredAt.totalRatio! - 1)).toBeLessThan(TIE_EPSILON);

      const absent = byId.get("absent")!;
      expect(absent.outcome).toBe("tied");
      expect(absent.newer).not.toBeNull();
      expect(absent.older).not.toBeNull();
      expect(Math.abs(absent.newer!.score.freshness - absent.newer!.score.decay)).toBeLessThan(
        1e-9,
      );
      expect(Math.abs(absent.older!.score.freshness - absent.older!.score.decay)).toBeLessThan(
        1e-9,
      );

      const halfLife = byId.get("half-life")!;
      expect(halfLife.outcome).toBe("newer-ranked-higher");
      expect(halfLife.newer).not.toBeNull();
      expect(halfLife.older).not.toBeNull();
      expect(halfLife.newer!.score.freshness).toBeCloseTo(1.0, 3);
      expect(halfLife.older!.score.freshness).toBeCloseTo(0.5, 3);
      expect(halfLife.similarityGapWithinPair).toBe(0);
      expect(halfLife.freshnessRatio).not.toBeNull();
      expect(halfLife.totalRatio).not.toBeNull();
      expect(Math.abs(halfLife.totalRatio! - halfLife.freshnessRatio!)).toBeLessThan(1e-3);

      const realistic = byId.get("realistic")!;
      expect(realistic.outcome).toBe("newer-ranked-higher");
      expect(realistic.newer).not.toBeNull();
      expect(realistic.older).not.toBeNull();
      expect(realistic.newer!.score.freshness).toBeCloseTo(0.97716, 3);
      expect(realistic.older!.score.freshness).toBeCloseTo(0.911724, 3);
      expect(realistic.similarityGapWithinPair).toBe(0);
      expect(realistic.freshnessRatio).not.toBeNull();
      expect(realistic.totalRatio).not.toBeNull();
      expect(Math.abs(realistic.totalRatio! - realistic.freshnessRatio!)).toBeLessThan(1e-3);

      const farPast = byId.get("far-past")!;
      expect(farPast.outcome).toBe("older-not-returned");
      expect(farPast.omittedKinds).toContain("below_threshold");

      const decayHalfLife = byId.get("decay-half-life")!;
      expect(decayHalfLife.outcome).toBe("newer-ranked-higher");
      expect(decayHalfLife.newer).not.toBeNull();
      expect(decayHalfLife.older).not.toBeNull();
      expect(decayHalfLife.similarityGapWithinPair).toBe(0);
      expect(decayHalfLife.freshnessGapWithinPair).toBe(0);
      expect(decayHalfLife.newer!.score.decay).toBeCloseTo(1.0, 3);
      expect(decayHalfLife.older!.score.decay).toBeCloseTo(0.5, 3);
      expect(decayHalfLife.decayRatio).not.toBeNull();
      expect(decayHalfLife.totalRatio).not.toBeNull();
      expect(Math.abs(decayHalfLife.totalRatio! - decayHalfLife.decayRatio!)).toBeLessThan(1e-3);

      const decayRealistic = byId.get("decay-realistic")!;
      expect(decayRealistic.outcome).toBe("newer-ranked-higher");
      expect(decayRealistic.newer).not.toBeNull();
      expect(decayRealistic.older).not.toBeNull();
      expect(decayRealistic.newer!.score.decay).toBeCloseTo(0.97716, 3);
      expect(decayRealistic.older!.score.decay).toBeCloseTo(0.911722, 3);
      expect(decayRealistic.freshnessGapWithinPair).toBe(0);
      expect(decayRealistic.decayRatio).not.toBeNull();
      expect(decayRealistic.totalRatio).not.toBeNull();
      expect(Math.abs(decayRealistic.totalRatio! - decayRealistic.decayRatio!)).toBeLessThan(1e-3);

      const decaySameRecordedAt = byId.get("decay-same-recorded-at")!;
      expect(decaySameRecordedAt.outcome).toBe("tied");
      expect(decaySameRecordedAt.freshnessGapWithinPair).toBe(0);
      expect(decaySameRecordedAt.totalRatio).not.toBeNull();
      expect(Math.abs(decaySameRecordedAt.totalRatio! - 1)).toBeLessThan(TIE_EPSILON);
    } finally {
      await handle.close();
    }
  });
});

afterAll(async () => {
  await closeTestClient();
});

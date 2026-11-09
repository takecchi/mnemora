import { describe, expect, it } from "vitest";
import { createLongHorizonRuntime, runLongHorizonBench } from "../long-horizon-bench.js";
import { LONG_HORIZON_FACTS } from "../long-horizon-case-set.js";
import { getTestClient, requireDatabaseUrl, resetTestDatabase } from "./test-db.js";

// 配線の検査であって、想起の質の測定ではない（擬似 embedding の similarity は意味を持たない）。
// 見るのは、模擬期間を進めたとき既定の忘却ゲートが実際に効き、ベンチがそれを decayed と名指しできるか。
describe("examples/chat: long-horizon（本物の Postgres、配線検査）", () => {
  it("使用報告の無い休眠の gold は、忘却ゲートの日（約130日）を過ぎると decayed と名指しされ、その前は decayed ではない", async () => {
    await resetTestDatabase();
    await getTestClient();
    const handle = await createLongHorizonRuntime(requireDatabaseUrl(), {});
    try {
      expect(handle.embeddingMode).toBe("deterministic");
      const dormant = LONG_HORIZON_FACTS.find((f) => f.factClass === "dormant")!;
      const correction = LONG_HORIZON_FACTS.find((f) => f.factClass === "correction")!;
      const report = await runLongHorizonBench(handle, {
        facts: [dormant, correction],
        days: 140,
        fillersPerDay: 1,
        checkpointDays: [7, 140],
        arms: ["A"],
        tenantPrefix: "long-horizon-wiring",
      });

      const dormantAt = (day: number) =>
        report.probes.find(
          (p) => p.factId === dormant.id && p.checkpointDay === day && p.role === "gold",
        )!;
      expect(dormantAt(7).outcome).not.toBe("decayed");
      expect(dormantAt(140).outcome).toBe("decayed");

      // 訂正の新しい側は90日目に植えるので、7日目には測られず、140日目には新旧の両方が測られる。
      const correctionProbes = report.probes.filter((p) => p.factId === correction.id);
      expect(correctionProbes.filter((p) => p.checkpointDay === 7).map((p) => p.role)).toEqual([
        "superseded",
      ]);
      expect(
        correctionProbes
          .filter((p) => p.checkpointDay === 140)
          .map((p) => p.role)
          .sort(),
      ).toEqual(["gold", "superseded"]);
    } finally {
      await handle.close();
    }
  });

  it("使用報告ありの arm では、常用の事実が話題に出るたびに報告され、gold の強化時刻が進む", async () => {
    await resetTestDatabase();
    await getTestClient();
    const handle = await createLongHorizonRuntime(requireDatabaseUrl(), {});
    try {
      const habitual = LONG_HORIZON_FACTS.find((f) => f.factClass === "habitual")!;
      const report = await runLongHorizonBench(handle, {
        facts: [habitual],
        days: 30,
        fillersPerDay: 1,
        checkpointDays: [30],
        arms: ["A", "B"],
        tenantPrefix: "long-horizon-usage-wiring",
      });
      expect(report.usageReports.A).toBe(0);
      expect(report.usageReports.B).toBeGreaterThan(0);
      const at = (arm: "A" | "B") => report.probes.find((p) => p.arm === arm && p.role === "gold")!;
      expect(at("A").lastReinforcedAt).toBeNull();
      expect(at("B").lastReinforcedAt).not.toBeNull();
    } finally {
      await handle.close();
    }
  });
});

import { afterAll, describe, expect, it } from "vitest";
import { formatIdentifierArmReport, runIdentifierProbeArm } from "../identifier-arm.js";
import { IDENTIFIER_PROBES } from "../identifier-probe-set.js";
import { createExampleRuntime } from "../runtime-factory.js";
import {
  closeTestClient,
  getTestClient,
  requireDatabaseUrl,
  resetTestDatabase,
} from "./test-db.js";

// 期待値はここに逐語で書く。実装と同じ関数を呼ぶと、実装が壊れても期待値が一緒に壊れて自己整合してしまう。
function expectedDeterministicDigest(text: string): string {
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

// provider は deterministic に固定して配線だけを見る。意味的な類似度を持たないので、goldRank/hit の値そのものは主張しない。
describe("examples/chat: identifier-probe arm(擬似 provider・本物の Postgres)", () => {
  it("IDENTIFIER_PROBES すべてで、クラッシュせずに構造化された結果を返す", async () => {
    await resetTestDatabase();
    await getTestClient();
    const handle = await createExampleRuntime(requireDatabaseUrl(), {
      MNEMORA_LLM: "deterministic",
      MNEMORA_EMBEDDING: "deterministic",
    });
    try {
      expect(handle.llmMode).toBe("deterministic");
      expect(handle.embeddingMode).toBe("deterministic");

      const haystackSize = 4;
      const report = await runIdentifierProbeArm({
        armLabel: "identifier-probe-test",
        tenantId: `identifier-probe-test-${Date.now()}`,
        runtime: handle.runtime,
        memoryStore: handle.memoryStore,
        llmMode: handle.llmMode,
        embeddingMode: handle.embeddingMode,
        haystackSize,
      });

      console.log(formatIdentifierArmReport(report));

      expect(report.probes).toHaveLength(IDENTIFIER_PROBES.length);
      expect(report.probeCount).toBe(IDENTIFIER_PROBES.length);
      expect(report.ingest.observationCount).toBe(IDENTIFIER_PROBES.length * 2 + haystackSize);

      expect(report.ingest.drain.totalProcessed).toBe(report.ingest.observationCount);
      expect(report.ingest.drain.totalFailed).toBe(0);

      expect(report.hit1Count).toBeGreaterThanOrEqual(0);
      expect(report.hit1Count).toBeLessThanOrEqual(report.probeCount);
      expect(report.hit10Count).toBeGreaterThanOrEqual(0);
      expect(report.hit10Count).toBeLessThanOrEqual(report.probeCount);
      expect(report.mrrOverall).toBeGreaterThanOrEqual(0);
      expect(report.mrrOverall).toBeLessThanOrEqual(1);

      for (const p of report.probes) {
        const probeDef = IDENTIFIER_PROBES.find((probe) => probe.id === p.probeId);
        expect(probeDef).toBeDefined();
        expect(p.hit1).toBe(p.goldRank === 1);
        expect(p.hit10).toBe(p.goldRank !== null);
        expect(p.totalInScope).toBe(report.ingest.observationCount);

        const expectedGoldDigest = expectedDeterministicDigest(probeDef!.fact);
        const expectedDistractorDigest = expectedDeterministicDigest(probeDef!.distractor);
        const goldDetail = p.scoreDetails.find((d) => d.roles.includes("gold"));
        if (goldDetail) {
          expect(goldDetail.digest).toBe(expectedGoldDigest);
          expect(goldDetail.digest).not.toBe(expectedDistractorDigest);
        }
        const distractorDetail = p.scoreDetails.find((d) => d.roles.includes("distractor"));
        if (distractorDetail) {
          expect(distractorDetail.digest).toBe(expectedDistractorDigest);
          expect(distractorDetail.digest).not.toBe(expectedGoldDigest);
        }
      }

      expect(formatIdentifierArmReport(report)).toContain("identifier-probe arm");
    } finally {
      await handle.close();
    }
  });
});

afterAll(async () => {
  await closeTestClient();
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LOCAL_NOISE_GROUPS, captureGroupCandidates } from "../local-noise-arm.js";
import { computeNoisyGroupMetrics } from "../synthetic-score-noise.js";
import { createExampleRuntime, type ExampleRuntimeHandle } from "../runtime-factory.js";
import {
  closeTestClient,
  getTestClient,
  requireDatabaseUrl,
  resetTestDatabase,
} from "./test-db.js";

// provider は deterministic に固定して配線だけを見る。意味的な類似度を持たないので、goldRank/hit@1 の値そのものは主張しない。
// 群ごとに it を分ける。7群を1つの it に詰めると、1つの testTimeout（30秒）を分け合って遅いランナーで落ちた。
describe("examples/chat: local-noise-arm 候補捕捉(擬似 provider・本物の Postgres)", () => {
  let handle: ExampleRuntimeHandle;

  beforeAll(async () => {
    await resetTestDatabase();
    await getTestClient();
    handle = await createExampleRuntime(requireDatabaseUrl(), {
      MNEMORA_LLM: "deterministic",
      MNEMORA_EMBEDDING: "deterministic",
    });
  });

  afterAll(async () => {
    await handle?.close();
  });

  it("擬似 provider で起動している", () => {
    expect(handle.llmMode).toBe("deterministic");
    expect(handle.embeddingMode).toBe("deterministic");
  });

  it.each(LOCAL_NOISE_GROUPS.map((group) => [group.key, group] as const))(
    "%s 群で、クラッシュせずに候補集合を捕まえ、σ=0 が素朴な順位計算と一致する",
    async (_key, group) => {
      const ctx = { tenantId: `local-noise-wiring-${group.key}-${Date.now()}` };
      const captured = await captureGroupCandidates(handle.runtime, handle.memoryStore, ctx, group);

      expect(captured.probes).toHaveLength(group.probeSet.probes.length);
      expect(captured.totalFailed).toBe(0);
      expect(captured.totalProcessed).toBe(captured.observationCount);

      for (const probe of captured.probes) {
        expect(probe.goldExternalId).toBe(group.probeSet.goldExternalId(probe.probeId));
        expect(probe.distractorExternalId).toBe(group.probeSet.distractorExternalId(probe.probeId));
        expect(probe.candidates.length).toBeGreaterThan(0);
      }

      const metrics = computeNoisyGroupMetrics(captured.probes, 0, 1);
      expect(metrics.probeCount).toBe(group.probeSet.probes.length);
      let expectedHit1 = 0;
      let expectedHit10 = 0;
      let expectedReciprocalSum = 0;
      for (const probe of captured.probes) {
        const goldIndex = probe.candidates.findIndex((c) => c.externalId === probe.goldExternalId);
        const goldRank = goldIndex === -1 ? null : goldIndex + 1;
        if (goldRank === 1) expectedHit1 += 1;
        if (goldRank !== null) {
          expectedHit10 += 1;
          expectedReciprocalSum += 1 / goldRank;
        }
      }
      expect(metrics.hit1Count).toBe(expectedHit1);
      expect(metrics.hit10Count).toBe(expectedHit10);
      expect(metrics.mrrOverall).toBeCloseTo(expectedReciprocalSum / captured.probes.length, 10);
    },
  );
});

afterAll(async () => {
  await closeTestClient();
});

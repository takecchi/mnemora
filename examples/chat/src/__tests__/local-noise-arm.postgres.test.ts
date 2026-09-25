import { afterAll, describe, expect, it } from "vitest";
import { LOCAL_NOISE_GROUPS, captureGroupCandidates } from "../local-noise-arm.js";
import { computeNoisyGroupMetrics } from "../synthetic-score-noise.js";
import { createExampleRuntime } from "../runtime-factory.js";
import {
  closeTestClient,
  getTestClient,
  requireDatabaseUrl,
  resetTestDatabase,
} from "./test-db.js";

/**
 * Issue #109 の残債（`docs/decisions/` 新設 ADR）——`local-noise-arm.ts` の配線を、
 * 本物の Postgres + pgvector に対して実際に1回走らせる
 * （`identifier-arm.postgres.test.ts` と同じ構え）。
 *
 * **provider は擬似(`deterministic`)に固定する。**この歯はネットワーク・モデル重み
 * 取得に依存しない「配線の正しさ」だけを見る——`@mnemora/local-embedding` を使った
 * **実際の想起の質**・合成ノイズの偽陽性率の実測は、
 * `src/scripts/local-embedding-synthetic-noise-fp.ts` を手で実行して測る
 * (`identifier-probes` サブコマンドと同じ区別)。
 *
 * `DeterministicEmbeddingProvider` は意味的な類似度を持たないため、ここでの
 * goldRank/hit@1 の値そのものには意味が無い(AGENTS.md「`deterministic` で測った
 * 想起の質は、性能について何も言っていない」)。見るのは**壊れずに捕捉できること**と
 * **`computeNoisyGroupMetrics(candidates, 0, seed)` が「ノイズ無し」の実際の順位と
 * 一致すること**である。
 */
describe("examples/chat: local-noise-arm 候補捕捉(擬似 provider・本物の Postgres)", () => {
  it("7群すべてで、クラッシュせずに候補集合を捕まえ、σ=0 が素朴な順位計算と一致する", async () => {
    await resetTestDatabase();
    await getTestClient();
    const handle = await createExampleRuntime(requireDatabaseUrl(), {
      MNEMORA_LLM: "deterministic",
      MNEMORA_EMBEDDING: "deterministic",
    });
    try {
      expect(handle.llmMode).toBe("deterministic");
      expect(handle.embeddingMode).toBe("deterministic");

      for (const group of LOCAL_NOISE_GROUPS) {
        const ctx = { tenantId: `local-noise-wiring-${group.key}-${Date.now()}` };
        const captured = await captureGroupCandidates(
          handle.runtime,
          handle.memoryStore,
          ctx,
          group,
        );

        expect(captured.probes).toHaveLength(group.probeSet.probes.length);
        expect(captured.totalFailed).toBe(0);
        expect(captured.totalProcessed).toBe(captured.observationCount);

        for (const probe of captured.probes) {
          // gold externalId は probe 集合の関数が決めた通りであること。
          expect(probe.goldExternalId).toBe(group.probeSet.goldExternalId(probe.probeId));
          expect(probe.distractorExternalId).toBe(
            group.probeSet.distractorExternalId(probe.probeId),
          );
          // 候補は空ではない(recall() が何かしら返している)。
          expect(probe.candidates.length).toBeGreaterThan(0);
        }

        // σ=0: 素朴に「捕まえた候補の並びそのまま」から goldRank を計算した値と一致する。
        const metrics = computeNoisyGroupMetrics(captured.probes, 0, 1);
        expect(metrics.probeCount).toBe(group.probeSet.probes.length);
        let expectedHit1 = 0;
        let expectedHit10 = 0;
        let expectedReciprocalSum = 0;
        for (const probe of captured.probes) {
          const goldIndex = probe.candidates.findIndex(
            (c) => c.externalId === probe.goldExternalId,
          );
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
      }
    } finally {
      await handle.close();
    }
  });
});

afterAll(async () => {
  await closeTestClient();
});

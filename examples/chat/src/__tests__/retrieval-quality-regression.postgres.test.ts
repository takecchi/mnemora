import { afterAll, describe, expect, it } from "vitest";
import { fixedClock } from "@mnemora/core";
import { cassettePathFor, loadCassette } from "../cassette-io.js";
import { PROBES } from "../probe-set.js";
import { runRetrievalQualityArm } from "../retrieval-quality.js";
import { createExampleRuntime } from "../runtime-factory.js";
import { closeTestClient, requireDatabaseUrl, resetTestDatabase } from "./test-db.js";

// 集計値（MRR・hit@1）には閾値を置かない。n=7 では順位1つで分数が動き、退行と標本の薄さを区別できない（ADR 0088・0033）。
// goldRank の実測順位は焼き込まず「候補に入っているか」だけを固定する。正当な reranking で赤くならないように（ADR 0201）。
// provider は deterministic にしない。意味的品質を測るため recorded にする（ADR 0088・0224）。
// fixedClock は実行時点より未来にしてある。ADR 0355 より前は available_at が DB の実時刻だったため、過去だと embed が claim されず、全 probe が静かに goldRank=null になった。
describe(
  "examples/chat: retrieval の固定回帰ケース(recorded provider・固定時計・本物の Postgres。" +
    "Issue #497、ADR 0227)",
  () => {
    it("PROBES の全7件で、gold が recall() の既定候補(limit=10)に入っている", async () => {
      await resetTestDatabase();

      const cassette = loadCassette(cassettePathFor("retrieval"));

      const clock = fixedClock(new Date("2030-01-01T00:00:00.000Z"));

      const handle = await createExampleRuntime(
        requireDatabaseUrl(),
        // OPENAI_API_KEY の有無を見ない。recorded を明示するので、環境に鍵が在っても実 API へ倒れない。
        { MNEMORA_LLM: "recorded", MNEMORA_EMBEDDING: "recorded" },
        { cassette },
        clock,
      );
      try {
        expect(handle.llmMode).toBe("recorded");
        expect(handle.embeddingMode).toBe("recorded");

        const report = await runRetrievalQualityArm({
          armLabel: "fixed-regression",
          tenantId: `retrieval-quality-regression-${Date.now()}`,
          runtime: handle.runtime,
          memoryStore: handle.memoryStore,
          llmMode: handle.llmMode,
          embeddingMode: handle.embeddingMode,
        });

        expect(report.probes).toHaveLength(PROBES.length);

        for (const probe of report.probes) {
          expect(
            probe.goldRank,
            `probe "${probe.probeId}" の gold が recall() の既定候補(limit=10)から落ちた` +
              `(goldRank=${probe.goldRank})。必要な記憶または情報が失われた可能性がある` +
              "——recall() のフィルタ・probe-set.ts の gold の内容・ingest の経路を確認すること。",
          ).not.toBeNull();
        }
      } finally {
        await handle.close();
      }
    });
  },
);

afterAll(async () => {
  await closeTestClient();
});

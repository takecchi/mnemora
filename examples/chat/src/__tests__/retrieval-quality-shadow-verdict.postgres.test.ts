import { afterAll, describe, expect, it } from "vitest";
import { fixedClock } from "@mnemora/core";
import { cassettePathFor, loadCassette } from "../cassette-io.js";
import { PROBES } from "../probe-set.js";
import { armHeadline, runRetrievalQualityArm } from "../retrieval-quality.js";
import {
  decideRetrievalQualityShadowVerdict,
  SHADOW_HIT1_MIN,
  SHADOW_MRR_THRESHOLD,
} from "../retrieval-quality-shadow-verdict.js";
import { createExampleRuntime } from "../runtime-factory.js";
import { closeTestClient, requireDatabaseUrl, resetTestDatabase } from "./test-db.js";

// 門にしない。verdict.pass を assert しない（Issue #572 段1 の境界）。
// DB のセットアップは regression.postgres.test.ts と意図的に重複させる。共有ヘルパーへ切り出すと既存ファイルの import を書き換えることになる。
describe(
  "examples/chat: retrieval の MRR/hit@1 影分身判定(門ではない・記録のみ。" +
    "Issue #572 段1、ADR 0276)",
  () => {
    it("MRR/hit@1 を測り、影分身判定の結果を記録する(⛔ 落とさない)", async () => {
      await resetTestDatabase();

      const cassette = loadCassette(cassettePathFor("retrieval"));

      // 固定時刻は未来にする。過去だと embed ジョブが claim されず全 probe が静かに goldRank=null になる（ADR 0227）。
      const clock = fixedClock(new Date("2030-01-01T00:00:00.000Z"));

      const handle = await createExampleRuntime(
        requireDatabaseUrl(),
        { MNEMORA_LLM: "recorded", MNEMORA_EMBEDDING: "recorded" },
        { cassette },
        clock,
      );
      try {
        expect(handle.llmMode).toBe("recorded");
        expect(handle.embeddingMode).toBe("recorded");

        const report = await runRetrievalQualityArm({
          armLabel: "shadow-verdict",
          tenantId: `retrieval-quality-shadow-verdict-${Date.now()}`,
          runtime: handle.runtime,
          memoryStore: handle.memoryStore,
          llmMode: handle.llmMode,
          embeddingMode: handle.embeddingMode,
        });

        expect(report.probes).toHaveLength(PROBES.length);

        const headline = armHeadline(report);
        const verdict = decideRetrievalQualityShadowVerdict({
          mrrOverall: headline.mrrOverall,
          hit1Count: headline.hit1Count,
          probeCount: headline.probeCount,
        });

        console.log(
          `[retrieval-quality shadow verdict / Issue #572 段1] ` +
            `MRR=${headline.mrrOverall} (閾値>=${SHADOW_MRR_THRESHOLD}) ` +
            `hit@1=${headline.hit1Count}/${headline.probeCount} (最低${SHADOW_HIT1_MIN}) ` +
            `=> pass=${verdict.pass}` +
            (verdict.reasons.length > 0 ? ` reasons=[${verdict.reasons.join("; ")}]` : ""),
        );

        expect(typeof verdict.pass).toBe("boolean");
        expect(Array.isArray(verdict.reasons)).toBe(true);
      } finally {
        await handle.close();
      }
    });
  },
);

afterAll(async () => {
  await closeTestClient();
});

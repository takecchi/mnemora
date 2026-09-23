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

/**
 * `retrieval-quality-regression.postgres.test.ts`(ADR 0227)と*並走*させる、
 * MRR / hit@1 の閾値判定(Issue #572「段1」、ADR 0275)。
 *
 * 🔴 **これは門ではない。⛔ `retrieval-quality-regression.postgres.test.ts` は
 * 1バイトも変えていない**——こちらは新しい別ファイルであり、既存の歯の assert・
 * 閾値・入力には一切触れていない。
 *
 * **やっているのは記録だけ**: 同じ `recorded` provider・同じ固定時計・同じ
 * `probe-set.ts` の `PROBES`(1件も足さない・変えない)で `runRetrievalQualityArm`
 * を1回走らせ、`decideRetrievalQualityShadowVerdict()`(純関数、
 * `../retrieval-quality-shadow-verdict.ts`)にかけた結果を標準出力へ印字する。
 * **`verdict.pass` が `false` でも、この it は落ちない**——閾値を下回っても
 * `example-chat` ジョブを赤くしないことが、Issue #572 段1 の境界である。
 *
 * ⚠ **DB のセットアップ(`resetTestDatabase`/`createExampleRuntime`/`fixedClock`)は、
 * 既存の `retrieval-quality-regression.postgres.test.ts` と意図的に重複している。**
 * 既存ファイルを1バイトも変えない制約の下で「並走」を作るには、同じ配線を
 * 別ファイルに複製するほかない——共有ヘルパーへ切り出すと、既存ファイル側の
 * import 文を書き換える必要が生じ、制約に抵触する。
 */
describe(
  "examples/chat: retrieval の MRR/hit@1 影分身判定(門ではない・記録のみ。" +
    "Issue #572 段1、ADR 0275)",
  () => {
    it("MRR/hit@1 を測り、影分身判定の結果を記録する(⛔ 落とさない)", async () => {
      await resetTestDatabase();

      const cassette = loadCassette(cassettePathFor("retrieval"));

      // 既存の retrieval-quality-regression.postgres.test.ts と同じ理由・同じ値
      // (実行時点より確実に未来。過去日付にすると embed ジョブが一生 claim されず
      // 全 probe が静かに goldRank=null になる。ADR 0227 のファイル doc 参照)。
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

        // ⛔ probe 件数(7)を焼き込まない——PROBES.length から取る(タスクの境界)。
        expect(report.probes).toHaveLength(PROBES.length);

        const headline = armHeadline(report);
        const verdict = decideRetrievalQualityShadowVerdict({
          mrrOverall: headline.mrrOverall,
          hit1Count: headline.hit1Count,
          probeCount: headline.probeCount,
        });

        // **記録するだけ。判定しない。**`verdict.pass` を assert しない——
        // それをやった瞬間、この歯は「並走」ではなく「門」になる(Issue #572 段1 の境界)。
        console.log(
          `[retrieval-quality shadow verdict / Issue #572 段1] ` +
            `MRR=${headline.mrrOverall} (閾値>=${SHADOW_MRR_THRESHOLD}) ` +
            `hit@1=${headline.hit1Count}/${headline.probeCount} (最低${SHADOW_HIT1_MIN}) ` +
            `=> pass=${verdict.pass}` +
            (verdict.reasons.length > 0 ? ` reasons=[${verdict.reasons.join("; ")}]` : ""),
        );

        // 構造上の健全性だけを確認する(壊れて例外になっていないこと)。
        // ⛔ これは合否の門ではない——上のコメントを参照。
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

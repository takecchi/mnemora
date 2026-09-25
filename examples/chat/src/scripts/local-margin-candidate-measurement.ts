import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { clopperPearsonUpperBound } from "../openai-arm-verdict.js";
import type { ProxyGroupMetrics } from "../openai-arm-verdict.js";
import { LOCAL_NOISE_GROUPS, captureGroupCandidates } from "../local-noise-arm.js";
import {
  SEEDS,
  SIGMA_GRID,
  computeNoisyGroupMetrics,
  decideNoiseRoundRed,
} from "../synthetic-score-noise.js";
import { noisyMarginsForGroup } from "../local-noise-margin.js";
import {
  DEFAULT_MARGIN_DROP_OPTIONS,
  decideMarginDropVerdict,
} from "../verdict-candidate-margin.js";
import { createExampleRuntime } from "../runtime-factory.js";
import { warmupLocalEmbedding } from "../local-embedding-warmup.js";
import { tryGitRevParseHead } from "../git-info.js";

/**
 * Issue #109 残件「A」——マネージャーからの実測依頼: ADR 0322 と同じ `local` 埋め込み・
 * 合成ノイズの反実仮想データに、**候補案1（margin基準、`../verdict-candidate-margin.ts`）**
 * を当て、既存の判定（案0、`decideNoiseRoundRed` = ADR 0316 の `decideEmbeddingDriftVerdict`
 * を呼ぶだけ、変更していない）と比べる。
 *
 * ⛔ **`local-noise-arm.ts`/`synthetic-score-noise.ts`/`openai-arm-verdict.ts` には
 * 1文字も触れていない。**このスクリプトは新しいファイルであり、既存の
 * `captureGroupCandidates`/`computeNoisyGroupMetrics`/`decideNoiseRoundRed` を
 * 呼ぶだけである。
 *
 * ⛔ 実 API は一切叩かない（`OPENAI_API_KEY` は読まない）。`local` 埋め込みは決定的
 * （ADR 0094 が2 run のビット一致で確認済み）なので、この反実仮想は「もし揺れが
 * あったら」という仮定の下での比較であって、実際の偽陽性率ではない
 * （`synthetic-score-noise.ts` の doc コメントと同じ限定）。
 *
 * ## 使い方
 *
 * ```
 * DATABASE_URL=postgresql://worker@127.0.0.1:<port>/mnemora_test \
 *   tsx examples/chat/src/scripts/local-margin-candidate-measurement.ts
 * ```
 */

const here = dirname(fileURLToPath(import.meta.url));
const CHAT_ROOT = join(here, "..", "..");
const OUTPUT_PATH = join(CHAT_ROOT, "local-margin-candidate-measurement.json");

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} が環境に無い。使い方はこのスクリプトの doc コメントを見ること。`);
  }
  return value;
}

interface SigmaOutcome {
  sigma: number;
  candidate0RedCount: number;
  candidate1RedCount: number;
  seedCount: number;
}

interface GroupOutcome {
  group: string;
  probeCount: number;
  baseline: ProxyGroupMetrics;
  sigmaLevels: SigmaOutcome[];
  candidate0FullGridRedCount: number;
  candidate1FullGridRedCount: number;
  fullGridTrials: number;
  candidate0FullGridUpperBound95: number;
  candidate1FullGridUpperBound95: number;
}

const POSITIVE_CONTROL_SIGMA = 5.0;

async function main(): Promise<void> {
  const databaseUrl = requireEnv("DATABASE_URL");
  const measuredAt = new Date();
  const commit = tryGitRevParseHead(process.cwd());

  const handle = await createExampleRuntime(databaseUrl, {
    ...process.env,
    MNEMORA_LLM: "deterministic",
    MNEMORA_EMBEDDING: "local",
  });

  const outcomes: GroupOutcome[] = [];
  const positiveControl: {
    group: string;
    candidate0RedCount: number;
    candidate1RedCount: number;
    seedCount: number;
  }[] = [];

  try {
    console.log("[local-margin-candidate] warmup() でモデルの読み込みを先に済ませる…");
    const warmup = await warmupLocalEmbedding(handle.embeddingProvider);
    if (!warmup.ok) {
      console.error(`🔴 ${warmup.detail}`);
      process.exitCode = 1;
      return;
    }
    console.log(`  ${warmup.detail}`);

    const space = handle.embeddingProvider.space;
    console.log(
      `[local-margin-candidate] embedding space: provider=${space.provider} ` +
        `model=${space.model} dimensions=${space.dimensions}`,
    );

    for (const group of LOCAL_NOISE_GROUPS) {
      console.log(`\n=== 群: ${group.key}(haystack=${group.haystackKind}) を捕捉中… ===`);
      const ctx = { tenantId: `local-margin-candidate-${group.key}-${Date.now()}` };
      const captured = await captureGroupCandidates(handle.runtime, handle.memoryStore, ctx, group);
      console.log(
        `  ingest: observations=${captured.observationCount} ticks=${captured.ticks} ` +
          `totalProcessed=${captured.totalProcessed} totalFailed=${captured.totalFailed}`,
      );

      const baselineMetrics = computeNoisyGroupMetrics(captured.probes, 0, 1);
      const baseline: ProxyGroupMetrics = {
        group: group.key,
        mrrOverall: baselineMetrics.mrrOverall,
        hit1Count: baselineMetrics.hit1Count,
        hit10Count: baselineMetrics.hit10Count,
        probeCount: baselineMetrics.probeCount,
      };
      const baselineMargins = noisyMarginsForGroup(captured.probes, 0, 1);
      console.log(
        `  baseline(σ=0): MRR=${baseline.mrrOverall.toFixed(4)} ` +
          `hit@1=${baseline.hit1Count}/${baseline.probeCount} ` +
          `margin比較可能=${baselineMargins.filter((m) => m !== null).length}/${baselineMargins.length}`,
      );

      const sigmaLevels: SigmaOutcome[] = [];
      for (const sigma of SIGMA_GRID) {
        let candidate0RedCount = 0;
        let candidate1RedCount = 0;
        for (const seed of SEEDS) {
          const m = computeNoisyGroupMetrics(captured.probes, sigma, seed);
          if (decideNoiseRoundRed(group.key, m, baselineMetrics)) {
            candidate0RedCount += 1;
          }
          const measuredMargins = noisyMarginsForGroup(captured.probes, sigma, seed);
          const marginVerdict = decideMarginDropVerdict(measuredMargins, baselineMargins);
          if (marginVerdict.red) {
            candidate1RedCount += 1;
          }
        }
        sigmaLevels.push({
          sigma,
          candidate0RedCount,
          candidate1RedCount,
          seedCount: SEEDS.length,
        });
        console.log(
          `  σ=${sigma}: 案0 red=${candidate0RedCount}/${SEEDS.length}  ` +
            `案1(margin) red=${candidate1RedCount}/${SEEDS.length}`,
        );
      }

      const candidate0FullGridRedCount = sigmaLevels.reduce((s, l) => s + l.candidate0RedCount, 0);
      const candidate1FullGridRedCount = sigmaLevels.reduce((s, l) => s + l.candidate1RedCount, 0);
      const fullGridTrials = sigmaLevels.reduce((s, l) => s + l.seedCount, 0);

      outcomes.push({
        group: group.key,
        probeCount: baseline.probeCount,
        baseline,
        sigmaLevels,
        candidate0FullGridRedCount,
        candidate1FullGridRedCount,
        fullGridTrials,
        candidate0FullGridUpperBound95: clopperPearsonUpperBound(
          candidate0FullGridRedCount,
          fullGridTrials,
        ),
        candidate1FullGridUpperBound95: clopperPearsonUpperBound(
          candidate1FullGridRedCount,
          fullGridTrials,
        ),
      });

      // --- 陽性対照: SIGMA_GRID には無い、極端に大きい σ で両案とも red を捕まえられるか ---
      let pcCandidate0Red = 0;
      let pcCandidate1Red = 0;
      for (const seed of SEEDS) {
        const m = computeNoisyGroupMetrics(captured.probes, POSITIVE_CONTROL_SIGMA, seed);
        if (decideNoiseRoundRed(group.key, m, baselineMetrics)) {
          pcCandidate0Red += 1;
        }
        const measuredMargins = noisyMarginsForGroup(captured.probes, POSITIVE_CONTROL_SIGMA, seed);
        const marginVerdict = decideMarginDropVerdict(measuredMargins, baselineMargins);
        if (marginVerdict.red) {
          pcCandidate1Red += 1;
        }
      }
      positiveControl.push({
        group: group.key,
        candidate0RedCount: pcCandidate0Red,
        candidate1RedCount: pcCandidate1Red,
        seedCount: SEEDS.length,
      });
      console.log(
        `  陽性対照(σ=${POSITIVE_CONTROL_SIGMA}): 案0 red=${pcCandidate0Red}/${SEEDS.length} ` +
          `案1(margin) red=${pcCandidate1Red}/${SEEDS.length}`,
      );
    }

    const anyPositiveControlRed = positiveControl.some(
      (r) => r.candidate0RedCount > 0 || r.candidate1RedCount > 0,
    );
    if (!anyPositiveControlRed) {
      console.error(
        "🔴 陽性対照が両案とも1件も red にならなかった——探り棒が死んでいる疑いがある。" +
          "この測定結果を信用しないこと。",
      );
      process.exitCode = 1;
    }
    const marginPositiveControlMissed = positiveControl.filter(
      (r) => r.candidate0RedCount > 0 && r.candidate1RedCount === 0,
    );
    if (marginPositiveControlMissed.length > 0) {
      console.error(
        `🔴 案1(margin基準)が、案0が red にした極端な劣化(σ=${POSITIVE_CONTROL_SIGMA})を` +
          `見逃した群がある: ${marginPositiveControlMissed.map((r) => r.group).join(", ")}` +
          "——感度が案0より低い(結果メモに残すこと)。",
      );
    }

    const json = {
      _readme:
        "Issue #109 残件「A」——マネージャーからの実測依頼。ADR 0322 と同じ local 埋め込み・" +
        "合成ノイズの反実仮想データに、候補案1(margin基準)を当て、案0(ADR 0316の判定、" +
        "変更していない)と比べる。🔴🔴 これは実際の偽陽性率ではない(local の揺れは" +
        "観測されていない)——反実仮想の比較専用。",
      schemaVersion: 1,
      provenance: {
        commit,
        measuredAt: measuredAt.toISOString(),
        embeddingSpace: handle.embeddingProvider.space,
        sigmaGrid: SIGMA_GRID,
        seedCount: SEEDS.length,
        marginDropOptions: DEFAULT_MARGIN_DROP_OPTIONS,
        positiveControlSigma: POSITIVE_CONTROL_SIGMA,
      },
      groups: outcomes,
      positiveControl,
    };
    writeFileSync(OUTPUT_PATH, `${JSON.stringify(json, null, 2)}\n`, "utf-8");
    console.log(`\n[local-margin-candidate] 機械可読な結果を書き出した: ${OUTPUT_PATH}`);
  } finally {
    await handle.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { clopperPearsonUpperBound } from "../openai-arm-verdict.js";
import type { ProxyGroupMetrics } from "../openai-arm-verdict.js";
import { LOCAL_NOISE_GROUPS, captureGroupCandidates } from "../local-noise-arm.js";
import {
  DEFAULT_MRR_DROP_THRESHOLD,
  SEEDS,
  SIGMA_GRID,
  aggregateFalsePositiveBand,
  computeNoisyGroupMetrics,
  decideNoiseRoundRed,
  summarizeSigmaLevels,
} from "../synthetic-score-noise.js";
import { createExampleRuntime } from "../runtime-factory.js";
import { warmupLocalEmbedding } from "../local-embedding-warmup.js";
import { tryGitRevParseHead } from "../git-info.js";

/**
 * 手で回す再計測。CI からは呼ばない。ここで出る数は実際の偽陽性率ではない: `local` の揺れは一度も観測されておらず、
 * 「スコアに σ の合成ノイズが入ったとしたら」という反実仮想の上限である。
 */

const here = dirname(fileURLToPath(import.meta.url));
const CHAT_ROOT = join(here, "..", "..");
const OUTPUT_PATH = join(CHAT_ROOT, "local-embedding-synthetic-noise-fp-measurement.json");

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} が環境に無い（必須。既定値は無い）。`);
  }
  return value;
}

interface GroupOutcome {
  group: string;
  probeCount: number;
  baseline: ProxyGroupMetrics;
  sigmaLevels: ReturnType<typeof summarizeSigmaLevels>;
  band: ReturnType<typeof aggregateFalsePositiveBand>;
  /** `band.trials === 0` のときは `null`（Clopper–Pearson は分母0では定義できない）。道具の欠陥ではなく実測結果で、この場合は帯方式では上限を置けない。 */
  bandUpperBound95: number | null;
  fullGridRedCount: number;
  fullGridTrials: number;
  fullGridUpperBound95: number;
}

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
  const capturedByGroup = new Map<string, Awaited<ReturnType<typeof captureGroupCandidates>>>();
  try {
    console.log(
      "[local-noise-fp] warmup() でモデルの読み込みを先に済ませる" +
        "(取得に失敗したら、ここでメトリクスを出さずに打ち切る)…",
    );
    const warmup = await warmupLocalEmbedding(handle.embeddingProvider);
    if (!warmup.ok) {
      console.error(`🔴 ${warmup.detail}`);
      console.error(
        "  メトリクスは1件も測っていない。ネットワーク・HF repo の状態を確認すること。",
      );
      process.exitCode = 1;
      return;
    }
    console.log(`  ${warmup.detail}`);

    const space = handle.embeddingProvider.space;
    console.log(
      `[local-noise-fp] embedding space: provider=${space.provider} model=${space.model} ` +
        `dimensions=${space.dimensions}`,
    );

    for (const group of LOCAL_NOISE_GROUPS) {
      console.log(`\n=== 群: ${group.key}(haystack=${group.haystackKind}) を捕捉中… ===`);
      const ctx = { tenantId: `local-noise-fp-${group.key}-${Date.now()}` };
      const captured = await captureGroupCandidates(handle.runtime, handle.memoryStore, ctx, group);
      capturedByGroup.set(group.key, captured);
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
      console.log(
        `  baseline(σ=0): MRR=${baseline.mrrOverall.toFixed(4)} ` +
          `hit@1=${baseline.hit1Count}/${baseline.probeCount}`,
      );

      const redFlagsPerSigma: boolean[][] = [];
      const mrrPerSigma: number[][] = [];
      for (const sigma of SIGMA_GRID) {
        const redFlags: boolean[] = [];
        const mrrValues: number[] = [];
        for (const seed of SEEDS) {
          const m = computeNoisyGroupMetrics(captured.probes, sigma, seed);
          redFlags.push(decideNoiseRoundRed(group.key, m, baselineMetrics));
          mrrValues.push(m.mrrOverall);
        }
        redFlagsPerSigma.push(redFlags);
        mrrPerSigma.push(mrrValues);
      }

      const sigmaLevels = summarizeSigmaLevels(
        SIGMA_GRID,
        redFlagsPerSigma,
        mrrPerSigma,
        baseline.mrrOverall,
      );
      for (const level of sigmaLevels) {
        console.log(
          `  σ=${level.sigma}: red=${level.redCount}/${level.seedCount} ` +
            `MRR[min/med/max]=${level.mrrMin.toFixed(4)}/${level.mrrMedian.toFixed(4)}/` +
            `${level.mrrMax.toFixed(4)} 帯=${level.medianPreservesBaseline ? "内" : "外"}`,
        );
      }

      const band = aggregateFalsePositiveBand(sigmaLevels);
      const bandUpperBound95 =
        band.trials > 0 ? clopperPearsonUpperBound(band.redCount, band.trials) : null;
      const fullGridRedCount = sigmaLevels.reduce((s, l) => s + l.redCount, 0);
      const fullGridTrials = sigmaLevels.reduce((s, l) => s + l.seedCount, 0);
      const fullGridUpperBound95 = clopperPearsonUpperBound(fullGridRedCount, fullGridTrials);

      if (band.trials > 0) {
        console.log(
          `  帯(median-preserved, σ∈{${band.bandSigmas.join(",")}}): ` +
            `red=${band.redCount}/${band.trials} 上限95%=${(bandUpperBound95! * 100).toFixed(2)}%`,
        );
      } else {
        console.log(
          "  帯(median-preserved): 該当する σ が無い(格子最小の σ=0.0025 で既に中央値が動いた)" +
            "——帯方式では上限を置けない。",
        );
      }
      console.log(
        `  参考(全11段合算・帯を無視): red=${fullGridRedCount}/${fullGridTrials} ` +
          `上限95%=${(fullGridUpperBound95 * 100).toFixed(2)}%`,
      );

      outcomes.push({
        group: group.key,
        probeCount: baseline.probeCount,
        baseline,
        sigmaLevels,
        band,
        bandUpperBound95,
        fullGridRedCount,
        fullGridTrials,
        fullGridUpperBound95,
      });
    }

    // 陽性対照: 格子内で red が出なかったことを「揺れが無い」の証明にしない。探り棒自体が生きているかを、極端に大きい σ で先に確かめる。
    console.log("\n=== 陽性対照(σ=5.0、SIGMA_GRID には含めない別の確認) ===");
    const POSITIVE_CONTROL_SIGMA = 5.0;
    const positiveControlResults: { group: string; redCount: number; seedCount: number }[] = [];
    for (const outcome of outcomes) {
      const captured = capturedByGroup.get(outcome.group)!;
      let redCount = 0;
      for (const seed of SEEDS) {
        const m = computeNoisyGroupMetrics(captured.probes, POSITIVE_CONTROL_SIGMA, seed);
        if (decideNoiseRoundRed(outcome.group, m, outcome.baseline)) {
          redCount += 1;
        }
      }
      positiveControlResults.push({ group: outcome.group, redCount, seedCount: SEEDS.length });
      console.log(
        `  ${outcome.group}: σ=${POSITIVE_CONTROL_SIGMA} で red=${redCount}/${SEEDS.length}`,
      );
    }
    const anyPositiveControlRed = positiveControlResults.some((r) => r.redCount > 0);
    if (!anyPositiveControlRed) {
      console.error(
        "🔴 陽性対照が1件も red にならなかった——探り棒(判定・ノイズ注入経路)が" +
          "死んでいる疑いがある。この測定結果を信用しないこと。",
      );
      process.exitCode = 1;
    }

    const json = {
      _readme:
        "🔴🔴 これは実際の偽陽性率ではない。local 埋め込みの揺れは観測されていない" +
        "(ADR 0094 は2 run のビット一致)。ここにあるのは、スコアに合成ノイズが入ったと" +
        "したらという反実仮想の測定である。詳細は docs/decisions/ 新設 ADR と " +
        "../synthetic-score-noise.ts の doc コメントを見ること。",
      schemaVersion: 1,
      provenance: {
        commit,
        measuredAt: measuredAt.toISOString(),
        embeddingSpace: space,
        sigmaGrid: SIGMA_GRID,
        seedCount: SEEDS.length,
        mrrDropThreshold: DEFAULT_MRR_DROP_THRESHOLD,
      },
      groups: outcomes,
      positiveControl: {
        sigma: POSITIVE_CONTROL_SIGMA,
        note:
          "SIGMA_GRID(測定に使う11段)には含めない。探り棒(ノイズ注入→判定)が" +
          "生きていることの確認専用——赤が1件も出なければ測定全体を疑う。",
        results: positiveControlResults,
      },
    };
    writeFileSync(OUTPUT_PATH, `${JSON.stringify(json, null, 2)}\n`, "utf-8");
    console.log(`\n[local-noise-fp] 機械可読な結果を書き出した: ${OUTPUT_PATH}`);
  } finally {
    await handle.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

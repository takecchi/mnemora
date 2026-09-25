import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { LOCAL_NOISE_GROUPS, captureGroupCandidates } from "../local-noise-arm.js";
import type { LocalNoiseGroupKey } from "../local-noise-arm.js";
import { diffGroupCandidates } from "../local-noise-candidate-diff.js";
import type { GroupCandidateDiffSummary } from "../local-noise-candidate-diff.js";
import { compareGroupNoiseOutcomes } from "../local-noise-grid-comparison.js";
import type { GroupNoiseComparisonSummary } from "../local-noise-grid-comparison.js";
import { SEEDS, SIGMA_GRID } from "../synthetic-score-noise.js";
import { createExampleRuntime } from "../runtime-factory.js";
import { warmupLocalEmbedding } from "../local-embedding-warmup.js";
import { tryGitRevParseHead } from "../git-info.js";

/**
 * Issue #109（06:58Z のコメント、4番「残っているもの」）の残債——ADR 0322 が測った
 * `local` 埋め込みの sparse/dense 群が σ・seed の全組で完全に一致した理由は、
 * 次の仮説のみで確認していなかった:
 *
 * > ノイズは (seed, probe 番号, 候補の並び位置) だけで決まるので、dense で足した
 * > distractor が `recall()` の返す候補に入らなければ、結果は完全に一致する。
 * > 群どうしで候補を突き合わせてはいない。
 *
 * このスクリプトは、その突き合わせを**実際に**行う（手で回す再計測の手順。CI からは
 * 呼ばない——ADR 0322 の「決めたこと」5番と同じ判断: この段でも CI ジョブは足さない）。
 *
 * ## やること
 *
 * 3組（`identifiers`/`japaneseNames`/`numeral`）それぞれについて、sparse/dense 両方の
 * `captureGroupCandidates`（`local-noise-arm.ts`、`../local-embedding-synthetic-noise-fp.ts`
 * と同じ捕捉経路。`recall()` は1回だけ呼ぶ）を実際に呼び、
 * 1. `local-noise-candidate-diff.ts` の `diffGroupCandidates` で probe ごとに
 *    候補配列そのもの（入力）を突き合わせ、
 * 2. `local-noise-grid-comparison.ts` の `compareGroupNoiseOutcomes` で
 *    σ 格子 × seed 全通り（ADR 0322 と同じ 11×15=165 通り）の MRR・red 判定（出力）
 *    を突き合わせる。
 *
 * ⛔ 実 API は一切叩かない（`OPENAI_API_KEY` は読まない）。`MNEMORA_EMBEDDING=local`・
 * `MNEMORA_LLM=deterministic` 固定（ADR 0322 と同じ）。
 *
 * ## 使い方
 *
 * ```
 * DATABASE_URL=postgresql://worker@127.0.0.1:<port>/mnemora_test \
 *   tsx examples/chat/src/scripts/local-noise-arm-candidate-diff.ts
 * ```
 */

const here = dirname(fileURLToPath(import.meta.url));
const CHAT_ROOT = join(here, "..", "..");
const OUTPUT_PATH = join(CHAT_ROOT, "local-noise-arm-candidate-diff.json");

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} が環境に無い。使い方はこのスクリプトの doc コメントを見ること。`);
  }
  return value;
}

interface FamilySpec {
  /** `diffGroupCandidates` に渡す表示名。 */
  name: string;
  sparseKey: LocalNoiseGroupKey;
  denseKey: LocalNoiseGroupKey;
}

/**
 * ADR 0322 が「sparse/dense の結果が完全一致した」と報告した3組
 * （`identifiersSparse`/`Dense`、`japaneseNamesSparse`/`Dense`、
 * `numeralSparse`/`Dense`）。`japanese`（sparse/dense の区別が無い群）は対象外。
 */
const FAMILIES: readonly FamilySpec[] = [
  { name: "identifiers", sparseKey: "identifiersSparse", denseKey: "identifiersDense" },
  { name: "japaneseNames", sparseKey: "japaneseNamesSparse", denseKey: "japaneseNamesDense" },
  { name: "numeral", sparseKey: "numeralSparse", denseKey: "numeralDense" },
];

function findGroup(key: LocalNoiseGroupKey) {
  const group = LOCAL_NOISE_GROUPS.find((g) => g.key === key);
  if (!group) {
    throw new Error(`local-noise-arm-candidate-diff: LOCAL_NOISE_GROUPS に ${key} が無い`);
  }
  return group;
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

  const familyResults: {
    family: string;
    sparseGroup: LocalNoiseGroupKey;
    denseGroup: LocalNoiseGroupKey;
    candidateDiff: GroupCandidateDiffSummary;
    noiseGridComparison: GroupNoiseComparisonSummary;
  }[] = [];

  try {
    console.log(
      "[local-noise-candidate-diff] warmup() でモデルの読み込みを先に済ませる" +
        "(取得に失敗したら、ここで突き合わせを1件も出さずに打ち切る)…",
    );
    const warmup = await warmupLocalEmbedding(handle.embeddingProvider);
    if (!warmup.ok) {
      console.error(`🔴 ${warmup.detail}`);
      process.exitCode = 1;
      return;
    }
    console.log(`  ${warmup.detail}`);

    const space = handle.embeddingProvider.space;
    console.log(
      `[local-noise-candidate-diff] embedding space: provider=${space.provider} ` +
        `model=${space.model} dimensions=${space.dimensions}`,
    );

    for (const family of FAMILIES) {
      console.log(`\n=== 組: ${family.name}(${family.sparseKey} vs ${family.denseKey}) ===`);

      const sparseGroup = findGroup(family.sparseKey);
      const denseGroup = findGroup(family.denseKey);

      const sparseCtx = { tenantId: `local-noise-diff-${family.sparseKey}-${Date.now()}` };
      const sparseCaptured = await captureGroupCandidates(
        handle.runtime,
        handle.memoryStore,
        sparseCtx,
        sparseGroup,
      );
      console.log(
        `  ${family.sparseKey}: observations=${sparseCaptured.observationCount} ` +
          `ticks=${sparseCaptured.ticks} totalFailed=${sparseCaptured.totalFailed}`,
      );

      const denseCtx = { tenantId: `local-noise-diff-${family.denseKey}-${Date.now()}` };
      const denseCaptured = await captureGroupCandidates(
        handle.runtime,
        handle.memoryStore,
        denseCtx,
        denseGroup,
      );
      console.log(
        `  ${family.denseKey}: observations=${denseCaptured.observationCount} ` +
          `ticks=${denseCaptured.ticks} totalFailed=${denseCaptured.totalFailed}`,
      );

      const summary = diffGroupCandidates(family.name, sparseCaptured.probes, denseCaptured.probes);

      console.log(
        `  突き合わせ: identical=${summary.identicalProbeCount}/${summary.probeCount}` +
          (summary.probesWithDenseOnlyAboveGoldOrDistractor.length > 0
            ? ` ⚠ dense固有候補がgold/distractorより上位に来たprobe: ` +
              `${summary.probesWithDenseOnlyAboveGoldOrDistractor.join(", ")}`
            : ""),
      );

      for (const diff of summary.diffs) {
        if (!diff.identical) {
          console.log(
            `    probe=${diff.probeId}: identical=false matchingPrefix=${diff.matchingPrefixLength} ` +
              `sparseCount=${diff.sparseCandidateCount} denseCount=${diff.denseCandidateCount} ` +
              `denseOnlyIds=[${diff.denseOnlyIds.join(",")}] sparseOnlyIds=[${diff.sparseOnlyIds.join(",")}] ` +
              `denseOnlyAboveGoldOrDistractor=${diff.denseOnlyRankedAboveGoldOrDistractor} ` +
              `goldRank(sparse/dense)=${diff.goldRankSparse}/${diff.goldRankDense} ` +
              `distractorRank(sparse/dense)=${diff.distractorRankSparse}/${diff.distractorRankDense}`,
          );
        }
      }

      const gridComparison = compareGroupNoiseOutcomes(
        family.name,
        sparseCaptured.probes,
        denseCaptured.probes,
        SIGMA_GRID,
        SEEDS,
      );
      console.log(
        `  σ×seed全${gridComparison.totalRounds}通り: MRR完全一致=${gridComparison.mrrExactMatchCount}/` +
          `${gridComparison.totalRounds} red判定一致=${gridComparison.redMatchCount}/` +
          `${gridComparison.totalRounds}`,
      );
      for (const mismatch of gridComparison.mismatches.slice(0, 10)) {
        console.log(
          `    ⚠ mismatch sigma=${mismatch.sigma} seed=${mismatch.seed} ` +
            `sparseMrr=${mismatch.sparseMrr} denseMrr=${mismatch.denseMrr} ` +
            `mrrExactMatch=${mismatch.mrrExactMatch} sparseRed=${mismatch.sparseRed} ` +
            `denseRed=${mismatch.denseRed} redMatch=${mismatch.redMatch}`,
        );
      }
      if (gridComparison.mismatches.length > 10) {
        console.log(`    …ほか ${gridComparison.mismatches.length - 10} 件の mismatch（JSON参照）`);
      }

      familyResults.push({
        family: family.name,
        sparseGroup: family.sparseKey,
        denseGroup: family.denseKey,
        candidateDiff: summary,
        noiseGridComparison: gridComparison,
      });
    }

    const json = {
      _readme:
        "Issue #109(06:58Zのコメント4番)の仮説の突き合わせ——ADR 0322 の sparse/dense 群が" +
        "σ・seedの全組で完全一致した理由が、実際に「dense固有の候補がrecall()の上位に" +
        "入らないから」で説明できるかを、probeごとの候補配列の突き合わせで確認する。" +
        "詳細は docs/decisions/0322-*.md の追記節と ../local-noise-candidate-diff.ts の" +
        "doc コメントを見ること。",
      schemaVersion: 1,
      provenance: {
        commit,
        measuredAt: measuredAt.toISOString(),
        embeddingSpace: space,
      },
      families: familyResults,
    };
    writeFileSync(OUTPUT_PATH, `${JSON.stringify(json, null, 2)}\n`, "utf-8");
    console.log(`\n[local-noise-candidate-diff] 機械可読な結果を書き出した: ${OUTPUT_PATH}`);
  } finally {
    await handle.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

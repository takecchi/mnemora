import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { createExampleRuntime } from "../runtime-factory.js";
import { warmupLocalEmbedding } from "../local-embedding-warmup.js";
import { tryGitRevParseHead } from "../git-info.js";
import { newRunToken } from "../retrieval-quality.js";
import {
  CORRECTION_HIT_CASE_SET_EVAL,
  CORRECTION_ABSTAIN_CASE_SET_EVAL,
} from "../correction-case-set.eval.js";
import { measureIntrusionMarginCandidates } from "../intrusion-margin-candidates.js";
import type { SignedMarginStats } from "../intrusion-margin-candidates.js";

/**
 * Issue #109 残件C（マネージャー依頼）——ADR 0291 §5.5/ADR 0321 が決めた
 * `intrusionMargin` の定義（B群、深い誤爆のときだけ `topScore − protectedFactScore`。
 * `protectedFacts` が0〜1件の今日の母集合では常に0になる、ADR 0321 §4 実測済み）を、
 * 同じ53件（A群21・B群32）に対して**候補の定義（`protectionMargin`）と並べて実測する**、
 * **手で回す測定スクリプト**（CI からは呼ばない。`local-embedding-synthetic-noise-fp.ts`
 * と同じ位置づけ）。
 *
 * ⛔ **`correction-candidate-arm.ts`・基準値 JSON
 * （`correction-candidate-probe-baseline.json`）・summary スクリプト・`ci.yml` は
 * 1文字も変えない。**このスクリプトは `../intrusion-margin-candidates.ts`（新規、
 * 純関数）を呼ぶだけであり、既存の測定は `runCorrectionCandidateArm`
 * （未変更）をそのまま内部で使う。
 *
 * ## 候補
 *
 * - **案0（現行）**: `intrusionMargin = topScore − protectedFactScore`。深い誤爆
 *   のときだけ定義。今日の母集合では常に0（ADR 0321 §4）。
 * - **案1/2（数値は同一）**: `protectionMargin = protectedFactScore −
 *   topNonProtectedScore`。深い誤爆・誤爆(浅)の両方で定義され、符号が意味を持つ
 *   （正=深い誤爆側、負=誤爆(浅)側）。案1/2の違いは出荷方法（`intrusionMargin` の
 *   定義域を書き換えるか、別名で新設するか）——数値の比較はこのスクリプトの範囲、
 *   出荷方法の選択は ADR 側に委ねる（`/tmp/mgr-65f771d7/results-C.md` に論点を書いた）。
 *
 * ## 使い方
 *
 * ```
 * DATABASE_URL=postgresql://worker@127.0.0.1:<port>/mnemora_test \
 *   tsx examples/chat/src/scripts/measure-intrusion-margin-candidates.ts
 * ```
 *
 * ⛔ 実 API は一切叩かない（`OPENAI_API_KEY` は読まない。LLM=`deterministic`、
 * embedding=`local`、`correction-candidates` サブコマンドと同じ組み合わせ）。
 */

const here = dirname(fileURLToPath(import.meta.url));
const CHAT_ROOT = join(here, "..", "..");
const OUTPUT_PATH = join(CHAT_ROOT, "intrusion-margin-candidates-measurement.json");

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} が環境に無い。使い方はこのスクリプトの doc コメントを見ること。`);
  }
  return value;
}

function formatSignedMarginStats(stats: SignedMarginStats): string {
  if (stats.count === 0) {
    return "n=0（測れたケースが無い）";
  }
  const stdDevText = stats.stdDev === null ? "—" : stats.stdDev.toExponential(6);
  return (
    `n=${String(stats.count)} mean=${stats.mean!.toExponential(6)} stdDev=${stdDevText} ` +
    `min=${stats.min!.toExponential(6)} max=${stats.max!.toExponential(6)}`
  );
}

async function main(): Promise<void> {
  const databaseUrl = requireEnv("DATABASE_URL");
  const measuredAt = new Date();
  const commit = tryGitRevParseHead(process.cwd());
  const runToken = newRunToken();

  const handle = await createExampleRuntime(databaseUrl, {
    ...process.env,
    MNEMORA_LLM: "deterministic",
    MNEMORA_EMBEDDING: "local",
  });

  try {
    console.log(
      "[intrusion-margin-candidates] warmup() でモデルの読み込みを先に済ませる" +
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
    const space = handle.embeddingProvider.space;
    console.log(
      `[intrusion-margin-candidates] embedding space: provider=${space.provider} ` +
        `model=${space.model} dimensions=${space.dimensions}`,
    );

    const result = await measureIntrusionMarginCandidates({
      tenantId: `intrusion-margin-candidates-${runToken}`,
      runtime: handle.runtime,
      memoryStore: handle.memoryStore,
      llmMode: handle.llmMode,
      embeddingMode: handle.embeddingMode,
      hitCases: CORRECTION_HIT_CASE_SET_EVAL,
      abstainCases: CORRECTION_ABSTAIN_CASE_SET_EVAL,
    });

    if (result.report.ingestDrain.totalFailed > 0) {
      console.error(
        `🔴 embed に失敗した件がある(${String(result.report.ingestDrain.totalFailed)}件)。` +
          "⛔ この数字は使えない。",
      );
      process.exitCode = 1;
      return;
    }

    console.log("");
    console.log(
      `A群 n=${String(result.report.hits.length)}、B群 n=${String(result.measurements.length)}`,
    );
    console.log("");
    console.log("--- 案0（現行） intrusionMargin(topScore−protectedFactScore、深い誤爆のみ) ---");
    console.log(`  ${formatSignedMarginStats(result.intrusionMarginCurrentStats)}`);
    console.log("");
    console.log(
      "--- 案1/2 protectionMargin(protectedFactScore−topNonProtectedScore、深い誤爆/誤爆(浅)の両方) ---",
    );
    console.log(`  全体:       ${formatSignedMarginStats(result.protectionMarginStats)}`);
    console.log(`  深い誤爆のみ: ${formatSignedMarginStats(result.protectionMarginStatsDeepOnly)}`);
    console.log(
      `  誤爆(浅)のみ: ${formatSignedMarginStats(result.protectionMarginStatsShallowOnly)}`,
    );
    console.log("");

    const vagueCount = result.measurements.filter((m) => m.protectionMargin === null).length;
    console.log(
      `protectionMargin が null のケース = ${String(vagueCount)}件` +
        "（protectedFacts が0件、または返らなかったケース）",
    );

    console.log("");
    if (result.consistencyMismatches.length === 0) {
      console.log(
        "✅ 内部整合性チェック: runCorrectionCandidateArm(1回目)とこのスクリプトの" +
          "2回目のrecall()で、protectedAtTop/topScore/protectedFactScoreが全件一致した。",
      );
    } else {
      console.error(
        `🔴 内部整合性チェックで${String(result.consistencyMismatches.length)}件の不一致:`,
      );
      for (const m of result.consistencyMismatches) {
        console.error(`  - ${m}`);
      }
      console.error(
        "  ⚠ この不一致は、どちらの値が正しいかをこのスクリプトが決めない" +
          "（AGENTS.md「機械には検出まで」）。手で調べること。",
      );
      process.exitCode = 1;
    }

    console.log("");
    for (const m of result.measurements) {
      console.log(
        `  ${m.caseId.padEnd(20)} kind=${m.kind.padEnd(13)} ` +
          `protectedAtTop=${String(m.protectedAtTop).padEnd(5)} ` +
          `intrusionMargin(案0)=${m.intrusionMarginCurrent === null ? "null" : m.intrusionMarginCurrent.toFixed(6)} ` +
          `protectionMargin(案1/2)=${m.protectionMargin === null ? "null" : m.protectionMargin.toFixed(6)}`,
      );
    }

    const json = {
      _readme:
        "Issue #109 残件C（マネージャー依頼）——ADR 0291 §5.5/ADR 0321 の intrusionMargin " +
        "定義の候補比較。correction-candidate-probe-baseline.json とは別ファイルであり、" +
        "そちらの内容・作法には一切触れていない。CI からは呼ばれない手動測定である " +
        "(examples/chat/src/scripts/local-embedding-synthetic-noise-fp.ts と同じ位置づけ)。 " +
        "案0=現行のintrusionMargin(深い誤爆のみ定義、今日の母集合では常に0)。" +
        "案1/2=protectionMargin(protectedFactScore-topNonProtectedScore、深い誤爆/誤爆(浅)の" +
        "両方で定義、符号が意味を持つ)。案1と案2は数値としては同一の式であり、" +
        "分かれるのは出荷方法(intrusionMarginの定義域を書き換えるか、別名で新設するか)。",
      schemaVersion: 1,
      provenance: {
        commit,
        measuredAt: measuredAt.toISOString(),
        how:
          "env -u OPENAI_API_KEY DATABASE_URL=<port> tsx " +
          "examples/chat/src/scripts/measure-intrusion-margin-candidates.ts",
        database: "PostgreSQL 17 + pgvector(ローカル、非本番。docs/autonomy.md の initdb 手順)",
        embeddingSpace: space,
        llmMode: handle.llmMode,
        embeddingMode: handle.embeddingMode,
        caseSet: "eval",
        hitCount: result.report.hits.length,
        abstainCount: result.measurements.length,
      },
      candidates: {
        "0_current_intrusionMargin": {
          definition:
            "topScore - protectedFactScore（深い誤爆(protectedAtTop=true)のときだけ。それ以外はnull）",
          stats: result.intrusionMarginCurrentStats,
        },
        "1_2_protectionMargin": {
          definition:
            "protectedFactScore - topNonProtectedScore（protectedFactsが1件以上返っていれば、深い誤爆・誤爆(浅)の両方で定義。符号: 正=深い誤爆側、負=誤爆(浅)側）",
          statsOverall: result.protectionMarginStats,
          statsDeepMisfireOnly: result.protectionMarginStatsDeepOnly,
          statsShallowMisfireOnly: result.protectionMarginStatsShallowOnly,
          nullCount: vagueCount,
        },
      },
      measurements: result.measurements,
      consistencyMismatches: result.consistencyMismatches,
    };
    writeFileSync(OUTPUT_PATH, `${JSON.stringify(json, null, 2)}\n`, "utf-8");
    console.log(`\n[intrusion-margin-candidates] 機械可読な結果を書き出した: ${OUTPUT_PATH}`);
  } finally {
    await handle.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

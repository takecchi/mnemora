import type { ClaimKeyOptions } from "@mnemora/core";
import { CassetteRecorder } from "@mnemora/testkit";
import { createPostgresClient, closePostgresClient } from "@mnemora/postgres";
import { createAnswerBenchRuntime, embeddingSpaceSlug, runAnswerCase } from "../answer-bench.js";
import type { AnswerCase } from "../answer-case.js";
import { ANSWER_CASE_SET_DEV } from "../answer-case-set.dev.js";
import { ANSWER_CASE_SET_EVAL } from "../answer-case-set.eval.js";
import { ANSWER_ORDER_LEGEND_CASSETTE_PATH, loadCassette, saveCassette } from "../cassette-io.js";

/**
 * 測るだけ。タグ件数が 0 件の回は「影響を測れていない回」で、その判定は集計側の仕事（ここは生データを出すだけ）。
 * `no-tag` は `detectContested` を渡さず、(A) との差分を「印の有無」だけにする対照。
 */

const TARGET_CASE_IDS = [
  "schedule-change-meeting-day",
  "negation-moved-city",
  "schedule-change-deadline",
  "negation-moved-job",
  "unknown-favorite-number",
  "other-period-city-this-year",
] as const;

const CONDITIONS = ["with-tag", "no-tag"] as const;
type Condition = (typeof CONDITIONS)[number];

function resolveCondition(raw: string | undefined): Condition {
  if (raw !== undefined && (CONDITIONS as readonly string[]).includes(raw)) {
    return raw as Condition;
  }
  throw new Error(
    `MNEMORA_CANDIDATE4_CONDITION には ${CONDITIONS.map((c) => `"${c}"`).join(" / ")} の` +
      `いずれかを指定すること（実際: ${JSON.stringify(raw ?? null)}）。`,
  );
}

function claimKeyOptionsFor(condition: Condition): ClaimKeyOptions {
  if (condition === "with-tag") {
    return { enabled: true, detectContested: true, knownPredicatesFromStore: true };
  }
  return { enabled: true, knownPredicatesFromStore: true };
}

const usage = () => {
  console.error(
    "使い方: DATABASE_URL=... OPENAI_API_KEY=... MNEMORA_CANDIDATE4_CONDITION=with-tag|no-tag " +
      "MNEMORA_RECORD_CASSETTE_PATH=... pnpm --filter @mnemora/example-chat exec tsx src/scripts/measure-835-candidate4-answer-quality.ts",
  );
};

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    usage();
    throw new Error("DATABASE_URL が無い。");
  }
  if (!process.env.OPENAI_API_KEY) {
    usage();
    throw new Error("OPENAI_API_KEY が無い。このスクリプトは実 API を叩く。");
  }
  const outputCassettePath = process.env.MNEMORA_RECORD_CASSETTE_PATH;
  if (!outputCassettePath) {
    usage();
    throw new Error("MNEMORA_RECORD_CASSETTE_PATH が無い。");
  }
  const condition = resolveCondition(process.env.MNEMORA_CANDIDATE4_CONDITION);
  const claimKeyOptions = claimKeyOptionsFor(condition);

  const allCases = [...ANSWER_CASE_SET_DEV, ...ANSWER_CASE_SET_EVAL];
  const targetCases: AnswerCase[] = TARGET_CASE_IDS.map((id) => {
    const found = allCases.find((c) => c.id === id);
    if (!found) {
      throw new Error(`ケース "${id}" が見つからない。`);
    }
    return found;
  });

  console.log(
    `[measure-835-candidate4] condition=${condition} claimKeyOptions=${JSON.stringify(claimKeyOptions)} ` +
      `対象 ${targetCases.length}ケース outputCassettePath=${outputCassettePath}`,
  );

  const seedCassette = loadCassette(ANSWER_ORDER_LEGEND_CASSETTE_PATH);
  const recorder = new CassetteRecorder();
  const handle = await createAnswerBenchRuntime(
    databaseUrl,
    { ...process.env, MNEMORA_LLM: "openai", MNEMORA_EMBEDDING: "openai" },
    { recorder, seedCassette },
  );

  const diagPool = createPostgresClient(databaseUrl);
  const runId = Date.now();
  const tenantPrefix = `measure-835-candidate4-${condition}-${runId}`;

  try {
    for (const answerCase of targetCases) {
      const result = await runAnswerCase(
        handle.runtime,
        handle.llmProvider,
        handle.embeddingProvider,
        handle.judgeLLMProvider,
        answerCase,
        tenantPrefix,
        { claimKey: claimKeyOptions },
      );
      const mnemoraContent = result.mnemora.promptSpec.messages[0]?.content ?? "";
      const contradictionTagCount = (mnemoraContent.match(/\[矛盾候補:/g) ?? []).length;

      const embeddingSpace = embeddingSpaceSlug(handle.embeddingProvider.space);
      const tenantId = `${tenantPrefix}-${embeddingSpace}-${answerCase.id}`;
      const rows = await diagPool.pool.query(
        `SELECT status, contested_with_id, claim_key_predicate FROM memories WHERE tenant_id = $1`,
        [tenantId],
      );
      const contestedCount = rows.rows.filter(
        (r) => (r as { status: string }).status === "contested",
      ).length;

      console.log(
        `[measure-835-candidate4] case=${answerCase.id} condition=${condition} ` +
          `contradictionTagCount=${contradictionTagCount} contestedMemories=${contestedCount} ` +
          `mnemora.verdict=${result.mnemora.verdict} ` +
          `mnemora.judgement.outcome=${result.mnemora.judgement?.outcome ?? "無し"} ` +
          `mnemora.reconciled=${result.mnemora.reconciled ?? "無し"} ` +
          `mnemora.answer=${JSON.stringify(result.mnemora.answer)}`,
      );
    }

    if (handle.usageMeter) {
      console.log(`\n${handle.usageMeter.formatReport()}`);
    }
    if (handle.readSeedUsage) {
      const seedUsage = handle.readSeedUsage();
      console.log(
        `\n[measure-835-candidate4] 種カセットの命中: ` +
          `LLM seed=${seedUsage.llm.seeded} real=${seedUsage.llm.real} / ` +
          `embedding seed=${seedUsage.embedding.seeded} real=${seedUsage.embedding.real}`,
      );
    }

    const cassette = recorder.toCassette();
    saveCassette(cassette, outputCassettePath);
    console.log(`\n[measure-835-candidate4] 書き出した: ${outputCassettePath}`);
  } finally {
    await closePostgresClient(diagPool);
    await handle.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

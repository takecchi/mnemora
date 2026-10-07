import { CassetteRecorder } from "@mnemora/testkit";
import { createPostgresClient, closePostgresClient } from "@mnemora/postgres";
import {
  applyCaseKnownSubjects,
  resolveAnswerClaimKeyOptions,
} from "../answer-claim-key-options.js";
import { createAnswerBenchRuntime, embeddingSpaceSlug, runAnswerCase } from "../answer-bench.js";
import type { AnswerCase } from "../answer-case.js";
import { ANSWER_CASE_SET_DEV } from "../answer-case-set.dev.js";
import { ANSWER_CASE_SET_EVAL } from "../answer-case-set.eval.js";
import { ANSWER_CASE_SET_SEPARATE_TURN } from "../answer-case-set.separate-turn.js";
import {
  ANSWER_CLAIM_KEY_CASSETTE_PATH,
  ANSWER_ORDER_LEGEND_CASSETTE_PATH,
  loadCassette,
  saveCassette,
} from "../cassette-io.js";

/**
 * 種カセットは常に `answer.order-legend.json` だけにする。`answer.claim-key.json` を種にすると、claim key 派生の呼び出し自体が記録済みの応答の再生になり、実 API に落ちる対照にならない。
 * `"known-subjects"` は正解を手で渡した場合の上限（オラクル）測定で、mnemora が実運用でその正解を知っている保証は無い。
 * 既存カセットは書き換えない。
 */

const RECORD_CONDITIONS = ["baseline", "known-predicates-from-store", "known-subjects"] as const;
type RecordCondition = (typeof RECORD_CONDITIONS)[number];

function resolveRecordCondition(raw: string | undefined): RecordCondition {
  if (raw === undefined || raw === "") {
    return "baseline";
  }
  if ((RECORD_CONDITIONS as readonly string[]).includes(raw)) {
    return raw as RecordCondition;
  }
  throw new Error(
    `MNEMORA_RECORD_CONDITION には ${RECORD_CONDITIONS.map((c) => `"${c}"`).join(" / ")} の` +
      `いずれかを指定すること（実際: "${raw}"）。`,
  );
}

const ANSWER_CASE_SET_OPTIONS = ["default", "separate-turn"] as const;
type AnswerCaseSetOption = (typeof ANSWER_CASE_SET_OPTIONS)[number];

function resolveAnswerCaseSetOption(raw: string | undefined): AnswerCaseSetOption {
  if (raw === undefined || raw === "") {
    return "default";
  }
  if ((ANSWER_CASE_SET_OPTIONS as readonly string[]).includes(raw)) {
    return raw as AnswerCaseSetOption;
  }
  throw new Error(
    `MNEMORA_ANSWER_CASE_SET には ${ANSWER_CASE_SET_OPTIONS.map((s) => `"${s}"`).join(" / ")} の` +
      `いずれかを指定すること（実際: "${raw}"）。`,
  );
}

function resolveAnswerCases(caseSetOption: AnswerCaseSetOption): AnswerCase[] {
  if (caseSetOption === "separate-turn") {
    return [...ANSWER_CASE_SET_SEPARATE_TURN];
  }
  return [...ANSWER_CASE_SET_DEV, ...ANSWER_CASE_SET_EVAL];
}

interface ObservedTurnDiagnostic {
  caseId: string;
  turnIndex: number;
  text: string;
  extraction: string;
  claimKeyFailure: unknown;
  contestedDetection: unknown;
}

const usage = () => {
  console.error(
    "使い方: DATABASE_URL=... OPENAI_API_KEY=... " +
      "[MNEMORA_RECORD_CONDITION=baseline|known-predicates-from-store|known-subjects] " +
      "[MNEMORA_RECORD_CASSETTE_PATH=...] " +
      "[MNEMORA_ANSWER_CASE_SET=default|separate-turn] " +
      "pnpm --filter @mnemora/example-chat exec tsx src/scripts/record-answer-claim-key.ts",
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

  const condition = resolveRecordCondition(process.env.MNEMORA_RECORD_CONDITION);
  const answerClaimKeyMode =
    condition === "known-predicates-from-store" ? "detect-known-predicates-from-store" : "detect";
  const outputCassettePath =
    process.env.MNEMORA_RECORD_CASSETTE_PATH ?? ANSWER_CLAIM_KEY_CASSETTE_PATH;
  const caseSetOption = resolveAnswerCaseSetOption(process.env.MNEMORA_ANSWER_CASE_SET);

  const claimKeyOptions = resolveAnswerClaimKeyOptions({
    MNEMORA_ANSWER_CLAIM_KEY: answerClaimKeyMode,
  });
  if (claimKeyOptions === undefined) {
    throw new Error("到達しないはず: resolveAnswerClaimKeyOptions が undefined を返した。");
  }
  console.log(
    `[record-answer-claim-key] condition=${condition} claimKeyOptions = ${JSON.stringify(claimKeyOptions)} ` +
      `outputCassettePath=${outputCassettePath} caseSet=${caseSetOption}`,
  );

  const seedCassette = loadCassette(ANSWER_ORDER_LEGEND_CASSETTE_PATH);
  console.log(
    `[record-answer-claim-key] 種カセットを読み込んだ（${ANSWER_ORDER_LEGEND_CASSETTE_PATH}）: ` +
      `LLM ${Object.keys(seedCassette.llm.entries).length}件 / ` +
      `embedding ${Object.keys(seedCassette.embedding.entries).length}件`,
  );

  const recorder = new CassetteRecorder();
  const handle = await createAnswerBenchRuntime(
    databaseUrl,
    { ...process.env, MNEMORA_LLM: "openai", MNEMORA_EMBEDDING: "openai" },
    { recorder, seedCassette },
  );

  const diagPool = createPostgresClient(databaseUrl);

  const diagnostics: ObservedTurnDiagnostic[] = [];
  const allCases = resolveAnswerCases(caseSetOption);
  const runId = Date.now();
  const tenantPrefix = `answer-claim-key-record-${condition}-${runId}`;

  try {
    const results: { caseId: string; contradictionTagCount: number }[] = [];
    for (const answerCase of allCases) {
      const caseClaimKeyOptions = applyCaseKnownSubjects(
        claimKeyOptions,
        condition,
        answerCase.knownSubjects,
      );
      if (caseClaimKeyOptions !== claimKeyOptions) {
        console.log(
          `[record-answer-claim-key] ${answerCase.id}: knownSubjects=${JSON.stringify(answerCase.knownSubjects)} を合流（condition=${condition}）`,
        );
      }
      const result = await runAnswerCase(
        handle.runtime,
        handle.llmProvider,
        handle.embeddingProvider,
        handle.judgeLLMProvider,
        answerCase,
        tenantPrefix,
        {
          claimKey: caseClaimKeyOptions,
          onObserved: (turn, observed) => {
            diagnostics.push({
              caseId: answerCase.id,
              turnIndex: turn.index,
              text: turn.text,
              extraction: observed.extraction,
              claimKeyFailure: observed.claimKeyFailure ?? null,
              contestedDetection: observed.contestedDetection ?? [],
            });
          },
        },
      );
      const mnemoraContent = result.mnemora.promptSpec.messages[0]?.content ?? "";
      const contradictionTagCount = (mnemoraContent.match(/\[矛盾候補:/g) ?? []).length;
      results.push({ caseId: answerCase.id, contradictionTagCount });
      console.log(
        `[record-answer-claim-key] ${answerCase.id}: [矛盾候補:] タグ ${contradictionTagCount} 件 / ` +
          `verdict(mnemora)=${result.mnemora.verdict}`,
      );

      const embeddingSpace = embeddingSpaceSlug(handle.embeddingProvider.space);
      const tenantId = `${tenantPrefix}-${embeddingSpace}-${answerCase.id}`;
      const rows = await diagPool.pool.query(
        `SELECT id, subject_id, content, content_hash, status, contested_with_id,
                claim_key_subject, claim_key_predicate, valid_from, valid_until, recorded_at
         FROM memories WHERE tenant_id = $1 ORDER BY recorded_at ASC`,
        [tenantId],
      );
      console.log(`  memories（tenant=${tenantId}）: ${rows.rowCount}件`);
      for (const row of rows.rows as Record<string, unknown>[]) {
        console.log(
          `    id=${String(row.id).slice(0, 8)} status=${row.status} ` +
            `claim_key=(${row.claim_key_subject ?? "null"}, ${row.claim_key_predicate ?? "null"}) ` +
            `subject_id=${row.subject_id ?? "null"} contested_with=${row.contested_with_id ? String(row.contested_with_id).slice(0, 8) : "null"} ` +
            `valid=[${row.valid_from ?? "null"}, ${row.valid_until ?? "null"}) content=${JSON.stringify(String(row.content).slice(0, 40))}`,
        );
      }
    }

    console.log("\n--- 診断: observe() ごとの claimKeyFailure / contestedDetection ---");
    for (const d of diagnostics) {
      if (
        d.claimKeyFailure !== null ||
        (Array.isArray(d.contestedDetection) && d.contestedDetection.length > 0)
      ) {
        console.log(
          `  ${d.caseId} turn#${d.turnIndex} extraction=${d.extraction} ` +
            `claimKeyFailure=${JSON.stringify(d.claimKeyFailure)} ` +
            `contestedDetection=${JSON.stringify(d.contestedDetection)}`,
        );
      }
    }

    console.log("\n--- ケースごとの [矛盾候補:] タグ件数 ---");
    for (const r of results) {
      console.log(`  ${r.caseId}: ${r.contradictionTagCount}`);
    }

    if (handle.usageMeter) {
      console.log(`\n${handle.usageMeter.formatReport()}`);
    }
    if (handle.readSeedUsage) {
      const seedUsage = handle.readSeedUsage();
      console.log(
        `\n[record-answer-claim-key] 種カセットの命中: ` +
          `LLM seed=${seedUsage.llm.seeded} real=${seedUsage.llm.real} / ` +
          `embedding seed=${seedUsage.embedding.seeded} real=${seedUsage.embedding.real}`,
      );
    }

    const cassette = recorder.toCassette();
    saveCassette(cassette, outputCassettePath);
    console.log(`\n[record-answer-claim-key] 書き出した: ${outputCassettePath}`);
    console.log(
      `  LLM ${Object.keys(cassette.llm.entries).length}件 / ` +
        `embedding ${Object.keys(cassette.embedding.entries).length}件`,
    );
  } finally {
    await closePostgresClient(diagPool);
    await handle.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

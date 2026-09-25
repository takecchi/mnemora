import { CassetteRecorder } from "@mnemora/testkit";
import { createPostgresClient, closePostgresClient } from "@mnemora/postgres";
import type { Ctx } from "@mnemora/core";
import { createAnswerBenchRuntime, embeddingSpaceSlug } from "../answer-bench.js";
import { ingestConversation } from "../mnemora-path.js";
import type { AnswerCase } from "../answer-case.js";
import { ANSWER_CASE_SET_DEV } from "../answer-case-set.dev.js";
import { ANSWER_CASE_SET_EVAL } from "../answer-case-set.eval.js";
import { ANSWER_ORDER_LEGEND_CASSETTE_PATH, loadCassette, saveCassette } from "../cassette-io.js";
import type { Conversation, ConversationTurn } from "../scenario.js";

/**
 * Issue #835（ADR 0329 負債1の続き）: `claim-key.ts` の
 * `buildKnownPredicateFromStoreInstruction`（store 由来の語彙ヒントだけ弱めた文言・
 * 別の見出しにする変更）が、訂正4件の predicate 一致・`contested` 成立を落とさずに
 * 誤検出（`unknown-favorite-number`/`other-period-city-this-year`）を減らせるかを、
 * 実 API（gpt-4o-mini）で確かめる縮小版の測定スクリプト。
 *
 * **`record-answer-claim-key.ts`（ADR 0329・#833）との違い**:
 *
 * 1. **回答生成・judge を一切呼ばない**——`runAnswerCase` ではなく
 *    `ingestConversation` だけを呼ぶ。マネージャー指示「claimKey の派生と contested の
 *    成立までを見れば十分（回答生成と採点は不要）」に従い、呼び出し回数を抑える。
 * 2. **14ケース全部ではなく、訂正4件 + 誤検出2件の計6件だけ**を回す
 *    （`TARGET_CASE_IDS`）——150回の予算内に収めるため。
 * 3. 条件は常に `{ enabled: true, detectContested: true, knownPredicatesFromStore: true }`
 *    固定——「基準（旧文言）」との対照は、既に repo にある
 *    `examples/chat/cassettes/answer.claim-key.known-predicates-{1,2,3}.json`
 *    （ADR 0329 本文の実測、旧文言・同じ6ケースを含む14ケース）を読み直す
 *    （`read-known-predicates-cassette-835.ts` 参照）——**新しく基準を録り直さない**
 *    （既に実測済みのものを再測定しても新しい情報が増えないため。実 API 予算の節約）。
 *
 * **種カセットは常に `answer.order-legend.json` だけ**（ADR 0329 決定6 と同じ理由）。
 * このスクリプトが読む claim key 呼び出しは種カセットに1件も無いため、
 * **claim key 呼び出しは常に実 API に落ちる**——狙い通り（これが測りたい呼び出し）。
 * 抽出・埋め込みは種カセットと入力が一致する限り種から返る。
 *
 * 使い方: `DATABASE_URL=... OPENAI_API_KEY=... MNEMORA_RECORD_CASSETTE_PATH=... \
 *   tsx examples/chat/src/scripts/measure-claim-key-835.ts`
 */

const TARGET_CASE_IDS = [
  // 訂正4件（ADR 0329「測ったこと」1節と同じ4件）
  "schedule-change-meeting-day",
  "negation-moved-city",
  "schedule-change-deadline",
  "negation-moved-job",
  // 誤検出2件（Issue #835 本文・ADR 0329「測ったこと」3節と同じ2件）
  "unknown-favorite-number",
  "other-period-city-this-year",
] as const;

function toConversation(answerCase: AnswerCase): Conversation {
  const turns: ConversationTurn[] = answerCase.conversation.map((turn, index) => ({
    index,
    role: turn.role,
    text: turn.text,
  }));
  return {
    turns,
    userUtterances: turns.filter((t) => t.role === "user"),
    query: answerCase.question,
  };
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
    "使い方: DATABASE_URL=... OPENAI_API_KEY=... [MNEMORA_RECORD_CASSETTE_PATH=...] " +
      "tsx examples/chat/src/scripts/measure-claim-key-835.ts",
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

  const allCases = [...ANSWER_CASE_SET_DEV, ...ANSWER_CASE_SET_EVAL];
  const targetCases = TARGET_CASE_IDS.map((id) => {
    const found = allCases.find((c) => c.id === id);
    if (!found) {
      throw new Error(`ケース "${id}" が見つからない。`);
    }
    return found;
  });

  console.log(
    `[measure-claim-key-835] 対象 ${targetCases.length} ケース: ${targetCases.map((c) => c.id).join(", ")} ` +
      `outputCassettePath=${outputCassettePath}`,
  );

  const seedCassette = loadCassette(ANSWER_ORDER_LEGEND_CASSETTE_PATH);
  console.log(
    `[measure-claim-key-835] 種カセットを読み込んだ（${ANSWER_ORDER_LEGEND_CASSETTE_PATH}）: ` +
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
  const runId = Date.now();
  const tenantPrefix = `measure-claim-key-835-${runId}`;

  try {
    for (const answerCase of targetCases) {
      const conversation = toConversation(answerCase);
      const embeddingSpace = embeddingSpaceSlug(handle.embeddingProvider.space);
      const ctx: Ctx = { tenantId: `${tenantPrefix}-${embeddingSpace}-${answerCase.id}` };
      await ingestConversation(handle.runtime, ctx, conversation, {
        claimKey: { enabled: true, detectContested: true, knownPredicatesFromStore: true },
        onObserved: (turn, observed) => {
          diagnostics.push({
            caseId: answerCase.id,
            turnIndex: turn.index,
            text: turn.text,
            extraction: JSON.stringify(observed.memoryIds),
            claimKeyFailure: observed.claimKeyFailure ?? null,
            contestedDetection: observed.contestedDetection ?? [],
          });
        },
      });

      const rows = await diagPool.pool.query(
        `SELECT id, subject_id, content, content_hash, status, contested_with_id,
                claim_key_subject, claim_key_predicate, valid_from, valid_until, recorded_at
         FROM memories WHERE tenant_id = $1 ORDER BY recorded_at ASC`,
        [ctx.tenantId],
      );
      console.log(`  memories（tenant=${ctx.tenantId}）: ${rows.rowCount}件`);
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
          `  ${d.caseId} turn#${d.turnIndex} memoryIds=${d.extraction} ` +
            `claimKeyFailure=${JSON.stringify(d.claimKeyFailure)} ` +
            `contestedDetection=${JSON.stringify(d.contestedDetection)}`,
        );
      }
    }

    if (handle.usageMeter) {
      console.log(`\n${handle.usageMeter.formatReport()}`);
    }
    if (handle.readSeedUsage) {
      const seedUsage = handle.readSeedUsage();
      console.log(
        `\n[measure-claim-key-835] 種カセットの命中: ` +
          `LLM seed=${seedUsage.llm.seeded} real=${seedUsage.llm.real} / ` +
          `embedding seed=${seedUsage.embedding.seeded} real=${seedUsage.embedding.real}`,
      );
    }

    const cassette = recorder.toCassette();
    saveCassette(cassette, outputCassettePath);
    console.log(`\n[measure-claim-key-835] 書き出した: ${outputCassettePath}`);
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

import { createPostgresClient, closePostgresClient } from "@mnemora/postgres";
import { createAnswerBenchRuntime, embeddingSpaceSlug } from "../answer-bench.js";
import { ingestConversation } from "../mnemora-path.js";
import type { AnswerCase } from "../answer-case.js";
import { ANSWER_CASE_SET_DEV } from "../answer-case-set.dev.js";
import { ANSWER_CASE_SET_EVAL } from "../answer-case-set.eval.js";
import { loadCassette } from "../cassette-io.js";
import type { Conversation, ConversationTurn } from "../scenario.js";

/**
 * `runAnswerCase` ではなく `ingestConversation` だけを呼ぶ。回答生成は `recall()` の減衰（現在時刻に依存）を通るので、記録した日と再生する日が違うと回答プロンプトが記録と食い違う。
 * claim key 派生の「記録に無い」は例外にならず `ObserveResult.claimKeyFailure` に丸められるので、1件ずつ出し、1件でもあれば exit 1 にする（許す一覧は持たない）。
 */

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

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL が無い。");
  }
  const cassettePath = process.argv[2];
  if (!cassettePath) {
    throw new Error(
      "使い方: DATABASE_URL=... tsx .../replay-835-candidate3-known-predicates.ts <cassette-path>",
    );
  }

  const cassette = loadCassette(cassettePath);
  console.log(
    `[replay-835-candidate3] カセット=${cassettePath} ` +
      `LLM ${Object.keys(cassette.llm.entries).length}件 / ` +
      `embedding ${Object.keys(cassette.embedding.entries).length}件`,
  );

  const allCases: AnswerCase[] = [...ANSWER_CASE_SET_DEV, ...ANSWER_CASE_SET_EVAL];

  const handle = await createAnswerBenchRuntime(
    databaseUrl,
    { ...process.env, MNEMORA_LLM: "recorded", MNEMORA_EMBEDDING: "recorded" },
    { cassette },
  );
  const diagPool = createPostgresClient(databaseUrl);
  const runId = Date.now();
  const tenantPrefix = `replay-835-candidate3-${runId}`;

  const claimKeyFailures: string[] = [];
  try {
    for (const answerCase of allCases) {
      const conversation = toConversation(answerCase);
      const embeddingSpace = embeddingSpaceSlug(handle.embeddingProvider.space);
      const ctx = { tenantId: `${tenantPrefix}-${embeddingSpace}-${answerCase.id}` };
      try {
        await ingestConversation(handle.runtime, ctx, conversation, {
          claimKey: { enabled: true, detectContested: true, knownPredicatesFromStore: true },
          onObserved: (turn, observed) => {
            const failure = observed.claimKeyFailure ?? null;
            if (failure !== null) {
              const line =
                `[${answerCase.id}] turn=${turn.index} で claim key 派生が失敗した` +
                `（${failure.kind ?? "種類不明"}）: ${failure.message.slice(0, 80)}`;
              claimKeyFailures.push(line);
              console.log(`  ${line}`);
            }
          },
        });
      } catch (error) {
        console.log(
          `  [${answerCase.id}] ingestConversation で例外（記録に無い入力）: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }

      const rows = await diagPool.pool.query(
        `SELECT id, content, status, contested_with_id, source_observation_id,
                claim_key_subject, claim_key_predicate
         FROM memories WHERE tenant_id = $1 ORDER BY recorded_at ASC`,
        [ctx.tenantId],
      );
      console.log(`  [${answerCase.id}] memories: ${rows.rowCount}件`);
      for (const row of rows.rows as Record<string, unknown>[]) {
        console.log(
          `    id=${String(row.id).slice(0, 8)} status=${row.status} ` +
            `claim_key=(${row.claim_key_subject ?? "null"}, ${row.claim_key_predicate ?? "null"}) ` +
            `contested_with=${row.contested_with_id ? String(row.contested_with_id).slice(0, 8) : "null"} ` +
            `content=${JSON.stringify(String(row.content).slice(0, 50))}`,
        );
      }
    }
    if (handle.usageMeter) {
      console.log(`\n${handle.usageMeter.formatReport()}`);
    } else {
      console.log("\n[replay-835-candidate3] usageMeter 無し（openai を1回も使っていない証拠）。");
    }
    if (claimKeyFailures.length > 0) {
      console.log(
        `\n[replay-835-candidate3] claim key 派生の失敗 ${claimKeyFailures.length}件` +
          "（この再生の値は、失敗したターンの鍵が null のまま出ている）:",
      );
      for (const line of claimKeyFailures) {
        console.log(`  ${line}`);
      }
      process.exitCode = 1;
    } else {
      console.log("\n[replay-835-candidate3] claim key 派生の失敗 0件。");
    }
  } finally {
    await closePostgresClient(diagPool);
    await handle.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

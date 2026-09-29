import { createPostgresClient, closePostgresClient } from "@mnemora/postgres";
import { createAnswerBenchRuntime, embeddingSpaceSlug } from "../answer-bench.js";
import { ingestConversation } from "../mnemora-path.js";
import type { AnswerCase } from "../answer-case.js";
import { ANSWER_CASE_SET_DEV } from "../answer-case-set.dev.js";
import { ANSWER_CASE_SET_EVAL } from "../answer-case-set.eval.js";
import { loadCassette } from "../cassette-io.js";
import type { Conversation, ConversationTurn } from "../scenario.js";

/**
 * Issue #835 候補3「今の文言（v4 ではない、既定の store 語彙ヒント文言）」の対照を、
 * PR #1424（ADR 0377、候補1）後の main で得るための**純粋な再生**（実 API を1回も
 * 叩かない）。
 *
 * ADR 0329 本文「測ったこと」で記録した `answer.claim-key.known-predicates-{1,2,3}.json`
 * （2026-09-25、候補1が入る**前**の main で記録・全14ケース・`{ enabled: true,
 * detectContested: true, knownPredicatesFromStore: true }`）を、`MNEMORA_LLM=recorded`/
 * `MNEMORA_EMBEDDING=recorded` で読み直す。
 *
 * ⚠ **`runAnswerCase`（回答生成込み）ではなく `ingestConversation` だけを呼ぶ。**
 * 【実測】`runAnswerCase` で全14ケースを再生しようとしたところ、2件目
 * （`schedule-change-meeting-day`）の mnemora 回答プロンプトで
 * `RecordedLLMProvider: このプロンプトは記録に無い` の例外になった——claim key 派生・
 * 抽出（`completeStructured`、時刻に依存しない）は候補1と無関係なはずだが、回答生成
 * （`complete`、`recall()` を経由）は `recall()` の減衰（decay、現在時刻に依存）を通る。
 * カセットを記録した日（2026-09-25）と再生した日（数日後）で「現在時刻」が違うため、
 * 減衰の効き方が変わり、回答プロンプトに含まれる記憶の集合・順序が記録済みと食い違った
 * ——**候補1（ADR 0377）そのものが原因ではなく、日付が経った通常の再生の限界**だと
 * 考えられる（推測。確かめていない）。
 *
 * ⟹ **この再生は `ingestConversation` まで（抽出・claim key 派生・書き込み・検出）に
 * 留める。** predicate 一致・`contested` 成立・誤検出は `memories` テーブルを直接読めば
 * 分かる（ADR 0329/0377 の実測手法と同じ）——`recall()`/回答生成を経由しないので、
 * 減衰の時刻依存を踏まない。
 *
 * 使い方: `DATABASE_URL=... tsx examples/chat/src/scripts/replay-835-candidate3-known-predicates.ts <cassette-path>`
 * （`OPENAI_API_KEY` は不要——記録に無い入力があれば `RecordedLLMProvider`/
 * `RecordedEmbeddingProvider` が例外を投げて止まる。黙って実 API へは落ちない。）
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

  try {
    for (const answerCase of allCases) {
      const conversation = toConversation(answerCase);
      const embeddingSpace = embeddingSpaceSlug(handle.embeddingProvider.space);
      const ctx = { tenantId: `${tenantPrefix}-${embeddingSpace}-${answerCase.id}` };
      try {
        await ingestConversation(handle.runtime, ctx, conversation, {
          claimKey: { enabled: true, detectContested: true, knownPredicatesFromStore: true },
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
  } finally {
    await closePostgresClient(diagPool);
    await handle.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

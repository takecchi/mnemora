import { CassetteRecorder } from "@mnemora/testkit";
import { createAnswerBenchRuntime, runAnswerCase } from "../answer-bench.js";
import { ANSWER_CASE_SET_DEV } from "../answer-case-set.dev.js";
import {
  RETENTION_MUTATION_CASE_ID,
  recordRetentionMutationPositiveControl,
} from "../answer-retention-mutation.js";
import { ANSWER_CASSETTE_PATH, loadCassette, saveCassette } from "../cassette-io.js";

/**
 * 既存の `answer.json` を録り直さず、変異分（chat 2回だけ）を追記する。`record answer` は毎回空の `CassetteRecorder` から始まる全置換なので、
 * 既存カセットを事前投入し、既存分の呼び出しを実 API へ送らない（0 回であることを前後比較で検査する）。
 * 変異分は `recordAnswer` の経路にも組み込んであるので、通常はこのスクリプトを直接使わない。
 * 書き出し後は prettier を通す（`saveCassette` は素の `JSON.stringify` で、整形差分が diff を埋める）。
 */

const usage = () => {
  console.error(
    "使い方: DATABASE_URL=... OPENAI_API_KEY=... " +
      "pnpm --filter @mnemora/example-chat exec tsx src/scripts/record-answer-retention-mutation.ts",
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

  const existing = loadCassette(ANSWER_CASSETTE_PATH);
  console.log(
    `[record-answer-retention-mutation] 既存カセットを読み込んだ: ` +
      `LLM ${Object.keys(existing.llm.entries).length}件 / ` +
      `embedding ${Object.keys(existing.embedding.entries).length}件`,
  );

  const recorder = new CassetteRecorder();
  for (const entry of Object.values(existing.embedding.entries)) {
    recorder.recordEmbedding(existing.embedding.space, entry.text, entry.vector);
  }
  for (const entry of Object.values(existing.llm.entries)) {
    recorder.recordLLM(existing.llm.model, entry.prompt, entry.value);
  }
  const preseededLLMCount = recorder.llmCount;
  const preseededEmbeddingCount = recorder.embeddingCount;
  console.log(
    `[record-answer-retention-mutation] 事前投入した: LLM ${preseededLLMCount}件 / ` +
      `embedding ${preseededEmbeddingCount}件（既存カセットと一致するはず）`,
  );

  const handle = await createAnswerBenchRuntime(
    databaseUrl,
    { ...process.env, MNEMORA_LLM: "openai", MNEMORA_EMBEDDING: "openai" },
    { recorder },
  );

  try {
    const answerCase = ANSWER_CASE_SET_DEV.find((c) => c.id === RETENTION_MUTATION_CASE_ID);
    if (!answerCase) {
      throw new Error(
        `[record-answer-retention-mutation] ケース ${RETENTION_MUTATION_CASE_ID} が ` +
          "ANSWER_CASE_SET_DEV に見つからない。",
      );
    }

    const runId = Date.now();
    const sanityCheck = await runAnswerCase(
      handle.runtime,
      handle.llmProvider,
      handle.embeddingProvider,
      handle.judgeLLMProvider,
      answerCase,
      `answer-mutation-498-sanity-${runId}`,
    );

    const afterSanityLLMCount = recorder.llmCount;
    const afterSanityEmbeddingCount = recorder.embeddingCount;
    if (
      afterSanityLLMCount !== preseededLLMCount ||
      afterSanityEmbeddingCount !== preseededEmbeddingCount
    ) {
      throw new Error(
        "[record-answer-retention-mutation] 想定外: 元のケースを走らせただけで新規の実 API " +
          `呼び出しが発生した（LLM ${preseededLLMCount}→${afterSanityLLMCount} / ` +
          `embedding ${preseededEmbeddingCount}→${afterSanityEmbeddingCount}）。` +
          "既存カセットと入力が食い違っている可能性がある。ここで中断する。",
      );
    }
    if (
      sanityCheck.mnemora.verdict !== "pass" ||
      sanityCheck.mnemora.judgement?.outcome !== "pass"
    ) {
      throw new Error(
        "[record-answer-retention-mutation] 想定外: 変異なしのケースが pass/pass になって" +
          `いない（verdict=${sanityCheck.mnemora.verdict}, ` +
          `judgement=${sanityCheck.mnemora.judgement?.outcome}）。既存カセットが変わった可能性がある。`,
      );
    }
    console.log(
      "[record-answer-retention-mutation] 段1（健全性確認）: mnemora verdict=" +
        `${sanityCheck.mnemora.verdict} judgement=${sanityCheck.mnemora.judgement?.outcome} ` +
        "（実 API 呼び出し 0 回。既存カセットの命中だけで完走した）",
    );

    const afterSanityLLMCountForMutation = recorder.llmCount;
    const mutation = await recordRetentionMutationPositiveControl(
      handle.runtime,
      handle.llmProvider,
      handle.embeddingProvider,
      handle.judgeLLMProvider,
      [answerCase],
      `answer-mutation-498-${runId}`,
    );
    console.log(
      `[record-answer-retention-mutation] 変異後の回答: "${mutation.mutatedAnswer}" ⟹ ` +
        `verdict=${mutation.mutatedVerdict} / judge outcome=${mutation.mutatedJudgement.outcome} ` +
        `reason=${JSON.stringify(mutation.mutatedJudgement.reason)}`,
    );

    const afterMutationLLMCount = recorder.llmCount;
    const newLLMEntries = afterMutationLLMCount - afterSanityLLMCountForMutation;
    console.log(
      `[record-answer-retention-mutation] 新規に記録した LLM エントリ数: ${newLLMEntries}（2 であるはず）`,
    );
    if (newLLMEntries !== 2) {
      throw new Error(
        "[record-answer-retention-mutation] 想定外: 新規に記録された LLM エントリ数が2でない " +
          `（実際: ${newLLMEntries}）。`,
      );
    }

    if (handle.usageMeter) {
      console.log(`\n${handle.usageMeter.formatReport()}`);
    }

    const cassette = recorder.toCassette();
    const newCount = Object.keys(cassette.llm.entries).length;
    console.log(
      `[record-answer-retention-mutation] 書き出す LLM エントリ総数: ${newCount} ` +
        `（既存 ${Object.keys(existing.llm.entries).length} + 新規 2 のはず）`,
    );
    saveCassette(cassette, ANSWER_CASSETTE_PATH);
    console.log(
      `[record-answer-retention-mutation] 書き出した: ${ANSWER_CASSETTE_PATH}\n` +
        "  ⚠ 忘れずに `pnpm run format` を通してから diff を確認すること（上の docstring 参照）。",
    );
  } finally {
    await handle.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

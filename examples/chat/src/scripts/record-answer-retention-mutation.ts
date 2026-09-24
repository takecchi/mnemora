import { CassetteRecorder } from "@mnemora/testkit";
import { createAnswerBenchRuntime, runAnswerCase } from "../answer-bench.js";
import { ANSWER_CASE_SET_DEV } from "../answer-case-set.dev.js";
import {
  RETENTION_MUTATION_CASE_ID,
  recordRetentionMutationPositiveControl,
} from "../answer-retention-mutation.js";
import { ANSWER_CASSETTE_PATH, loadCassette, saveCassette } from "../cassette-io.js";

/**
 * Issue #498 完了条件4・「回答評価」側の陽性対照を、実 API で**変異分だけ**追加記録する
 * ——**既存の `examples/chat/cassettes/answer.json`（67件）を1バイトも録り直さずに**。
 *
 * ⭐ **通常はこのスクリプトを直接使う必要は無い。** 変異の記録は
 * `recordRetentionMutationPositiveControl`（`../answer-retention-mutation.ts`）として
 * `cli.ts` の `recordAnswer`（＝ `pnpm --filter @mnemora/example-chat run record:answer`）
 * に組み込んである——**以後、誰かが `record answer` を素で（全置換で）走らせれば、
 * この変異分は自動的に一緒に録り直される。** Issue #691/#693 が `answer.json` を
 * 近く全体で録り直す予定であることが分かっているので、この組み込みが本命である。
 *
 * **このスクリプトが要るのは、全12ケース×2経路（24回答生成＋24 judge、約 $0.003）を
 * 録り直さずに、変異分（chat 2回だけ）を既存カセットへ追記したいときだけ**——
 * 実際にこの Issue の残作業を片付けた本 PR がまさにその場合だった。`record answer` は
 * 毎回空の `CassetteRecorder` から始まる全置換なので、既存67件を保ったまま変異だけを
 * 足すには、既存カセットを `CassetteRecorder` へ事前投入し
 * （`RecordingLLMProvider`/`RecordingEmbeddingProvider` の「既に記録済みの鍵は委譲先を
 * 呼ばない」という既存の挙動——ADR 0233 決定1——を利用して）既存分の呼び出しを
 * 実 API へ送らないようにする必要がある。
 *
 * ⚠ **`answer.json` が既に（`record answer` の全置換 or 他の手段で）録り直されていたら、
 * このスクリプトは不要——`recordRetentionMutationPositiveControl` が `recordAnswer` の
 * 経路に組み込まれているので、その録り直し自体に変異分が含まれているはずである。**
 * 万一含まれていない場合（組み込みが後から外された等）は、このスクリプトを
 * そのまま再実行すればよい——既存カセットを毎回読み直して事前投入するので、
 * 何度実行しても安全（冪等ではないが、既存分の呼び出しは常に0回のまま、
 * 変異分だけが新たに追記される）。
 *
 * ## 呼び出し回数（このスクリプトを読めば事前に確定できる。実行前にコードで確定させる規律）
 *
 * 1. `ANSWER_CASE_SET_DEV` から `pref-tea-over-coffee` を取り出し、`runAnswerCase` を
 *    そのまま1回走らせる（段1・健全性確認）——ingest（抽出）・recall・naive/mnemora の
 *    回答生成・naive/mnemora の judge、全部で `complete`/`completeStructured` が
 *    複数回走るが、**入力はどれも `examples/chat/cassettes/answer.json` に既に記録済みの
 *    内容と一致する**（ケース定義を1文字も変えていない）ので、事前投入した
 *    `CassetteRecorder.lookupLLM`/`lookupEmbedding` がすべて命中し、**実 API 呼び出しは
 *    0 回**になるはずである（このスクリプトはその前提を `recorder.llmCount`/
 *    `embeddingCount` の前後比較で検査し、0 でなければ即座に落ちる）。
 * 2. `recordRetentionMutationPositiveControl` が同じケースをもう一度 `runAnswerCase` で
 *    走らせ（これも同じ理由で実 API 呼び出しは0回）、`applyRetentionMutation` で
 *    mnemora 側の回答生成 `PromptSpec` の digest から答えの語を落とし、`complete()` を
 *    1回呼ぶ ⟹ **新規 chat 呼び出し #1**。その回答を使って judge を1回呼ぶ
 *    ⟹ **新規 chat 呼び出し #2**。
 *
 * ⟹ **このスクリプトが実 API に送る呼び出しは、合計ちょうど2回（どちらも
 * `gpt-4o-mini` の chat）。embeddings は0回。** Issue #498 の最新コメントが見積もった
 * 「1ケースあたり chat 2回」と一致する。
 *
 * ⛔ **既存カセットへの書き込みは追記のみ**——`CassetteRecorder.toCassette()` が返す
 * `Map` は事前投入した既存エントリを挿入順のまま保持し、新規の2件はその後に追加される
 * ため、`saveCassette` が書き出す JSON も既存67件が同じ順・同じ内容のまま、末尾に
 * 新規2件が足される形になる（diff で確認すること。書き出し後に
 * `pnpm run format`（prettier）を通すこと——`saveCassette` は素の
 * `JSON.stringify(cassette, null, 2)` を書くため、既存ファイルの prettier
 * 整形（配列を printWidth に合わせて詰める）とは行の折り方が異なり、
 * prettier を通さないと無関係な整形差分で diff が埋まる）。
 */

const usage = () => {
  console.error(
    "使い方: DATABASE_URL=... OPENAI_API_KEY=... " +
      "tsx examples/chat/src/scripts/record-answer-retention-mutation.ts",
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
  // ⭐ 既存エントリを挿入順のまま事前投入する（diff を追記だけにするため）。
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

    // ---------------------------------------------------------------------
    // 段1: 健全性確認（元のケースをそのまま1回走らせる）。既存カセットに記録済みの
    // 入力だけを踏むはずなので、実 API 呼び出しは0回であることを検査する。
    // ---------------------------------------------------------------------
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

    // ---------------------------------------------------------------------
    // 段2: 変異（digest から答えの語を落とす）。ここだけが実 API を叩く。
    // ---------------------------------------------------------------------
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

    // ---------------------------------------------------------------------
    // 書き出し（既存67件 + 新規2件 = 69件のはず）。
    // ---------------------------------------------------------------------
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

import { afterAll, describe, expect, it } from "vitest";
import { createAnswerBenchRuntime, runAnswerCase } from "../answer-bench.js";
import { gradeAnswer } from "../answer-case.js";
import { ANSWER_CASE_SET_DEV } from "../answer-case-set.dev.js";
import { judgeAnswer } from "../answer-judge.js";
import {
  RETENTION_MUTATION_CASE_ID,
  applyRetentionMutation,
} from "../answer-retention-mutation.js";
import { ANSWER_ORDER_LEGEND_CASSETTE_PATH, loadCassette } from "../cassette-io.js";
import {
  closeTestClient,
  getTestClient,
  requireDatabaseUrl,
  resetTestDatabase,
} from "./test-db.js";

/**
 * Issue #498 完了条件4・「回答評価」側の陽性対照（設計コメント §7 の逐語どおりの形。
 * ADR 0236 / PR #523 が未達のまま残した半分）。**記録（カセット）の再生で回る**
 * ——鍵は要らない。
 *
 * ⛔ **ADR 0305（Issue #691 続き）**: `buildMnemoraPrompt` が `order-legend` 描画に
 * 変わったため、再生元を `ANSWER_CASSETTE_PATH`（旧形式、`answer.json`）から
 * `ANSWER_ORDER_LEGEND_CASSETTE_PATH`（新形式、`answer.order-legend.json`）へ向け直した。
 * このファイルは、旧 `answer.json` を種にして `record:answer` 1回で記録した（ADR 0305 §4.5.2）
 * ——`recordRetentionMutationPositiveControl` が同じ実行の中で変異分（下記「実 API の記録」節）
 * も一緒に記録するため、旧形式のときのような専用の追記スクリプト
 * （`record-answer-retention-mutation.ts`）はもう要らない。
 * 新しい記録でも、下の【実測】コメントの outcome（`mutatedVerdict`/`mutatedJudgement.outcome`
 * が両方 `"fail"`）は旧の値のまま一致した。⚠ **次に録り直したら、この outcome を
 * 新しい記録の実測値で確かめ直すこと**
 * ——プロンプトの文言が変わるため、同じ outcome になる保証は無い。
 *
 * ## この歯が示すもの
 *
 * `pref-tea-over-coffee`（`answer-case-set.dev.ts`）を素材に、**同じ実行経路
 * （`ingestConversation` → `queryRecall` → `buildMnemoraPrompt`。本物の Postgres +
 * pgvector、`recorded` provider）が組み立てた mnemora 側 `PromptSpec` から、
 * `applyRetentionMutation`（`../answer-retention-mutation.js`）で答えの語（「紅茶」を
 * 含む部分文字列）だけを落とす**——`sourceObservationId` を指す経路（`ingestConversation`/
 * `queryRecall`）には一切触れていないので、出典は変異の前後で同じ Observation を
 * 指したままである（層1・出典到達は ADR 0236 / PR #523 の単体試験が既に固定済み。
 * ここでは層1を測り直さない）。
 *
 * 1. **変異前**（復元後と同じ内容）: 一次判定（`gradeAnswer`）・二次観測（judge）
 *    ともに `pass`。
 * 2. **変異後**: 一次判定・二次観測ともに `pass` ではない
 *    （実測した記録済みの具体的な outcome を、下の `it` が固定する）。
 * 3. **復元**（元の `PromptSpec` に戻す）: 変異前と同じ `pass` に戻る。
 *
 * ⟹ **「出典到達が変わらないまま、回答評価（層3）が変異で崩れ、復元で戻る」**
 * という、Issue #498 設計コメント §7 が当初計画した陽性対照そのものを、初めて
 * `gradeAnswer`/judge を実際に走らせる形で固定する。
 *
 * ## 実 API の記録（旧形式カセット、`answer.json`。当時の記録——書き換えない）
 *
 * 変異後の2エントリ（mnemora 回答生成1回＋judge 1回）は
 * `examples/chat/src/scripts/record-answer-retention-mutation.ts` で実 API から
 * 追加記録した——既存67件は1バイトも録り直していない（`recorder-answer-retention-mutation.ts`
 * の docstring、PR 本文参照）。
 *
 * **ADR 0305 以降、この節は歴史的な記録である。**新形式カセット
 * （`answer.order-legend.json`）は、上の docstring が書いたとおり `record:answer` 1回で
 * 変異分も含めて記録する——追記専用スクリプトを介さない全置換になる。
 *
 * ## 歯が噛むことの確認（手元でのみ実施——このファイルには残さない）
 *
 * `applyRetentionMutation` を呼ばずに（＝変異を入れずに）下の `it` を走らせると、
 * 「変異後」の行が復元後と同じ `pass`/`pass` になり、3番目のブロックの
 * `.not.toBe("pass")` 系アサーションが赤くなることを手元で確認した——PR 本文参照。
 */
describe("examples/chat answer: 回答評価の陽性対照（記録の再生、Issue #498 完了条件4）", () => {
  afterAll(async () => {
    await closeTestClient();
  });

  it("digest から答えの語を落とすと一次判定・二次観測がともに pass でなくなり、復元すると pass に戻る", async () => {
    await resetTestDatabase();
    await getTestClient();

    const cassette = loadCassette(ANSWER_ORDER_LEGEND_CASSETTE_PATH);
    const handle = await createAnswerBenchRuntime(
      requireDatabaseUrl(),
      { MNEMORA_LLM: "recorded", MNEMORA_EMBEDDING: "recorded" },
      { cassette },
    );
    try {
      expect(handle.llmMode).toBe("recorded");
      expect(handle.embeddingMode).toBe("recorded");

      const answerCase = ANSWER_CASE_SET_DEV.find((c) => c.id === RETENTION_MUTATION_CASE_ID);
      expect(answerCase).toBeDefined();

      // 段1（変異前 = 復元後と同じ内容）: 既存カセットの再生だけで完走する。
      const before = await runAnswerCase(
        handle.runtime,
        handle.llmProvider,
        handle.embeddingProvider,
        handle.judgeLLMProvider,
        answerCase!,
        "answer-retention-positive-control",
      );
      expect(before.mnemora.verdict).toBe("pass");
      expect(before.mnemora.judgement?.outcome).toBe("pass");
      expect(before.mnemora.reconciled).toBe("pass");

      // 段2（変異）: digest から答えの語を落とした PromptSpec を、新しく記録した
      // カセットエントリで再生する。
      const mutatedPromptSpec = applyRetentionMutation(before.mnemora.promptSpec);
      const ctx = { tenantId: "answer-retention-positive-control-mutated" };
      const mutatedResponse = await handle.llmProvider.complete(ctx, mutatedPromptSpec);
      const mutatedVerdict = gradeAnswer(mutatedResponse.content, answerCase!.expected);

      const groundTurnTexts = answerCase!.grounds.turnIndex.map(
        (i) => answerCase!.conversation[i]!.text,
      );
      const mutatedJudgement = await judgeAnswer(handle.judgeLLMProvider, ctx, {
        question: answerCase!.question,
        expectedKind: answerCase!.expected.kind,
        rationale: answerCase!.grounds.rationale,
        groundTurnTexts,
        answer: mutatedResponse.content,
      });

      // ⭐ 本題: 出典到達（層1）に相当する検査はここでは行っていない（ADR 0236 /
      // PR #523 が別の検査で既に固定済み）。ここが固定するのは、その出典到達が
      // 変わらない前提のまま、回答評価（層3）が実際に崩れることだけである。
      //
      // 【実測 2026-09-24、gpt-4o-mini】実 API から記録した値はどちらも "fail"
      // （一次: 空欄の digest から「分かりません。」と回答し、reject/accept のどちらにも
      // 一致しないため fail。二次: judge が「質問に対する具体的な答えを示していない」と
      // 判定して FAIL）。`indeterminate` に丸めた緩い assertion にしていない——記録した
      // 具体的な outcome をそのまま固定する。
      expect(mutatedVerdict).toBe("fail");
      expect(mutatedJudgement.outcome).toBe("fail");

      // 段3（復元）: 変異前と同じ PromptSpec に戻すと、同じ pass/pass に戻る
      // （`before` を再利用する——`applyRetentionMutation` は非破壊なので
      // `before.mnemora.promptSpec` 自体は変異していない）。
      const restoredResponse = await handle.llmProvider.complete(ctx, before.mnemora.promptSpec);
      const restoredVerdict = gradeAnswer(restoredResponse.content, answerCase!.expected);
      const restoredJudgement = await judgeAnswer(handle.judgeLLMProvider, ctx, {
        question: answerCase!.question,
        expectedKind: answerCase!.expected.kind,
        rationale: answerCase!.grounds.rationale,
        groundTurnTexts,
        answer: restoredResponse.content,
      });
      expect(restoredVerdict).toBe("pass");
      expect(restoredJudgement.outcome).toBe("pass");
    } finally {
      await handle.close();
    }
  }, 30_000);
});

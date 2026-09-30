import type { ClaimKeyOptions } from "@mnemora/core";
import { CassetteRecorder } from "@mnemora/testkit";
import { createPostgresClient, closePostgresClient } from "@mnemora/postgres";
import {
  ANSWER_SYSTEM_PROMPT,
  createAnswerBenchRuntime,
  embeddingSpaceSlug,
  runAnswerCase,
} from "../answer-bench.js";
import type { AnswerCase } from "../answer-case.js";
import { ANSWER_CASE_SET_DEV } from "../answer-case-set.dev.js";
import { ANSWER_CASE_SET_EVAL } from "../answer-case-set.eval.js";
import { ANSWER_ORDER_LEGEND_CASSETTE_PATH, loadCassette, saveCassette } from "../cassette-io.js";

/**
 * Issue #1430: 矛盾候補欄の非対称文面（案1）と、system への一文追記（案3）を、実 API
 * （gpt-4o-mini）で測る。#835 候補4（`measure-835-candidate4-answer-quality.ts`、PR #1429）
 * と同じ対象6ケース・n=5・同じ `ClaimKeyOptions` の骨組みを再利用する——
 * 差分は「矛盾候補欄の文面」と「system 文」だけになるようにするため。
 *
 * **対象6ケース**: 訂正4件（`schedule-change-meeting-day`・`negation-moved-city`・
 * `schedule-change-deadline`・`negation-moved-job`）+ 誤検出2件（`unknown-favorite-number`・
 * `other-period-city-this-year`）。
 *
 * **2条件**（`MNEMORA_1430_CONDITION` で選ぶ）:
 * - `"c1"`: 案1（非対称文面）のみ。`runAnswerCase` へ `contestedCorrectionGuidance: false`
 *   を明示的に渡す——system は常に `ANSWER_SYSTEM_PROMPT` のまま
 *   （`runAnswerCase` 自体の既定は Issue #1430・ADR 0379「C2 採用」以降 `true` だが、
 *   この条件では明示的に上書きする）。
 * - `"c2"`: 案1＋案3。`contestedCorrectionGuidance: true` を渡す——実際に非対称文面が
 *   出た回だけ、system に `CONTESTED_CORRECTION_GUIDANCE` が足される（構造として
 *   `hasContestedCorrectionWording` が true の回だけ、という規律。
 *   `resolveMnemoraAnswerSystemPrompt` docstring参照）。
 *
 * claim key は #835 候補4の (A) 印あり条件と同じ
 * `{ enabled: true, detectContested: true, knownPredicatesFromStore: true }` を両条件で使う
 * ——A'（旧文面・印あり、同日の対照、別 worktree の main で `with-tag` 条件を回す）との
 * 差分が「矛盾候補欄の文面／system」だけになるようにするため。
 *
 * **同じ入力・同じ記憶集合にする**ため、claim key 派生の呼び出し以外は種カセット
 * `answer.order-legend.json` から返る（`measure-835-candidate4-answer-quality.ts` と
 * 同じ配線・同じ理由）。
 *
 * 出力: ケースごとに、`[矛盾候補:]` タグ件数・非対称文面（「訂正の可能性」印）が
 * 実際に出たか・system がどちらだったか・mnemora の `verdict`/`judgement.outcome`/
 * `reconciled`・回答本文を記録する。
 *
 * 使い方: `DATABASE_URL=... OPENAI_API_KEY=... MNEMORA_1430_CONDITION=c1|c2 \
 *   MNEMORA_RECORD_CASSETTE_PATH=... pnpm --filter @mnemora/example-chat exec tsx src/scripts/measure-1430-contested-tag-direction.ts`
 */

const TARGET_CASE_IDS = [
  "schedule-change-meeting-day",
  "negation-moved-city",
  "schedule-change-deadline",
  "negation-moved-job",
  "unknown-favorite-number",
  "other-period-city-this-year",
] as const;

const CONDITIONS = ["c1", "c2"] as const;
type Condition = (typeof CONDITIONS)[number];

function resolveCondition(raw: string | undefined): Condition {
  if (raw !== undefined && (CONDITIONS as readonly string[]).includes(raw)) {
    return raw as Condition;
  }
  throw new Error(
    `MNEMORA_1430_CONDITION には ${CONDITIONS.map((c) => `"${c}"`).join(" / ")} の` +
      `いずれかを指定すること（実際: ${JSON.stringify(raw ?? null)}）。`,
  );
}

// #835 候補4の (A) 印あり条件と同じ ClaimKeyOptions（両条件で共通）。
const CLAIM_KEY_OPTIONS: ClaimKeyOptions = {
  enabled: true,
  detectContested: true,
  knownPredicatesFromStore: true,
};

const usage = () => {
  console.error(
    "使い方: DATABASE_URL=... OPENAI_API_KEY=... MNEMORA_1430_CONDITION=c1|c2 " +
      "MNEMORA_RECORD_CASSETTE_PATH=... pnpm --filter @mnemora/example-chat exec tsx src/scripts/measure-1430-contested-tag-direction.ts",
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
  const condition = resolveCondition(process.env.MNEMORA_1430_CONDITION);
  const contestedCorrectionGuidance = condition === "c2";

  const allCases = [...ANSWER_CASE_SET_DEV, ...ANSWER_CASE_SET_EVAL];
  const targetCases: AnswerCase[] = TARGET_CASE_IDS.map((id) => {
    const found = allCases.find((c) => c.id === id);
    if (!found) {
      throw new Error(`ケース "${id}" が見つからない。`);
    }
    return found;
  });

  console.log(
    `[measure-1430] condition=${condition} contestedCorrectionGuidance=${contestedCorrectionGuidance} ` +
      `claimKeyOptions=${JSON.stringify(CLAIM_KEY_OPTIONS)} 対象 ${targetCases.length}ケース ` +
      `outputCassettePath=${outputCassettePath}`,
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
  const tenantPrefix = `measure-1430-${condition}-${runId}`;

  try {
    for (const answerCase of targetCases) {
      const result = await runAnswerCase(
        handle.runtime,
        handle.llmProvider,
        handle.embeddingProvider,
        handle.judgeLLMProvider,
        answerCase,
        tenantPrefix,
        { claimKey: CLAIM_KEY_OPTIONS },
        undefined, // association: 既定のまま
        contestedCorrectionGuidance,
      );
      const mnemoraContent = result.mnemora.promptSpec.messages[0]?.content ?? "";
      const contradictionTagCount = (mnemoraContent.match(/\[矛盾候補:/g) ?? []).length;
      const mnemoraSystem = result.mnemora.promptSpec.system ?? "";
      // `systemExtended`（下記ログ）が、非対称文面（案1）が実際に出たかどうかの構造の
      // 判定結果をそのまま表す——`contestedCorrectionGuidance` を明示している条件では、
      // system が拡張された ⟺ `buildMnemoraPromptDetail` の `hasContestedCorrectionWording`
      // が true だった、という対応になる（`resolveMnemoraAnswerSystemPrompt` の docstring）。

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
        `[measure-1430] case=${answerCase.id} condition=${condition} ` +
          `contradictionTagCount=${contradictionTagCount} contestedMemories=${contestedCount} ` +
          `systemExtended=${mnemoraSystem !== ANSWER_SYSTEM_PROMPT} ` +
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
        `\n[measure-1430] 種カセットの命中: ` +
          `LLM seed=${seedUsage.llm.seeded} real=${seedUsage.llm.real} / ` +
          `embedding seed=${seedUsage.embedding.seeded} real=${seedUsage.embedding.real}`,
      );
    }

    const cassette = recorder.toCassette();
    saveCassette(cassette, outputCassettePath);
    console.log(`\n[measure-1430] 書き出した: ${outputCassettePath}`);
  } finally {
    await closePostgresClient(diagPool);
    await handle.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

import { CassetteRecorder } from "@mnemora/testkit";
import { createPostgresClient, closePostgresClient } from "@mnemora/postgres";
import { resolveAnswerClaimKeyOptions } from "../answer-claim-key-options.js";
import { createAnswerBenchRuntime, embeddingSpaceSlug, runAnswerCase } from "../answer-bench.js";
import { ANSWER_CASE_SET_DEV } from "../answer-case-set.dev.js";
import { ANSWER_CASE_SET_EVAL } from "../answer-case-set.eval.js";
import {
  ANSWER_CLAIM_KEY_CASSETTE_PATH,
  ANSWER_ORDER_LEGEND_CASSETTE_PATH,
  loadCassette,
  saveCassette,
} from "../cassette-io.js";

/**
 * Issue #691 続き（claimKey/detectContested の evaluate、ADR 0324 の続き）。
 *
 * **目的**: `examples/chat` の `answer` 経路（`answer-bench.ts`）だけで、
 * `MNEMORA_ANSWER_CLAIM_KEY=detect`（`answer-claim-key-options.ts`）を opt-in し、
 * `Runtime.observe()` に `claimKey: { enabled: true, detectContested: true }`
 * （`knownPredicates` は渡さない）を渡して dev + eval 全12ケースを実 API で1回ずつ
 * 走らせ、記録済みの回答プロンプトを**新しいカセット**（`answer.claim-key.json`）へ
 * 書き出す。**既存4カセット（`retrieval.json`/`compare.json`/`answer.order-legend.json`/
 * `answer-time-weighting.order-legend.json`）は1バイトも触らない**（ADR 0315 決定4）。
 *
 * **なぜ `answer.order-legend.json` を種カセットにするか（ADR 0309 §4.5.2 の踏襲）**:
 * ADR 0315 決定1・決定2 により、抽出プロンプト（`extraction.ts`）はこの opt-in でも
 * 1バイトも変わらない——claimKey 派生は既存の抽出候補群への**別の構造化呼び出し**
 * （separate、ADR 0315 決定2）であり、抽出そのものの入出力には触れない。⟹
 * 既存カセットを種にすれば、抽出・埋め込み・（矛盾候補タグが増えない）naive 経路の
 * 回答生成はすべて種から返り、**実 API を呼ぶのは claimKey 派生の呼び出しと、実際に
 * 描画が変わった（矛盾候補タグが増えた）mnemora 経路の回答生成・judge 呼び出しだけ**
 * になる——呼び出し回数を抑えつつ、**A（この新カセット）と B（`answer.order-legend.json`）の
 * 記憶集合（抽出結果）を同じに保てる**（このスクリプトの本命の理由。プロンプト末尾の
 * 実測レポートで、実際に何回が種から返り何回が実 API に落ちたかを報告する）。
 *
 * **診断出力**: `runAnswerCase` に `onObserved` フックを渡し、各ターンの
 * `ObserveResult`（`claimKeyFailure`/`contestedDetection`）をそのまま記録する。
 * 実行後、各ケースのテナントに対して `memories` テーブルを直接 SELECT し、
 * `claim_key_subject`/`claim_key_predicate`/`status`/`valid_from`/`valid_until`/
 * `content_hash` を出力する——「なぜ対にならなかったか」を (a)〜(g) の段で切り分ける
 * ための実データ。
 */

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
      "tsx examples/chat/src/scripts/record-answer-claim-key.ts",
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

  const claimKeyOptions = resolveAnswerClaimKeyOptions({ MNEMORA_ANSWER_CLAIM_KEY: "detect" });
  if (claimKeyOptions === undefined) {
    throw new Error("到達しないはず: resolveAnswerClaimKeyOptions が undefined を返した。");
  }
  console.log(
    `[record-answer-claim-key] claimKeyOptions = ${JSON.stringify(claimKeyOptions)}（knownPredicates は渡さない）`,
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
  const allCases = [...ANSWER_CASE_SET_DEV, ...ANSWER_CASE_SET_EVAL];
  const runId = Date.now();
  const tenantPrefix = `answer-claim-key-record-${runId}`;

  try {
    const results: { caseId: string; contradictionTagCount: number }[] = [];
    for (const answerCase of allCases) {
      const result = await runAnswerCase(
        handle.runtime,
        handle.llmProvider,
        handle.embeddingProvider,
        handle.judgeLLMProvider,
        answerCase,
        tenantPrefix,
        {
          claimKey: claimKeyOptions,
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

      // ⭐ このケースのテナントに実際に書かれた memories を直接 SELECT する
      // （診断用。「対になるはずが、なぜならなかったか」の段(a)〜(g)を切り分ける）。
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
    saveCassette(cassette, ANSWER_CLAIM_KEY_CASSETTE_PATH);
    console.log(`\n[record-answer-claim-key] 書き出した: ${ANSWER_CLAIM_KEY_CASSETTE_PATH}`);
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

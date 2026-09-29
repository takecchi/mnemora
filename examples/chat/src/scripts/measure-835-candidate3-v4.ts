import { OpenAILLMProvider } from "@mnemora/openai";
import { CassetteRecorder } from "@mnemora/testkit";
import { createPostgresClient, closePostgresClient } from "@mnemora/postgres";
import { createAnswerBenchRuntime, embeddingSpaceSlug, runAnswerCase } from "../answer-bench.js";
import type { AnswerCase } from "../answer-case.js";
import { ANSWER_CASE_SET_DEV } from "../answer-case-set.dev.js";
import { ANSWER_CASE_SET_EVAL } from "../answer-case-set.eval.js";
import { ANSWER_ORDER_LEGEND_CASSETTE_PATH, loadCassette, saveCassette } from "../cassette-io.js";

/**
 * Issue #835 候補3: ADR 0329 追記（2026-09-25）「負債1を語彙ヒントの文言で塞ぐ試み」が
 * 試作した v4 文言（本ファイル下部 {@link V4_INSTRUCTION_TEMPLATE}、ADR 0329 の追記から
 * 逐語転記）だけを、PR #1424（ADR 0377、Issue #835 候補1）が入った後の main で
 * 再測定する（マネージャー指示）。
 *
 * **同じ物差し**（ADR 0329 追記「測ったこと」節と同一）:
 * - 対象: `answer-case-set.dev.ts`（6件）+ `.eval.ts`（8件）の全14ケース。
 * - 条件: `{ enabled: true, detectContested: true, knownPredicatesFromStore: true }`
 *   （`record-answer-claim-key.ts` の `MNEMORA_RECORD_CONDITION=known-predicates-from-store`
 *   と同じ）。
 * - 記録スクリプトの配線: `record-answer-claim-key.ts` と同じ
 *   （`createAnswerBenchRuntime` → `runAnswerCase` → `CassetteRecorder`）。
 * - 種カセットは常に `answer.order-legend.json` だけ（ADR 0329 決定6 と同じ理由）。
 *
 * **v4 の文言を core（`packages/core/src/claim-key.ts`）へは一切入れない。** 代わりに、
 * この測定スクリプトだけが `OpenAILLMProvider.prototype.completeStructured` を実行時に
 * 差し替え（monkey-patch）、claim key 派生の system プロンプト（`" 既知の predicate
 * 候補一覧: {list}。この一覧に当てはまる場合は必ずそのまま使い、…"` を含むものだけ）を
 * 実 API へ送る**直前**に v4 文言へ書き換える。既定の経路（`buildKnownPredicateInstruction`）
 * にも既存カセットの鍵にも触れない——差し替えは real の直前、実 API へ送る request
 * オブジェクトの上でだけ起きる（`examples/chat/src/scripts/measure-claim-key-835.ts` が
 * 先行して使った「real 層だけを monkey-patch する」手法と同型）。
 *
 * 使い方: `DATABASE_URL=... OPENAI_API_KEY=... MNEMORA_RECORD_CASSETTE_PATH=... \
 *   tsx examples/chat/src/scripts/measure-835-candidate3-v4.ts`
 */

// ---------------------------------------------------------------------------
// v4 文言（ADR 0329 追記 2026-09-25 から逐語転記。試作コードの再現であり、
// core には実装しない——このファイルだけが持つ）
// ---------------------------------------------------------------------------

/** 既定の文言（`claim-key.ts` の `buildKnownPredicateInstruction`）が生成する接尾辞を検出する正規表現。 */
const DEFAULT_SUFFIX_PATTERN =
  / 既知の predicate 候補一覧: (.+?)。この一覧に当てはまる場合は必ずそのまま使い、どれにも当てはまらない場合だけ新しい predicate を作ってください。/;

/**
 * ADR 0329 追記（2026-09-25）「試した4変種」v4 の逐語（原文はブロック引用の折り返しの
 * ため複数行に分かれているが、改行そのものは版組みの都合であり文の一部ではない——
 * ADR 本文を1文字も変えない制約の下、`{predicates}` の前後を機械的に切り出して
 * 連結する。`packages/core/src/__tests__/claim-key.test.ts` 的な「原文との一致」を
 * 保つため、分割元の文字列は ADR から一度も手で書き写していない
 * （このコメントの下の2つの定数は、ADR 0329 の v4 引用ブロックをそのまま抜き出し、
 * `{predicates}` の位置で機械的に2分割しただけである）。
 */
const V4_INSTRUCTION_PREFIX =
  "既知の predicate 候補一覧（このテナント・主題について過去に使われたもの）:";
const V4_INSTRUCTION_SUFFIX =
  "。ある記憶が、一覧のいずれかと同じ主体の同じ属性について述べていると確信できる場合に限り、その predicate を" +
  "そのまま使ってください。以前の値を否定して新しい値に置き換える記憶（例:「エンジニアではなく、デザイナーとして" +
  "働いている」）も、同じ属性について述べていれば含みます。話題が一覧のどれとも異なる場合や、記憶の内容が" +
  "「言及していない」「特に述べていない」「〜したいことがある」のように実質的な主張を持たない場合は、一覧を無理に" +
  "当てはめず、新しい predicate を作ってください。無関係な記憶どうしを同じ predicate にまとめないでください。";

/** `export` は自己検査用（`_smoke-835-v4.ts`、追跡外）が ADR 原文との一致を確かめるため。 */
export function buildV4Instruction(predicatesList: string): string {
  return ` ${V4_INSTRUCTION_PREFIX}${predicatesList}${V4_INSTRUCTION_SUFFIX}`;
}

let patchedCalls = 0;
let sawSuffixCalls = 0;

/**
 * `OpenAILLMProvider.prototype.completeStructured` を書き換える。real（実 API）の直前で
 * だけ効く——`SeededLLMProvider`/`RecordingLLMProvider` はこのインスタンスを包む外側の層
 * であり、書き換え後の `req.prompt.system`（同じオブジェクト参照）をそのままカセットへ
 * 記録する（`RecordingLLMProvider.completeStructured` は呼び出し後に `req.prompt` を鍵に
 * 使う——`cassette-recorder.ts` 参照）。
 */
function installV4Patch(): () => void {
  const proto = OpenAILLMProvider.prototype as unknown as {
    completeStructured: (...args: unknown[]) => Promise<unknown>;
  };
  const original = proto.completeStructured;
  proto.completeStructured = async function patched(this: unknown, ...args: unknown[]) {
    patchedCalls += 1;
    const req = args[1] as { prompt?: { system?: string } } | undefined;
    const system = req?.prompt?.system;
    if (typeof system === "string") {
      const match = DEFAULT_SUFFIX_PATTERN.exec(system);
      if (match) {
        sawSuffixCalls += 1;
        const predicatesList = match[1] ?? "";
        req!.prompt!.system = system.replace(
          DEFAULT_SUFFIX_PATTERN,
          buildV4Instruction(predicatesList),
        );
      }
    }
    return original.apply(this, args as [unknown, unknown, unknown?]);
  };
  return () => {
    proto.completeStructured = original;
  };
}

const usage = () => {
  console.error(
    "使い方: DATABASE_URL=... OPENAI_API_KEY=... MNEMORA_RECORD_CASSETTE_PATH=... " +
      "tsx examples/chat/src/scripts/measure-835-candidate3-v4.ts",
  );
};

interface ObservedTurnDiagnostic {
  caseId: string;
  turnIndex: number;
  extraction: string;
  claimKeyFailure: unknown;
  contestedDetection: unknown;
}

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

  const allCases: AnswerCase[] = [...ANSWER_CASE_SET_DEV, ...ANSWER_CASE_SET_EVAL];
  console.log(
    `[measure-835-candidate3-v4] 対象 ${allCases.length} ケース（dev+eval 全件） ` +
      `outputCassettePath=${outputCassettePath}`,
  );

  const seedCassette = loadCassette(ANSWER_ORDER_LEGEND_CASSETTE_PATH);
  console.log(
    `[measure-835-candidate3-v4] 種カセットを読み込んだ（${ANSWER_ORDER_LEGEND_CASSETTE_PATH}）: ` +
      `LLM ${Object.keys(seedCassette.llm.entries).length}件 / ` +
      `embedding ${Object.keys(seedCassette.embedding.entries).length}件`,
  );

  const uninstall = installV4Patch();
  const recorder = new CassetteRecorder();
  const handle = await createAnswerBenchRuntime(
    databaseUrl,
    { ...process.env, MNEMORA_LLM: "openai", MNEMORA_EMBEDDING: "openai" },
    { recorder, seedCassette },
  );

  const diagPool = createPostgresClient(databaseUrl);
  const diagnostics: ObservedTurnDiagnostic[] = [];
  const runId = Date.now();
  const tenantPrefix = `measure-835-candidate3-v4-${runId}`;

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
          claimKey: { enabled: true, detectContested: true, knownPredicatesFromStore: true },
          onObserved: (turn, observed) => {
            diagnostics.push({
              caseId: answerCase.id,
              turnIndex: turn.index,
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

      const embeddingSpace = embeddingSpaceSlug(handle.embeddingProvider.space);
      const tenantId = `${tenantPrefix}-${embeddingSpace}-${answerCase.id}`;
      const rows = await diagPool.pool.query(
        `SELECT id, subject_id, content, content_hash, status, contested_with_id, source_observation_id,
                claim_key_subject, claim_key_predicate, valid_from, valid_until, recorded_at
         FROM memories WHERE tenant_id = $1 ORDER BY recorded_at ASC`,
        [tenantId],
      );
      console.log(
        `  [${answerCase.id}] memories: ${rows.rowCount}件, [矛盾候補:] タグ=${contradictionTagCount}`,
      );
      for (const row of rows.rows as Record<string, unknown>[]) {
        console.log(
          `    id=${String(row.id).slice(0, 8)} status=${row.status} ` +
            `claim_key=(${row.claim_key_subject ?? "null"}, ${row.claim_key_predicate ?? "null"}) ` +
            `contested_with=${row.contested_with_id ? String(row.contested_with_id).slice(0, 8) : "null"} ` +
            `source_obs=${row.source_observation_id ? String(row.source_observation_id).slice(0, 8) : "null"} ` +
            `content=${JSON.stringify(String(row.content).slice(0, 50))}`,
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
        `\n[measure-835-candidate3-v4] 種カセットの命中: ` +
          `LLM seed=${seedUsage.llm.seeded} real=${seedUsage.llm.real} / ` +
          `embedding seed=${seedUsage.embedding.seeded} real=${seedUsage.embedding.real}`,
      );
    }
    console.log(
      `\n[measure-835-candidate3-v4] v4 monkey-patch: completeStructured 呼び出し ${patchedCalls}件中、` +
        `既知 predicate 接尾辞を検出して書き換えた回数 ${sawSuffixCalls}件`,
    );

    const cassette = recorder.toCassette();
    saveCassette(cassette, outputCassettePath);
    console.log(`\n[measure-835-candidate3-v4] 書き出した: ${outputCassettePath}`);
    console.log(
      `  LLM ${Object.keys(cassette.llm.entries).length}件 / ` +
        `embedding ${Object.keys(cassette.embedding.entries).length}件`,
    );
  } finally {
    uninstall();
    await closePostgresClient(diagPool);
    await handle.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

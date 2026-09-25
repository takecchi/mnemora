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
 * Issue #691 続き（claimKey/detectContested の evaluate、ADR 0324 の続き。
 * ADR 0329 で条件（基準/新案）と保存先を選べる引数を追加）。
 *
 * **目的**: `examples/chat` の `answer` 経路（`answer-bench.ts`）だけで、
 * `MNEMORA_ANSWER_CLAIM_KEY=detect`（`answer-claim-key-options.ts`）を opt-in し、
 * `Runtime.observe()` に `claimKey: { enabled: true, detectContested: true }`
 * （`knownPredicates` は渡さない）を渡して dev + eval 全12ケースを実 API で1回ずつ
 * 走らせ、記録済みの回答プロンプトを**新しいカセット**（`answer.claim-key.json`）へ
 * 書き出す。**既存カセット（`retrieval.json`/`compare.json`/`answer.order-legend.json`/
 * `answer-time-weighting.order-legend.json`・#748 の `answer.claim-key.json`）は
 * 1バイトも触らない**（ADR 0315 決定4）——`MNEMORA_RECORD_CASSETTE_PATH` を渡さない
 * ときの既定の保存先・既定の条件（下記 `MNEMORA_RECORD_CONDITION` 省略時）は
 * この PR の変更前と完全に同じままである。
 *
 * **ADR 0329 が足した2つの環境変数**（両方省略すれば、この PR より前と1バイトも
 * 変わらない挙動になる）:
 *
 * - `MNEMORA_RECORD_CONDITION`（`"baseline"` 省略時の既定 |
 *   `"known-predicates-from-store"` | `"known-subjects"`）:
 *   `"known-predicates-from-store"` を指定すると、`MNEMORA_ANSWER_CLAIM_KEY` を
 *   `"detect-known-predicates-from-store"` に切り替える（`ClaimKeyOptions.
 *   knownPredicatesFromStore: true` を足した新案）。省略・`"baseline"` は従来どおり
 *   `"detect"`（`knownPredicatesFromStore` を渡さない基準）。
 *   **`"known-subjects"`（ADR 0334 負債2、Issue #372負債6の続き）**は、
 *   `MNEMORA_ANSWER_CLAIM_KEY` は `"detect"` のまま、ケースごとに
 *   `AnswerCase.knownSubjects`（作業者が手で埋めた、正解の第三者名。任意項目）を
 *   `applyCaseKnownSubjects`（`answer-claim-key-options.ts`）で
 *   `claimKeyOptions.knownSubjects` へ合流させる——**`knownSubjects` を持たない
 *   ケース（14件中10件）はこの条件でも `claimKeyOptions` が1バイトも変わらない**。
 *   ⚠ **これは上限（オラクル）測定である**（`AnswerCase.knownSubjects` docstring・
 *   `applyCaseKnownSubjects` docstring 参照）——正解を作業者が手で渡した場合の
 *   効き目の上限を見るためのものであり、mnemora が実運用でこの正解を知っている
 *   保証は無い。
 * - `MNEMORA_RECORD_CASSETTE_PATH`（省略時の既定 = {@link ANSWER_CLAIM_KEY_CASSETTE_PATH}）:
 *   書き出し先を上書きする。ADR 0329 の測定は、条件×反復ごとに別ファイル
 *   （`examples/chat/cassettes/` の新しいファイル名）へ書く——このスクリプト自体は
 *   1本の記録しか行わないため、反復は呼び出し側（シェル）が複数回このスクリプトを
 *   別のパスで呼ぶことで実現する。
 *
 * **種カセットは常に `answer.order-legend.json` だけ**（下記変更しない）——基準・新案の
 * どちらの条件でも、#748 の `answer.claim-key.json`（既に claimKey opt-in 込みで
 * 記録済み）を種にしない。#748 を種にすると、claim key 派生の呼び出し自体が
 * 「記録済みの応答の再生」になってしまい、実 API に落ちる対照にならないため
 * （ADR 0329 決定、マネージャー指示）。
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
 *
 * **`MNEMORA_ANSWER_CASE_SET`（ADR 0334 追記 2026-09-26（2）、Issue #372負債6の続き。
 * opt-in、省略時は従来どおり）**: `"default"`（省略時の既定）| `"separate-turn"`。
 * **既定は dev+eval 全14件（この env を足す前と1バイトも変わらない）。**
 * `"separate-turn"` を指定すると、代わりに `ANSWER_CASE_SET_SEPARATE_TURN`
 * （`answer-case-set.separate-turn.ts`、本人の事実と第三者の事実を意図的に別ターン
 * ＝別の `observe()` 呼び出しに分けたケース集合）だけを走らせる——**既存14件の
 * ケースセットは一切参照しない**（両方を混ぜて走らせる経路は無い）。
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

/** `caseSetOption` から実際に走らせるケース集合を選ぶ。既定は dev+eval の14件。 */
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

  // ADR 0329: 条件（基準/新案）と保存先を env で選べる。両方省略すれば、この PR より前と
  // 完全に同じ挙動（"detect"、ANSWER_CLAIM_KEY_CASSETTE_PATH）になる。
  const condition = resolveRecordCondition(process.env.MNEMORA_RECORD_CONDITION);
  const answerClaimKeyMode =
    condition === "known-predicates-from-store" ? "detect-known-predicates-from-store" : "detect";
  const outputCassettePath =
    process.env.MNEMORA_RECORD_CASSETTE_PATH ?? ANSWER_CLAIM_KEY_CASSETTE_PATH;
  // ADR 0334 追記 2026-09-26（2）: ケース集合を env で選べる。省略すれば従来どおり
  // dev+eval の14件（この env を足す前と1バイトも変わらない）。
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
      // ADR 0334 負債2: condition === "known-subjects" のときだけ、このケースの
      // knownSubjects（在れば）を合流させる。他の条件・knownSubjects を持たない
      // ケースでは claimKeyOptions をそのまま返す（1バイトも変わらない）。
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

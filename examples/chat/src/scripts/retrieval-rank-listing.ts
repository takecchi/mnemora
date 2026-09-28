/**
 * 固定回帰ケース(ADR 0227 の門)と同じ条件で probe ごとの順位を一覧にし、Markdown を標準出力へ、
 * 機械可読の JSON を `MNEMORA_RANK_LISTING_JSON` のパスへ書く(Issue #572、ADR 0276 の
 * 2026-09-28 の追記。⛔ 門ではない)。
 *
 * 条件は門と揃える: provider = `recorded`(`examples/chat/cassettes/retrieval.json` の再生。
 * `OPENAI_API_KEY` の有無を見ない)、時計 = `fixedClock(RANK_LISTING_FIXED_CLOCK_ISO)`、
 * 入力 = `probe-set.ts` の `PROBES`(変えない)。
 *
 * **終了コードは順位を見ない**(`decideRankListingExit`)。非0になるのは、DATABASE_URL が無い・
 * カセットに無い入力・DB エラーなどで例外になったときと、一覧を作れなかったときだけである。
 */
import { writeFileSync } from "node:fs";
import { fixedClock } from "@mnemora/core";
import { cassettePathFor, loadCassette } from "../cassette-io.js";
import { PROBES } from "../probe-set.js";
import { runRetrievalQualityArm } from "../retrieval-quality.js";
import {
  RANK_LISTING_FIXED_CLOCK_ISO,
  buildRankListing,
  decideRankListingExit,
  formatRankListingMarkdown,
} from "../retrieval-rank-listing.js";
import { createExampleRuntime } from "../runtime-factory.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL が設定されていません。本物の Postgres + pgvector を要求する。");
  process.exit(1);
}

const cassette = loadCassette(cassettePathFor("retrieval"));
const handle = await createExampleRuntime(
  databaseUrl,
  { MNEMORA_LLM: "recorded", MNEMORA_EMBEDDING: "recorded" },
  { cassette },
  fixedClock(new Date(RANK_LISTING_FIXED_CLOCK_ISO)),
);

let exitCode: number;
try {
  if (handle.llmMode !== "recorded" || handle.embeddingMode !== "recorded") {
    throw new Error(
      `provider が recorded になっていない(llm=${handle.llmMode} embedding=${handle.embeddingMode})`,
    );
  }
  const report = await runRetrievalQualityArm({
    armLabel: "rank-listing",
    tenantId: `retrieval-rank-listing-${Date.now()}`,
    runtime: handle.runtime,
    memoryStore: handle.memoryStore,
    llmMode: handle.llmMode,
    embeddingMode: handle.embeddingMode,
  });
  const listing = buildRankListing(report, RANK_LISTING_FIXED_CLOCK_ISO);
  const jsonPath = process.env.MNEMORA_RANK_LISTING_JSON;
  if (jsonPath) {
    writeFileSync(jsonPath, `${JSON.stringify(listing, null, 2)}\n`, "utf-8");
  }
  console.log(formatRankListingMarkdown(listing));
  const decided = decideRankListingExit(listing, PROBES.length);
  for (const reason of decided.reasons) {
    console.error(`[retrieval-rank-listing] 一覧を作れなかった: ${reason}`);
  }
  exitCode = decided.exitCode;
} finally {
  await handle.close();
}
process.exit(exitCode);

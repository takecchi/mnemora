import type { SeedUsageSummary } from "./providers.js";

/**
 * 「種カセット」（Issue #691 続き、`MNEMORA_RECORD_SEED_CASSETTE`）から再生した件数と、
 * 実 API を呼んだ件数を画面に出す。
 *
 * ⛔ **`usage-meter`（`usage-meter.ts` の `formatReport`/`formatNoApiCallsNotice`）とは
 * 別の実測であり、混ぜて出さない**（マネージャー指示）。あちらは「この run で OpenAI の
 * API を実際に何回叩き・何トークン使い・いくら掛かったか」を計測する——こちらは
 * 「その呼び出しのうち、どれだけが種カセットで肩代わりされたか」を計測する。
 * 前者の呼び出し回数（`chatCalls`/`embeddingCalls`）は後者の `real` 分と一致するはずだが、
 * **この関数は突き合わせない**——突き合わせは呼び出し側（人）の仕事にする。
 */
export function formatSeedUsageReport(usage: SeedUsageSummary): string {
  const total = (counts: SeedUsageSummary["llm"]): number => counts.seeded + counts.real;
  return [
    "--- 種カセットからの再生（usage-meter とは別の実測） ---",
    `LLM      : 種から再生 ${usage.llm.seeded} 件 / 実 API を呼んだ ${usage.llm.real} 件 ` +
      `（計 ${total(usage.llm)} 件）`,
    `埋め込み  : 種から再生 ${usage.embedding.seeded} 件 / 実 API を呼んだ ${usage.embedding.real} 件 ` +
      `（計 ${total(usage.embedding)} 件）`,
  ].join("\n");
}

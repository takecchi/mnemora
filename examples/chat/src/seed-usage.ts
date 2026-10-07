import type { SeedUsageSummary } from "./providers.js";

/** `usage-meter` の実測とは別物なので、混ぜて出さず、突き合わせもしない（呼び出し側の仕事）。 */
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

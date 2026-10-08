import type { RecallResult } from "@mnemora/core";
import { scoreTotalOrNull } from "./recalled-score.js";

export function formatRecall(result: RecallResult, label: string): string {
  const lines: string[] = [];
  lines.push(`--- recall (${label}) ---`);
  lines.push(`memories: ${result.memories.length} 件返却`);
  for (const m of result.memories) {
    // 連想枠（affinityMeasured: false）は total を持たないので「n/a」にする。
    const total = scoreTotalOrNull(m.score);
    const scoreText = "n/a";
    lines.push(`  - [${m.retrievedVia}] score=${scoreText} digest="${m.digest}"`);
  }
  lines.push(`omitted (${result.omitted.length} 件):`);
  if (result.omitted.length === 0) {
    lines.push("  (無し)");
  }
  for (const o of result.omitted) {
    lines.push(`  - ${JSON.stringify(o)}`);
  }
  lines.push(
    `index: totalInScope=${result.index.totalInScope} (countKind=${result.index.countKind}), groups=${result.index.groups.length}`,
  );
  lines.push(
    `usage: chars=${result.usage.chars} estimatedTokens=${result.usage.estimatedTokens} ` +
      `(counter=${result.usage.counter})${
        result.usage.share !== undefined ? ` share=${(result.usage.share * 100).toFixed(1)}%` : ""
      }`,
  );
  return lines.join("\n");
}

/**
 * `chat` の「まとめ」の行を組み立てる。mnemora の2行には、予算の対象になった量と予算の外の目次帯（`usage.indexChars`）の内訳を並べる。
 * 内訳が無いと、目次帯へ回った分で「予算を渡したら増えた」と読めてしまう。
 */
export function formatChatSummary(
  naiveChars: number,
  withoutBudget: Pick<RecallResult, "usage">,
  withBudget: Pick<RecallResult, "usage">,
): string {
  const mnemoraLine = (usage: RecallResult["usage"]): string =>
    `${usage.chars}（予算の対象 ${usage.chars - usage.indexChars} + 予算の外の目次帯 indexChars=${usage.indexChars}）`;
  return [
    `naive chars                  : ${naiveChars}`,
    `mnemora chars (budget 無し)      : ${mnemoraLine(withoutBudget.usage)}`,
    `mnemora chars (budget あり)      : ${mnemoraLine(withBudget.usage)}`,
    "  ⚠ 目次帯は予算の対象外（何が在るかは予算に関係なく言う）。予算で落とした記憶が目次帯へ回ると、" +
      "予算を渡した run の全量は渡さない run より大きくなりうる。",
  ].join("\n");
}

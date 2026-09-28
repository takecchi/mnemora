import type { RecallResult } from "@mnemora/core";
import { scoreTotalOrNull } from "./recalled-score.js";

/**
 * `recall()` の返り値のうち、roadmap.md 段階7の完了条件そのものである
 * `omitted` と `usage` を画面に可視化する（PR 本文「omitted と usage を可視化する」）。
 */
export function formatRecall(result: RecallResult, label: string): string {
  const lines: string[] = [];
  lines.push(`--- recall (${label}) ---`);
  lines.push(`memories: ${result.memories.length} 件返却`);
  for (const m of result.memories) {
    // Issue #548 方向2 / ADR 0351: affinityMeasured: false（連想枠・必須の同伴取得）は
    // total を持たない——表示は「n/a」にする（比較可能な total ではないことをそのまま出す）。
    const total = scoreTotalOrNull(m.score);
    const scoreText = total === null ? "n/a" : total.toFixed(3);
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
 * `chat` の「まとめ」の行（naive と、budget 無し／あり の mnemora の文字数）を組み立てる。
 *
 * mnemora の2行には内訳——予算の対象になった量（`chars - indexChars`）と、予算の外の
 * 目次帯（`usage.indexChars`）——を並べる。目次帯は予算の対象外なので、予算で落とした
 * 記憶が目次帯へ回ると、予算を渡した run の全量は渡さない run より大きくなりうる。
 * 内訳が無いと「予算を渡したら増えた」と読める（歯は `__tests__/format.test.ts`）。
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

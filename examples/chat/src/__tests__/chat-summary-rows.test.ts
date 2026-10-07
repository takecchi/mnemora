import { describe, expect, it } from "vitest";
import { formatChatSummary } from "../format.js";

const usage = (chars: number, indexChars: number) =>
  ({
    usage: {
      chars,
      estimatedTokens: 0,
      counter: "heuristic",
      byTier: { full: 0, digest: chars - indexChars, index: indexChars },
      indexChars,
    },
  }) as never;

// 行ごとに見る。format.test.ts は全体への toContain なので、budget 無し・ありの行が入れ替わっても通ってしまう。
describe("formatChatSummary — 行ごとの中身", () => {
  const lines = formatChatSummary(441, usage(346, 40), usage(793, 599)).split("\n");
  const row = (prefix: string) => {
    const found = lines.find((l) => l.startsWith(prefix));
    expect(found, `${prefix} の行が無い`).toBeDefined();
    return found as string;
  };

  it("budget 無しの行は budget 無しの値と内訳を持つ", () => {
    const text = row("mnemora chars (budget 無し)");
    expect(text).toContain("346（予算の対象 306 + 予算の外の目次帯 indexChars=40）");
  });

  it("budget ありの行は budget ありの値と内訳を持つ", () => {
    const text = row("mnemora chars (budget あり)");
    expect(text).toContain("793（予算の対象 194 + 予算の外の目次帯 indexChars=599）");
  });

  it("naive の行を残す", () => {
    expect(row("naive chars")).toContain("441");
  });
});

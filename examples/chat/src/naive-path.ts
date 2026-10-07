import type { TokenCounter } from "@mnemora/core";
import type { Conversation } from "./scenario.js";

export interface PathMeasurement {
  chars: number;
  estimatedTokens: number;
  counter: "heuristic" | "exact";
}

/** 経路A（naive）: 会話ログを全部プロンプトへ積む。システムプロンプト無しの生の transcript だけを作るので、実際のアプリでの削減の絶対値はここで測る数字より大きくなりうる。 */
export function naivePrompt(conversation: Conversation): string {
  return conversation.turns.map((t) => `${t.role}: ${t.text}`).join("\n");
}

export function measureNaive(
  conversation: Conversation,
  tokenCounter: TokenCounter,
): PathMeasurement {
  const text = naivePrompt(conversation);
  const counted = tokenCounter.count(text);
  return { chars: text.length, estimatedTokens: counted.tokens, counter: counted.counter };
}

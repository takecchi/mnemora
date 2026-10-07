import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { PromptSpec } from "@mnemora/core";
import { llmCassetteKey } from "@mnemora/testkit";
import { ANSWER_SYSTEM_PROMPT, CONTESTED_CORRECTION_GUIDANCE } from "../answer-bench.js";
import { ORDER_LEGEND_LINE } from "../mnemora-path.js";
import type { CaseMaterial } from "../answer-trials-material.js";
import { parseMnemoraPromptBody } from "../answer-trials-material.js";
import { recordedRenderer } from "../answer-trials-render.js";

// loadAnswerTrialsMaterial を経由せず、カセットを直接読む。C2 のカセットは system 文が ANSWER_SYSTEM_PROMPT そのものではなく、
// 既定カセット向けの絞り込み（system === ANSWER_SYSTEM_PROMPT）が当てはまらないため。

function cassettePath(fileName: string): string {
  return fileURLToPath(new URL(`../../cassettes/${fileName}`, import.meta.url));
}

interface RawCassetteLlmEntry {
  prompt: { system?: string; messages: { role: string; content: string }[] };
}

interface RawCassette {
  llm: { entries: Record<string, RawCassetteLlmEntry> };
}

function loadRawCassette(fileName: string): RawCassette {
  return JSON.parse(readFileSync(cassettePath(fileName), "utf8")) as RawCassette;
}

function findAsymmetricMnemoraEntry(cassette: RawCassette): {
  key: string;
  system: string;
  content: string;
} {
  const found = Object.entries(cassette.llm.entries).find(([, entry]) => {
    const message = entry.prompt.messages[0];
    if (message === undefined) {
      return false;
    }
    const content = message.content;
    const isMnemoraShaped = content.startsWith("- [由来:") || content.startsWith(ORDER_LEGEND_LINE);
    return (
      isMnemoraShaped &&
      (content.includes("（訂正の可能性）") || content.includes("（訂正された可能性）"))
    );
  });
  if (found === undefined) {
    throw new Error("非対称文面を含む mnemora 経路の回答プロンプトがカセットに見つからない。");
  }
  const [key, entry] = found;
  const message = entry.prompt.messages[0];
  if (message === undefined) {
    throw new Error("見つかったエントリに messages[0] が無い。");
  }
  return { key, system: entry.prompt.system ?? "", content: message.content };
}

function splitBodyAndQuestion(content: string): { body: string; question: string } {
  const marker = "\n\n質問: ";
  const idx = content.lastIndexOf(marker);
  if (idx === -1) {
    throw new Error(`content に質問の接尾辞（"${marker}"）が見つからない: ${content}`);
  }
  return { body: content.slice(0, idx), question: content.slice(idx + marker.length) };
}

describe(
  "Issue #1430: 測定で録った C1/C2 カセットの非対称文面プロンプトを、コードから" +
    "組み直して llmCassetteKey で引ける（DB/API 不要）",
  () => {
    it("C1（案1のみ）: system は ANSWER_SYSTEM_PROMPT のまま", () => {
      const cassette = loadRawCassette("answer.claim-key.issue1430-c1-1.json");
      const found = findAsymmetricMnemoraEntry(cassette);
      expect(found.system).toBe(ANSWER_SYSTEM_PROMPT);

      const { body, question } = splitBodyAndQuestion(found.content);
      const parsed = parseMnemoraPromptBody(body);
      const material: CaseMaterial = {
        caseId: "issue-1430-c1-replay",
        question,
        system: found.system,
        totalInScope: parsed.totalInScope,
        presented: parsed.presented,
        lines: parsed.lines,
        hasOrderLegend: parsed.hasOrderLegend,
        rawContent: found.content,
        fingerprint: "unused-in-this-test",
      };

      const rebuiltContent = recordedRenderer.renderUserContent(material);
      expect(rebuiltContent).toBe(found.content);

      const rebuiltPromptSpec: PromptSpec = {
        system: found.system,
        messages: [{ role: "user", content: rebuiltContent }],
      };
      expect(llmCassetteKey(rebuiltPromptSpec)).toBe(found.key);
    });

    it("C2（案1+案3）: system は ANSWER_SYSTEM_PROMPT + CONTESTED_CORRECTION_GUIDANCE", () => {
      const cassette = loadRawCassette("answer.claim-key.issue1430-c2-1.json");
      const found = findAsymmetricMnemoraEntry(cassette);
      expect(found.system).toBe(`${ANSWER_SYSTEM_PROMPT}${CONTESTED_CORRECTION_GUIDANCE}`);
      expect(found.system).not.toBe(ANSWER_SYSTEM_PROMPT);

      const { body, question } = splitBodyAndQuestion(found.content);
      const parsed = parseMnemoraPromptBody(body);
      const material: CaseMaterial = {
        caseId: "issue-1430-c2-replay",
        question,
        system: found.system,
        totalInScope: parsed.totalInScope,
        presented: parsed.presented,
        lines: parsed.lines,
        hasOrderLegend: parsed.hasOrderLegend,
        rawContent: found.content,
        fingerprint: "unused-in-this-test",
      };

      const rebuiltContent = recordedRenderer.renderUserContent(material);
      expect(rebuiltContent).toBe(found.content);

      const rebuiltPromptSpec: PromptSpec = {
        system: found.system,
        messages: [{ role: "user", content: rebuiltContent }],
      };
      expect(llmCassetteKey(rebuiltPromptSpec)).toBe(found.key);
    });
  },
);

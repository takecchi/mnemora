import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CORRECTION_SCENARIO } from "../correction-scenario.js";
import { DEFAULT_COMPARE_SEQUENCE } from "../compare.js";
import { FACT_STATEMENT, QUERY_TEXT, buildConversation } from "../scenario.js";

function readSourceText(relativePath: string): string {
  const url = new URL(relativePath, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf-8");
}

describe("correction シナリオは compare の import グラフに入っていない", () => {
  it("correction-demo.ts は compare/scenario/probe-set/naive-path のいずれも import しない", () => {
    const source = readSourceText("../correction-demo.ts");
    for (const forbidden of [
      "./compare.js",
      "./compare-json.js",
      "./scenario.js",
      "./probe-set.js",
      "./naive-path.js",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it("correction-scenario.ts は compare/scenario/probe-set/naive-path のいずれも import しない", () => {
    const source = readSourceText("../correction-scenario.ts");
    for (const forbidden of [
      "./compare.js",
      "./compare-json.js",
      "./scenario.js",
      "./probe-set.js",
      "./naive-path.js",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it("🔴 逆方向の依存も無い: compare.ts / scenario.ts は 'correction' という語を含まない", () => {
    const compareSource = readSourceText("../compare.ts");
    const scenarioSource = readSourceText("../scenario.ts");
    expect(compareSource.toLowerCase()).not.toContain("correction");
    expect(scenarioSource.toLowerCase()).not.toContain("correction");
  });
});

describe("compare が実測に使う値は、このシナリオを足しても変わっていない", () => {
  it("DEFAULT_COMPARE_SEQUENCE は既知の12点のまま(fillerPairs、ADR 0133 の turnCount = 2×(値+1))", () => {
    expect(DEFAULT_COMPARE_SEQUENCE).toEqual([0, 1, 2, 3, 4, 5, 10, 20, 40, 80, 160, 320]);
  });

  it("FACT_STATEMENT / QUERY_TEXT は既知の文言のまま", () => {
    expect(FACT_STATEMENT).toBe("私の好きな色は青です。誕生日は4月3日です。");
    expect(QUERY_TEXT).toBe("ところで、わたしの好きな色を覚えていますか?");
  });

  it("buildConversation(2) の出力は既知の形のまま(会話生成関数の構造を変えていない)", () => {
    const conversation = buildConversation(2);
    expect(conversation.turns).toHaveLength(6);
    expect(conversation.turns[0]).toMatchObject({ role: "user", text: FACT_STATEMENT });
    expect(conversation.userUtterances).toHaveLength(3);
  });
});

describe("correction シナリオの externalId は compare/probe-set の externalId と衝突しない", () => {
  it("correction-scenario の externalId は 'correction-demo-' で始まり、他のシナリオの命名空間と重ならない", () => {
    expect(CORRECTION_SCENARIO.original.externalId.startsWith("correction-demo-")).toBe(true);
    expect(CORRECTION_SCENARIO.correction.externalId.startsWith("correction-demo-")).toBe(true);
  });
});

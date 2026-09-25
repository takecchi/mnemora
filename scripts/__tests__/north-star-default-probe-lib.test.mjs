import { describe, expect, it } from "vitest";
import {
  NORTH_STAR_ITEM_REGISTRY,
  buildFatalFallbackMarkdown,
  buildRegistryReport,
  buildSummaryMarkdown,
  countAdopterSuppliedMarks,
  extractGoalStatements,
} from "../north-star-default-probe-lib.mjs";

/**
 * `scripts/north-star-default-probe-lib.mjs` の歯（Issue #387 / ADR 0216 決定7「段1」）。
 *
 * `north-star-default-probe.mjs`（実際に `Runtime` を組んで観測する側）は、ここでは
 * 走らせない——`association-summary.mjs`/`-lib.mjs` と同じ分担で、この歯が見るのは
 * 純関数（登録簿の突き合わせ・ADOPTER-SUPPLIED の集計・Markdown 組み立て）だけである。
 */

const CANON_GOAL_MARKDOWN = `# north star

## 目指す姿

- **言ったことを、次の日も覚えている。**
- **聞かれていないことを、自分から思い出す。**
- **なぜそれを思い出したのかを、後から説明できる。**
- **使われない記憶が、静かに遠ざかる。**——消えるのではなく、遠ざかる。
- **間違いを正すと、古いほうが先に出てこなくなる。**
- **知らないことを、知らないと言える。**——「見つからなかった」と「探していない」を、同じ顔で返さない。
- **どれだけ載せるかを、使う側が決められる。**

## 物差し

本文。
`;

describe("NORTH_STAR_ITEM_REGISTRY", () => {
  it("全7行が出典を持つ", () => {
    expect(NORTH_STAR_ITEM_REGISTRY).toHaveLength(7);
    for (const entry of NORTH_STAR_ITEM_REGISTRY) {
      expect(entry.source).toBe("ADR 0216 決定1");
    }
  });

  it("類は甲・乙・丙のいずれかで、ADR 0216 決定1の割り当てと一致する", () => {
    const byItem = new Map(NORTH_STAR_ITEM_REGISTRY.map((entry) => [entry.item, entry.class]));
    // ADR 0216 決定1: 甲 = 1・2・5・6 / 乙 = 7 / 丙 = 3・4。
    expect(byItem.get(1)).toBe("甲");
    expect(byItem.get(2)).toBe("甲");
    expect(byItem.get(3)).toBe("丙");
    expect(byItem.get(4)).toBe("丙");
    expect(byItem.get(5)).toBe("甲");
    expect(byItem.get(6)).toBe("甲");
    expect(byItem.get(7)).toBe("乙");
    for (const entry of NORTH_STAR_ITEM_REGISTRY) {
      expect(["甲", "乙", "丙"]).toContain(entry.class);
    }
  });

  it("すべての行の excerpt が、実際の docs/north-star.md「## 目指す姿」の文面と一致する", () => {
    const extracted = extractGoalStatements(CANON_GOAL_MARKDOWN);
    expect(extracted.ok).toBe(true);
    const report = buildRegistryReport(extracted.statements, NORTH_STAR_ITEM_REGISTRY);
    expect(report.unassignedCanonStatements).toEqual([]);
    expect(report.registryEntriesMissingFromCanon).toEqual([]);
    for (const row of report.rows) {
      expect(row.foundInCanon).toBe(true);
    }
  });
});

describe("extractGoalStatements", () => {
  it("「## 目指す姿」節の箇条を、太字部分だけ逐語で取り出す", () => {
    const result = extractGoalStatements(CANON_GOAL_MARKDOWN);
    expect(result.ok).toBe(true);
    expect(result.statements).toEqual([
      "言ったことを、次の日も覚えている。",
      "聞かれていないことを、自分から思い出す。",
      "なぜそれを思い出したのかを、後から説明できる。",
      "使われない記憶が、静かに遠ざかる。",
      "間違いを正すと、古いほうが先に出てこなくなる。",
      "知らないことを、知らないと言える。",
      "どれだけ載せるかを、使う側が決められる。",
    ]);
  });

  it("見出しが無ければ ok:false", () => {
    const result = extractGoalStatements("# north star\n\n## 物差し\n\n本文\n");
    expect(result.ok).toBe(false);
  });

  it("見出しはあるが箇条が1つも無ければ ok:false", () => {
    const result = extractGoalStatements("# north star\n\n## 目指す姿\n\n本文だけ\n\n## 物差し\n");
    expect(result.ok).toBe(false);
  });

  it("次の見出しの手前で節を打ち切る（後続の節の箇条を拾わない）", () => {
    const markdown = `## 目指す姿\n\n- **項目A。**\n\n## 別の節\n\n- **これは拾わない。**\n`;
    const result = extractGoalStatements(markdown);
    expect(result.ok).toBe(true);
    expect(result.statements).toEqual(["項目A。"]);
  });
});

describe("buildRegistryReport", () => {
  const registry = [
    { item: 1, excerpt: "文面A", class: "甲", source: "ADR 0216 決定1" },
    { item: 2, excerpt: "文面B", class: "乙", source: "ADR 0216 決定1" },
  ];

  it("正典側に登録簿に無い項目があれば unassignedCanonStatements に出る（推測で埋めない）", () => {
    const report = buildRegistryReport(["文面A", "文面C（新項目）"], registry);
    expect(report.unassignedCanonStatements).toEqual(["文面C（新項目）"]);
    // 「文面B」は正典に無いので missing 側に出る。
    expect(report.registryEntriesMissingFromCanon.map((e) => e.item)).toEqual([2]);
    // foundInCanon は文面Aの行だけ true。
    const rowByItem = new Map(report.rows.map((row) => [row.entry.item, row.foundInCanon]));
    expect(rowByItem.get(1)).toBe(true);
    expect(rowByItem.get(2)).toBe(false);
  });

  it("登録簿の項目が正典に無いと検出して報告する", () => {
    const report = buildRegistryReport(["文面A"], registry);
    expect(report.registryEntriesMissingFromCanon).toHaveLength(1);
    expect(report.registryEntriesMissingFromCanon[0].item).toBe(2);
  });

  it("完全一致すれば unassigned も missing も空", () => {
    const report = buildRegistryReport(["文面A", "文面B"], registry);
    expect(report.unassignedCanonStatements).toEqual([]);
    expect(report.registryEntriesMissingFromCanon).toEqual([]);
    expect(report.rows.every((row) => row.foundInCanon)).toBe(true);
  });
});

describe("countAdopterSuppliedMarks", () => {
  it("項目ごとに種別別の件数を数える", () => {
    const source = `
      // ADOPTER-SUPPLIED(item1): 配線 — 何かの説明
      const a = 1;
      // ADOPTER-SUPPLIED(item2): データ — maxCount は採用者が決める
      const b = 2;
      // ADOPTER-SUPPLIED(item2): 配線 — ストア構築だけ
      const c = 3;
    `;
    const tally = countAdopterSuppliedMarks(source);
    expect(tally.get("item1")).toEqual({ 配線: 1, データ: 0, 判定: 0 });
    expect(tally.get("item2")).toEqual({ 配線: 1, データ: 1, 判定: 0 });
  });

  it("印が無いソースからは空の Map を返す", () => {
    const tally = countAdopterSuppliedMarks("const x = 1;\n");
    expect(tally.size).toBe(0);
  });

  it("判定の印も数える（このライブラリ自身は判定しない——数えるだけ）", () => {
    const tally = countAdopterSuppliedMarks(
      "// ADOPTER-SUPPLIED(item5): 判定 — contestedPair のようなもの\n",
    );
    expect(tally.get("item5")).toEqual({ 配線: 0, データ: 0, 判定: 1 });
  });
});

describe("buildSummaryMarkdown", () => {
  const baseRegistryReport = buildRegistryReport(
    ["文面A", "文面B", "文面C", "文面D", "文面E", "文面F", "文面G"],
    [
      { item: 1, excerpt: "文面A", class: "甲", source: "ADR 0216 決定1" },
      { item: 2, excerpt: "文面B", class: "甲", source: "ADR 0216 決定1" },
      { item: 3, excerpt: "文面C", class: "丙", source: "ADR 0216 決定1" },
      { item: 4, excerpt: "文面D", class: "丙", source: "ADR 0216 決定1" },
      { item: 5, excerpt: "文面E", class: "甲", source: "ADR 0216 決定1" },
      { item: 6, excerpt: "文面F", class: "甲", source: "ADR 0216 決定1" },
      { item: 7, excerpt: "文面G", class: "乙", source: "ADR 0216 決定1" },
    ],
  );

  const baseItemResults = [
    { item: 1, mode: "measured", fact: "観測1の事実。" },
    { item: 2, mode: "measured", fact: "観測2の事実。" },
    { item: 3, mode: "not-measured", fact: "機械に載せない。" },
    { item: 4, mode: "not-measured", fact: "機械に載せない。" },
    { item: 5, mode: "measured", fact: "観測5の事実。" },
    { item: 6, mode: "measured", fact: "観測6の事実。" },
    { item: 7, mode: "measured", fact: "観測7の事実。" },
  ];

  /** 段1相当のダミー `stage`（このテストでは文面の逐語一致は見ない）。 */
  const stage1 = {
    label: "段1",
    scopeNote:
      "⚠ **段1: ワークスペース解決で測っている。出荷物（tarball）で測ったとは名乗らない**（テスト用の断り）。",
  };

  it("冒頭の断りをすべて含む", () => {
    const markdown = buildSummaryMarkdown({
      stage: stage1,
      registryReport: baseRegistryReport,
      canonError: null,
      itemResults: baseItemResults,
      adopterSuppliedTally: new Map(),
      generatedAt: "2026-09-25T00:00:00.000Z",
    });
    expect(markdown).toContain("出荷物（tarball）で測ったとは名乗らない");
    expect(markdown).toContain("これは判定ではない");
    expect(markdown).toContain("門ではない。常に exit 0");
    expect(markdown).toContain("`packages/postgres` は1バイトも測らない");
  });

  it("stage.label が見出しに出る（段1と段2の出力を見分けられる）", () => {
    const markdown = buildSummaryMarkdown({
      stage: { label: "段2（tarball を install して測った）", scopeNote: "断り。" },
      registryReport: baseRegistryReport,
      canonError: null,
      itemResults: baseItemResults,
      adopterSuppliedTally: new Map(),
      generatedAt: "2026-09-25T00:00:00.000Z",
    });
    expect(
      markdown.startsWith(
        "# 北極星7項目・既定差分の一覧（段2（tarball を install して測った）、Issue #387 / ADR 0216）",
      ),
    ).toBe(true);
  });

  it("extraSections を ADOPTER-SUPPLIED節の後・「確かめていないこと」の前に足す", () => {
    const markdown = buildSummaryMarkdown({
      stage: stage1,
      registryReport: baseRegistryReport,
      canonError: null,
      itemResults: baseItemResults,
      adopterSuppliedTally: new Map(),
      generatedAt: "2026-09-25T00:00:00.000Z",
      extraSections: ["## tarball install の経路\n\n観測した事実。"],
    });
    const adopterIndex = markdown.indexOf("## ADOPTER-SUPPLIED");
    const extraIndex = markdown.indexOf("## tarball install の経路");
    const caveatsIndex = markdown.indexOf("## このスクリプトが確かめていないこと");
    expect(adopterIndex).toBeGreaterThan(-1);
    expect(extraIndex).toBeGreaterThan(adopterIndex);
    expect(caveatsIndex).toBeGreaterThan(extraIndex);
  });

  it("extraCaveats を「確かめていないこと」の箇条書きに足す", () => {
    const markdown = buildSummaryMarkdown({
      stage: stage1,
      registryReport: baseRegistryReport,
      canonError: null,
      itemResults: baseItemResults,
      adopterSuppliedTally: new Map(),
      generatedAt: "2026-09-25T00:00:00.000Z",
      extraCaveats: ["段2固有の確かめていないこと。"],
    });
    expect(markdown).toContain("- 段2固有の確かめていないこと。");
  });

  it("観測セクション（項目ごとの事実）は判定語（満たす/満たさない/半分）を名乗らない", () => {
    const markdown = buildSummaryMarkdown({
      stage: stage1,
      registryReport: baseRegistryReport,
      canonError: null,
      itemResults: baseItemResults,
      adopterSuppliedTally: new Map(),
      generatedAt: "2026-09-25T00:00:00.000Z",
    });
    // 冒頭の断り・ADOPTER-SUPPLIED節は、方針そのもの（ADR 0216 決定4-2の逐語）を
    // 説明するために「半分」等の語を自己言及として含みうる——それは判定として書いて
    // いることとは違う。判定語が実際に混ざってはいけないのは、項目ごとの事実を書く
    // 「## 観測」セクションであり、ここだけを切り出して見る。
    const observationsStart = markdown.indexOf("## 観測");
    const observationsEnd = markdown.indexOf("## ADOPTER-SUPPLIED");
    expect(observationsStart).toBeGreaterThan(-1);
    expect(observationsEnd).toBeGreaterThan(observationsStart);
    const observationsSection = markdown.slice(observationsStart, observationsEnd);
    expect(observationsSection).not.toContain("満たす");
    expect(observationsSection).not.toContain("半分");
    // 「在る6 / 半分1」のような件数を焼き込まない。
    expect(observationsSection).not.toMatch(/在る\d/);
  });

  it("項目ごとの観測結果（事実）をすべて含む", () => {
    const markdown = buildSummaryMarkdown({
      stage: stage1,
      registryReport: baseRegistryReport,
      canonError: null,
      itemResults: baseItemResults,
      adopterSuppliedTally: new Map(),
      generatedAt: "2026-09-25T00:00:00.000Z",
    });
    for (const result of baseItemResults) {
      expect(markdown).toContain(result.fact);
    }
  });

  it("正典を読めなかった場合（canonError）は、その旨を出し、未割り当て/文面相違の節は出さない", () => {
    const markdown = buildSummaryMarkdown({
      stage: stage1,
      registryReport: baseRegistryReport,
      canonError: "docs/north-star.md が読めなかった: ENOENT",
      itemResults: baseItemResults,
      adopterSuppliedTally: new Map(),
      generatedAt: "2026-09-25T00:00:00.000Z",
    });
    expect(markdown).toContain("docs/north-star.md から文面を読めなかった");
    expect(markdown).not.toContain("未割り当て（正典に在るが");
  });

  it("mode:'print-failed' の項目は🔴の見出しと「印字に失敗した」の本文を出す（個別観測のthrowを全体に波及させない設計の印字側）", () => {
    const itemResultsWithFailure = baseItemResults.map((result) =>
      result.item === 5
        ? { item: 5, mode: "print-failed", fact: "印字に失敗した: 何かの理由" }
        : result,
    );
    const markdown = buildSummaryMarkdown({
      stage: stage1,
      registryReport: baseRegistryReport,
      canonError: null,
      itemResults: itemResultsWithFailure,
      adopterSuppliedTally: new Map(),
      generatedAt: "2026-09-25T00:00:00.000Z",
    });
    expect(markdown).toContain("🔴（印字に失敗した）");
    expect(markdown).toContain("印字に失敗した: 何かの理由");
    // 他の項目は無傷で残っている（全体が落ちていないことの印字側の証拠）。
    expect(markdown).toContain("観測1の事実。");
    expect(markdown).toContain("観測7の事実。");
  });

  it("ADOPTER-SUPPLIED の集計を表として出す", () => {
    const tally = new Map([
      ["item1", { 配線: 1, データ: 0, 判定: 0 }],
      ["item7", { 配線: 1, データ: 1, 判定: 0 }],
    ]);
    const markdown = buildSummaryMarkdown({
      stage: stage1,
      registryReport: baseRegistryReport,
      canonError: null,
      itemResults: baseItemResults,
      adopterSuppliedTally: tally,
      generatedAt: "2026-09-25T00:00:00.000Z",
    });
    expect(markdown).toContain("| item1 | 1 | 0 | 0 |");
    expect(markdown).toContain("| item7 | 1 | 1 | 0 |");
  });
});

describe("buildFatalFallbackMarkdown", () => {
  it("Error からメッセージを取り出し、断りを含む", () => {
    const markdown = buildFatalFallbackMarkdown(new Error("import に失敗した"));
    expect(markdown).toContain("印字に失敗した");
    expect(markdown).toContain("import に失敗した");
  });

  it("Error でない値も文字列化して落とさない", () => {
    const markdown = buildFatalFallbackMarkdown("plain string failure");
    expect(markdown).toContain("plain string failure");
  });
});

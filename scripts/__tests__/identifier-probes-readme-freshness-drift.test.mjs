import { describe, expect, it } from "vitest";
import {
  checkReadmeMatchesBaseline,
  extractGroupCountClaim,
  extractGroupOverviewTableNames,
  extractResultsTable,
} from "../identifier-probes-readme-freshness-lib.mjs";

const FIXTURE_README = `
## \`identifier-probes\`: fixture

### 5群を別々に集計する（⛔ 混ぜた単一の MRR にしない）

| 群 | probe | haystack | 直接比較できる相手 |
|---|---|---|---|
| \`japanese\` | 7件 | sparse | x |
| \`identifiersSparse\` | 30件 | sparse | x |
| \`identifiersDense\` | 30件 | dense | x |
| \`japaneseNamesSparse\` | 12件 | sparse | x |
| \`japaneseNamesDense\` | 12件 | dense | x |

### 実測結果（fixture）

| 群 | \`(provider, model, dimensions)\` | haystack | MRR | hit@1 | hit@10 |
|---|---|---|---|---|---|
| \`japanese\`(7件) | local | sparse | **0.810** | 5/7 | 7/7 |
| \`identifiersSparse\`(30件) | local | sparse | **1.000** | 30/30 | 30/30 |
| \`identifiersDense\`(30件) | local | dense | **1.000** | 30/30 | 30/30 |
| 🔴 \`japaneseNamesSparse\`(12件) | local | sparse | **0.958** | 11/12 | 12/12 |
| 🔴 \`japaneseNamesDense\`(12件) | local | dense | **0.958** | 11/12 | 12/12 |

### 次の節
`;

const g = (group, probeCount, hit1Count, hit10Count, mrrOverall) => ({
  group,
  probeCount,
  hit1Count,
  hit10Count,
  mrrOverall,
});
const BASELINE = {
  groups: [
    g("japanese", 7, 5, 7, 0.8095238095238095),
    g("identifiersSparse", 30, 30, 30, 1),
    g("identifiersDense", 30, 30, 30, 1),
    g("japaneseNamesSparse", 12, 11, 12, 0.9583333333333334),
    g("japaneseNamesDense", 12, 11, 12, 0.9583333333333334),
  ],
};

const JAPANESE_ROW = "`japanese`(7件) | local | sparse | **0.810** | 5/7 | 7/7";
const drift = (from, to) => {
  expect(FIXTURE_README).toContain(from);
  return checkReadmeMatchesBaseline(FIXTURE_README.replace(from, to), BASELINE);
};

describe("README が基準値とずれているときの検知（Issue #425）", () => {
  it("土台: 合成 README は基準値と一致する", () => {
    expect(checkReadmeMatchesBaseline(FIXTURE_README, BASELINE)).toEqual([]);
  });

  it("「N群を別々に集計する」の見出しが無ければ、そう言う", () => {
    const problems = drift("### 5群を別々に集計する", "### 群を別々に集計しない");
    expect(problems.some((p) => p.includes("見出し「N群を別々に集計する」が見つからない"))).toBe(
      true,
    );
  });

  it("群一覧表に、基準値に無い群があれば検知する", () => {
    const problems = drift(
      "| `japaneseNamesDense` | 12件 | dense | x |\n",
      "| `japaneseNamesDense` | 12件 | dense | x |\n| `ghostGroup` | 1件 | dense | x |\n",
    );
    expect(problems.some((p) => p.includes("群一覧表に基準値に無い群「ghostGroup」"))).toBe(true);
  });

  it("実測結果の表の probe 件数が基準値とずれていれば、hit の分母が合っていても検知する", () => {
    const problems = drift(
      JAPANESE_ROW,
      "`japanese`(8件) | local | sparse | **0.810** | 5/7 | 7/7",
    );
    expect(problems.some((p) => p.includes("japanese: probe件数"))).toBe(true);
  });

  it("hit@1 の分母だけがずれていても検知する（件数 5 は合っている）", () => {
    const problems = drift(
      JAPANESE_ROW,
      "`japanese`(7件) | local | sparse | **0.810** | 5/8 | 7/7",
    );
    expect(problems.some((p) => p.includes("japanese: hit@1"))).toBe(true);
  });

  it("hit@10 の件数がずれていれば検知する", () => {
    const problems = drift(
      JAPANESE_ROW,
      "`japanese`(7件) | local | sparse | **0.810** | 5/7 | 6/7",
    );
    expect(problems.some((p) => p.includes("japanese: hit@10"))).toBe(true);
  });

  it("hit@10 の分母だけがずれていても検知する（件数 7 は合っている）", () => {
    const problems = drift(
      JAPANESE_ROW,
      "`japanese`(7件) | local | sparse | **0.810** | 5/7 | 7/8",
    );
    expect(problems.some((p) => p.includes("japanese: hit@10"))).toBe(true);
  });

  it("MRR が大きくずれていれば検知する", () => {
    const problems = drift(
      JAPANESE_ROW,
      "`japanese`(7件) | local | sparse | **0.500** | 5/7 | 7/7",
    );
    expect(problems.some((p) => p.includes("japanese: MRR"))).toBe(true);
  });

  it("MRR は小数第3位まで一致を見る（0.810 と 0.811 は別）", () => {
    const problems = drift(
      JAPANESE_ROW,
      "`japanese`(7件) | local | sparse | **0.811** | 5/7 | 7/7",
    );
    expect(problems.some((p) => p.includes("japanese: MRR"))).toBe(true);
  });

  it("実測結果の表に、基準値に無い群の行があれば検知する", () => {
    const problems = drift(
      "### 次の節",
      "| `ghostGroup`(1件) | local | sparse | **1.000** | 1/1 | 1/1 |\n\n### 次の節",
    );
    expect(problems.some((p) => p.includes("実測結果の表に基準値に無い群「ghostGroup」"))).toBe(
      true,
    );
  });

  it("実測結果の表から、基準値にある群の行が欠けていれば検知する", () => {
    const problems = drift(
      "| 🔴 `japaneseNamesDense`(12件) | local | dense | **0.958** | 11/12 | 12/12 |\n",
      "",
    );
    expect(
      problems.some((p) => p.includes("実測結果の表に基準値の群「japaneseNamesDense」の行が無い")),
    ).toBe(true);
  });
});

describe("節と表の切り方", () => {
  it("`identifier-probes` の節の外（次の `## ` 節）にある見出しを、この節の主張として読まない", () => {
    const readme = [
      "## `identifier-probes`: 本体",
      "",
      "（ここには見出しが無い）",
      "",
      "## `other`: 別の節",
      "",
      "### 3群を別々に集計する",
    ].join("\n");
    expect(extractGroupCountClaim(readme)).toBeNull();
  });

  it("見出しの `###` の無い地の文の「N群を別々に集計する」は、主張として読まない", () => {
    const readme = FIXTURE_README.replace(
      "### 5群",
      "以前は 3群を別々に集計する 形だった。\n\n### 5群",
    );
    expect(extractGroupCountClaim(readme)).toBe(5);
  });

  it("群一覧表の終わり（次の `###`）より後ろの行を、一覧表の群として読まない", () => {
    const readme = FIXTURE_README.replace(
      "### 実測結果（fixture）",
      "### 補足\n\n| `notInTable` | 1件 | x | x |\n\n### 実測結果（fixture）",
    );
    expect(extractGroupOverviewTableNames(readme)).not.toContain("notInTable");
    expect(checkReadmeMatchesBaseline(readme, BASELINE)).toEqual([]);
  });

  it("実測結果の表の終わり（次の `###`）より後ろの行を、実測の行として読まない", () => {
    const readme = FIXTURE_README.replace(
      "### 次の節",
      "### 次の節\n\n| `lateGroup`(1件) | local | sparse | **1.000** | 1/1 | 1/1 |\n",
    );
    expect(extractResultsTable(readme).map((r) => r.group)).not.toContain("lateGroup");
    expect(checkReadmeMatchesBaseline(readme, BASELINE)).toEqual([]);
  });
});

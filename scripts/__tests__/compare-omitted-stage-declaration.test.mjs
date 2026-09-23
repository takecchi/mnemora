import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  diffStageSets,
  evaluate,
  exitCodeFor,
  findDeclaration,
  omittedEntryKey,
  stageSetForRow,
  turnCountMismatch,
} from "../compare-omitted-stage-declaration-lib.mjs";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CLI = path.join(REPO_ROOT, "scripts/check-compare-omitted-stage-declaration.mjs");

/**
 * ⭐ **陽性対照（これが無いと「0件」が測れていないのか本当に0なのか分かれない）。**
 *
 * [Issue #403](https://github.com/takecchi/mnemora/issues/403) が実測で報告した
 * 「基準値 `9fcd47c` と ADR 0188 着地後の実測」の食い違いを、そのまま fixture にする。
 * ⚠ **件数はこの fixture が持つ。**`main` の基準値ファイルから読まない
 * ——読むと `main` が動くたびに歯の意味が変わる（`AGENTS.md`「⚠ 数を、道具と生成物に焼き込まない」
 * の対象外: これは *測った記録* であって、どこかの正本の写しではない）。
 */
const HISTORICAL_BASELINE_ROWS = [
  { turnCount: 42, omitted: [{ kind: "over_limit", count: 30, countKind: "exact" }] },
  { turnCount: 82, omitted: [{ kind: "over_limit", count: 30, countKind: "exact" }] },
  { turnCount: 162, omitted: [{ kind: "over_limit", count: 30, countKind: "exact" }] },
  { turnCount: 322, omitted: [{ kind: "over_limit", count: 30, countKind: "exact" }] },
  { turnCount: 642, omitted: [{ kind: "over_limit", count: 30, countKind: "exact" }] },
];
const HISTORICAL_MEASURED_ROWS = [
  { turnCount: 42, omitted: [{ kind: "over_limit", stage: "rescore", count: 30 }] },
  { turnCount: 82, omitted: [{ kind: "over_limit", stage: "rescore", count: 30 }] },
  {
    turnCount: 162,
    omitted: [{ kind: "ann_unreached" }, { kind: "over_limit", stage: "rescore", count: 30 }],
  },
  {
    turnCount: 322,
    omitted: [
      { kind: "ann_unreached" },
      { kind: "over_limit", stage: "association", count: 7 },
      { kind: "over_limit", stage: "rescore", count: 30 },
    ],
  },
  {
    turnCount: 642,
    omitted: [
      { kind: "ann_unreached" },
      { kind: "over_limit", stage: "association", count: 21 },
      { kind: "over_limit", stage: "rescore", count: 30 },
    ],
  },
];

describe("omittedEntryKey / stageSetForRow", () => {
  it("`stage` が無い形を「無い」という1つの値として扱う（ADR 0188 以前の基準値）", () => {
    expect(omittedEntryKey({ kind: "over_limit", count: 30 })).toBe("over_limit::(stage無し)");
  });

  it("`stage` が在れば kind と組にする", () => {
    expect(omittedEntryKey({ kind: "over_limit", stage: "rescore" })).toBe("over_limit::rescore");
  });

  it("⛔ `count` / `countKind` は鍵に入れない（件数は見ない、が設計である）", () => {
    const a = omittedEntryKey({ kind: "over_limit", stage: "rescore", count: 1 });
    const b = omittedEntryKey({ kind: "over_limit", stage: "rescore", count: 999 });
    expect(a).toBe(b);
  });

  it("重複を潰して並べ替える（集合として扱う）", () => {
    expect(
      stageSetForRow({
        omitted: [
          { kind: "over_limit", stage: "rescore" },
          { kind: "ann_unreached" },
          { kind: "over_limit", stage: "rescore" },
        ],
      }),
    ).toEqual(["ann_unreached::(stage無し)", "over_limit::rescore"]);
  });

  it("`omitted` が無い / 配列でない行は空集合として扱う", () => {
    expect(stageSetForRow({})).toEqual([]);
    expect(stageSetForRow({ omitted: null })).toEqual([]);
  });
});

describe("🔴 陽性対照: Issue #403 が報告した食い違いを、実際に捕まえる", () => {
  it("5行すべてを「動いた」と検出する", () => {
    const changed = diffStageSets(HISTORICAL_MEASURED_ROWS, HISTORICAL_BASELINE_ROWS);
    expect(changed.map((row) => row.turnCount)).toEqual([42, 82, 162, 322, 642]);
  });

  it("⭐ 件数だけが動いた場合は検出しない（この門は `count` を見ないという設計の裏取り）", () => {
    const measured = HISTORICAL_BASELINE_ROWS.map((row) => ({
      ...row,
      omitted: row.omitted.map((entry) => ({ ...entry, count: entry.count + 100 })),
    }));
    expect(diffStageSets(measured, HISTORICAL_BASELINE_ROWS)).toEqual([]);
  });

  it("⭐ 空振り防止: 同じ入力どうしなら0件になる", () => {
    expect(diffStageSets(HISTORICAL_BASELINE_ROWS, HISTORICAL_BASELINE_ROWS)).toEqual([]);
    expect(diffStageSets(HISTORICAL_MEASURED_ROWS, HISTORICAL_MEASURED_ROWS)).toEqual([]);
  });
});

describe("findDeclaration", () => {
  it("理由まで在る行を申告として拾う", () => {
    expect(
      findDeclaration("前\nCompare-Omitted-Stage: ADR 0188 が stage を足した\n後")?.reason,
    ).toBe("ADR 0188 が stage を足した");
  });

  it("⛔ 印だけで理由が空の行は申告として数えない", () => {
    expect(findDeclaration("Compare-Omitted-Stage:")).toBeNull();
    expect(findDeclaration("Compare-Omitted-Stage:    ")).toBeNull();
  });

  it("引用・箇条書きの行頭装飾が付いていても拾う", () => {
    expect(findDeclaration("> - Compare-Omitted-Stage: 理由")?.reason).toBe("理由");
  });

  it("PR 本文が文字列でなければ null", () => {
    expect(findDeclaration(undefined)).toBeNull();
    expect(findDeclaration(null)).toBeNull();
  });
});

describe("turnCountMismatch", () => {
  it("同じ集合なら null", () => {
    expect(turnCountMismatch(HISTORICAL_MEASURED_ROWS, HISTORICAL_BASELINE_ROWS)).toBeNull();
  });

  it("片方にしか無い turnCount が在れば食い違いとして返す", () => {
    const mismatch = turnCountMismatch([{ turnCount: 1 }], [{ turnCount: 2 }]);
    expect(mismatch).toEqual({ measured: [1], baseline: [2] });
  });
});

describe("evaluate / exitCodeFor", () => {
  const cases = [
    [
      "PR 本文が無ければ判定しない",
      HISTORICAL_MEASURED_ROWS,
      HISTORICAL_BASELINE_ROWS,
      undefined,
      "skipped",
      0,
    ],
    [
      "動いていなければ緑",
      HISTORICAL_BASELINE_ROWS,
      HISTORICAL_BASELINE_ROWS,
      "本文",
      "no_change",
      0,
    ],
    [
      "動いたのに申告が無ければ赤",
      HISTORICAL_MEASURED_ROWS,
      HISTORICAL_BASELINE_ROWS,
      "本文",
      "undeclared",
      1,
    ],
    [
      "動いても申告が在れば緑",
      HISTORICAL_MEASURED_ROWS,
      HISTORICAL_BASELINE_ROWS,
      "Compare-Omitted-Stage: ADR 0188",
      "declared",
      0,
    ],
    [
      "turnCount 集合が食い違えば判定不能（exit 2）",
      [{ turnCount: 1 }],
      [{ turnCount: 2 }],
      "本文",
      "unmeasurable",
      2,
    ],
  ];

  it.each(cases)("%s", (_name, measuredRows, baselineRows, prBody, status, code) => {
    const result = evaluate({ measuredRows, baselineRows, prBody });
    expect(result.status).toBe(status);
    expect(exitCodeFor(result.status)).toBe(code);
  });

  it("🔴 判定不能は、申告の有無より先に立つ（申告で黙らせられない）", () => {
    const result = evaluate({
      measuredRows: [{ turnCount: 1 }],
      baselineRows: [{ turnCount: 2 }],
      prBody: "Compare-Omitted-Stage: 黙らせようとしている",
    });
    expect(result.status).toBe("unmeasurable");
  });
});

describe("CLI（実際に起動して終了コードを固定する）", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "compare-omitted-stage-"));
  const baselinePath = path.join(dir, "baseline.json");
  const measuredPath = path.join(dir, "measured.json");
  writeFileSync(baselinePath, JSON.stringify({ rows: HISTORICAL_BASELINE_ROWS }));
  writeFileSync(measuredPath, JSON.stringify({ rows: HISTORICAL_MEASURED_ROWS }));

  function run(env) {
    try {
      const stdout = execFileSync(
        process.execPath,
        [CLI, "--measured", measuredPath, "--baseline", baselinePath],
        {
          encoding: "utf8",
          env: { ...process.env, PR_BODY: undefined, ...env },
        },
      );
      return { code: 0, output: stdout };
    } catch (error) {
      return { code: error.status, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
    }
  }

  it("申告が無ければ exit 1 で、直し方を出す", () => {
    const { code, output } = run({ PR_BODY: "ふつうの本文" });
    expect(code).toBe(1);
    expect(output).toContain("Compare-Omitted-Stage:");
    expect(output).toContain("申告を書いてから push し、緑を引き直すこと");
  });

  it("申告が在れば exit 0 で、⛔ 中身は見ていないと断る", () => {
    const { code, output } = run({ PR_BODY: "Compare-Omitted-Stage: ADR 0188 が stage を足した" });
    expect(code).toBe(0);
    expect(output).toContain("申告の中身が正しいかを見ていません");
  });

  it("PR 本文が無ければ exit 0 だが、「動いていない」とは言わない", () => {
    const { code, output } = run({});
    expect(code).toBe(0);
    expect(output).toContain("⛔ 「動いていない」ではありません");
  });

  it("読めない入力は exit 2（判定不能。緑にしない）", () => {
    const bad = path.join(dir, "bad.json");
    writeFileSync(bad, "{");
    let code = 0;
    try {
      execFileSync(process.execPath, [CLI, "--measured", bad, "--baseline", baselinePath], {
        encoding: "utf8",
        env: { ...process.env, PR_BODY: "本文" },
      });
    } catch (error) {
      code = error.status;
    }
    expect(code).toBe(2);
  });
});

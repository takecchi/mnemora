import { describe, expect, it } from "vitest";
import { gateExitCode, summarizeStages } from "../root-test-gate.mjs";

// 門そのものは子プロセスで起動しない（段2が pnpm -r run test を呼ぶので再帰する）。

const allPassed = [
  { name: "vitest run", ran: true, exitCode: 0 },
  { name: "pnpm -r --if-present --no-bail run test", ran: true, exitCode: 0 },
  { name: "run-db-tests（ADR 0015）", ran: true, exitCode: 0 },
];

const allFailed = [
  { name: "vitest run", ran: true, exitCode: 1 },
  { name: "pnpm -r --if-present --no-bail run test", ran: true, exitCode: 1 },
  { name: "run-db-tests（ADR 0015）", ran: true, exitCode: 1 },
];

describe("gateExitCode", () => {
  it("全段成功なら終了コード0", () => {
    expect(gateExitCode(allPassed)).toBe(0);
  });

  it("1段だけ失敗していても終了コードは非ゼロ", () => {
    const results = [
      { name: "vitest run", ran: true, exitCode: 1 },
      { name: "pnpm -r --if-present --no-bail run test", ran: true, exitCode: 0 },
      { name: "run-db-tests（ADR 0015）", ran: true, exitCode: 0 },
    ];
    expect(gateExitCode(results)).not.toBe(0);
  });

  it("全段失敗なら終了コードは非ゼロ", () => {
    expect(gateExitCode(allFailed)).not.toBe(0);
  });

  it("段が1つでも未起動（ran: false）なら、他が全部成功していても終了コードは非ゼロ", () => {
    const results = [
      { name: "vitest run", ran: true, exitCode: 0 },
      { name: "pnpm -r --if-present --no-bail run test", ran: false, exitCode: null },
      { name: "run-db-tests（ADR 0015）", ran: true, exitCode: 0 },
    ];
    expect(gateExitCode(results)).not.toBe(0);
  });
});

describe("summarizeStages", () => {
  it("全段が失敗していても、3段すべてが「走った」と要約に出る", () => {
    const summary = summarizeStages(allFailed);
    for (const stage of allFailed) {
      expect(summary).toContain(stage.name);
    }
    expect(summary).not.toContain("未起動");
    expect(summary).toContain("3/3 段が実際に走りました");
  });

  it("全段成功のときは、失敗した段・未起動の段の行が出ない", () => {
    const summary = summarizeStages(allPassed);
    expect(summary).toContain("3/3 段が実際に走りました");
    expect(summary).not.toContain("失敗した段");
    expect(summary).not.toContain("未起動の段");
    expect(summary).toContain("通過");
  });

  it("未起動の段があれば、要約はそれを「未起動」として名指しし、走った段と区別する", () => {
    const results = [
      { name: "vitest run", ran: true, exitCode: 1 },
      { name: "pnpm -r --if-present --no-bail run test", ran: false, exitCode: null },
      { name: "run-db-tests（ADR 0015）", ran: false, exitCode: null },
    ];
    const summary = summarizeStages(results);
    expect(summary).toContain("1/3 段が実際に走りました");
    expect(summary).toContain("未起動の段");
    expect(summary).toContain("pnpm -r --if-present --no-bail run test");
    expect(summary).toContain("run-db-tests（ADR 0015）");
  });
});

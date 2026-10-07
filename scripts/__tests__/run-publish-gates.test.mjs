import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { spawnSyncWithDeadline } from "./spawn-with-deadline.mjs";

// 本物の pnpm run typecheck 等は起動しない。MNEMORA_PUBLISH_GATE_STAGES_JSON（テスト専用）で、
// 5段を偽のコマンドに差し替える。

const script = fileURLToPath(new URL("../run-publish-gates.mjs", import.meta.url));
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

/**
 * @param {string} name
 * @param {number} exitCode
 */
function fakeStage(name, exitCode) {
  return { name, command: process.execPath, args: ["-e", `process.exit(${exitCode})`] };
}

/**
 * @param {{ name: string; command: string; args: string[] }[]} stages
 */
function runGate(stages, workflow = "test-of-run-publish-gates") {
  return spawnSyncWithDeadline(process.execPath, [script], {
    cwd: repoRoot,
    encoding: "utf8",
    // GITHUB_WORKFLOW を上書きする（publish の job の中で走ると親の値が Publish になり、
    // 差し替えを断る守りに歯自体が当たる）。
    env: {
      ...process.env,
      GITHUB_WORKFLOW: workflow,
      MNEMORA_PUBLISH_GATE_STAGES_JSON: JSON.stringify(stages),
    },
  });
}

describe("scripts/run-publish-gates.mjs（偽の5段で、前段の成否に関わらず全部起動することを測る）", () => {
  it("5段とも成功 ⟹ 終了コード0、5段とも走ったと出力に出る", () => {
    const stages = [
      fakeStage("gate-1", 0),
      fakeStage("gate-2", 0),
      fakeStage("gate-3", 0),
      fakeStage("gate-4", 0),
      fakeStage("gate-5", 0),
    ];
    const result = runGate(stages);
    expect(result.status).toBe(0);
    for (const stage of stages) {
      expect(result.stdout).toContain(stage.name);
    }
    expect(result.stdout).toContain("5/5 段が実際に走りました");
    expect(result.stdout).not.toContain("未起動");
  });

  it("2本目が失敗 ⟹ 3〜5本目も走る（bash -e のように止まらない）。最後に非0。落ちた門の名前が出る", () => {
    const stages = [
      fakeStage("gate-1", 0),
      fakeStage("gate-2", 7),
      fakeStage("gate-3", 0),
      fakeStage("gate-4", 0),
      fakeStage("gate-5", 0),
    ];
    const result = runGate(stages);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("gate-3");
    expect(result.stdout).toContain("gate-4");
    expect(result.stdout).toContain("gate-5");
    expect(result.stdout).not.toContain("未起動");
    expect(result.stdout).toContain("失敗した段");
    expect(result.stdout).toContain("gate-2");
  });

  it("最後の1本だけ失敗 ⟹ 非0。他の4本は成功したと出る", () => {
    const stages = [
      fakeStage("gate-1", 0),
      fakeStage("gate-2", 0),
      fakeStage("gate-3", 0),
      fakeStage("gate-4", 0),
      fakeStage("gate-5", 3),
    ];
    const result = runGate(stages);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("失敗した段");
    expect(result.stdout).toContain("gate-5");
    for (const name of ["gate-1", "gate-2", "gate-3", "gate-4"]) {
      expect(result.stdout).toContain(name);
    }
  });

  it("publish の workflow（GITHUB_WORKFLOW=Publish）の中では、差し替えを断る（偽の段を1本も走らせずに exit 3）", () => {
    const marker = path.join(os.tmpdir(), `run-publish-gates-marker-${process.pid}-${Date.now()}`);
    const writesMarker = {
      name: "gate-writes-marker",
      command: process.execPath,
      args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`],
    };
    const result = runGate([writesMarker], "Publish");
    expect(result.status).toBe(3);
    expect(result.stderr).toContain("publish の workflow の中では使えない");
    expect(existsSync(marker)).toBe(false);
  });

  it("差し替えたときは、本物の門ではないと出力で名乗る", () => {
    const result = runGate([fakeStage("gate-1", 0)]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("これは本物の門ではない");
  });
});

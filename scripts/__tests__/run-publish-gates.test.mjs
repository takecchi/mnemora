import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `scripts/run-publish-gates.mjs`（`.github/workflows/publish.yml` の門ステップの CLI 入口）の歯。
 *
 * **これは何を直したものか（Issue #476、ADR 0210 追記）**
 *
 * `publish.yml` の門ステップは、直す前は `run: |` に5行（`pnpm run typecheck` /
 * `lint` / `format:check` / `test` / `build`）を並べただけで、既定シェル（`bash -e`）に
 * 任せていた——`-e` が保たれている限り「壊れているのに緑になる」偽陽性は起きないが
 * （それは `scripts/__tests__/publish-yml-gate-shell-wiring.test.mjs` が別に縛る）、
 * **1本目が落ちた時点でステップ全体が止まり、2本目以降が実際に壊れているかどうかが
 * 一度も分からない**——ADR 0210 がルートの `test` 門（`&&` 連結）について直した族と
 * 同じ形（同 ADR「数え直した結果」の表・6番）。この script は、ADR 0210 の
 * `scripts/run-root-test-gate.mjs` と同じ形で、5段を**前段の成否に関わらず全部**
 * 起動し、終了コードは最後にまとめて決める。
 *
 * ⛔ **本物の `pnpm run typecheck` 等を子プロセスとして起動しない。**
 * `MNEMORA_PUBLISH_GATE_STAGES_JSON`（この script だけが読む、テスト専用の環境変数。
 * `publish.yml` は設定しない）で、5段を「成功する偽のコマンド」「失敗する偽のコマンド」
 * に差し替えて確かめる。
 */

const script = fileURLToPath(new URL("../run-publish-gates.mjs", import.meta.url));
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

/**
 * 偽の段（`node -e "process.exit(N)"`）を作る。本物の pnpm コマンドは一切起動しない。
 *
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
  return spawnSync(process.execPath, [script], {
    cwd: repoRoot,
    encoding: "utf8",
    // **`GITHUB_WORKFLOW` を明示的に上書きする。** `publish.yml` の門そのものが
    // `pnpm run test` でこの歯を走らせるので、publish の job の中では親の
    // `GITHUB_WORKFLOW` が `Publish` になっている。受け継ぐと、下の「publish の
    // workflow の中では差し替えを断る」守りに歯自体が当たって落ち、publish を止める。
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
    // 3〜5本目も実際に起動され、成功したと出ていること
    // （直す前の bash -e なら、2本目が落ちた時点でステップ全体が止まり、
    //   3〜5本目が動いたかどうかは出力からは一切分からなかった）。
    expect(result.stdout).toContain("gate-3");
    expect(result.stdout).toContain("gate-4");
    expect(result.stdout).toContain("gate-5");
    expect(result.stdout).not.toContain("未起動");
    // 落ちた門の名前が名指しで出ること。
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

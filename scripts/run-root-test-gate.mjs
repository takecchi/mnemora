#!/usr/bin/env node
/**
 * ⚠ この CLI 自身を歯から子プロセスとして起動しないこと。段2が `pnpm -r run test` を呼ぶので、
 * 歯の中から起動すると自分自身を再帰して起動する。歯は `./root-test-gate.mjs` の純関数にだけ当てる。
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { STAGES, gateExitCode, summarizeStages } from "./root-test-gate.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/** @type {import("./root-test-gate.mjs").StageResult[]} */
const results = [];

for (const stage of STAGES) {
  const run = spawnSync(stage.command, stage.args, { cwd: repoRoot, stdio: "inherit" });
  results.push({
    name: stage.name,
    ran: true,
    exitCode: run.status === null ? 1 : run.status,
  });
}

console.log(summarizeStages(results));
process.exit(gateExitCode(results));

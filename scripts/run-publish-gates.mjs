#!/usr/bin/env node
/**
 * ⛔ 5段を前段の成否に関わらず順に全部起動する。判定は `./publish-gates.mjs` が持つ。
 *
 * ⚠ テスト専用の抜け道: 環境変数 `MNEMORA_PUBLISH_GATE_STAGES_JSON` で既定の段を差し替えられる。
 * 本物の `pnpm run test` 等(数分かかる)を起動せずに、この CLI を実プロセスとして試験するため。
 * `.github/workflows/publish.yml` はこの環境変数を設定しない。
 *
 * ⛔ JSON が壊れているときは、黙って既定にフォールバックせず exit 3 で落ちる
 * (誤った上書きに気づかず既定が走ったふりをするより安全)。
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { STAGES as DEFAULT_STAGES, gateExitCode, summarizeStages } from "./publish-gates.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/** @returns {{ name: string; command: string; args: string[] }[]} */
function resolveStages() {
  const raw = process.env.MNEMORA_PUBLISH_GATE_STAGES_JSON;
  if (raw === undefined) return DEFAULT_STAGES;

  // ⛔ publish の job の中では差し替えを断る。上書き経路は歯のためだけに在り、publish の workflow で設定されると
  // 本物の門を偽の段で置き換えて緑にできてしまう。偽の段を1本も走らせず exit 3 で断る。
  if (process.env.GITHUB_WORKFLOW === "Publish") {
    console.error(
      "MNEMORA_PUBLISH_GATE_STAGES_JSON は publish の workflow の中では使えない" +
        "（テスト専用の上書き経路。本物の門を偽の段で置き換えることになる）。門を走らせずに断る。",
    );
    process.exit(3);
  }
  console.log(
    "⚠ テスト専用の上書き経路（MNEMORA_PUBLISH_GATE_STAGES_JSON）で段を差し替えている。" +
      "これは本物の門ではない。",
  );

  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.error(
      `MNEMORA_PUBLISH_GATE_STAGES_JSON が JSON として読めない（テスト専用の上書き経路）: ${error.message}`,
    );
    process.exit(3);
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    !parsed.every(
      (stage) =>
        stage &&
        typeof stage.name === "string" &&
        typeof stage.command === "string" &&
        Array.isArray(stage.args),
    )
  ) {
    console.error(
      "MNEMORA_PUBLISH_GATE_STAGES_JSON は { name: string; command: string; args: string[] }[] の形の、" +
        `空でない配列である必要がある。受け取った値: ${raw}`,
    );
    process.exit(3);
  }
  return parsed;
}

const STAGES = resolveStages();

/** @type {import("./publish-gates.mjs").StageResult[]} */
const results = [];

for (const stage of STAGES) {
  const run = spawnSync(stage.command, stage.args, { cwd: repoRoot, stdio: "inherit" });
  results.push({
    name: stage.name,
    ran: true,
    // signal で終わった場合(`run.status === null`)も、未起動と混同せず「失敗した」として扱う(非ゼロの固定値 1)。
    exitCode: run.status === null ? 1 : run.status,
  });
}

console.log(summarizeStages(results));
process.exit(gateExitCode(results));

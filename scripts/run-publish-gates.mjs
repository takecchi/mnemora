#!/usr/bin/env node
/**
 * `.github/workflows/publish.yml` の門ステップ（「Typecheck / Lint / Format / Test / Build
 * （非 DB の門を全部通す）」）の CLI 入口（Issue #476、ADR 0210 追記）。
 *
 * 判定（要約テキストと終了コード）は `./publish-gates.mjs` が持つ（副作用が無く、
 * 歯から直接呼べる）。ここでは5段を**前段の成否に関わらず順に全部**起動し、
 * 結果を集めて要約を出し、門全体の終了コードで終わる——ADR 0210 の
 * `scripts/run-root-test-gate.mjs` と同じ形。
 *
 * | 段 | コマンド |
 * |---|---|
 * | 1 | `pnpm run typecheck` |
 * | 2 | `pnpm run lint` |
 * | 3 | `pnpm run format:check` |
 * | 4 | `pnpm run test` |
 * | 5 | `pnpm run build` |
 *
 * 各段の stdout/stderr は `stdio: "inherit"` でそのまま流す——握り潰したり加工したり
 * しない。
 *
 * ⚠ **テスト専用の抜け道**: 環境変数 `MNEMORA_PUBLISH_GATE_STAGES_JSON` が設定されて
 * いれば、既定の5段（`./publish-gates.mjs` の `STAGES`）の代わりに、その値を
 * `[{ name, command, args }]` の JSON として読んで使う。
 *
 * `.github/workflows/publish.yml` はこの環境変数を一切設定しない——本物の CI では
 * 常に既定の5段（本物の `pnpm run typecheck` 等）が使われる。この抜け道が存在するのは
 * `scripts/__tests__/run-publish-gates.test.mjs` が、**本物の `pnpm run test` / `build` 等を
 * 一度も起動せずに**、「前段が失敗しても後段が必ず起動されること」「落ちた段の名前が
 * 出力に出ること」を、この CLI 自身を実プロセスとして起動して確かめるためである
 * （`scripts/__tests__/run-db-tests.test.mjs` が本物の `run-db-tests.mjs` を子プロセスで
 * 起動して検査するのと同じ考え方だが、5段のうち "test" 相当を本物の
 * `pnpm run test`（= `scripts/run-root-test-gate.mjs`、数分かかる）で置き換えるのは
 * 歯として重すぎるため、偽のコマンドに差し替えられる経路を持たせた）。
 *
 * JSON が壊れている・配列でない・各要素が `{ name, command, args }` の形を満たさない
 * 場合は、黙って既定の5段にフォールバックせず、exit 3 で理由を名指しして落ちる
 * （`AGENTS.md`「⚠ 静かに失敗する道具」と同じ理由——誤った上書きに気づかず
 * 既定の5段が走ったふりをするより、壊れていることが分かる形で落ちるほうが安全）。
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { STAGES as DEFAULT_STAGES, gateExitCode, summarizeStages } from "./publish-gates.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * @returns {{ name: string; command: string; args: string[] }[]}
 */
function resolveStages() {
  const raw = process.env.MNEMORA_PUBLISH_GATE_STAGES_JSON;
  if (raw === undefined) return DEFAULT_STAGES;

  // **publish の job の中では、差し替えを断る**（Issue #476）。この上書き経路は
  // 歯のためだけに在る。publish の workflow（`name: Publish`）の中でこれが
  // 設定されていたら、本物の門を偽の段で置き換えて緑にできてしまう——リリースの
  // 門に抜け道を残さないため、偽の段を1本も走らせずに exit 3 で断る。歯は CI の
  // workflow（`name: CI`）や手元で走るので、ここには当たらない。
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
    // signal で終わった場合（run.status === null）も、未起動と混同しないよう
    // 「起動した・失敗した」として扱う（非ゼロの固定値 1）。
    exitCode: run.status === null ? 1 : run.status,
  });
}

console.log(summarizeStages(results));
process.exit(gateExitCode(results));

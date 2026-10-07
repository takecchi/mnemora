/**
 * ⚠ ルートの `test` 門の `scripts/root-test-gate.mjs` とは意図的に別ファイルにする（コードは共有しない）。
 * あちらは「歯から `run-root-test-gate.mjs` を子プロセスとして起動しない」という固有の制約を抱えており、
 * その制約を持ち込まない。形（判定と実行を分ける・全段起動・要約の書式）だけを揃える。
 */

/**
 * @typedef {Object} StageResult
 * @property {string} name
 * @property {boolean} ran
 * @property {number | null} exitCode
 */

const BANNER = "─".repeat(72);

/**
 * @type {{ name: string; command: string; args: string[] }[]}
 */
export const STAGES = [
  { name: "typecheck", command: "pnpm", args: ["run", "typecheck"] },
  { name: "lint", command: "pnpm", args: ["run", "lint"] },
  { name: "format:check", command: "pnpm", args: ["run", "format:check"] },
  { name: "test", command: "pnpm", args: ["run", "test"] },
  { name: "build", command: "pnpm", args: ["run", "build"] },
];

/**
 * @param {StageResult[]} results
 * @returns {string}
 */
export function summarizeStages(results) {
  const lines = [BANNER, "publish.yml の門: 各段の結果", ""];

  for (const stage of results) {
    if (!stage.ran) {
      lines.push(`  ⊘ 未起動  ${stage.name}`);
      continue;
    }
    if (stage.exitCode === 0) {
      lines.push(`  ✔ 成功    ${stage.name}（exit 0）`);
    } else {
      lines.push(`  ✗ 失敗    ${stage.name}（exit ${stage.exitCode}）`);
    }
  }

  const ranCount = results.filter((stage) => stage.ran).length;
  const failedNames = results
    .filter((stage) => stage.ran && stage.exitCode !== 0)
    .map((stage) => stage.name);
  const notRunNames = results.filter((stage) => !stage.ran).map((stage) => stage.name);

  lines.push("");
  lines.push(`  ${ranCount}/${results.length} 段が実際に走りました。`);

  if (failedNames.length > 0) {
    lines.push(`  失敗した段: ${failedNames.join(", ")}`);
  }
  if (notRunNames.length > 0) {
    lines.push(`  未起動の段: ${notRunNames.join(", ")}`);
  }

  lines.push("");
  lines.push(gateExitCode(results) === 0 ? "  門: ✔ 通過" : "  門: ✗ 失敗");
  lines.push(BANNER);

  return lines.join("\n");
}

/**
 * ⛔ 「全部走らせたうえで、最後に 0 を返す」実装にしないこと。全段を必ず起動することと、
 * 1本でも落ちていれば非0で終わることは、どちらも欠けてはいけない別の要件。
 * 未起動の段は「通った」ではないので、成功として扱わない。
 *
 * @param {StageResult[]} results
 * @returns {number} 0 = 全段が走って全段成功、1 = それ以外
 */
export function gateExitCode(results) {
  const allRanAndPassed = results.every((stage) => stage.ran && stage.exitCode === 0);
  return allRanAndPassed ? 0 : 1;
}

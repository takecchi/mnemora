/**
 * ⛔ 3段を前段の成否に関わらず全部起動する。`&&` 連結だと、段1が落ちたとき段2・3は一度も起動されず、「赤1件」の裏に「未起動の段」が隠れる。
 * 段2(`pnpm -r`)も既定で bail するので、同じ欠陥が段2の内側にもある。
 * なお壊れていたのは赤の読み方だけで、緑の意味は壊れていない。
 *
 * この関数群は副作用を持たない。CLI の入口は `scripts/run-root-test-gate.mjs`。
 */

/**
 * `ran` を落とすと、この関数だけを見て「未起動が起きていないこと」を検査できなくなる。`ran` が `false` のとき `exitCode` は `null` にする。
 *
 * @typedef {Object} StageResult
 * @property {string} name
 * @property {boolean} ran
 * @property {number | null} exitCode
 */

const BANNER = "─".repeat(72);

/**
 * ⛔ 配線の配列は CLI ではなくこちらに置く。CLI は import した時点で3段を起動するので、配線を釘付けにする歯(`run-db-tests.test.mjs`)が import できず、
 * ソースを文字列として読むしかなくなる。すると冒頭コメントに同じ語が同じ順で並んでいるだけで緑になる。
 *
 * @type {{ name: string; command: string; args: string[] }[]}
 */
export const STAGES = [
  { name: "vitest run", command: "pnpm", args: ["exec", "vitest", "run"] },
  {
    name: "pnpm -r --if-present --no-bail run test",
    command: "pnpm",
    args: ["-r", "--if-present", "--no-bail", "run", "test"],
  },
  { name: "run-db-tests（ADR 0015）", command: "node", args: ["scripts/run-db-tests.mjs"] },
];

/**
 * 要約は必ず「何段中何段が実際に走ったか」の一行を持つ。全段が失敗していても「3/3 段が実際に走りました」と報告し、
 * 落ちたことと起動されなかったことを別の事実として出す。
 *
 * @param {StageResult[]} results
 * @returns {string}
 */
export function summarizeStages(results) {
  const lines = [BANNER, "ルートの test 門: 各段の結果", ""];

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
 * 未起動の段は「検査していない」のであって「通った」のではないので、成功として扱わない。起動されなかった段が紛れ込んでも黙って緑にしない。
 *
 * @param {StageResult[]} results
 * @returns {number}
 */
export function gateExitCode(results) {
  const allRanAndPassed = results.every((stage) => stage.ran && stage.exitCode === 0);
  return allRanAndPassed ? 0 : 1;
}

/**
 * `.github/workflows/publish.yml` の門ステップ（「Typecheck / Lint / Format / Test / Build
 * （非 DB の門を全部通す）」）の判定部（Issue #476、ADR 0210 追記）。
 *
 * **直す前の門ステップ（逐語、`.github/workflows/publish.yml:137-142`。ADR 0210 の
 * 数え直した族の6番）**:
 * ```yaml
 * run: |
 *   pnpm run typecheck
 *   pnpm run lint
 *   pnpm run format:check
 *   pnpm run test
 *   pnpm run build
 * ```
 *
 * **欠陥**: GitHub Actions の `run: |` は既定シェル（`bash -e`）で走るため、5行のうち
 * どれか1本が落ちた時点でステップ全体がその場で非0終了する。**偽陽性の緑（壊れている
 * のに通る）は起きない**（Issue #476 の判定はこの1点に立っている）——だが、**1本目が
 * 落ちると2〜5本目が実際に壊れているかどうかは、その回では一度も分からない。** リリース
 * 当日に「Test だけ赤く見えて、実は Build も壊れている」を見落としうる、という
 * ADR 0210 が本体（ルートの `test` 門）で直したのと同じ形の欠陥である。
 *
 * **直した向き**: ADR 0210 が `scripts/root-test-gate.mjs` / `scripts/run-root-test-gate.mjs`
 * に置いた「判定関数（副作用なし）と実行部（CLI）を分ける」形をそのまま踏襲する。
 * 5段を前段の成否に関わらず全部走らせ（`scripts/run-publish-gates.mjs`）、
 * 各段の結果をこのファイルの純関数で要約する。`bash -e` に任せるのをやめて、
 * **止まらずに全部起動したうえで、何が走って何が通って何が落ちたかを1画面に出す。**
 *
 * ⚠ **ADR 0210 の `scripts/root-test-gate.mjs` とは意図的に別ファイルにしてある**
 * （コードは共有していない）。ルートの `test` 門とこの門は対象も段数も違い、
 * `scripts/root-test-gate.mjs` 側は「歯からは `run-root-test-gate.mjs` を子プロセスとして
 * 起動しない（段2の `pnpm -r run test` が再帰するため）」という固有の制約を抱えている
 * ——このファイルにその制約を持ち込みたくない。**形（判定と実行を分ける・全段起動・
 * 要約の書式）だけを揃え、実装は独立させた。**
 *
 * この関数群は副作用（`console.log` / 子プロセスの起動 / `process.exit`）を持たない。
 * CLI としての入口は `scripts/run-publish-gates.mjs` にある。
 */

/**
 * @typedef {Object} StageResult
 * @property {string} name - 段の名前（要約に出す表示名）
 * @property {boolean} ran - この段が実際に起動されたか。
 *   `run-publish-gates.mjs` は5段すべてを前段の成否に関わらず起動するため、
 *   本物の CLI が作る配列ではここは常に `true` になる。
 * @property {number | null} exitCode - 起動した場合の終了コード（0 = 成功）。
 *   `ran` が `false` のときは意味を持たないので `null` にすること。
 */

const BANNER = "─".repeat(72);

/**
 * 門が起動する5段の定義（**この配列が配線そのものである**）。
 *
 * `.github/workflows/publish.yml` の門ステップは `pnpm run <name>` を5本並べていた。
 * ここではそれぞれを個別のコマンドとして持つ——`pnpm run typecheck` のような文字列を
 * shell に食わせるのではなく、`spawnSync("pnpm", ["run", "typecheck"])` の形で直接
 * 起動する（`scripts/run-publish-gates.mjs` 側）。
 *
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
 * 各段の結果から、1画面で読める要約テキストを作る。
 *
 * ⭐ **この門が解こうとしている問題は「1本落ちたら残りが分からない」ことなので**、
 * 要約は必ず「何段中何段が実際に走ったか」を名指しする一行を持つ——
 * **全段が失敗していても、この一行は「5/5 段が実際に走りました」を報告する**
 * （落ちたことと、起動されなかったことは、要約の上でも別の事実として出す。
 * `scripts/root-test-gate.mjs` の `summarizeStages` と同じ形）。
 *
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
 * 各段の結果から、門全体の終了コードを決める。
 *
 * 1つでも段が失敗した（`ran: true` かつ `exitCode !== 0`）、または
 * 1つでも段が未起動（`ran: false`）であれば非ゼロを返す。未起動の段は
 * 「検査していない」のであって「通った」のではないので、成功として扱わない。
 *
 * ⛔ **「全部走らせたうえで、最後に 0 を返す」実装にしないこと。** それは
 * この Issue が「やりすぎた変異」として名指ししている欠陥そのもの——
 * 全段を必ず起動することと、1本でも落ちていれば非0で終わることは、
 * どちらも欠けてはいけない別の要件である。
 *
 * @param {StageResult[]} results
 * @returns {number} 0 = 全段が走って全段成功、1 = それ以外
 */
export function gateExitCode(results) {
  const allRanAndPassed = results.every((stage) => stage.ran && stage.exitCode === 0);
  return allRanAndPassed ? 0 : 1;
}

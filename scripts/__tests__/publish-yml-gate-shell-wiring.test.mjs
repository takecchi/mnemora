import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { blankOutWorkflowComments } from "../workflow-comment-blank-lib.mjs";

/**
 * ⭐ **この歯が測っているもの（消す前に読むこと）**
 *
 * **`.github/workflows/publish.yml` の門ステップ（「Typecheck / Lint / Format /
 * Test / Build（非 DB の門を全部通す）」段）が、`scripts/run-publish-gates.mjs` を
 * 呼んでいること、そして `shell:` の上書きで既定シェル（`bash -e`）の保証が
 * 黙って崩されていないこと。**
 *
 * ⚠ **なぜこれが要るか（Issue #476、2026-09-24 追記で前提が変わった）**
 *
 * この歯は元々、Issue #476 の判定「⭕ `v1.0.0` を止めない（偽陽性の緑は起きない）」が
 * **門ステップが `bash -e` で走ること**に全面的に依存していたことを受けて置かれた
 * ——`shell: bash {0}`（`-e` を含まない自前テンプレート）を1行足すだけで偽陽性の緑が
 * 戻る、という穴を縛っていた。
 *
 * **2026-09-24（Issue #476、ADR 0210 追記）に、門ステップの中身そのものを直した**
 * ——5行の `pnpm run …` を `bash -e` に任せる形をやめ、`scripts/run-publish-gates.mjs`
 * （ADR 0210 の `scripts/run-root-test-gate.mjs` と同じ形。5段を前段の成否に関わらず
 * 全部起動し、どれか1本でも失敗・未起動なら最後に非0で終わる）を1行だけ呼ぶ形に
 * 変えた。**この歯の役割はそれに応じて2つに分かれた**:
 *
 * 1. **門ステップが実際に `scripts/run-publish-gates.mjs` を1行だけ呼んでいること**
 *    （前後に他のコマンドが繋がっていないこと——`|| true` のような、終了コードを
 *    握り潰す尾を許さない）。この配線が保たれている限り、偽陽性の緑を防ぐ主な責務は
 *    **`scripts/publish-gates.mjs` の `gateExitCode()`**（歯:
 *    `scripts/__tests__/publish-gates.test.mjs` / `run-publish-gates.test.mjs`）が持つ
 *    ——単一コマンドの終了コードがそのままステップの終了コードになるので、`-e` の
 *    有無そのものにはもう依存しない。
 * 2. **それでも `-e` を保つ確認は消さない**（防御の重ね掛け）。将来この `run: |` へ
 *    別の行が足されたとき（例えば呼び出しの前後にログ出力を1行足す等）、`-e` が
 *    失われていれば同じ族の欠陥が再発しうる——その回帰を捕まえるのはこの歯だけである。
 *
 * ⚠ **`scripts/__tests__/publish-yml-gates-wiring.test.mjs` の重複ではない。**
 * あちらは「`scripts/run-publish-gates.mjs` が実在し、yml に書いてある通りの形で
 * 起動すると実際に動く（偽の段を差し替えて子プロセスとして起動する）」ことを測る。
 * こちらは**シェルの意味論と、余計な尾が付いていないこと**だけを測る。
 * 両者は独立した主張であり、どちらか一方が緑でも他方の保証にはならない。
 *
 * ⚠ **`scripts/__tests__/publish-yml-dry-run-wiring.test.mjs` の重複でもない。**
 * あちらは dry-run 判定のステップ間の受け渡しを測る——`shell:` は1バイトも見ない。
 *
 * ⚠ **YAML は構造として解析していない（文字列で見ている）。** 既存の workflow
 * 検査の歯（`publish-yml-dry-run-wiring.test.mjs` / `ci-yml-postgres-regime-
 * wiring.test.mjs` 等）と同じ判断で、依存（js-yaml 等）を足していない
 * （依存追加はオーナー専権）。**だからこの歯は書き方の変更に弱い。**壊れたら
 * 「配線が変わった」か「書き方が変わった」かを見分け、**後者なら取り出し方の
 * ほうを直すこと（歯を消さないこと）**。
 *
 * ⚠ **注釈の中に `shell:` という文字列があるだけで赤くなる誤検出を避けるため、
 * `blankOutWorkflowComments` でコメントを潰した本文に対して判定する**
 * （`workflow-comment-blank-lib.mjs` の docstring・Issue #148/#155 と同じ理由）。
 * `unhandled`（潰しきれなかった形）が1件でもあれば、それ以下の判定は信用できない
 * ——このファイルには現時点でヒアドキュメントも `''` も無いことを確認済みだが、
 * 将来それが増えたときに黙って見落とさないよう、下の最初の `it` で `unhandled` が
 * 空であることも確かめる。
 *
 * 🔴 **この歯が捕まえないもの:**
 * - **`scripts/run-publish-gates.mjs` の中身が正しいかは見ていない。** それは
 *   `scripts/__tests__/publish-gates.test.mjs` / `run-publish-gates.test.mjs` /
 *   `publish-yml-gates-wiring.test.mjs` が見る。
 * - **`ci.yml` 側との一致は見ていない。**
 * - **GitHub Actions が将来 `bash` / `sh` の既定から `-e` を外したら、この歯の
 *   2番目の役割（防御の重ね掛け）は嘘になる。** ⟹ 前提は「2026-09 時点の GitHub の
 *   既定」（`bash --noprofile --norc -eo pipefail {0}` / `sh -e {0}`）である。
 */

const workflowPath = fileURLToPath(new URL("../../.github/workflows/publish.yml", import.meta.url));
const runPublishGatesPath = fileURLToPath(new URL("../run-publish-gates.mjs", import.meta.url));

const workflowRaw = readFileSync(workflowPath, "utf8");
const { text: workflow, unhandled: commentUnhandled } = blankOutWorkflowComments(workflowRaw);

/**
 * `run: |` ブロックを yml から切り出す。**`steps:` の構造は仮定しない**
 * ——「`run: |` の行より深いインデントで続く連続行」という形だけを見る
 * （ステップ名で探すと、名前が変わったときに歯が古いまま緑になる）。
 *
 * @param {string} text コメントを潰した後の本文
 * @returns {{ startLine: number, indent: number, body: string }[]}
 */
function extractRunBlocks(text) {
  const lines = text.split("\n");
  /** @type {{ startLine: number, indent: number, body: string }[]} */
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const match = lines[i].match(/^( +)run:\s*\|\s*$/);
    if (!match) {
      i += 1;
      continue;
    }
    const indent = match[1].length;
    const startLine = i + 1;
    /** @type {string[]} */
    const bodyLines = [];
    let j = i + 1;
    for (; j < lines.length; j += 1) {
      const line = lines[j];
      if (line.trim() === "") {
        bodyLines.push(line);
        continue;
      }
      const lineIndent = line.match(/^ */)[0].length;
      if (lineIndent <= indent) break;
      bodyLines.push(line);
    }
    blocks.push({ startLine, indent, body: bodyLines.join("\n") });
    i = j;
  }
  return blocks;
}

/**
 * 本文全体から `shell:` の値をすべて抽出する（行番号つき）。
 * ⚠ 値の前後の引用符（`"…"` / `'…'`）は剥がす。
 *
 * @param {string} text コメントを潰した後の本文
 * @returns {{ lineNumber: number, value: string }[]}
 */
function extractShellOverrides(text) {
  const lines = text.split("\n");
  /** @type {{ lineNumber: number, value: string }[]} */
  const overrides = [];
  lines.forEach((line, index) => {
    const match = line.match(/^\s*shell:\s*(.+?)\s*$/);
    if (!match) return;
    let value = match[1].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    overrides.push({ lineNumber: index + 1, value });
  });
  return overrides;
}

const runBlocks = extractRunBlocks(workflow);
// 門ステップを「`run-publish-gates.mjs` を含む run: | ブロック」で探す
// （ADR 0265 の `ci-yml-local-embedding-fingerprint-shell.test.mjs` と同じ形の選び方
// ——ステップ名には依存しない）。
// 【実測 2026-09-24 / `publish.yml`】この形に当たるブロックは門ステップ1つだけである
// ——2つ以上に増えたら下の `it` が曖昧として赤くなる（黙ってどちらかを選ばない）。
const gateCandidates = runBlocks.filter((block) => block.body.includes("run-publish-gates.mjs"));
const gateBlock = gateCandidates.length === 1 ? gateCandidates[0] : undefined;
const shellOverrides = extractShellOverrides(workflow);

/**
 * GitHub Actions が `bash` / `sh` に与える既定シェルコマンドは、どちらも `-e` を
 * 含む（`bash --noprofile --norc -eo pipefail {0}` / `sh -e {0}`、2026-09 時点）。
 * ⟹ **上書きを許すのはこの2つの値だけ。** `{0}` を含む自前テンプレート
 * （例 `bash {0}`）や `pwsh` / `powershell` / `python` / `cmd` はすべて赤くする。
 */
const ALLOWED_SHELLS = new Set(["bash", "sh"]);

describe(".github/workflows/publish.yml の門ステップが既定シェル（bash -e）で走るという前提が縛られていること（Issue #476）", () => {
  it("この歯は publish.yml を実際に読んでいる（読めなければ以下は何も測っていない）", () => {
    expect(workflowRaw, `${workflowPath} が読めなかった`).not.toBe("");
    expect(
      workflowRaw.length,
      "publish.yml が短すぎる——別ファイルを読んでいる可能性がある",
    ).toBeGreaterThanOrEqual(1000);
    expect(
      commentUnhandled,
      "コメント潰しが扱えない形に当たった——以下の shell: の判定の土台が信用できない" +
        `（unhandled: ${JSON.stringify(commentUnhandled)}）`,
    ).toEqual([]);
  });

  it("門ステップ（非 DB の門を全部通す段）が実在し、run-publish-gates.mjs をちょうど1回だけ、余計な尾を付けずに呼んでいる", () => {
    expect(
      gateCandidates.length,
      "run-publish-gates.mjs を含む run: | ブロックが、publish.yml にちょうど1つ在ることを期待した" +
        `（見つかった数: ${gateCandidates.length}）——0 なら門ステップが script 呼び出しに` +
        "なっていない（bash -e に任せるインライン実装へ戻った可能性がある)。" +
        "2以上なら、どれが門ステップかをこの歯が決められない" +
        "（⛔ 黙ってどちらかを選ばない。取り出し方のほうを直すこと）",
    ).toBe(1);
    expect(gateBlock, "門ステップの run: | ブロックを取り出せなかった").toBeDefined();
    // 🔑 呼び出しの前後に何も無いこと（`|| true` のような、終了コードを握り潰す尾を
    // 許さない）。単一コマンドの終了コードがそのままステップの終了コードになる、
    // という 2026-09-24 追記の主張そのものを検査している。
    expect(
      gateBlock.body.trim(),
      "門ステップの run: | ブロックが node scripts/run-publish-gates.mjs 単独の1行になっていない" +
        `（実際の中身: ${JSON.stringify(gateBlock.body)}）——前後に余計なコマンドが繋がっていると、` +
        "run-publish-gates.mjs の終了コードがステップの終了コードとしてそのまま使われる保証が崩れる",
    ).toBe("node scripts/run-publish-gates.mjs");
  });

  it("workflow 全体に defaults: ブロックが無い（既定シェルを黙って差し替えていない）", () => {
    expect(workflow).not.toMatch(/^ {0,2}defaults:\s*$/m);
  });

  it("シェルを上書きしている段が在るなら、それは -e を保つ shell に限られる", () => {
    const offending = shellOverrides.filter((override) => !ALLOWED_SHELLS.has(override.value));
    const offendingLines = offending
      .map((override) => `  ${override.lineNumber}: shell: ${override.value}`)
      .join("\n");
    const message =
      `.github/workflows/publish.yml が、既定シェルの -e を失う形で shell を上書きしている:\n\n` +
      `${offendingLines}\n\n` +
      `⟹ なぜこれが赤いのか:\n` +
      `  Issue #476 の判定「偽陽性の緑は起きない」は、門ステップが GitHub Actions の\n` +
      `  既定シェル（bash -e）で走ることに全面的に依存している。-e を失うと、\n` +
      `  前段のコマンドが落ちてもステップが緑で終わりうる——リリース経路に\n` +
      `  「壊れているのに通る」が戻る。\n` +
      `⟹ どうすればよいか:\n` +
      `  shell: を上書きしないか、-e を保つ形（bash / sh）にすること。\n` +
      `  意図して別のシェルに変えるなら、Issue #476 の判定そのものが成り立たなく\n` +
      `  なるので、判定を引き直してからこの歯を更新すること。\n` +
      `  ⛔ この歯を通すために publish.yml の門ステップを1段ずつに割らないこと\n` +
      `     （それは別の判断である。ADR 0210 の6番を読むこと）。`;
    expect(offending, message).toEqual([]);
  });

  it("門ステップが呼ぶ scripts/run-publish-gates.mjs が実在する（パスの書き間違いで静かに空回りしない）", () => {
    expect(
      gateBlock,
      "門ステップが無いので、走らせる段の実在性そのものを確認できない",
    ).toBeDefined();
    expect(existsSync(runPublishGatesPath), `${runPublishGatesPath} が無い`).toBe(true);
  });
});

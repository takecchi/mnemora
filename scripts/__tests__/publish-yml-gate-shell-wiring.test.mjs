import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { blankOutWorkflowComments } from "../workflow-comment-blank-lib.mjs";

/**
 * ⭐ **この歯が測っているもの（消す前に読むこと）**
 *
 * **`.github/workflows/publish.yml` の門ステップ（「Typecheck / Lint / Format /
 * Test / Build（非 DB の門を全部通す）」段）が、GitHub Actions の既定シェル
 * （`bash -e`）で走るという前提が、`shell:` の上書きで黙って崩されていないこと。**
 *
 * ⚠ **なぜこれが要るか（Issue #476）**
 *
 * Issue #476 の判定「⭕ `v1.0.0` を止めない（偽陽性の緑は起きない）」は、
 * **門ステップが `bash -e` で走ること**に全面的に依存している。だが本文・判定
 * コメントとも、逐語で「`.github/workflows/publish.yml` を読んでいない」と
 * 名乗っている——この判定は現物ではなく ADR 0210 の記述の上に立っていた。
 * ⟹ **この歯が、その前提を初めて現物の上で確かめ、以後は縛る。**
 * `shell: bash {0}`（`-e` を含まない自前テンプレート）を1行足すだけで、
 * 前段が落ちてもステップが緑のまま終わりうる——リリース経路に偽陽性の緑が
 * 戻る。この歯はそれを赤くする。
 *
 * ⚠ **`scripts/__tests__/publish-yml-dry-run-wiring.test.mjs` の重複ではない。**
 * あちらは「判定（`decideDryRun()`）が `publish.yml` に実際に配線されているか」
 * （dry-run 判定のステップ間の受け渡し）を測る——`shell:` は1バイトも見ない。
 * こちらは**シェルの意味論**（既定シェルの `-e` が保たれているか）だけを測る。
 * 両者は独立した主張であり、どちらか一方が緑でも他方の保証にはならない。
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
 * - **`run:` の中身が正しいかは見ていない。** 門の並び順・過不足（`typecheck` /
 *   `lint` / `format:check` / `test` / `build` の内容そのもの）は縛らない。
 * - **`ci.yml` 側との一致は見ていない。** ADR 0210 が数え直した「族」（6箇所）
 *   そのものを塞ぐわけではない——**塞いでいるのは「Issue #476 の判定の前提が
 *   黙って崩れること」だけである。**
 * - **GitHub Actions が将来 `bash` / `sh` の既定から `-e` を外したら、この歯は
 *   嘘になる。** ⟹ 前提は「2026-09 時点の GitHub の既定」
 *   （`bash --noprofile --norc -eo pipefail {0}` / `sh -e {0}`）である。
 */

const workflowPath = fileURLToPath(new URL("../../.github/workflows/publish.yml", import.meta.url));
const packageJsonPath = fileURLToPath(new URL("../../package.json", import.meta.url));

const workflowRaw = readFileSync(workflowPath, "utf8");
const { text: workflow, unhandled: commentUnhandled } = blankOutWorkflowComments(workflowRaw);

/** @type {{ scripts?: Record<string, string> }} */
const rootPackageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const rootScriptNames = new Set(Object.keys(rootPackageJson.scripts ?? {}));

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
 * `run:` ブロックの本文から `pnpm run <名前>` の行を抽出する。
 * ⛔ 本数・名前の一覧はここに焼き込まない（呼び出し側が数だけを見る）。
 *
 * @param {string} body
 * @returns {string[]}
 */
function extractPnpmRunNames(body) {
  return [...body.matchAll(/pnpm run ([^\s"'|&;]+)/g)].map((m) => m[1]);
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
// ⛔ 門ステップを「`pnpm run typecheck` を含むブロック」で探さない——script 名を歯へ
//    焼き込むことになり、名前が変わったときに「門が消えた」と誤診する
//    （`AGENTS.md`「⚠ 数を、道具と生成物に焼き込まない」。名前も `main` が動けば変わる側である）。
// ⟹ **形だけで選ぶ**: 「`pnpm run` の行が2本以上並ぶ `run: |` ブロック」。
//    【実測 2026-09-19 / `publish.yml`】この形に当たるブロックは門ステップ1つだけである
//    ——2つ以上に増えたら `it` 2 が曖昧として赤くなる（黙ってどちらかを選ばない）。
const gateCandidates = runBlocks.filter((block) => extractPnpmRunNames(block.body).length >= 2);
const gateBlock = gateCandidates.length === 1 ? gateCandidates[0] : undefined;
const gateCommandNames = gateBlock ? extractPnpmRunNames(gateBlock.body) : [];
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

  it("門ステップ（非 DB の門を全部通す段）が実在し、1つの run ブロックに複数のコマンドが並んでいる", () => {
    expect(
      gateCandidates.length,
      "pnpm run の行が2本以上並ぶ run: | ブロックが、publish.yml にちょうど1つ在ることを期待した" +
        `（見つかった数: ${gateCandidates.length}）——0 なら門ステップの形が変わった。` +
        "2以上なら、どれが門ステップかをこの歯が決められない" +
        "（⛔ 黙ってどちらかを選ばない。取り出し方のほうを直すこと）",
    ).toBe(1);
    expect(gateBlock, "門ステップの run: | ブロックを取り出せなかった").toBeDefined();
    // 🔑 なぜ2本以上が要るか: 1本しか無いなら「前段の失敗が後段の起動を止める」
    // という性質そのものが意味を持たない。⟹ この歯が守っている前提
    // （既定シェルの -e）が現に効いていることの確認である。
    expect(
      gateCommandNames.length,
      `門ステップから pnpm run の行を2本以上取り出せなかった` +
        `（取り出せた: ${JSON.stringify(gateCommandNames)}）`,
    ).toBeGreaterThanOrEqual(2);
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

  it("この歯が読んでいる publish.yml が、門を実際に走らせる段を持っている", () => {
    expect(
      gateBlock,
      "門ステップが無いので、走らせる段の実在性そのものを確認できない",
    ).toBeDefined();
    expect(
      gateCommandNames.length,
      "門ステップから pnpm run のコマンド名を1つも取り出せなかった",
    ).toBeGreaterThan(0);
    for (const name of gateCommandNames) {
      expect(
        rootScriptNames.has(name),
        `package.json の scripts に "${name}" が無い` +
          "——パスの書き間違いで、この段が静かに空回りしている可能性がある",
      ).toBe(true);
    }
  });
});

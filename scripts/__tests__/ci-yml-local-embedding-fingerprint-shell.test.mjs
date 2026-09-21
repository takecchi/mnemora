import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * ⭐ **この歯が測っているもの（消す前に読むこと）**
 *
 * `.github/workflows/ci.yml` の `example-chat` ジョブに在る
 * 「local-embedding が実際に読み込んだ重みファイルは、宣言された Hugging Face repo が
 * 今まさに持っているものと一致しているか(⭐ 門)」ステップの `run:` 本文を、
 * **`ci.yml` から逐語で取り出し、1バイトも書き換えずに `bash` へ食わせて**、
 * `check-local-embedding-fingerprint.mjs`（`scripts/check-local-embedding-fingerprint.mjs`）の
 * 判定表が定める4つの終了コード（`0`=match / `1`=mismatch / `2`=undetermined /
 * `3`=実行時エラー）それぞれについて、シェルが判定表どおりに振る舞うことを固定する。
 *
 * `node` は差し替える（一時ディレクトリに `#!/bin/sh\nexit N` という実行可能ファイルを
 * 置き、`PATH` の先頭に足す）。⛔ **`run:` の本文そのものは1文字も文字列置換しない**
 * ——本文を書き換えて実行すると「写しを測った」ことになり、`ci.yml` が実際に持つ
 * 本文とこの歯が検査する対象がずれていく（過去に本文の書き換え漏れで歯だけが
 * 緑のまま残った実例が他の wiring 歯の docstring に記録されている、というのと
 * 同じ構造の危険）。
 *
 * 各終了コードについて、次の3点を確かめる:
 *
 * 1. **シェル自身の終了状態**（`spawnSync` の `status`）。
 * 2. **stdout に `::warning::` が出たか**（GitHub Actions の annotation 記法。
 *    Checks 画面に warning として立つのはこの文字列である——Issue #574 の
 *    本番観測が確かめた通り）。
 * 3. **`GITHUB_STEP_SUMMARY` に指定した一時ファイルへ何行書かれ、中身が何か。**
 *
 * ## 判定表との対応（このファイルの4つの `it` が固定する期待値）
 *
 * | exit | シェルの終了状態 | stdout の `::warning::` | GITHUB_STEP_SUMMARY |
 * |---|---|---|---|
 * | `0`（match） | 成功（0） | 無し | 1行、`🟢`・「一致した」を含む |
 * | `1`（mismatch） | 失敗（1） | 無し | 0行（何も書かれない） |
 * | `2`（undetermined） | 成功（0）——**ジョブは落ちない** | 有り、「保留した」を含む | 1行、`🟡`・「判定していない」を含む |
 * | `3`（実行時エラー） | 失敗（3） | 無し | 0行（何も書かれない） |
 *
 * ⭐ **exit 2 が「シェルの終了状態は成功」であることが、この門の設計そのものである**
 * （`case` の `2)` 枝が `exit` を呼ばず、`::warning::` と Job Summary の1行だけを
 * 出して抜ける）。これにより保留（HF に届かない）は必須ジョブを止めない一方、
 * `exit 0`（本当に一致した）とは `::warning::` の有無と Job Summary の絵文字で
 * 見分けが付く——ci.yml のコメントと `check-local-embedding-fingerprint.mjs` の
 * docstring 判定表が明記している設計であり、この歯はそれを実行して確かめる。
 *
 * ## ⚠ シェルの前提（2026-09 時点の GitHub Actions の既定）
 *
 * この歯は本文を `bash --noprofile --norc -e <file>` で実行する。GitHub Actions は
 * `run:` に `shell:` の指定が無いとき、Linux runner では既定として **`bash -e {0}`**
 * を使う——**`-o pipefail` は付かない**（`shell: bash` と明示したときだけ
 * `bash --noprofile --norc -eo pipefail {0}` になり、両者は別物である。GitHub の
 * ワークフロー構文のドキュメント、および `actions/runner` 側の既知の issue が、
 * 「未指定の既定」と「明示した bash」の食い違いを記録している）。
 *
 * ⟹ **`--noprofile --norc` は、この歯が便宜的に足しているだけで、判定には効かない。**
 * 非対話・非ログインの子プロセスとして `bash <file>` を起動する時点で、
 * `/etc/profile` や `~/.bashrc` はそもそも読まれない（それらはログインシェル・
 * 対話シェルのときだけ読まれる）——`--noprofile --norc` は理論上 no-op である。
 * `-o pipefail` を付けていないことも、この run: 本文に `|`（パイプ）が1つも
 * 無いため判定に影響しない（下の陰性対照・本体テストのどちらも、パイプの
 * 有無に依存する分岐を持たない）。
 *
 * ⚠ **`ci.yml` 自身のコメントは「既定の `bash -e` である——ADR 0245」とだけ書いており、
 * `-o pipefail` の有無には触れていない。** 一方、ADR 0245 の本文は
 * 「Linux runner では `bash --noprofile --norc -eo pipefail {0}`」と書いている
 * ——これは `shell: bash` を明示したときの値であり、`shell:` 未指定の既定とは
 * 食い違う（ADR 0245 自身が「本 ADR が新たに確かめたのはこの逐語の値そのものではない」
 * と断っている）。**この歯は ADR 0245 の本文を書き換えない**（ADR は事後に本文を
 * 直さない規律——`docs/decisions/README.md`）。この食い違いは新しい ADR の側に記録した。
 * ⟹ **どちらの値で実行しても、この run: 本文の判定結果は変わらない**（パイプが
 * 無いため）——だから判定の正しさ自体には影響しないが、値の由来は正直に書く。
 *
 * 🔴 **この歯が測っていないもの:**
 * - **Actions の `run:` ステップとして実際に走ったことは測っていない。** 測ったのは
 *   「同じ本文を、GitHub Actions の既定と同じ形のシェル呼び出しに食わせたときの
 *   振る舞い」であって、GitHub 側のランナー・チェックアウト後の作業ディレクトリ・
 *   `${{ github.workspace }}` の展開・`actions/cache` 等、YAML の他の部分が絡む
 *   経路は一切通していない。**本番のランナーで実際に1回ずつ通した観測は別の層の
 *   証拠であり、この歯の実行結果ではない**（[Issue #574](https://github.com/takecchi/mnemora/issues/574)
 *   のコメント `#issuecomment-5766805876`、使い捨て PR #599、run 35648302199。⚠ この
 *   本番観測は exit 1 と exit 2 の2つだけであり、exit 0・exit 3 は本番では通っていない
 *   ——**この歯はその2つも含めて4つとも手元の bash 実行で固定する**が、それは
 *   「本番のランナーで通した」こととは別の主張である）。
 * - **`check-local-embedding-fingerprint.mjs` 自身が正しい終了コードを返すかは
 *   見ていない。** ここでは `node` を丸ごと偽物（`exit N` するだけの `/bin/sh`
 *   スクリプト）に差し替えているので、CLI 本体の判定ロジックは一切実行されない。
 *   その側は `scripts/__tests__/check-local-embedding-fingerprint-lib.test.mjs`
 *   （純関数側）が見る——役割はそちらとこの歯とで分かれている。
 * - **本文の取り出し方が壊れたときに「配線が変わった」のか「取り出し方が古い」のか
 *   は、この歯自身では判定できない。** `ci-yml-local-embedding-fingerprint-wiring.test.mjs`
 *   と同じ判断——依存追加（YAML パーサ等）はオーナー専権であり、文字列ベースの
 *   取り出しを続ける。
 * - **YAML は構造として解析していない（文字列で見ている）。**
 *
 * ⚠ **`ci-yml-local-embedding-fingerprint-wiring.test.mjs` との役割分担:**
 * あちらは「ステップが正しい形で配線されているか」（存在する・`test:db` より後・
 * `continue-on-error` を持たない等）を YAML の構造だけで見る。**この歯はその
 * ステップの中身（`run:` 本文）をシェルとして実際に実行する。**どちらか一方が
 * 緑でも他方の保証にはならない。
 */

const workflowPath = fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url));
const rawWorkflow = readFileSync(workflowPath, "utf8");

/**
 * `run: |` ブロックを yml から切り出す。**`steps:` の構造は仮定しない**——
 * 「`run: |` の行より深いインデントで続く連続行」という形だけを見る（ステップ名で
 * 探すと、名前が変わったときに歯が古いまま緑になる）。
 *
 * `scripts/__tests__/publish-yml-gate-shell-wiring.test.mjs` の同名関数と同じ形。
 * ⚠ **`blankOutWorkflowComments` を通さない**——あちらは「コメントの中の文字列に
 * 惑わされない」ための前処理だが、ここでは抽出した本文を1バイトも書き換えずに
 * そのまま `bash` へ渡す必要があるため、コメント潰しという文字列置換を経由させない
 * （下の「対象ブロックがちょうど1つに定まる」で、この判断がなぜ安全かを検証する）。
 *
 * @param {string} text
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

const runBlocks = extractRunBlocks(rawWorkflow);
// ⛔ ステップ名（「local-embedding が実際に読み込んだ...」）では選ばない——名前が変われば
// 歯が古いまま緑になる。⟹ 本文が呼ぶスクリプトのファイル名という、より安定した目印で選ぶ。
const fingerprintCandidates = runBlocks.filter((block) =>
  block.body.includes("check-local-embedding-fingerprint.mjs"),
);
const fingerprintBlock = fingerprintCandidates.length === 1 ? fingerprintCandidates[0] : undefined;

/**
 * 抽出した `run:` 本文を一時ファイルへ書き出し、`node` を偽物に差し替えた上で
 * `bash --noprofile --norc -e <file>` に食わせる。
 *
 * @param {string} body `run:` ブロックの本文(1バイトも書き換えない)
 * @param {number} fakeNodeExitCode `node` の代わりに置く偽物が返す終了コード
 * @returns {{ status: number | null, stdout: string, stderr: string, summaryLines: string[] }}
 */
function runFingerprintStepBody(body, fakeNodeExitCode) {
  const scratch = mkdtempSync(join(tmpdir(), "fingerprint-shell-tooth-"));
  const binDir = join(scratch, "bin");
  mkdirSync(binDir);

  // ⭐ 本文を書き換える代わりに、PATH で `node` を差し替える。
  const fakeNodePath = join(binDir, "node");
  writeFileSync(fakeNodePath, `#!/bin/sh\nexit ${fakeNodeExitCode}\n`, { mode: 0o755 });

  const scriptPath = join(scratch, "step.sh");
  writeFileSync(scriptPath, body);

  const summaryPath = join(scratch, "GITHUB_STEP_SUMMARY.md");
  writeFileSync(summaryPath, "");

  const cacheDir = join(scratch, "cache-does-not-need-to-exist");

  const result = spawnSync("bash", ["--noprofile", "--norc", "-e", scriptPath], {
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      GITHUB_STEP_SUMMARY: summaryPath,
      MNEMORA_LOCAL_EMBEDDING_CACHE_DIR: cacheDir,
    },
    encoding: "utf8",
  });

  const summaryContent = readFileSync(summaryPath, "utf8");
  const summaryLines = summaryContent.split("\n").filter((line) => line.length > 0);

  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    summaryLines,
  };
}

describe("ci.yml の local-embedding fingerprint ステップの run: 本文をシェルとして実行する(Issue #574)", () => {
  it("この歯は ci.yml を実際に読んでいる(読めなければ以下は何も測っていない)", () => {
    expect(rawWorkflow, `${workflowPath} が読めなかった`).not.toBe("");
    expect(
      rawWorkflow.length,
      "ci.yml が短すぎる——別ファイルを読んでいる可能性がある",
    ).toBeGreaterThanOrEqual(1000);
  });

  it("check-local-embedding-fingerprint.mjs を呼ぶ run: ブロックが、ちょうど1つに定まる", () => {
    expect(
      fingerprintCandidates.length,
      "check-local-embedding-fingerprint.mjs を含む run: | ブロックが、ci.yml にちょうど1つ" +
        `在ることを期待した(見つかった数: ${fingerprintCandidates.length})——0 なら配線が` +
        "変わった。2以上なら、どれが対象かをこの歯が決められない" +
        "(⛔ 黙ってどちらかを選ばない。取り出し方のほうを直すこと)。",
    ).toBe(1);
    expect(fingerprintBlock, "対象の run: | ブロックを取り出せなかった").toBeDefined();
  });

  it("⚠ 陰性対照: 取り出した本文が空文字列へ退化していない(case/対象スクリプト名/GITHUB_STEP_SUMMARY を含む)", () => {
    expect(fingerprintBlock, "前の it が失敗している場合、ここも意味を持たない").toBeDefined();
    const body = fingerprintBlock?.body ?? "";
    // ⭐ 取り出しに失敗して空文字列に落ちると、bash は何もせず成功終了する——
    // それだと下の exit 0 の it だけが「たまたま」緑になりかねない。この it は
    // その退化を、シェル実行の *前* に文字列として捕まえる。
    expect(body).toContain("check-local-embedding-fingerprint.mjs");
    expect(body).toContain("case");
    expect(body).toContain("GITHUB_STEP_SUMMARY");
    expect(body.trim().length).toBeGreaterThan(0);
  });

  it.runIf(fingerprintBlock !== undefined)(
    "exit 0(match) → シェルは成功終了。::warning:: は出ない。GITHUB_STEP_SUMMARY に🟢の1行",
    () => {
      const { status, stdout, summaryLines } = runFingerprintStepBody(fingerprintBlock.body, 0);
      expect(status).toBe(0);
      expect(stdout).not.toContain("::warning::");
      expect(summaryLines).toHaveLength(1);
      expect(summaryLines[0]).toContain("🟢");
      expect(summaryLines[0]).toContain("一致した");
    },
  );

  it.runIf(fingerprintBlock !== undefined)(
    "exit 1(mismatch) → シェルは exit 1(ジョブは失敗)。::warning:: は出ない。GITHUB_STEP_SUMMARY には何も書かれない",
    () => {
      const { status, stdout, summaryLines } = runFingerprintStepBody(fingerprintBlock.body, 1);
      expect(status).toBe(1);
      expect(stdout).not.toContain("::warning::");
      expect(summaryLines).toHaveLength(0);
    },
  );

  it.runIf(fingerprintBlock !== undefined)(
    "exit 2(undetermined/保留) → シェルは成功終了(ジョブは落ちない)。::warning:: が stdout に出る。GITHUB_STEP_SUMMARY に🟡の1行",
    () => {
      const { status, stdout, summaryLines } = runFingerprintStepBody(fingerprintBlock.body, 2);
      expect(status).toBe(0);
      expect(stdout).toContain("::warning::");
      expect(stdout).toContain("保留した");
      expect(summaryLines).toHaveLength(1);
      expect(summaryLines[0]).toContain("🟡");
      expect(summaryLines[0]).toContain("判定していない");
    },
  );

  it.runIf(fingerprintBlock !== undefined)(
    "exit 3(実行時エラー) → シェルは exit 3(ジョブは失敗)。::warning:: は出ない。GITHUB_STEP_SUMMARY には何も書かれない",
    () => {
      const { status, stdout, summaryLines } = runFingerprintStepBody(fingerprintBlock.body, 3);
      expect(status).toBe(3);
      expect(stdout).not.toContain("::warning::");
      expect(summaryLines).toHaveLength(0);
    },
  );
});

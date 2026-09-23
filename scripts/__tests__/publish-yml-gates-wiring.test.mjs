import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * ⭐ **この歯が測っているもの（消す前に読むこと）**
 *
 * **`.github/workflows/publish.yml` が、実際に `scripts/run-publish-gates.mjs` に
 * 配線されていること**（Issue #476、ADR 0210 追記）。
 *
 * ⚠ **これは `scripts/__tests__/run-publish-gates.test.mjs` の重複ではない。**
 * あちらは**入力を自分で作って**（偽の段の JSON を環境変数で渡して）script 単体の
 * 振る舞いを測る——`publish.yml` を1バイトも読まない。⟹ 誰かが `publish.yml` から
 * `node scripts/run-publish-gates.mjs` の呼び出しを消して、直す前のインライン
 * `pnpm run …` の5行（`bash -e` 任せ）に戻しても、あちらは緑のまま通る。
 *
 * **この歯だけが `publish.yml` を入力に取る。**やっていることは:
 *
 * 1. `publish.yml` から門ステップを取り出す（`run-publish-gates.mjs` を打つ段）
 * 2. yml に書いてある通りの起動コマンドを取り出す
 *    （`run-publish-gates.mjs` という名前をこの歯に書き写さない——書き写すと、
 *    名前が変わったときに歯のほうが古いまま緑になる。正規表現でマッチした
 *    グループをそのまま使う）
 * 3. **yml から取り出したコマンドを、そのまま子プロセスとして実際に起動する**
 *    ——`MNEMORA_PUBLISH_GATE_STAGES_JSON`（テスト専用の抜け道。
 *    `scripts/run-publish-gates.mjs` の docstring）で本物の pnpm コマンドを
 *    偽の段に差し替え、「yml から取り出した呼び出しが、確かに動く実物へ繋がっている」
 *    ことを見る。
 *
 * ⚠ **YAML は構造として解析していない（文字列で見ている）。**
 * `scripts/__tests__/publish-yml-dry-run-wiring.test.mjs` と同じ判断で、歯のために
 * YAML パーサの依存を足していない。**だからこの歯は書き方の変更に弱い。**
 * 壊れたときは「配線が変わった」か「書き方が変わった」かを見て、
 * **配線が変わっていないなら取り出し方のほうを直すこと（歯を消さないこと）**。
 *
 * 🔴 **この歯が捕まえないもの:**
 * - **既定の5段（本物の `pnpm run typecheck` 等）が実際に走ることは測っていない。**
 *   それは CI 自身の実行（あるいは手で `node scripts/run-publish-gates.mjs` を
 *   走らせること）でしか確認できない——この歯は偽の段しか流さない。
 * - **shell の `-e` が保たれているか**は
 *   `scripts/__tests__/publish-yml-gate-shell-wiring.test.mjs` が見る。
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const workflowPath = fileURLToPath(new URL("../../.github/workflows/publish.yml", import.meta.url));

const workflow = readFileSync(workflowPath, "utf8");

/**
 * `steps:` の下の1段（`      - name: ...` から次の同じ深さまで）へ切り分ける。
 * `scripts/__tests__/publish-yml-dry-run-wiring.test.mjs` の `parseSteps` と同じ形
 * （意図的にファイルをまたいで共有しない——歯ごとに自己完結させる、という既存の
 * workflow wiring 歯群の慣習に揃える）。
 *
 * @param {string} yaml
 * @returns {{ name: string, run: string }[]}
 */
function parseSteps(yaml) {
  const steps = [];
  /** @type {string[] | null} */
  let current = null;
  for (const line of yaml.split("\n")) {
    if (/^ {6}- /.test(line)) {
      current = [line.replace(/^ {6}- /, "        ")];
      steps.push(current);
      continue;
    }
    if (!current) continue;
    if (line.trim() !== "" && /^ {0,7}\S/.test(line)) {
      current = null;
      continue;
    }
    current.push(line);
  }
  return steps.map((lines) => {
    const text = lines.join("\n");
    const nameMatch = text.match(/^ {8}name: (.*)$/m);
    return {
      name: nameMatch ? nameMatch[1].trim() : "",
      run: parseScalarBlock(lines, "run"),
      raw: text,
    };
  });
}

/**
 * `        run: |` の下の本体、または `        run: <一行>` を返す。
 *
 * @param {string[]} lines
 * @returns {string}
 */
function parseScalarBlock(lines, key) {
  const body = [];
  let inside = false;
  for (const line of lines) {
    if (!inside) {
      const oneLine = line.match(new RegExp(`^ {8}${key}: (?!\\|)(.*)$`));
      if (oneLine) return oneLine[1].trim();
      if (new RegExp(`^ {8}${key}: \\|`).test(line)) {
        inside = true;
        continue;
      }
      continue;
    }
    if (line.trim() === "") {
      body.push("");
      continue;
    }
    if (/^ {8}\S/.test(line)) break;
    body.push(line.replace(/^ {10}/, ""));
  }
  return body.join("\n").trim();
}

const steps = parseSteps(workflow);
const gateStep = steps.find((step) => step.run.includes("run-publish-gates.mjs"));

describe(".github/workflows/publish.yml が scripts/run-publish-gates.mjs に配線されていること（通しの歯）", () => {
  it("この歯は publish.yml を実際に読んでいる（読めなければ以下は何も測っていない）", () => {
    expect(workflow, `${workflowPath} が読めなかった`).not.toBe("");
    expect(steps.length, "publish.yml の steps を1段も切り出せなかった").toBeGreaterThan(5);
  });

  /**
   * ⭐ **この歯の存在理由そのもの。**これが落ちるときは、
   * publish.yml が5行の `pnpm run …` を `bash -e` に任せる形へ戻したか、
   * 呼び出し先のファイル名が変わったかのどちらかである。
   */
  it("run-publish-gates.mjs を打つ段が在る（インラインの5行 + bash -e に戻っていない）", () => {
    expect(
      gateStep,
      "publish.yml に run-publish-gates.mjs を打つ段が無い" +
        "——門が5行のインライン pnpm run … に戻っている可能性がある（Issue #476 の欠陥が再発する）",
    ).toBeDefined();
  });

  it("段が打つスクリプトが実在する（パスの書き間違いで静かに空回りしない）", () => {
    expect(gateStep, "門ステップが無い").toBeDefined();
    const invocation = gateStep.run.match(/node\s+(\S*run-publish-gates\.mjs)/);
    expect(invocation, `node で起動していない: ${JSON.stringify(gateStep.run)}`).not.toBeNull();
    expect(existsSync(`${repoRoot}/${invocation[1]}`), `${invocation[1]} が無い`).toBe(true);
  });

  it("継続を握り潰す continue-on-error: を持たない", () => {
    expect(gateStep, "門ステップが無い").toBeDefined();
    expect(gateStep.raw).not.toMatch(/continue-on-error:\s*true/);
  });

  /**
   * ⭐⭐ 芯。yml に書いてある通りのコマンドで、本物の script を実際に起動する
   * （偽の段に差し替えて）。「yml のテキストにそれっぽい文字列がある」だけでなく、
   * **その文字列が本当に動く実行可能ファイルを指している**ことを見る。
   */
  it("yml から取り出した呼び出しをそのまま実行すると、偽の段を前段の成否に関わらず全部起動し、失敗した段の名前を報告する", () => {
    expect(gateStep, "門ステップが無い").toBeDefined();
    const invocation = gateStep.run.match(/node\s+(\S*run-publish-gates\.mjs)/);
    expect(
      invocation,
      "門ステップが node で run-publish-gates.mjs を起動していない",
    ).not.toBeNull();

    const stages = [
      { name: "wired-stage-1", command: process.execPath, args: ["-e", "process.exit(0)"] },
      { name: "wired-stage-2", command: process.execPath, args: ["-e", "process.exit(9)"] },
      { name: "wired-stage-3", command: process.execPath, args: ["-e", "process.exit(0)"] },
    ];
    const result = spawnSync(process.execPath, [`${repoRoot}/${invocation[1]}`], {
      cwd: repoRoot,
      encoding: "utf8",
      // `GITHUB_WORKFLOW` を明示的に上書きする（`run-publish-gates.test.mjs` の `runGate` の
      // doc と同じ理由。publish の job の中でこの歯が走ると、親の値は `Publish` になる）。
      env: {
        ...process.env,
        GITHUB_WORKFLOW: "test-of-publish-yml-gates-wiring",
        MNEMORA_PUBLISH_GATE_STAGES_JSON: JSON.stringify(stages),
      },
    });

    expect(result.status, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).not.toBe(0);
    // 2本目が落ちても3本目が走ったこと（bash -e のように途中で止まっていない）。
    expect(result.stdout).toContain("wired-stage-3");
    expect(result.stdout).not.toContain("未起動");
    expect(result.stdout).toContain("失敗した段");
    expect(result.stdout).toContain("wired-stage-2");
  });
});

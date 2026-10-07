import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyPublishOutcome,
  detectDryRunMarker,
  evaluatePublishRunCoverage,
  findPublishStepName,
  parsePublishGroups,
} from "../publish-run-coverage-lib.mjs";
import { PUBLISH_TARGETS } from "../publish-targets.mjs";
import { spawnSyncWithDeadline } from "./spawn-with-deadline.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const scriptsDir = join(repoRoot, "scripts");
const script = join(scriptsDir, "check-publish-run-coverage.mjs");
const TS = "2026-09-17T01:14:00.3481028Z ";

const targets = [
  { name: "@mnemora/core" },
  { name: "@mnemora/testkit" },
  { name: "@mnemora/openai" },
];

function group(spec, resultLine, { endgroup = true } = {}) {
  return (
    `${TS}##[group]npm publish ${spec}\n` +
    `${TS}${resultLine}\n` +
    (endgroup ? `${TS}##[endgroup]\n` : "")
  );
}
const published = (name) => group(`${name}@1.0.0`, `✔ ${name}@1.0.0 を publish した`);
const skipped = (name) =>
  group(`${name}@1.0.0`, `✔ ${name}@1.0.0 は既に registry に在る（飛ばした）`);
const failed = (name) => group(`${name}@1.0.0`, `✗ ${name}@1.0.0 の publish が失敗した（exit 1）`);

describe("evaluatePublishRunCoverage: 1本だけの異常も pass に倒さない", () => {
  it("P13c: 1本だけ failed で、他が全部 published なら fail（名指しし、published の数は数えない）", () => {
    const log =
      published("@mnemora/core") + failed("@mnemora/testkit") + published("@mnemora/openai");
    const result = evaluatePublishRunCoverage(log, targets);
    expect(result.verdict).toBe("fail");
    expect(result.publishedCount).toBe(2);
    expect(result.reason).toContain("失敗した: @mnemora/testkit");
    expect(result.reason).toContain("2/3 本しか publish 経路を通っていない");
  });

  it("P13d: 1本だけログに無く（missing）、他が全部 published なら fail（名指しする）", () => {
    const log = published("@mnemora/core") + published("@mnemora/openai");
    const result = evaluatePublishRunCoverage(log, targets);
    expect(result.verdict).toBe("fail");
    expect(result.reason).toContain("ログに無い: @mnemora/testkit");
    expect(result.reason).toContain("2/3 本しか publish 経路を通っていない");
  });

  it("P14a・P14d: skipped・余分な名前が、他が全部 published でも reason に名指しで出る", () => {
    const log =
      skipped("@mnemora/core") +
      published("@mnemora/testkit") +
      published("@mnemora/openai") +
      published("@someone/else");
    const result = evaluatePublishRunCoverage(log, targets);
    expect(result.verdict).toBe("fail");
    expect(result.reason).toContain("飛ばした: @mnemora/core");
    expect(result.reason).toContain("PUBLISH_TARGETS に無い名前がログに在る: @someone/else");
    expect(result.unexpectedNames).toEqual(["@someone/else"]);
  });

  it("P14e: 本数は『通った本数/対象の本数』で出す（対象の本数を2回書かない）", () => {
    const log =
      skipped("@mnemora/core") + skipped("@mnemora/testkit") + published("@mnemora/openai");
    const result = evaluatePublishRunCoverage(log, targets);
    expect(result.reason).toContain("1/3 本しか publish 経路を通っていない");
  });
});

describe("parsePublishGroups: group の切り出し境界", () => {
  it("P2・P2b: endgroup（##[endgroup] 形も ::endgroup:: 形も）より後の行を、その本の本文に混ぜない", () => {
    const stray = `${TS}✔ @mnemora/core@1.0.0 を publish した\n`;
    for (const [open, close] of [
      ["##[group]", "##[endgroup]"],
      ["::group::", "::endgroup::"],
    ]) {
      const log =
        `${TS}${open}npm publish @mnemora/core@1.0.0\n` +
        `${TS}何も言わない本文\n` +
        `${TS}${close}\n` +
        stray;
      const groups = parsePublishGroups(log);
      expect(groups).toHaveLength(1);
      expect(classifyPublishOutcome(groups[0].body)).toBe("unknown");
      expect(evaluatePublishRunCoverage(log, [{ name: "@mnemora/core" }]).verdict).toBe(
        "indeterminate",
      );
    }
  });

  it("P6・P6b: endgroup を見ないまま次の group が来ても、前の本を捨てずに1本として確定する", () => {
    const log =
      group("@mnemora/core@1.0.0", "✗ @mnemora/core@1.0.0 の publish が失敗した（exit 1）", {
        endgroup: false,
      }) + published("@mnemora/testkit");
    const groups = parsePublishGroups(log);
    expect(groups.map((g) => g.spec)).toEqual(["@mnemora/core@1.0.0", "@mnemora/testkit@1.0.0"]);
    const result = evaluatePublishRunCoverage(log, [
      { name: "@mnemora/core" },
      { name: "@mnemora/testkit" },
    ]);
    expect(result.perTarget.find((p) => p.name === "@mnemora/core").outcome).toBe("failed");
  });
});

describe("文言の同一性: この道具が読む文言が、publish.yml が実際に出す echo と一致する（ADR 0209「引き受けた負債」1番）", () => {
  const workflow = readFileSync(join(repoRoot, ".github/workflows/publish.yml"), "utf8");
  const echoLines = workflow
    .split("\n")
    .map((line) => /^\s*echo "(.*)"( >&2)?\s*$/.exec(line))
    .filter(Boolean)
    .map((m) => m[1]);

  const specEchoes = echoLines
    .filter((text) => text.includes("${spec}"))
    .map((text) => text.replaceAll("${spec}", "@mnemora/core@1.0.0").replaceAll("${STATUS}", "1"));

  it("spec を名指しする echo は、group の開始・publish した・飛ばした・失敗した の4つだけで、この順に並ぶ", () => {
    expect(specEchoes).toHaveLength(4);
    expect(specEchoes[0]).toBe("::group::npm publish @mnemora/core@1.0.0");
  });

  it("3つの結果の echo は、それぞれ published・skipped・failed に分類される", () => {
    expect(classifyPublishOutcome(specEchoes[1])).toBe("published");
    expect(classifyPublishOutcome(specEchoes[2])).toBe("skipped");
    expect(classifyPublishOutcome(specEchoes[3])).toBe("failed");
  });

  it("実物の echo だけで組んだ group（runner が ::group:: を ##[group] へ変換した形）から、3本とも期待どおりに読める", () => {
    const toRunnerForm = (text) => text.replace("::group::", "##[group]");
    const log = (resultEcho) =>
      `${TS}${toRunnerForm(specEchoes[0])}\n${TS}${resultEcho}\n${TS}##[endgroup]\n`;
    const one = [{ name: "@mnemora/core" }];
    expect(evaluatePublishRunCoverage(log(specEchoes[1]), one).verdict).toBe("pass");
    expect(evaluatePublishRunCoverage(log(specEchoes[2]), one).perTarget[0].outcome).toBe(
      "skipped",
    );
    expect(evaluatePublishRunCoverage(log(specEchoes[3]), one).perTarget[0].outcome).toBe("failed");
  });

  it("予行の固定文言は、publish.yml が出す echo と一致し、実行結果の行として予行と判定される", () => {
    const dryEcho = echoLines.filter((text) => text.startsWith("予行（--dry-run）"));
    expect(dryEcho).toHaveLength(1);
    expect(detectDryRunMarker(`${TS}${dryEcho[0]}\n`)).toBe(true);
  });

  it("publish.yml の step 名の逆算が、`::group::npm publish` を出す段を指す", () => {
    const name = findPublishStepName(workflow);
    expect(name).not.toBeNull();
    const at = workflow.indexOf(`- name: ${name}`);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(workflow.indexOf("::group::npm publish", at)).toBeGreaterThan(at);
  });
});

describe("check-publish-run-coverage.mjs（--run の経路。偽の gh で判定不能と実行時エラーを仕分ける）", () => {
  /** @type {string | undefined} */
  let workDir;
  afterEach(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
    workDir = undefined;
  });

  const stepName = findPublishStepName(
    readFileSync(join(repoRoot, ".github/workflows/publish.yml"), "utf8"),
  );

  const fullLog = PUBLISH_TARGETS.map((t) => published(t.name)).join("");

  /**
   * @param {object} scenario
   * @param {{ cliDir?: string }} [options] CLI を別の木から起動するとき、その木のルート
   */
  function runWithFakeGh(scenario, args = ["--run", "100", "--repo", "o/r"], options = {}) {
    workDir ??= mkdtempSync(join(tmpdir(), "check-publish-run-coverage-recheck-"));
    const bin = join(workDir, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(workDir, "scenario.json"), JSON.stringify(scenario));
    const fake = [
      `#!${process.execPath}`,
      'const fs = require("node:fs");',
      `const s = JSON.parse(fs.readFileSync(${JSON.stringify(join(workDir, "scenario.json"))}, "utf8"));`,
      "const a = process.argv.slice(2);",
      'if (a[0] === "run" && a[1] === "view") {',
      "  if (s.runViewFails) { console.error('run not found'); process.exit(1); }",
      '  const fields = a[a.indexOf("--json") + 1].split(",");',
      "  const out = {}; for (const f of fields) if (f in s.run) out[f] = s.run[f];",
      "  console.log(JSON.stringify(out)); process.exit(0);",
      "}",
      'if (a[0] === "api") {',
      "  if (s.logFails) { console.error('HTTP 410: logs expired'); process.exit(1); }",
      "  const m = /actions\\/jobs\\/(\\d+)\\/logs/.exec(a[1]);",
      "  if (!m || Number(m[1]) !== s.logJobId) { console.error('wrong job ' + a[1]); process.exit(1); }",
      "  process.stdout.write(s.log); process.exit(0);",
      "}",
      'if (a[0] === "repo") { console.log("o/r"); process.exit(0); }',
      "process.exit(99);",
    ].join("\n");
    writeFileSync(join(bin, "gh"), fake);
    chmodSync(join(bin, "gh"), 0o755);
    return spawnSyncWithDeadline(process.execPath, [options.cliPath ?? script, ...args], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` },
    });
  }

  const completedRun = (jobs) => ({
    status: "completed",
    conclusion: "success",
    event: "workflow_dispatch",
    url: "https://example.invalid/run/100",
    jobs,
  });
  const jobWithStep = (databaseId) => ({
    databaseId,
    name: `job-${databaseId}`,
    steps: [{ name: "Checkout" }, { name: stepName }],
  });
  const jobWithoutStep = (databaseId) => ({
    databaseId,
    name: `job-${databaseId}`,
    steps: [{ name: "Checkout" }],
  });

  it("Q11・Q10: 完了した run の、publish 段を持つ job（2つ目）のログを読み、全部 publish していれば exit 0", () => {
    const result = runWithFakeGh({
      run: completedRun([jobWithoutStep(7), jobWithStep(8)]),
      logJobId: 8,
      log: fullLog,
    });
    expect(result.stdout).toContain("判定: pass");
    expect(result.status).toBe(0);
  });

  it("Q2: run がまだ走っていれば exit 2（判定不能）。ログは読みに行かない", () => {
    const result = runWithFakeGh({
      run: { ...completedRun([jobWithStep(8)]), status: "in_progress" },
      logJobId: 8,
      log: fullLog,
    });
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("まだ走っている");
    expect(result.stdout).not.toContain("判定: pass");
  });

  it("Q3: publish 段を持つ job が run の中に無ければ exit 2（判定不能）", () => {
    const result = runWithFakeGh({
      run: completedRun([jobWithoutStep(7)]),
      logJobId: 7,
      log: fullLog,
    });
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("見つからなかった");
  });

  it("Q6: ログが取れなければ（期限切れ）exit 2（判定不能）で、実行時エラー（3）にしない", () => {
    const result = runWithFakeGh({
      run: completedRun([jobWithStep(8)]),
      logJobId: 8,
      logFails: true,
      log: "",
    });
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("ログが取得できなかった");
  });

  it("Q7: gh run view 自体が失敗すれば exit 3（実行時エラー）で、判定不能（2）にしない", () => {
    const result = runWithFakeGh({ runViewFails: true });
    expect(result.status).toBe(3);
  });

  it("--repo を省くと gh repo view で repo を引く。--json は repo・job の素性も出す", () => {
    const result = runWithFakeGh(
      { run: completedRun([jobWithStep(8)]), logJobId: 8, log: fullLog },
      ["--run", "100", "--json"],
    );
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout.slice(result.stdout.indexOf("{")));
    expect(parsed.repo).toBe("o/r");
    expect(parsed.jobId).toBe(8);
    expect(parsed.result.verdict).toBe("pass");
  });

  it("Q4: 手元の publish.yml から publish 段の step 名が逆算できなければ exit 3（この CLI 自身が使えない）", () => {
    workDir = mkdtempSync(join(tmpdir(), "check-publish-run-coverage-recheck-"));
    mkdirSync(join(workDir, "tree", "scripts"), { recursive: true });
    mkdirSync(join(workDir, "tree", ".github", "workflows"), { recursive: true });
    for (const f of [
      "check-publish-run-coverage.mjs",
      "publish-run-coverage-lib.mjs",
      "publish-targets.mjs",
    ]) {
      copyFileSync(join(scriptsDir, f), join(workDir, "tree", "scripts", f));
    }
    writeFileSync(
      join(workDir, "tree", ".github", "workflows", "publish.yml"),
      "name: Publish\njobs:\n  x:\n    steps:\n      - name: nothing\n        run: echo hi\n",
    );
    const result = runWithFakeGh(
      { run: completedRun([jobWithStep(8)]), logJobId: 8, log: fullLog },
      ["--run", "100", "--repo", "o/r"],
      { cliPath: join(workDir, "tree", "scripts", "check-publish-run-coverage.mjs") },
    );
    expect(result.status).toBe(3);
    expect(result.stderr).toContain("step 名が");
  });
});

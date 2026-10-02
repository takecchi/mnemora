import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * ADR 0478: `examples/chat/README.md` の節「フラグと環境変数の一覧」が載せると決めたフラグ・環境変数が、
 *   (1) README に在ること、(2) `examples/chat/src`（テストを除く）が実際に読んでいること、を縛る。
 *
 * ⚠ **全集合の一致は縛らない。**ソースが読む環境変数のうち、`src/scripts/*`・`src/bench/*` の単発の測定スクリプトだけが
 * 読むもの（`MEASURE_*` など）は、README が網羅しないと決めている（ADR 0478 の基準）。全集合を縛ると内部用まで載せることになる。
 * 載せるものを増やしたら、下の表にも足すこと。ソースから消えた変数を README が載せ続けていたら (2) が赤になる。
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const readme = readFileSync(join(repoRoot, "examples/chat/README.md"), "utf8");

const SECTION_HEADING = "## フラグと環境変数の一覧";
/** 節の本文（見出しから次の `## ` まで）。 */
function section() {
  const start = readme.indexOf(SECTION_HEADING);
  if (start < 0) return "";
  const rest = readme.slice(start + SECTION_HEADING.length);
  const next = rest.search(/\n## /);
  return next < 0 ? rest : rest.slice(0, next);
}

/** 載せると決めたフラグ・環境変数（ADR 0478）。 */
const FLAGS = ["--trials", "--temperature", "--dev"];
const ENV_VARS = [
  "MNEMORA_TIME_WEIGHTING_JSON",
  "MNEMORA_COMPARE_JSON",
  "MNEMORA_RETRIEVAL_JSON",
  "MNEMORA_BENCH_CHANNELS",
  "MNEMORA_LEXICAL_STORE",
  "MNEMORA_NUMERAL_TOKEN_OPENAI_JSON",
  "MNEMORA_ASSOCIATION_JSON",
  "MNEMORA_CONSOLIDATION_JSON",
  "MNEMORA_CONSOLIDATION_GROUP_SIZE",
  "MNEMORA_CONSOLIDATION_BUDGET_LADDER",
  "MNEMORA_CONSOLIDATION_RECALL_LIMIT",
  "MNEMORA_ARCHIVE_SWEEP_JSON",
  "MNEMORA_ARCHIVE_SWEEP_MARGIN_HOURS",
  "MNEMORA_ARCHIVE_SWEEP_LIMIT",
  "MNEMORA_ARCHIVE_SWEEP_BUDGET_LADDER",
  "MNEMORA_ARCHIVE_SWEEP_RECALL_LIMIT",
  "MNEMORA_ANSWER_CLAIM_KEY",
  "MNEMORA_ANSWER_TRIALS_RENDERS",
  "MNEMORA_EMBEDDING_FINGERPRINT_RAW_JSON",
  "MNEMORA_EMBEDDING_FINGERPRINT_NUM_THREADS",
];

/** `examples/chat/src` の、テスト（`__tests__`）を除く `.ts` の本文を連結する。 */
function readSources() {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === "__tests__") continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".ts")) out.push(readFileSync(p, "utf8"));
    }
  };
  walk(join(repoRoot, "examples/chat/src"));
  return out.join("\n");
}
const sources = readSources();

/**
 * `cli.ts` の `printHelp` の本文（usage = `--help` の出力の元）。
 * `cli.ts` は末尾で `main()` を無条件に実行するので import できない。ソースの文字列として切り出す。
 */
function readUsageSource() {
  const cli = readFileSync(join(repoRoot, "examples/chat/src/cli.ts"), "utf8");
  const start = cli.indexOf("function printHelp(");
  const end = cli.indexOf("const HELP_COMMANDS");
  return start < 0 || end < start ? "" : cli.slice(start, end);
}
const usage = readUsageSource();

describe("examples/chat/README.md の節「フラグと環境変数の一覧」（ADR 0478）", () => {
  const body = section();

  it("陽性対照: 節が見つかり、すでに別の節に書いてある変数（MNEMORA_ANSWER_TRIALS_N）は、この表の外にも README に在る", () => {
    expect(body.length).toBeGreaterThan(500);
    expect(readme).toContain("MNEMORA_ANSWER_TRIALS_N");
  });

  it.each([...FLAGS, ...ENV_VARS])("%s は節に書いてあり、ソースが読んでいる", (token) => {
    expect(body, `${token} が README の節に無い`).toContain(token);
    expect(sources, `${token} を examples/chat/src が読んでいない（README が古い）`).toContain(
      token,
    );
  });

  it("陽性対照: 内部の測定スクリプト専用の変数（MEASURE_N）は節に載せていない（載せない基準どおり）", () => {
    expect(body).not.toMatch(/`MEASURE_N`/);
    expect(sources).toContain("MEASURE_N");
  });

  // ADR 0501（ADR 0478 負債1）: README の節に載せた利用者向けのものは、usage（--help）にも出ていること。
  // 内部用（MEASURE_N など）は usage に載せない。
  it("陽性対照: usage の本文を切り出せている（既に usage にある変数と、サブコマンド名が在る）", () => {
    expect(usage.length).toBeGreaterThan(500);
    expect(usage).toContain("MNEMORA_ANSWER_TRIALS_N");
    expect(usage).toContain("answer-time-weighting");
  });

  it.each([...FLAGS, ...ENV_VARS])("%s は usage（--help）にも出ている", (token) => {
    expect(usage, `${token} が cli.ts の usage に無い（README の節にはある）`).toContain(token);
  });

  it("陽性対照: 内部の測定スクリプト専用の変数（MEASURE_N）は usage に載せていない", () => {
    expect(usage).not.toContain("MEASURE_N");
  });
});

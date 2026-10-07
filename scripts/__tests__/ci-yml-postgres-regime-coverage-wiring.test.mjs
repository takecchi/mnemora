import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EXPECTED_SERVER_ENCODINGS } from "../lexical-regime-coverage-lib.mjs";
import { artifactNameForEncoding } from "../lexical-regime-coverage-lib.mjs";
import { blankOutWorkflowComments } from "../workflow-comment-blank-lib.mjs";
import { normalizeWorkflowExpressions } from "../workflow-expression-lib.mjs";

/**
 * YAML は構造として解析せず文字列で見る（依存追加はオーナー専権）。
 */

const workflowPath = fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url));
const workflow = readFileSync(workflowPath, "utf8");

const COVERAGE_JOB_ID = "postgres-regime-coverage";
const POSTGRES_JOB_ID = "postgres";

/**
 * @param {string} jobId
 * @returns {string}
 */
function extractJob(jobId) {
  const lines = workflow.split("\n");
  const start = lines.findIndex((line) => line === `  ${jobId}:`);
  if (start === -1) {
    throw new Error(
      `ci.yml に \`  ${jobId}:\` のジョブが無い。Issue #155 が対象にしているジョブが消えたか、` +
        "名前が変わったか、インデントが変わった。",
    );
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^ {2}\S/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/**
 * @returns {string[]}
 */
function extractMatrixServerEncodings() {
  const jobBlock = extractJob(POSTGRES_JOB_ID);
  const lines = jobBlock.split("\n");
  const includeAt = lines.findIndex((line) => line === "        include:");
  if (includeAt === -1) {
    throw new Error(
      "ci.yml の postgres ジョブに strategy.matrix.include が無い(Issue #155 の matrix 化が外れている)。",
    );
  }
  const encodings = [];
  for (let i = includeAt + 1; i < lines.length; i += 1) {
    const line = lines[i];
    const legStart = /^ {10}- serverEncoding: (.+)$/.exec(line);
    if (legStart) {
      encodings.push(legStart[1].trim());
      continue;
    }
    if (line.trim() === "" || line.trim().startsWith("#") || /^ {10,}/.test(line)) {
      continue;
    }
    break;
  }
  return encodings;
}

/**
 * `path:` や `pattern:` の値では段を見分けない（変異させる当のフィールドで同定すると歯が空回りする）。
 *
 * @returns {string}
 */
function extractDownloadStepBlock() {
  const lines = coverageJobBlock.split("\n");
  const at = lines.findIndex((line) => /uses:\s*actions\/download-artifact@/.test(line));
  if (at === -1) {
    throw new Error(
      "postgres-regime-coverage ジョブに actions/download-artifact の段が無い" +
        "(Issue #155 の artifact 収集が外れている)。",
    );
  }
  let start = at;
  while (start > 0 && !/^\s*- name:/.test(lines[start])) {
    start -= 1;
  }
  let end = lines.length;
  for (let i = at + 1; i < lines.length; i += 1) {
    if (/^\s*- name:/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/**
 * @returns {string}
 */
function extractDownloadPattern() {
  const match = /^\s*pattern:\s*(\S.*?)\s*$/m.exec(extractDownloadStepBlock());
  if (match === null) {
    throw new Error("download-artifact の段に pattern: が無い。");
  }
  return stripQuotes(match[1]);
}

/**
 * @returns {string}
 */
function extractDownloadPath() {
  const match = /^\s*path:\s*(\S.*?)\s*$/m.exec(extractDownloadStepBlock());
  if (match === null) {
    throw new Error("download-artifact の段に path: が無い。");
  }
  return stripQuotes(match[1]);
}

/**
 * `path:` の値ではなくスクリプト名で段を同定する。
 *
 * @returns {string}
 */
function extractArtifactsDirArgument() {
  const match = /--artifacts-dir\s+"([^"]+)"/.exec(coverageJobBlock);
  if (match === null) {
    throw new Error('lexical-regime-coverage.mjs へ --artifacts-dir "…" を渡す段が見つからない。');
  }
  return match[1];
}

/**
 * @param {string} value
 * @returns {string}
 */
function stripQuotes(value) {
  return value.replace(/^["']|["']$/g, "");
}

/**
 * 照合のためだけに使い、実行されるテキストへは通さない。
 *
 * @param {string} value
 * @returns {string}
 */
function normalizeExpression(value) {
  const { text, unhandled } = normalizeWorkflowExpressions(value);
  if (unhandled.length > 0) {
    throw new Error(`照合専用の網が正規化できない式が在る: ${unhandled.join(", ")}`);
  }
  return text;
}

/**
 * `*` だけを扱う。依存（minimatch 等）は足さない（依存追加はオーナー専権）。
 *
 * @param {string} pattern
 * @param {string} name
 * @returns {boolean}
 */
function globMatches(pattern, name) {
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]*");
  return new RegExp(`^${source}$`).test(name);
}

/**
 * @returns {string[]}
 */
function extractUploadedArtifactNames() {
  const { text } = blankOutWorkflowComments(workflow);
  const lines = text.split("\n");
  const names = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!/uses:\s*actions\/upload-artifact@/.test(lines[i])) {
      continue;
    }
    for (let j = i + 1; j < Math.min(lines.length, i + 8); j += 1) {
      if (/^\s*- name:/.test(lines[j])) {
        break;
      }
      const match = /^\s*name:\s*(\S.*?)\s*$/.exec(lines[j]);
      if (match !== null) {
        names.push(stripQuotes(match[1]));
        break;
      }
    }
  }
  return names;
}

// `coverageJobBlock` は `toContain`/`toMatch` にしか使わない（実行する側の生テキストへ適用しない）。
const { text: coverageJobBlock, unhandled: coverageJobBlockUnhandled } = blankOutWorkflowComments(
  extractJob(COVERAGE_JOB_ID),
);

describe("ci.yml の postgres-regime-coverage ジョブの配線(Issue #155 満たすべきこと2)", () => {
  it("🔴 コメント潰しが「扱えない」形に当たっていない(無視できないAPIにする)", () => {
    expect(coverageJobBlockUnhandled).toEqual([]);
  });

  it("ジョブが存在し、needs: postgres / if: always() を持つ(片脚が落ちても走る)", () => {
    expect(coverageJobBlock).toContain("needs: postgres");
    expect(coverageJobBlock).toContain("if: always()");
  });

  it("🔴 needs.postgres.result が skipped のとき非0で終わる段がある(skip を成功として読ませない)", () => {
    expect(coverageJobBlock).toContain("needs.postgres.result");
    expect(coverageJobBlock).toMatch(/skipped/);
    expect(coverageJobBlock).toContain("exit 1");
  });

  it("lexical-regime-* パターンで artifact をダウンロードする段がある", () => {
    expect(coverageJobBlock).toContain("uses: actions/download-artifact@v");
    expect(coverageJobBlock).toContain("pattern: lexical-regime-*");
  });

  it("🔴🔴 Issue #163 ②: download の pattern が、消費側(artifactNameForEncoding)が探す名前を実際に拾える", () => {
    const pattern = extractDownloadPattern();
    for (const encoding of EXPECTED_SERVER_ENCODINGS) {
      const artifactName = artifactNameForEncoding(encoding);
      expect(
        globMatches(pattern, artifactName),
        `download の pattern(${pattern})が、消費側が探す artifact 名(${artifactName})を拾えない。` +
          "⟹ その脚の artifact は download されず、coverage は「脚が走っていない」と読む。",
      ).toBe(true);
    }
  });

  it("🔴🔴 Issue #163 ②: download の pattern が、この workflow の他の artifact まで巻き込んでいない(陰性対照)", () => {
    // 比較対象は書き置かず、ci.yml が実際に upload している artifact 名を読み出して使う。
    const otherNames = extractUploadedArtifactNames().filter(
      (name) => !name.startsWith("lexical-regime-"),
    );
    expect(
      otherNames.length,
      "ci.yml から lexical-regime 以外の artifact 名を1つも読み出せなかった。" +
        "⟹ この陰性対照は何も弾いていない(空回り)。取り出し方が古くなっている。",
    ).toBeGreaterThan(0);

    const pattern = extractDownloadPattern();
    for (const name of otherNames) {
      expect(
        globMatches(pattern, name),
        `download の pattern(${pattern})が、この coverage ジョブと無関係な artifact(${name})まで拾う。`,
      ).toBe(false);
    }
  });

  it("🔴🔴 Issue #163 ②: download の path: と、coverage.mjs へ渡す --artifacts-dir が同じ場所を指している", () => {
    // `path:` の値では段を見分けない（変異させるフィールドで同定すると空回りする）。
    const downloadPath = extractDownloadPath();
    const artifactsDirArg = extractArtifactsDirArgument();
    expect(
      normalizeExpression(artifactsDirArg),
      "download-artifact が降ろす先(path:)と、lexical-regime-coverage.mjs へ渡す " +
        "--artifacts-dir が食い違っている。⟹ 両脚の artifact を落としても、coverage は " +
        "空のディレクトリを読んで「どちらの脚も走っていない」と報告する。",
    ).toBe(normalizeExpression(downloadPath));
  });

  it("scripts/lexical-regime-coverage.mjs を実行する段がある", () => {
    expect(coverageJobBlock).toContain("lexical-regime-coverage.mjs");
    expect(coverageJobBlock).toContain("--artifacts-dir");
  });

  it("🔴🔴 lib の EXPECTED_SERVER_ENCODINGS が、postgres ジョブの matrix の脚と一致する(二重管理が壊れたら赤くなる)", () => {
    const matrixEncodings = extractMatrixServerEncodings();
    expect(new Set(matrixEncodings)).toEqual(new Set(EXPECTED_SERVER_ENCODINGS));
    expect(matrixEncodings).toHaveLength(EXPECTED_SERVER_ENCODINGS.length);
  });
});

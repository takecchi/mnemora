import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EXPECTED_SERVER_ENCODINGS } from "../lexical-regime-coverage-lib.mjs";
import { artifactNameForEncoding } from "../lexical-regime-coverage-lib.mjs";
import { blankOutWorkflowComments } from "../workflow-comment-blank-lib.mjs";
import { normalizeWorkflowExpressions } from "../workflow-expression-lib.mjs";

/**
 * ⭐ **この歯が測っているもの(消す前に読むこと)**
 *
 * **`.github/workflows/ci.yml` に、「両方の server_encoding regime が実際に走ったか」を
 * 測る `postgres-regime-coverage` ジョブが実際に配線されていること**(Issue #155
 * 満たすべきこと2)。
 *
 * `postgres` ジョブを matrix にしただけでは、片方の脚が skip/失敗しても
 * `postgres` ジョブ自体は(もう片方の脚が通れば)緑になりうる——⛔ それを
 * 「両方測れた」と読ませないための後続ジョブが要る。この歯は:
 *
 * 1. `postgres-regime-coverage` ジョブが存在し、`needs: postgres` / `if: always()`
 *    を持つこと(matrix の一部が落ちても走ること)。
 * 2. `needs.postgres.result` が `skipped` のとき明示的に非0で終わる段があること
 *    (skip を成功として読ませない)。
 * 3. `lexical-regime-*` パターンで artifact をダウンロードする段があること。
 * 4. `scripts/lexical-regime-coverage.mjs` を実行する段があること。
 * 5. 🔴 **`scripts/lexical-regime-coverage-lib.mjs` の `EXPECTED_SERVER_ENCODINGS`
 *    (このジョブが期待する脚の集合)が、`postgres` ジョブの matrix の脚
 *    (`scripts/__tests__/ci-yml-postgres-regime-wiring.test.mjs` が固定している側)
 *    と一致すること。** 期待する脚の集合をスクリプト側にハードコードした二重管理なので、
 *    ずれたら赤くなるようにする——(c) と同じ思想。
 *
 * ⚠ **YAML は構造として解析していない(文字列で見ている)。**
 * 既存の wiring テストと同じ判断(依存追加はオーナー専権。`docs/autonomy.md`)。
 * 壊れたときは「配線が変わった」か「取り出し方が古い」かを見て、配線が変わっていない
 * なら取り出し方を直すこと(歯を消さないこと)。
 */

const workflowPath = fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url));
const workflow = readFileSync(workflowPath, "utf8");

const COVERAGE_JOB_ID = "postgres-regime-coverage";
const POSTGRES_JOB_ID = "postgres";

/**
 * `jobs:` の下の1ジョブを切り出す(`ci-yml-postgres-regime-wiring.test.mjs` の
 * `extractJob` と同じ形。ファイルをまたいで共有していない——既存の wiring テスト群も
 * 各ファイルが自己完結している)。
 *
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
 * `postgres` ジョブの `strategy.matrix.include` から `serverEncoding` の集合だけを
 * 取り出す(`ci-yml-postgres-regime-wiring.test.mjs` の `extractMatrixLegs` の
 * 簡約版——この歯は集合の一致だけを見るので initdbArgs までは要らない)。
 *
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
 * `postgres-regime-coverage` ジョブの `actions/download-artifact` の段を切り出す
 * (⛔ `path:` や `pattern:` の**値**で見分けない——それらこそ変異させる対象であり、
 * 値で同定すると変異を当てた瞬間に段が「対象外」になって歯が空回りする。
 * Issue #162 のコメントが名指しした一般形: **測る対象を、変異させる当のフィールドで
 * 同定してはいけない**)。
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
 * download 段の `pattern:` の値。
 *
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
 * download 段の `path:`(降ろす先)の値。
 *
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
 * `lexical-regime-coverage.mjs` を呼ぶ段が渡す `--artifacts-dir` の値
 * (⛔ こちらも `path:` の値では見分けず、スクリプト名で同定している)。
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
 * Actions の式を**照合のためだけに**正規形へ揃える(Issue #163 ① で足した網)。
 * ⛔ 実行されるテキストへは通さない——この歯は `toBe` の比較にしか使っていない。
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
 * `actions/*-artifact` の `pattern:` を、**グロブとして**当てる。
 *
 * ⚠ **`*` だけを扱う。**`?` / `[…]` / `!`(除外)は解釈していない——いま ci.yml が
 * 使っているのは `*` だけだからである。ci.yml がそれ以外を使い始めたら、ここも合わせて
 * 直すこと(**歯を消さないこと**)。⛔ この歯のために依存(minimatch 等)は足していない
 * (依存追加はオーナー専権。`docs/autonomy.md`)。
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
 * この workflow が `actions/upload-artifact` で上げている artifact 名を全部読み出す
 * (陰性対照を文字列で書き置かないため。⭐ 空回りしていないことの根拠でもある)。
 *
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

// 🔴 **コメントを潰してから当てる(Issue #155 段1)。**この歯の一部(`exit 1` /
// `needs: postgres` / `if: always()` の固定)は、実際に実行される行ではなく
// **地の文のコメントがその文字列を引用しているだけ**でも `toContain` が一致していた
// (変異D。段0で実測)。⟹ 照合前にコメントを潰す
// (`scripts/workflow-comment-blank-lib.mjs` の docstring)。
//
// ⛔ **この歯の `coverageJobBlock` は `toContain`/`toMatch` にしか使っていない
// (実行しない)ことを確認済み。**実行する側の生テキストへ適用してはいけない、という
// `ci-yml-postgres-regime-wiring.test.mjs` の断り書きと同じ理由による区別である。
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
    // ⭐ **字面の `toContain` ではなく、グロブとして当てる。**上の歯は
    // `pattern: lexical-regime-*` という**文字列**が在ることしか見ていない ⟹ 命名規則
    // (`scripts/lexical-regime-coverage-lib.mjs` の `artifactNameForEncoding`)と
    // `pattern:` の関係は1ミリも測っていない。ここはその関係だけを見る。
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
    // ⭐ **陰性対照が空でないことの確かめ方**: 比較対象を文字列で書き置かず、
    // **ci.yml から実際に upload されている artifact 名を読み出して**使う。
    // ⟹ 下の `toBeGreaterThan(0)` が、この主張が空回りしていないことの根拠である
    // (lexical-regime 以外の artifact が1つも無い workflow なら、この歯は何も弾いていない)。
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
    // 🔴 **2026-09-13 に手で当てて実測した、生き残った変異**: download の `path:` だけを
    // `…/lexical-regime-artifacts-TYPO` へ書き換えても `scripts/__tests__/` は
    // **614件すべて緑のまま**だった。⟹ 「どこへ降ろしたか」と「どこを読むか」の対を、
    // ここまで誰も測っていなかった。
    //
    // ⭐ これは PR #165(Issue #162 F)が `actions/cache` の `path:` ↔
    // `MNEMORA_LOCAL_EMBEDDING_CACHE_DIR` に対してやったのと**同じ族**である。
    //
    // ⛔ **`path:` の値そのもので段を見分けていない**(Issue #162 のコメントが名指しした
    // 空回り)——download 段は `uses: actions/download-artifact` で、消費段は
    // `lexical-regime-coverage.mjs` で同定している。⟹ `path:` を変異させても、歯は
    // 同じ2つの段を見続ける。
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
    // 集合だけでなく個数も一致すること(片方に重複があるケースを拾う)。
    expect(matrixEncodings).toHaveLength(EXPECTED_SERVER_ENCODINGS.length);
  });
});

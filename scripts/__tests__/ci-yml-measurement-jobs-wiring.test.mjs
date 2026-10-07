import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { blankOutWorkflowComments } from "../workflow-comment-blank-lib.mjs";

/**
 * YAML は構造として解析せず文字列で見る（依存追加はオーナー専権）。
 * `ci.yml` の `continue-on-error` は全部コメント中にあるので、`blankOutWorkflowComments` を通してから数える。
 */

const CI_WORKFLOW_PATH = fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url));
const PUBLISH_WORKFLOW_PATH = fileURLToPath(
  new URL("../../.github/workflows/publish.yml", import.meta.url),
);

const WORKFLOW_PATHS = {
  "ci.yml": CI_WORKFLOW_PATH,
  "publish.yml": PUBLISH_WORKFLOW_PATH,
};

/** @type {readonly string[]} */
const MEASUREMENT_JOB_IDS = Object.freeze([
  "retrieval-quality",
  "identifier-probes",
  "association-probes",
  "consolidation-cost",
  "archive-sweep-cost",
  "time-term",
  "validity",
  "retrieval-rank-listing",
]);

/**
 * 対象は job id の行そのもので同定する（値で同定すると、値を変異させた瞬間に歯が空回りする）。
 *
 * @param {string} text 全文(`jobs:` を含む workflow のテキスト、または
 *   トップレベルジョブを複数含む合成テキスト)
 * @param {string} jobId
 * @returns {string | null} 見つからなければ `null`
 */
function extractJobBlock(text, jobId) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line === `  ${jobId}:`);
  if (start === -1) {
    return null;
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
 * ステップレベルの `if:` は見ない（7本には正当な `if: always()` が多数ある）。
 *
 * @param {string} jobBlock `extractJobBlock` が返すブロック
 * @returns {boolean}
 */
function hasJobLevelIf(jobBlock) {
  return /^ {4}if:/m.test(jobBlock);
}

/**
 * @param {string} blankedJobBlock
 * @returns {boolean}
 */
function hasContinueOnError(blankedJobBlock) {
  return /continue-on-error:/.test(blankedJobBlock);
}

/**
 * @param {string} blankedText
 * @returns {string[]}
 */
function findPathsFilterLines(blankedText) {
  return blankedText.split("\n").filter((line) => /^[ \t]*paths(-ignore)?:/.test(line));
}

describe("ci.yml/publish.yml の on: に paths:/paths-ignore: が無い(Issue #426 検査1)", () => {
  it.each(Object.entries(WORKFLOW_PATHS))(
    "🔴 %s: コメント潰しが「扱えない」形に当たっていない(無視できないAPIにする)",
    (_name, path) => {
      const raw = readFileSync(path, "utf8");
      const { unhandled } = blankOutWorkflowComments(raw);
      expect(unhandled).toEqual([]);
    },
  );

  it.each(Object.entries(WORKFLOW_PATHS))(
    "%s に paths:/paths-ignore: が1件も無い",
    (_name, path) => {
      const raw = readFileSync(path, "utf8");
      const { text: blanked } = blankOutWorkflowComments(raw);
      expect(findPathsFilterLines(blanked)).toEqual([]);
    },
  );

  it("🔴 陰性対照: 検査関数そのものが paths-ignore: を実際に検出できる(常に true を返すだけに退化していない)", () => {
    const synthetic = ["on:", "  pull_request:", "    paths-ignore:", '      - "docs/**"'].join(
      "\n",
    );
    expect(findPathsFilterLines(synthetic)).toEqual(["    paths-ignore:"]);
  });

  it("🔴 陰性対照: path:(単数、upload-artifact/cache が使う)を誤検出しない", () => {
    const synthetic = [
      "      - name: cache",
      "        uses: actions/cache@v4",
      "        with:",
      "          path: /tmp/x",
    ].join("\n");
    expect(findPathsFilterLines(synthetic)).toEqual([]);
  });
});

describe("ci.yml に、Issue #426 が名指しした測定ジョブ(MEASUREMENT_JOB_IDS)が全部存在する(Issue #426 検査2)", () => {
  const workflow = readFileSync(CI_WORKFLOW_PATH, "utf8");

  it("名指しした全部が見つかる(空回り防止——1本でも見つからなければこの歯は的を外している)", () => {
    const found = MEASUREMENT_JOB_IDS.filter((jobId) => extractJobBlock(workflow, jobId) !== null);
    expect(found).toEqual([...MEASUREMENT_JOB_IDS]);
    // 本数は名前にも assertion にも焼き込まない（`MEASUREMENT_JOB_IDS` の1箇所が持つ）。
  });

  it("extractJobBlock が合成テキストからも job を正しく切り出す(取り出し方自体の確認)", () => {
    const synthetic = [
      "jobs:",
      "  some-other-job:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: 何か関係ない段",
      "        run: echo hello",
      "",
      "  retrieval-quality:",
      "    name: 合成した retrieval-quality ジョブ",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: 何か",
      "        run: echo hi",
      "",
      "  identifier-probes:",
      "    name: 次のジョブ(境界の確認)",
      "    runs-on: ubuntu-latest",
    ].join("\n");
    const block = extractJobBlock(synthetic, "retrieval-quality");
    expect(block).not.toBeNull();
    expect(block).toContain("合成した retrieval-quality ジョブ");
    expect(block).not.toContain("次のジョブ(境界の確認)");
    expect(extractJobBlock(synthetic, "no-such-job")).toBeNull();
  });
});

describe("名指しした測定ジョブに job レベルの if: が無い(Issue #426 検査3)", () => {
  const workflow = readFileSync(CI_WORKFLOW_PATH, "utf8");

  it.each(MEASUREMENT_JOB_IDS)("%s に job レベルの if: が無い", (jobId) => {
    const block = extractJobBlock(workflow, jobId);
    expect(block, `ci.yml に \`  ${jobId}:\` ジョブが無い`).not.toBeNull();
    expect(
      hasJobLevelIf(block),
      `${jobId} ジョブに job レベルの if: が在る。⟹ 何らかの条件で job 全体が` +
        "静かに skip されうる(Issue #426)。",
    ).toBe(false);
  });

  it("🔴 ステップレベルの if: always() は名指しした測定ジョブの中に多数あり、正当なので誤検出しない(空回り防止でもある)", () => {
    let stepLevelIfCount = 0;
    for (const jobId of MEASUREMENT_JOB_IDS) {
      const block = extractJobBlock(workflow, jobId);
      // この番人を外さない（block が null だと TypeError になり、job が消えた欠陥が歯の実装不良に見える）。
      expect(block, `ci.yml に \`  ${jobId}:\` ジョブが無い`).not.toBeNull();
      const stepLevelLines = block
        .split("\n")
        .filter((line) => /^\s+if:/.test(line) && !/^ {4}if:/.test(line));
      stepLevelIfCount += stepLevelLines.length;
    }
    expect(
      stepLevelIfCount,
      "7本の中に step レベルの if: が1件も見つからなかった。⟹ 上の「job レベルの " +
        "if: が無い」というテストが、そもそも何かを弾いているのか分からない(空回り)。",
    ).toBeGreaterThanOrEqual(1);
  });

  it("🔴 陰性対照: job レベルの if: を持つ合成 job は検出され、step レベルの if: always() だけの合成 job は検出されない", () => {
    const syntheticWithJobLevelIf = [
      "  synthetic-job-with-job-level-if:",
      "    name: 合成した job(job レベル if を持つ)",
      "    if: github.event_name == 'push'",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: 何か",
      "        run: echo hi",
      "        if: always()",
      "  next-job:",
      "    name: 次のジョブ",
    ].join("\n");
    const blockA = extractJobBlock(syntheticWithJobLevelIf, "synthetic-job-with-job-level-if");
    expect(hasJobLevelIf(blockA)).toBe(true);

    const syntheticStepLevelOnly = [
      "  synthetic-job-step-level-only:",
      "    name: 合成した job(step レベルの if: always() だけ)",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: 何か",
      "        run: echo hi",
      "        if: always()",
      "  next-job:",
      "    name: 次のジョブ",
    ].join("\n");
    const blockB = extractJobBlock(syntheticStepLevelOnly, "synthetic-job-step-level-only");
    expect(hasJobLevelIf(blockB)).toBe(false);
  });
});

describe("名指しした測定ジョブに continue-on-error: が無い(Issue #426 検査4)", () => {
  const workflow = readFileSync(CI_WORKFLOW_PATH, "utf8");
  const { text: blankedWorkflow, unhandled } = blankOutWorkflowComments(workflow);

  it("🔴 コメント潰しが「扱えない」形に当たっていない(無視できないAPIにする)", () => {
    expect(unhandled).toEqual([]);
  });

  it("🔴🔴 陽性対照: コメント潰し前は、名指しした測定ジョブのうち複数本で continue-on-error: が(コメントの引用として)見つかる", () => {
    let rawHitCount = 0;
    for (const jobId of MEASUREMENT_JOB_IDS) {
      const rawBlock = extractJobBlock(workflow, jobId);
      if (/continue-on-error:/.test(rawBlock)) {
        rawHitCount += 1;
      }
    }
    expect(
      rawHitCount,
      "コメント潰し前に continue-on-error: を含む測定ジョブが1つも見つからなかった。" +
        "⟹ この陽性対照は何も示していない(空回り)——ci.yml 側の注意書きコメントが" +
        "動いたか、取り出し方が古くなっている。",
    ).toBeGreaterThanOrEqual(1);
  });

  it.each(MEASUREMENT_JOB_IDS)("%s に continue-on-error: が無い(コメント潰し後)", (jobId) => {
    const block = extractJobBlock(blankedWorkflow, jobId);
    expect(block, `ci.yml に \`  ${jobId}:\` ジョブが無い`).not.toBeNull();
    expect(
      hasContinueOnError(block),
      `${jobId} ジョブに continue-on-error: が在る。⟹ そのステップ(または job)が` +
        "失敗しても success のまま通り、測定が事実上動いていなくても気づけない(Issue #426)。",
    ).toBe(false);
  });

  it("🔴 陰性対照: continue-on-error: true を持つ合成 job は検出され、コメント行としての引用はコメント除去後は非検出", () => {
    const syntheticWithContinueOnError = [
      "  synthetic-job:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: 何か",
      "        run: echo hi",
      "        continue-on-error: true",
      "  next-job:",
      "    name: 次のジョブ",
    ].join("\n");
    expect(hasContinueOnError(syntheticWithContinueOnError)).toBe(true);

    const syntheticCommentOnly = [
      "  synthetic-job:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: 何か",
      "        run: echo hi",
      "        # continue-on-error: true は使わない",
      "  next-job:",
      "    name: 次のジョブ",
    ].join("\n");
    const { text: blankedSynthetic, unhandled: syntheticUnhandled } =
      blankOutWorkflowComments(syntheticCommentOnly);
    expect(syntheticUnhandled).toEqual([]);
    expect(hasContinueOnError(blankedSynthetic)).toBe(false);
    expect(hasContinueOnError(syntheticCommentOnly)).toBe(true);
  });
});

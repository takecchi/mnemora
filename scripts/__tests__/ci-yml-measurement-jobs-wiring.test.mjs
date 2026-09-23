import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { blankOutWorkflowComments } from "../workflow-comment-blank-lib.mjs";

/**
 * ⭐ **この歯が測っているもの(消す前に読むこと)**
 *
 * [Issue #426](https://github.com/takecchi/mnemora/issues/426) が実測したとおり、
 * `.github/workflows/ci.yml` の13 checks のうち、branch protection の
 * `required_status_checks` に入っているのは6本だけである。**残る7本
 * (`retrieval-quality` / `identifier-probes` / `association-probes` /
 * `consolidation-cost` / `archive-sweep-cost` / `time-term` / `validity`。
 * いずれも「値を実測して残す」ジョブ)は GitHub 自身の門ではなく、運用の規律に
 * 依拠している。**
 *
 * 同 Issue のコメント(クローンの判定)は「7本を required へ足す」ことは
 * [ADR 0223](../../docs/decisions/0223-cross-cutting-disciplines-extracted-from-the-adr-corpus.md)
 * 決定3(偽陽性率に上限を置けない検査を門にしない)により却下し、代わりに
 * **「測定そのもの」ではなく「測定が*走ったこと*(skip されていないこと)」を
 * 門にする**という [Issue #155](https://github.com/takecchi/mnemora/issues/155)
 * の `postgres-regime-coverage` と同じ形を挙げている。**この歯はその(A) ——
 * 「いま7本が skip される配線になっていないこと」を固定する wiring テストである。**
 *
 * ## 🔴 この歯が塞ぐ具体的な穴
 *
 * **いま `ci.yml` / `publish.yml` / `release-followup-notice.yml` に
 * `paths:` / `paths-ignore:` は1件も無い**(Issue #426 本文が grep で確認済み。
 * この歯も検査1でそれを固定する)。**だが誰かが `on:` へ `paths-ignore:` を1行足した
 * 瞬間、docs-only の変更などで7本の測定ジョブが静かに skip されはじめる。**
 *
 * そして `scripts/ci-green-check-lib.mjs` の `verdict()` は、**登録済み
 * check-run 全件**(required かどうかを問わない)を見て判定する
 * (`summarizeCheckRuns()` → `!summary.allSuccess` の分岐)。同 lib の docstring
 * 逐語:
 *
 * > `skipped`/`neutral`/`cancelled`/`timed_out`/`action_required` はどれも
 * > `success` では ないので `red` 側に入る(issue が名指しした「`skipped` は
 * > 緑ではない」の一般化)
 *
 * ⟹ **skip された瞬間、`docs/autonomy.md` §2.1 の手順(`ci-green-check.mjs`)は
 * 赤を返す。** だから穴は「誰も気づかない」ではなく、**「気づくかどうかが
 * `ci-green-check.mjs` を実際に使う手順を踏むかどうかに依存している」**——
 * 素朴に GitHub の Merge ボタン(branch protection の required 6本)だけを見る
 * 手順では、7本が skip されても気づけない。
 *
 * 同様に、7本のうちどれかに **job レベルの `if:`** が足されれば静かに skip され、
 * どれかのステップに **`continue-on-error: true`** が足されれば、そのステップが
 * 落ちてもジョブは `success` のまま通る——どちらも「測定が走った」という前提を
 * 崩す変異であり、この歯はその両方も検査2〜4で固定する。
 *
 * ## 🔴🔴 この歯自身が踏んだ罠(陽性対照でもある)
 *
 * **`ci.yml` には `continue-on-error` という文字列が6箇所出てくるが、全部
 * コメントの中である**(391 / 825 / 878 / 945 / 1067 / 1189行、いずれも
 * 「⛔ `continue-on-error: true` は使わない」という注意書き)。**コメントを
 * 潰さずに `toContain("continue-on-error")` のような素朴な検査を当てると、
 * この歯は最初から(実際の指定が1つも無いのに)赤くなる。**⟹ 下の検査4は
 * これを**同時に「コメント除去が効いていることの陽性対照」として使う**
 * ——`blankOutWorkflowComments` を通さずに素朴に数えると誤検出するという実測は、
 * `it("🔴🔴 陽性対照 …")` に残す。
 *
 * ## この歯が検査する4つ
 *
 * 1. **3本すべての workflow に `paths:` / `paths-ignore:` が無い**
 *    (`path:` 単数は対象外——`upload-artifact`/`cache` が使うキーであり、
 *    誤検出しないことを陰性対照で確かめる)。
 * 2. **7本の測定ジョブが `ci.yml` に(job id として)存在する。**
 * 3. **7本のいずれにも job レベルの `if:` が無い**(ステップレベルの
 *    `if: always()` は7本の中に多数あり、正当なので誤検出しない)。
 * 4. **7本のいずれにも `continue-on-error:` が無い**(job レベル・
 *    ステップレベルどちらも)。
 *
 * ## 🔴 この歯が塞がないもの(必ず読むこと)
 *
 * - **設定に現れない理由での実行時 skip は塞げない**——runner の不調、
 *   `concurrency` による cancel、GitHub 側の障害、workflow がそもそも
 *   起動しなかった場合。この歯は `.github/workflows/*.yml` という**静的な
 *   テキスト**しか見ていない。
 * - **ステップレベルの `if:` は検査していない。**測定そのものを行う段が
 *   step レベルの条件で落とされても、この歯は赤くならない
 *   (`if: always()` はこの歯の対象外として正当に許している——それを step
 *   レベルの他の条件と区別する検査は、この歯には無い)。
 * - **7本を `required_status_checks` に入れるものではない。**測定ジョブが
 *   赤いままでも GitHub の Merge ボタンはそれだけでは止まらない、という
 *   Issue #426 が記録したギャップ自体は、この歯だけでは残る——branch
 *   protection を変えるのはオーナーの領分である(`docs/autonomy.md` §3)。
 * - ⟹ **この歯が通ったからといって「測定は必ず走っている」とは読めない。**
 *   読めるのは「いまの `ci.yml` の書き方では、配線上 skip される経路が
 *   見えていない」という、静的な配線についての主張だけである。
 *
 * ⚠ **YAML は構造として解析していない(文字列で見ている)。**既存の wiring
 * テストと同じ判断(依存追加はオーナー専権。`docs/autonomy.md`)。壊れたときは
 * 「配線が変わった」か「取り出し方が古い」かを見て、配線が変わっていないなら
 * 取り出し方を直すこと(歯を消さないこと)。
 */

const CI_WORKFLOW_PATH = fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url));
const PUBLISH_WORKFLOW_PATH = fileURLToPath(
  new URL("../../.github/workflows/publish.yml", import.meta.url),
);
const RELEASE_FOLLOWUP_NOTICE_WORKFLOW_PATH = fileURLToPath(
  new URL("../../.github/workflows/release-followup-notice.yml", import.meta.url),
);

const WORKFLOW_PATHS = {
  "ci.yml": CI_WORKFLOW_PATH,
  "publish.yml": PUBLISH_WORKFLOW_PATH,
  "release-followup-notice.yml": RELEASE_FOLLOWUP_NOTICE_WORKFLOW_PATH,
};

/**
 * Issue #426 本文が名指しした7本の測定ジョブ(job id)。
 * ⚠ この配列に足す/引くのは、対象そのものを変える設計判断であり、この歯を
 * 直すだけでは済まない——足したり引いたりしたら、上の docstring の主張
 * (どのジョブが required でないか)も一致するか見直すこと。
 *
 * @type {readonly string[]}
 */
const MEASUREMENT_JOB_IDS = Object.freeze([
  "retrieval-quality",
  "identifier-probes",
  "association-probes",
  "consolidation-cost",
  "archive-sweep-cost",
  "time-term",
  "validity",
]);

/**
 * `jobs:` の下の1ジョブ(トップレベル、2空白字下げの `  <jobId>:` 行)を切り出す
 * (既存の wiring テスト群の `extractJob` と同じ形——ファイルをまたいで共有していない)。
 *
 * ⛔ 対象の同定は job id の**行そのもの**(`  <jobId>:` に厳密一致)であり、
 * `with:`/`run:` の値では同定しない——値で同定すると、値を変異させた瞬間に
 * 対象が「対象外」になって歯が空回りする(既存 wiring テスト群と同じ判断)。
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
 * job ブロックが job レベルの `if:` を持つか
 * (job マッピングの直接の子——`  <jobId>:` の1段下、4空白字下げの `if:`)。
 *
 * ⚠ **ステップレベルの `if:`(`steps:` の下の各段、8空白字下げ以上)は
 * 意図的に見ない**——7本の中には正当な `if: always()` が step レベルに
 * 多数あるため、job レベルとステップレベルを字下げで区別する。
 *
 * @param {string} jobBlock `extractJobBlock` が返すブロック
 * @returns {boolean}
 */
function hasJobLevelIf(jobBlock) {
  return /^ {4}if:/m.test(jobBlock);
}

/**
 * job ブロック(コメント潰し済みのテキストを渡すこと)に `continue-on-error:` が
 * 出現するか。job レベル・ステップレベルどちらの字下げも区別せず拾う——どちらも
 * 「測定が失敗しても job を success にする」効果を持ち、この歯にとっては同じ穴。
 *
 * @param {string} blankedJobBlock
 * @returns {boolean}
 */
function hasContinueOnError(blankedJobBlock) {
  return /continue-on-error:/.test(blankedJobBlock);
}

/**
 * コメント潰し済みのテキストから `paths:` / `paths-ignore:` の行を全部拾う。
 *
 * ⛔ `path:`(単数、`actions/upload-artifact` や `actions/cache` の `with:` が
 * 使うキー)を誤検出しない——`paths` という語そのもの(`s` を含む)を先頭一致で
 * 要求し、`path:` はこの正規表現に一致しない。同様に `release-paths:` のような
 * 無関係な複合語も、行頭からの空白の直後が `paths` そのものであることを要求する
 * ことで誤検出しない(`^[ \t]*paths` は `some-paths:` の `some-` の前では
 * 止まらない)。
 *
 * @param {string} blankedText
 * @returns {string[]}
 */
function findPathsFilterLines(blankedText) {
  return blankedText.split("\n").filter((line) => /^[ \t]*paths(-ignore)?:/.test(line));
}

describe("ci.yml/publish.yml/release-followup-notice.yml の on: に paths:/paths-ignore: が無い(Issue #426 検査1)", () => {
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

describe("ci.yml に7本の測定ジョブが存在する(Issue #426 検査2)", () => {
  const workflow = readFileSync(CI_WORKFLOW_PATH, "utf8");

  it("7本ちょうど見つかる(空回り防止——1本でも見つからなければこの歯は的を外している)", () => {
    const found = MEASUREMENT_JOB_IDS.filter((jobId) => extractJobBlock(workflow, jobId) !== null);
    expect(found).toEqual([...MEASUREMENT_JOB_IDS]);
    expect(found).toHaveLength(7);
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

describe("7本の測定ジョブに job レベルの if: が無い(Issue #426 検査3)", () => {
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

  it("🔴 ステップレベルの if: always() は7本の中に多数あり、正当なので誤検出しない(空回り防止でもある)", () => {
    // ⭐ 「0件だった」だけでは検査が動いている証明にならない——7本の中に実際に
    // step レベルの if: always() が複数在ることを先に確かめる(下限を固定)。
    let stepLevelIfCount = 0;
    for (const jobId of MEASUREMENT_JOB_IDS) {
      const block = extractJobBlock(workflow, jobId);
      // ⛔ この番人を外さないこと。外すと block が null のとき `.split` が TypeError を
      // 投げ、**「job が消えた」という本物の欠陥が「この歯の実装が壊れた」ように見える**
      // ——失敗の宛先が付け替わる。歯の結果は 一致 / 不一致 / 読めない の3つに分かれ、
      // 「読めない」は 🔴 赤として名指しで出すこと(⛔ 握り潰して緑へ倒さない)。
      // 同じ形が検査3・検査4 の it.each にも在る(この歯の流儀)。
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

describe("7本の測定ジョブに continue-on-error: が無い(Issue #426 検査4)", () => {
  const workflow = readFileSync(CI_WORKFLOW_PATH, "utf8");
  const { text: blankedWorkflow, unhandled } = blankOutWorkflowComments(workflow);

  it("🔴 コメント潰しが「扱えない」形に当たっていない(無視できないAPIにする)", () => {
    expect(unhandled).toEqual([]);
  });

  it("🔴🔴 陽性対照: コメント潰し前は、7本のうち複数本で continue-on-error: が(コメントの引用として)見つかる", () => {
    // ⭐ **これは同時に「コメント除去が効いていることの陽性対照」である。**
    // `ci.yml` には `continue-on-error` という文字列が6箇所出てくるが、全部
    // 「⛔ continue-on-error: true は使わない」という注意書きのコメントの中である。
    // コメントを潰さずに検査すると、この歯は(実際の指定が1つも無いのに)最初から
    // 赤くなる——それを確かめるための対照。
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
    // ⭐ 潰す前は(コメントの引用として)拾ってしまうことも確認する——
    // 上の「陽性対照」と同じ形を、合成テキストでも固定する。
    expect(hasContinueOnError(syntheticCommentOnly)).toBe(true);
  });
});

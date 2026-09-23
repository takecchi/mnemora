/**
 * `scripts/changelog-candidates-summary.mjs`（PR の Job Summary に「CHANGELOG 載せ漏れの候補」を
 * 出す CLI）の純関数の側。ファイル I/O・`git` の起動・`process.argv`・`process.exit` を一切持たない
 * ——`scripts/release-candidates-lib.mjs` と同じ分担・同じ理由。
 *
 * ## これは [Issue #433](https://github.com/takecchi/mnemora/issues/433) 方向(B) の B2 版である
 *
 * 本文の判定案（逐語）:
 * > `v<最新タグ>..HEAD` の各コミットについて、`packages/*\/src`（`__tests__` と `*.test.ts` を
 * > 除く）または `packages/*\/migrations` に差分が在り、**かつ** その PR 番号が
 * > `CHANGELOG.md` の未リリース節にも**明示的な除外リスト**にも無ければ、**赤**。
 *
 * 同 Issue のコメント史は、この判定を**落とす門（CI の歯）**にする案を2度検討し、2度とも
 * 却下している（2026-09-17「(い) 現状維持。ADR 0214 決定6 を追認する」/ 2026-09-20
 * 「並行 PR の衝突が未解決のまま」）。却下の芯は一貫して同じ——**偽陽性率に上限を置けない
 * 検査は門にしない**（`AGENTS.md`）。実測された偽陽性率は **33%（4/12）**、絞り込んでも
 * **17%（2/12）**であり（同 Issue 2026-09-17 コメントの訂正）、しかも `packages/testkit/src/
 * *-conformance.ts`（適合スイート）という構造的な族を持つ（同 2026-09-17 コメント）。
 *
 * **B2 が違うのはここである**: 判定を**門にしない**。PR の Job Summary に「候補」を列挙する
 * だけで、終了コード（プロセス全体としては常に `0`。詳細は CLI 側の doc コメント）は何も
 * 変えない。⟹ **偽陽性率に上限を置けない検査を門にしない、という規律そのものに従っている**
 * ——却下されたのは「門」であって、「候補を出す観測口」ではない
 * （ADR 0214 決定6「道具であって門ではない」と同じ形を、手で叩く道具から PR ごとの自動観測へ
 * 拡張したもの）。
 *
 * ## 「publish される中身を触ったか」は書き起こさない——`release-candidates-lib.mjs` を再利用する
 *
 * `isPackageSrcPath()` をそのまま import する。この関数は「`packages/*\/src/` を触っているか
 * （テストを除く）」を機械的に判定する、既に歯が付いた述語である。ここで同じ述語を
 * 書き起こすと、2つの定義がいずれずれる（`AGENTS.md`「⚠ 数を、道具と生成物に焼き込まない」の
 * 精神と同じ——複製は複製した瞬間からずれ始める）。
 *
 * ⚠ **本文の判定案が挙げていた `packages/*\/migrations` は、ここには含まれない**
 * ——`isPackageSrcPath()` がそれを見ていないため。この関数を拡張するのはこのファイルの外
 * （`release-candidates-lib.mjs` 側）の変更であり、この PR の範囲外。
 */
import { isPackageSrcPath } from "./release-candidates-lib.mjs";

/**
 * `## [x.y.z] - 未リリース` の形をした見出し行。`isReleasedHeading`（`release-changelog-gate-lib.mjs`）
 * の裏返しに当たるが、あちらは「released の形をしているか」だけを見る述語であり、
 * 「未リリース」という語そのものは見ていない。ここでは逆に、CHANGELOG.md の実際の記法
 * （`ADR 0169` 決定「見出しは `## [1.0.0] - 未リリース` のように」）に合わせ、
 * 「未リリース」を名乗る見出しを直接探す。
 */
const UNRELEASED_HEADING_RE = /^##\s+\[[^\]]+\]\s+-\s+未リリース\s*$/;

/** `## [` で始まる見出し行（版を問わない）。節の終端を求めるのに使う。 */
const ANY_SECTION_HEADING_RE = /^##\s+\[/;

/**
 * `CHANGELOG.md` の本文から、「未リリース節」の行範囲（1始まり・両端含む）を求める。
 *
 * 見つからなければ `found: false` を返す（例外にしない）——**この状態は実際に起こりうる**。
 * 【実測 2026-09-24】`origin/main` の `CHANGELOG.md` は `v1.0.0` の released 節（`## [1.0.0] -
 * 2026-09-23`）で始まり、未リリース節を1つも持たない（`v1.1.0` 相当の節はまだ起こされて
 * いない）。呼び出し側は `found: false` を「差分が無い」と同じ扱いにせず、別途注記すること
 * （`computeChangelogCandidates` の doc コメント参照）。
 *
 * @param {string} changelogText
 * @returns {{ found: boolean, startLine: number | null, endLine: number | null }}
 */
export function findUnreleasedSectionRange(changelogText) {
  const lines = String(changelogText ?? "").split("\n");
  const startIdx = lines.findIndex((line) => UNRELEASED_HEADING_RE.test(line));
  if (startIdx === -1) {
    return { found: false, startLine: null, endLine: null };
  }
  let endIdx = lines.length - 1;
  for (let i = startIdx + 1; i < lines.length; i += 1) {
    if (ANY_SECTION_HEADING_RE.test(lines[i])) {
      endIdx = i - 1;
      break;
    }
  }
  return { found: true, startLine: startIdx + 1, endLine: endIdx + 1 };
}

/**
 * unified diff のテキストから、**新ファイル側の行番号**で「追加された行」の一覧を求める。
 *
 * `git diff --unified=0` の出力を主な入力として想定するが、context 行（先頭が半角スペース）
 * を含む一般の unified diff にも対応する——ハンク見出し（`@@ -a,b +c,d @@`）から新ファイル側の
 * 開始行を読み取り、`+` 行のたびにその位置を記録して1つ進め、` `（context）行でも1つ進め、
 * `-` 行では進めない、という unified diff の定義どおりの走査である。
 *
 * @param {string} diffText
 * @returns {number[]} 新ファイル側の1始まり行番号（追加された行のみ）
 */
export function parseAddedLineNumbers(diffText) {
  const lines = String(diffText ?? "").split("\n");
  const added = [];
  let newLine = null;
  for (const line of lines) {
    const hunkMatch = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunkMatch) {
      newLine = Number(hunkMatch[1]);
      continue;
    }
    if (newLine === null) continue; // ハンクの外（`diff --git` / `index` / `+++` などの前置き）
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) {
      added.push(newLine);
      newLine += 1;
    } else if (line.startsWith("-")) {
      // 新ファイルの行番号は進めない（削除された行は新ファイルに存在しない）
    } else if (line.startsWith(" ")) {
      newLine += 1;
    }
    // それ以外（`\ No newline at end of file` 等）は無視する
  }
  return added;
}

/**
 * 「未リリース節に、この diff で追加された行があるか」を求める。
 *
 * @param {{ changelogText: string, diffText: string }} input
 * @returns {{ sectionFound: boolean, added: boolean, range: ReturnType<typeof findUnreleasedSectionRange> }}
 */
export function computeUnreleasedSectionAddition({ changelogText, diffText }) {
  const range = findUnreleasedSectionRange(changelogText);
  if (!range.found) {
    return { sectionFound: false, added: false, range };
  }
  const addedLines = parseAddedLineNumbers(diffText);
  const added = addedLines.some((n) => n >= range.startLine && n <= range.endLine);
  return { sectionFound: true, added, range };
}

/**
 * この PR（想定: `origin/main...HEAD` の差分）が「CHANGELOG 載せ漏れの候補」に当たるかを求める。
 *
 * **判定ではない**——ADR 0214 決定1 と同じ立場を取る。返り値の `hasCandidates` は
 * 「載せ漏れである」という結論ではなく、「publish される中身を触っているのに、CHANGELOG.md の
 * 未リリース節に追加された行が見当たらない」という**機械的に読み取れる事実**だけを表す。
 * `packages/*\/src` は doc コメントのみの変更にも立つ粗い信号である（ADR 0214「引き受けた
 * 負債」3・[Issue #433](https://github.com/takecchi/mnemora/issues/433) 実測）——だからこそ、
 * これを門にせず、候補の一覧として人に渡す。
 *
 * @param {{ touchedFiles: string[], changelogText: string, changelogDiffText: string }} input
 * @returns {{ hasCandidates: boolean, srcFiles: string[], sectionFound: boolean | null }}
 */
export function computeChangelogCandidates({ touchedFiles, changelogText, changelogDiffText }) {
  const srcFiles = (touchedFiles ?? []).filter(isPackageSrcPath);
  if (srcFiles.length === 0) {
    return { hasCandidates: false, srcFiles: [], sectionFound: null };
  }
  const { sectionFound, added } = computeUnreleasedSectionAddition({
    changelogText,
    diffText: changelogDiffText,
  });
  if (added) {
    return { hasCandidates: false, srcFiles, sectionFound };
  }
  return { hasCandidates: true, srcFiles, sectionFound };
}

const HEADER = "## CHANGELOG 載せ漏れの候補（⛔ 判定ではない。Issue #433 方向B2 / ADR 0214 追記）";

/**
 * `computeChangelogCandidates()` の結果を、Job Summary 用の Markdown へ変換する。
 *
 * **一致（＝候補なし）なら1行で黙り、候補が在るときだけ展開する**（ADR 0088 §3 の作法。
 * 常に同じ量を出す観測口は読まれない）。
 *
 * @param {ReturnType<typeof computeChangelogCandidates>} result
 * @returns {string}
 */
export function formatChangelogCandidatesSummary(result) {
  if (!result.hasCandidates) {
    return [
      HEADER,
      "",
      "🟢 候補なし（publish される中身への差分が無い、または CHANGELOG.md の未リリース節に" +
        "既にこの PR の差分がある）。",
    ].join("\n");
  }

  const lines = [
    HEADER,
    "",
    `🔴 候補が ${result.srcFiles.length} 件ある。publish される中身（\`packages/*/src\`）を` +
      "触っているが、CHANGELOG.md の未リリース節にこの PR が追加した行が見当たらない。",
    "",
  ];
  for (const file of result.srcFiles) {
    lines.push(`- ${file}`);
  }
  lines.push("");
  if (result.sectionFound === false) {
    lines.push(
      "⚠ CHANGELOG.md に `## [x.y.z] - 未リリース` の形の見出しが見つからなかった" +
        "（未リリース節がまだ起こされていない可能性がある。その場合、この一覧は" +
        "『節が無いので載せようがない』ことも含めて示している）。",
      "",
    );
  }
  lines.push(
    "⛔ **これは判定ではない。**載せるべきかどうかは書き手が決めること——`packages/*/src` は " +
      "doc コメントのみの変更や適合テストの調整にも立つ粗い信号である" +
      "（ADR 0214「引き受けた負債」3 / Issue #433 実測）。",
  );
  return lines.join("\n");
}

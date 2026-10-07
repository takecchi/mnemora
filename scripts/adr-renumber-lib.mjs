/**
 * ⛔ 書き換えてよいのは「このブランチが実際に追加した行」だけ。衝突した番号は定義上 `origin/main` で既に使われており、その番号への正当な言及が repo に多数在る。
 * 一括置換すると、`origin/main` から継承した行まで巻き込む。呼び出し側は `git diff --unified=0 origin/main -- <file>` を `addedLineNumbers` に通し、その行だけに `rewriteReferencesInText` を適用する。
 *
 * ⛔ 書き換えるのは「旧ファイル名の stem」と「`ADR ` に続く旧番号」の2形だけ。裸の4桁数字は、日付・識別子などを巻き込まないよう一切触らない。
 *
 * どれも I/O を持たない。ファイルの読み書き・`git mv`・`git diff` の実行は呼び出し側(`scripts/adr-renumber.mjs`)が行う。
 */
import { ADR_FILENAME_RE } from "./generate-adr-index-lib.mjs";

/**
 * `generate-adr-index-lib.mjs` の `ADR_FILENAME_RE` をそのまま使う(別々に持つとずれていく。ADR 0540)。
 */
const FILENAME_RE = ADR_FILENAME_RE;

/**
 * ADR ファイルの形でなければ `null` を返す(例外にしない。呼び出し側が「対象外だから無視する」を選べるようにする)。
 *
 * @param {string} filename
 * @returns {{ number: string, slug: string } | null}
 */
export function parseAdrFilename(filename) {
  const m = FILENAME_RE.exec(filename);
  if (!m) return null;
  return { number: m[1], slug: m[2] };
}

/**
 * 既存の最大値より小さい欠番を埋めには行かない。
 *
 * @param {Iterable<string>} usedNumbers
 * @returns {string}
 */
export function pickNextFreeNumber(usedNumbers) {
  const used = new Set(usedNumbers);
  let max = 0;
  for (const u of used) {
    const n = Number.parseInt(u, 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  let candidate = max + 1;
  while (used.has(String(candidate).padStart(4, "0"))) candidate += 1;
  return String(candidate).padStart(4, "0");
}

/**
 * @param {Iterable<string>} mainNumbers
 * @param {{ filename: string }[]} addedFiles
 * @returns {{
 *   oldFilename: string,
 *   oldNumber: string,
 *   newNumber: string,
 *   newFilename: string,
 *   slug: string,
 *   renamed: boolean,
 * }[]}
 */
export function planRenumbering(mainNumbers, addedFiles) {
  const mainUsed = new Set(mainNumbers);

  const parsed = addedFiles.map((f) => {
    const p = parseAdrFilename(f.filename);
    if (!p) {
      throw new Error(`ADR ファイル名の形にマッチしません: ${f.filename}`);
    }
    return { filename: f.filename, number: p.number, slug: p.slug };
  });

  // 衝突しない番号は、他の衝突エントリに横取りされないよう先に使用済みとして予約する。
  const claimed = new Set(mainUsed);
  for (const f of parsed) {
    if (!mainUsed.has(f.number)) claimed.add(f.number);
  }

  // 採番の基準点は `origin/main` の最大値だけから取る。このブランチが先取りした大きい番号に引きずられると、間の空き番号を無駄に飛ばす。
  let mainMax = 0;
  for (const n of mainUsed) {
    const v = Number.parseInt(n, 10);
    if (Number.isFinite(v) && v > mainMax) mainMax = v;
  }

  const plan = [];
  for (const f of parsed) {
    if (!mainUsed.has(f.number)) {
      plan.push({
        oldFilename: f.filename,
        oldNumber: f.number,
        newNumber: f.number,
        newFilename: f.filename,
        slug: f.slug,
        renamed: false,
      });
      continue;
    }
    let candidate = mainMax + 1;
    let newNumber = String(candidate).padStart(4, "0");
    while (claimed.has(newNumber)) {
      candidate += 1;
      newNumber = String(candidate).padStart(4, "0");
    }
    claimed.add(newNumber);
    plan.push({
      oldFilename: f.filename,
      oldNumber: f.number,
      newNumber,
      newFilename: `${newNumber}-${f.slug}.md`,
      slug: f.slug,
      renamed: true,
    });
  }
  return plan;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * ⛔ 旧ファイル名の stem は、直前が数字でなく、直後が英数字・ハイフンでないことを確認してから置換する(長い数字列や別の slug の一部を巻き込まない)。
 * 旧番号は、直後が数字でないことを確認してから置換する。
 *
 * @param {string} text
 * @param {{ oldNumber: string, newNumber: string, slug: string }[]} renames
 * @returns {{ text: string, changes: { type: "stem" | "adr-mention", oldNumber: string, newNumber: string, count: number }[] }}
 */
export function rewriteReferencesInText(text, renames) {
  let result = text;
  const changes = [];

  for (const { oldNumber, newNumber, slug } of renames) {
    if (oldNumber === newNumber) continue;

    const stemRe = new RegExp(`(?<!\\d)${oldNumber}-${escapeRegExp(slug)}(?![a-z0-9-])`, "g");
    const stemMatches = result.match(stemRe);
    if (stemMatches && stemMatches.length > 0) {
      result = result.replace(stemRe, `${newNumber}-${slug}`);
      changes.push({ type: "stem", oldNumber, newNumber, count: stemMatches.length });
    }

    const adrRe = new RegExp(`ADR ${oldNumber}(?!\\d)`, "g");
    const adrMatches = result.match(adrRe);
    if (adrMatches && adrMatches.length > 0) {
      result = result.replace(adrRe, `ADR ${newNumber}`);
      changes.push({ type: "adr-mention", oldNumber, newNumber, count: adrMatches.length });
    }
  }

  return { text: result, changes };
}

/**
 * ⛔ この関数は何も書き換えない。`rewriteReferencesInText` の射程は `ADR ` の直後の1箇所だけで、`ADR 0270 / 0271` のように `/` で連なる略記の2番目以降は届かない。
 * 射程を広げなかったのは、書き込む道具は間違えたとき静かに壊れる(無関係な4桁数字を巻き込む)ため。検出なら、偽陽性が出ても人が確認するだけで済む。
 *
 * ⚠ 区切りは `/` だけ(repo に実在する区切りがそれだけ。前後の空白は有り無し両方を許す)。
 * 連なりの1番目は `rewriteReferencesInText` が届く位置なので見ない(`.slice(1)`)。
 *
 * ⛔ 対象外: `ADR` の錨が無い裸の4桁数字、`/` 以外の区切り、PR タイトル・本文(repo 内のファイルではないので、人が目で見るしかない)。
 *
 * @param {string} text
 * @param {{ oldNumber: string, newNumber: string }[]} renames
 * @returns {{ oldNumber: string, match: string }[]}
 */
const ADR_CHAIN_RE = /ADR \d{4}(?:[ \t]*\/[ \t]*\d{4})+/g;

export function findUnrewrittenAdrReferences(text, renames) {
  const oldNumbers = new Set(
    (renames ?? []).filter((r) => r.oldNumber !== r.newNumber).map((r) => r.oldNumber),
  );
  if (oldNumbers.size === 0) return [];

  const results = [];
  for (const chainMatch of text.matchAll(ADR_CHAIN_RE)) {
    const chain = chainMatch[0];
    const numbers = chain.match(/\d{4}/g) ?? [];
    for (const number of numbers.slice(1)) {
      if (oldNumbers.has(number)) {
        results.push({ oldNumber: number, match: chain });
      }
    }
  }
  return results;
}

/**
 * `renames` が空なら `null` を返す(毎回出ると読み飛ばされる)。
 *
 * ⛔ PR タイトルと PR 本文は書き換えられない(GitHub 側の状態)。squash merge ではそのまま `main` の履歴に残るので、
 * マージする側が `gh pr edit` でタイトルと本文の両方を直す必要がある。タイトルだけでなく本文も警告する。
 *
 * @param {{ oldNumber: string, newNumber: string }[]} renames
 * @returns {string | null}
 */
export function renumberedReferenceWarning(renames) {
  if (!renames || renames.length === 0) return null;
  const mappings = renames.map((r) => `ADR ${r.oldNumber} -> ADR ${r.newNumber}`).join(", ");
  return [
    `⚠ ADR 番号を付け替えました（${mappings}）。`,
    "PR タイトルと本文——squash commit のタイトルと本文の両方——は機械が直せません" +
      "（このリポジトリは squash_merge_commit_title=PR_TITLE / squash_merge_commit_message=PR_BODY）。",
    'マージ前に次を実行して両方直すこと: gh pr edit <PR番号> --title "...（ADR <新番号>）" --body "..."',
    "⚠ 本文が旧番号を名指ししたまま残っていないかは、CI では検査していません。目で確かめること。",
  ].join("\n");
}

const HUNK_HEADER_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * `--unified=0` を前提にする(ハンク内に `+`/`-` 行しか現れない)。
 *
 * @param {string} unifiedDiffText
 * @returns {Set<number>}
 */
export function addedLineNumbers(unifiedDiffText) {
  const added = new Set();
  let curLine = null;
  for (const line of unifiedDiffText.split("\n")) {
    const hunkMatch = HUNK_HEADER_RE.exec(line);
    if (hunkMatch) {
      curLine = Number.parseInt(hunkMatch[1], 10);
      continue;
    }
    if (curLine === null) continue;
    if (line.startsWith("+")) {
      added.add(curLine);
      curLine += 1;
    } else if (line.startsWith("-")) {
      // 削除行は新ファイル側の行番号を消費しない。
    } else if (line.length > 0) {
      // 万一コンテキスト行が出ても、行番号だけは進めておく(安全側)。
      curLine += 1;
    }
  }
  return added;
}

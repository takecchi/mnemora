/**
 * 「`compare` の `omitted` の `stage` 集合が基準値から動いたら、その PR に
 * *申告* を要求する」門の、判定を持つ純関数の側（Issue #403）。
 *
 * `scripts/compare-summary-lib.mjs` と同じ分担——ファイル I/O・`process.argv`・
 * `process.exit` を一切持たない。呼び出す側（`scripts/check-compare-omitted-stage-declaration.mjs`）
 * がファイルと環境変数を読んで渡す。
 *
 * ## なぜ「落とす門」ではなく「申告を要求する門」なのか
 *
 * ⭐ **判定は [Issue #403](https://github.com/takecchi/mnemora/issues/403) に降りている。**
 * そこで測られたことを、この docstring には写さない（[AGENTS.md](../AGENTS.md)
 * 「⚠ 数を、道具と生成物に焼き込まない」）——**指すだけにする。**
 *
 * 形だけ要約すると:
 *
 * - ⛔ **`stage` 集合の一致を `GATE_FIELDS` に足して落とす門にはしない。**
 *   `AGENTS.md`「⚠ 偽陽性率に上限を置けない検査は門にしない」に当たる。
 *   `stage` 集合が動く理由は「退行」と「意図した仕様変更」の両方が在り、
 *   **機械にはその2つを区別できない。**
 * - ⛔ **かといって「見ない」も採らない。**`omitted` は判定に使われないまま
 *   基準値に載り続け、**誰も直す義務を負わないので腐る**——それが #403 の報告である。
 * - ⟹ **第3の形**: **動いたこと自体は機械が検出し、「意図した仕様変更である」という
 *   *申告* を人に書かせる。**申告が在れば通し、無ければ落とす。
 *   ⟹ 偽陽性の代償が「PR が赤になる」から「**一行書く**」に変わる
 *   ⟹ **偽陽性率に上限を置けなくても門にできる。**
 *
 * ⭐ これは `AGENTS.md`「⚠ 機械には「検出」まで — 確定と書き込みは人に残す」の適用でもある
 * ——**機械は検出して赤くするところまでで止まり、基準値を書き換えない。**
 *
 * ## ⛔ この門が見ていない範囲
 *
 * 1. **`count` / `countKind` の値は一切見ない。**見るのは `kind` と `stage` の組の
 *    **集合**だけである。件数は run ごとに揺れうる側であり、#403 の測定もそこは
 *    「揺れなかった」以上のことを主張していない。
 * 2. 🔴 **PR 本文は、この CI 実行を起こした push の時点のものしか見えない。**
 *    ⟹ **最後の push の「後」に `gh pr edit` で申告を足しても、この検査は効かない**
 *    （`ci.yml` の `pull_request` トリガーに `edited` を足していない。
 *    `scripts/check-pr-adr-reference.mjs` が同じ穴を持ち、同じ断りを書いている）。
 *    ⟹ **申告を書いてから push し、緑を引き直すこと**（儀式の順序への依拠であって検査ではない）。
 * 3. **申告の中身が本当かは見ない。**「理由が空でない」ことしか見ない
 *    ——中身の妥当性は人の仕事である。
 * 4. **`push`（`main`）では判定しない。**PR 本文が存在しないためである。
 *    ⟹ 呼び出し側が `prBody` を渡さなければ `skipped` を返す。
 */

/** `omitted` の1要素を、`kind` と `stage` の組を表す1つの文字列にする。 */
export function omittedEntryKey(entry) {
  if (entry === null || typeof entry !== "object") {
    return `(不正な要素: ${JSON.stringify(entry)})`;
  }
  const kind = typeof entry.kind === "string" ? entry.kind : "(kind無し)";
  // ⚠ `stage` が無い形は実在する（ADR 0188 が `stage` を足す前の基準値）。
  // ⟹ 「無い」を1つの値として扱う——`stage` が付いたこと自体が、検出したい変化である。
  const stage = typeof entry.stage === "string" ? entry.stage : "(stage無し)";
  return `${kind}::${stage}`;
}

/** 1行の `omitted` から、`kind::stage` の**集合**（重複を潰し、並べ替えた配列）を作る。 */
export function stageSetForRow(row) {
  const omitted = row && Array.isArray(row.omitted) ? row.omitted : [];
  return [...new Set(omitted.map(omittedEntryKey))].sort();
}

/** 2つの集合（並べ替え済み配列）が等しいか。 */
function sameSet(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * 実測と基準値の行を `turnCount` で突き合わせ、`stage` 集合が動いた行を全部返す。
 *
 * ⚠ **両方に在る `turnCount` だけを見る。**片方にしか無い `turnCount` は
 * `evaluate` が別に「判定不能」として扱う——「比較していない」を
 * 「動いていない」と同じ顔にしないためである（Issue #477 が `compare-summary` に
 * 入れたのと同じ線）。
 */
export function diffStageSets(measuredRows, baselineRows) {
  const baselineByTurn = new Map((baselineRows ?? []).map((row) => [row?.turnCount, row]));
  const changed = [];
  for (const measuredRow of measuredRows ?? []) {
    const baselineRow = baselineByTurn.get(measuredRow?.turnCount);
    if (baselineRow === undefined) {
      continue;
    }
    const measured = stageSetForRow(measuredRow);
    const baseline = stageSetForRow(baselineRow);
    if (!sameSet(measured, baseline)) {
      changed.push({ turnCount: measuredRow?.turnCount, baseline, measured });
    }
  }
  return changed;
}

/** 実測と基準値の `turnCount` 集合が食い違っているか（判定不能の条件）。 */
export function turnCountMismatch(measuredRows, baselineRows) {
  const measured = [...new Set((measuredRows ?? []).map((row) => row?.turnCount))].sort(
    (a, b) => a - b,
  );
  const baseline = [...new Set((baselineRows ?? []).map((row) => row?.turnCount))].sort(
    (a, b) => a - b,
  );
  if (measured.length === baseline.length && measured.every((v, i) => v === baseline[i])) {
    return null;
  }
  return { measured, baseline };
}

/**
 * 申告の形。**理由まで書かせる**——印だけ置けば通る形にしない。
 *
 * ⛔ `Compare-Omitted-Stage:` だけ書いて理由が空の行は、申告として数えない。
 */
export const DECLARATION_PATTERN = /^[ \t>*-]*Compare-Omitted-Stage:[ \t]*(\S.*?)[ \t]*$/m;

/** PR 本文から申告を取り出す。無ければ `null`。 */
export function findDeclaration(prBody) {
  if (typeof prBody !== "string") {
    return null;
  }
  const match = DECLARATION_PATTERN.exec(prBody);
  if (match === null) {
    return null;
  }
  return { raw: match[0].trim(), reason: match[1] };
}

/**
 * 判定本体。
 *
 * 返す `status`:
 * - `skipped` — PR 本文が無い（`main` への push 等）⟹ 判定しない
 * - `unmeasurable` — `turnCount` 集合が食い違う ⟹ 判定不能
 * - `no_change` — `stage` 集合が1行も動いていない
 * - `declared` — 動いたが、申告が在る
 * - `undeclared` — 動いたのに、申告が無い（⟹ 赤）
 */
export function evaluate({ measuredRows, baselineRows, prBody }) {
  if (typeof prBody !== "string") {
    return { status: "skipped", changed: [], declaration: null };
  }
  const mismatch = turnCountMismatch(measuredRows, baselineRows);
  if (mismatch !== null) {
    return { status: "unmeasurable", changed: [], declaration: null, mismatch };
  }
  const changed = diffStageSets(measuredRows, baselineRows);
  if (changed.length === 0) {
    return { status: "no_change", changed, declaration: null };
  }
  const declaration = findDeclaration(prBody);
  return {
    status: declaration === null ? "undeclared" : "declared",
    changed,
    declaration,
  };
}

/** `status` を終了コードへ。⚠ `unmeasurable` は 2（`compare-summary` と揃える）。 */
export function exitCodeFor(status) {
  if (status === "undeclared") {
    return 1;
  }
  if (status === "unmeasurable") {
    return 2;
  }
  return 0;
}

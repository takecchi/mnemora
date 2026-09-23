/**
 * ADR の番号採番を「マージ直前」に確定させるための純関数群（Issue #295、ADR 0179）。
 *
 * ## 何を解いているか
 *
 * [ADR 0137](../docs/decisions/0137-adr-index-generated-from-source.md) は
 * 「索引（`docs/decisions/README.md`）の _行位置_ の衝突」を消したが、
 * 「_番号そのもの_ の払い出し」は各 PR の作成者が手で選ぶままだった。並行して走る
 * 複数の PR が同じ番号を独立に選ぶと、`main` に同じ番号の ADR が2本着地しうる
 * （[Issue #295](https://github.com/takecchi/mnemora/issues/295) の実測:
 * 2026-09-16、`0146` を4本の PR が同時に主張していた）。
 *
 * `scripts/__tests__/adr-duplicate-number.test.mjs`（Issue #315）は「重複が
 * 実際に起きたか」を検出する歯であり、**単一ブランチ内では常に緑になる**
 * （衝突はブランチ間にあるため）。この lib はその先——**採番そのものを、
 * 衝突しようがないタイミング（マージ直前・`origin/main` を取り込んだ直後の
 * PR ブランチ上）で確定させる**——を担う。`main` へのマージは直列化されている
 * ため、この時点で他の ADR が同時に着地することは構造的に無い（ADR 0179
 * 「問い」節で現物を確認した記録を見ること）。
 *
 * ## この lib が扱う3つの操作
 *
 * 1. **`planRenumbering`** — 「このブランチが `origin/main` に対して新しく
 *    追加した ADR ファイル」のうち、番号が `origin/main` 側で既に使われている
 *    ものを、まだ誰も使っていない次の番号へ割り当てる計画を作る。
 * 2. **`rewriteReferencesInText`** — 1つのテキストの中で、旧番号への参照を
 *    新番号へ書き換える。書き換えるのは次の2形だけ:
 *    - 旧ファイル名の stem（拡張子抜き、`NNNN-slug`）を含む文字列
 *      （markdown リンク・パス参照）
 *    - `ADR ` に続く旧番号（見出し・本文中の言及）
 *    **裸の4桁数字は、この2形のどちらにもマッチしない限り一切触らない**
 *    ——日付・他の何かの識別子・無関係な4桁数字を巻き込まないため。
 * 3. **`addedLineNumbers`** — `git diff --unified=0` の出力から、このブランチが
 *    実際に「追加した」行番号だけを取り出す。
 *
 * ### ⚠ なぜ3番が要るか（自分の手で確かめた実例）
 *
 * 【実測】このリポジトリで実際に `git grep -n "ADR 0173\b"` を打つと、
 * `packages/core/src/recall-runtime.ts` や `docs/recall.md` など、**既存の
 * ADR 0173（`0173-decayed-omission-counted-by-aggregate-scope.md`）を指す
 * 正当な言及が repo 全体に数十箇所ある**ことを確認した。もし「衝突した番号
 * NNNN への言及をリポジトリ全体で一括置換する」と、**このブランチが足した
 * ADR とは無関係な、`origin/main` 側の既存の正当な言及まで巻き込んで
 * 書き換えてしまう**——衝突している番号は定義上「`origin/main` で既に
 * 使われている」番号であり、その番号への正当な言及が repo に既に多数
 * 存在するのはむしろ通常の状態である。
 *
 * ⟹ 書き換えてよいのは「**このブランチが実際に追加した行**」だけであり、
 * `origin/main` から継承した行（このブランチが触っていない行）は、たとえ
 * 同じファイル内に衝突した番号への言及が同居していても、一切変更しない。
 * 呼び出し側は、変更対象の各ファイルについて
 * `git diff --unified=0 origin/main -- <file>` を取り、`addedLineNumbers`
 * で追加行番号を求め、その行だけに `rewriteReferencesInText` を適用する。
 *
 * どれも I/O を持たない。ファイルの読み書き・`git mv`・`git diff` の実行は
 * 呼び出し側（`scripts/adr-renumber.mjs`）が行う。
 */
/**
 * ADR ファイル名から4桁番号と slug を取り出す正規表現
 * （`generate-adr-index-lib.mjs` の `isAdrFilename` が使う形と同じ）。
 */
const FILENAME_RE = /^(\d{4})-([a-z0-9][a-z0-9-]*)\.md$/;

/**
 * ADR ファイル名を `{ number, slug }` に分解する。ADR ファイルの形でなければ
 * `null` を返す（例外にしない——呼び出し側が「対象外だから無視する」を
 * 選べるようにする）。
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
 * 与えられた「使用済み番号」の集合の中で、まだ使われていない次の番号を返す。
 * **既存の最大値より小さい欠番を埋めには行かない**——ADR は
 * 0001..0173 まで単調増加で採番されてきた実態に合わせ、「最大値+1から昇順に、
 * まだ使われていない最初の番号」を返す。空集合なら `0001` を返す。
 *
 * @param {Iterable<string>} usedNumbers 4桁の数字文字列の集合
 * @returns {string} 4桁ゼロ埋めの番号
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
 * 「このブランチが `origin/main` に対して新しく追加した ADR ファイル」の一覧から、
 * 番号の衝突を解消する計画を作る。
 *
 * @param {Iterable<string>} mainNumbers `origin/main` 側で既に使われている4桁番号の集合
 * @param {{ filename: string }[]} addedFiles このブランチが追加した ADR ファイル
 *   （`origin/main` に存在せず、このブランチには存在するもの）。順序は入力の順序を保つ。
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

  // 衝突しない番号は、他の衝突エントリの採番候補として横取りされないよう
  // 先に「使用済み」として予約しておく。
  const claimed = new Set(mainUsed);
  for (const f of parsed) {
    if (!mainUsed.has(f.number)) claimed.add(f.number);
  }

  // 採番の基準点は `origin/main` の最大値だけから取る——このブランチが
  // たまたま大きい番号を先取りした「衝突していない」ADR（上で claimed に
  // 加えたもの）に引きずられて基準点が跳ね上がると、その間の本当は
  // 空いている番号（例: main の最大が0173で、衝突しないファイルが0180を
  // 名乗っていた場合の0174〜0179）を無駄に飛ばしてしまう。
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
 * 1つのテキストに対し、`renames`（`renamed: true` のエントリだけを渡すこと）に
 * 基づいて参照を書き換える。書き換えるのは次の2形だけ:
 *
 * 1. 旧ファイル名の stem（`NNNN-slug`、拡張子抜き）——直前が数字でなく、
 *    直後が英数字・ハイフンでないことを確認してから置換する（長い数字列や
 *    別の slug の一部を巻き込まないため）。
 * 2. `ADR ` に続く旧番号——直後が数字でないことを確認してから置換する。
 *
 * 裸の4桁数字（上記どちらの形にもマッチしないもの）は一切変更しない。
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
 * `ADR ` を主語に持つ*略記の連なり*（`ADR NNNN / MMMM`、3連・4連…）の中で、
 * `rewriteReferencesInText` が構造的に届かない位置に残った旧番号を検出する
 * （[Issue #615](https://github.com/takecchi/mnemora/issues/615) が指す「衝突した
 * *あと*」側の穴。⚠ **同 issue が扱う「衝突そのものを直列化する」話ではない**）。
 *
 * ## なぜ要るか（自分の手で踏んだ実例）
 *
 * `rewriteReferencesInText` の `adrRe`（`ADR ${oldNumber}(?!\d)`）は、
 * **「`ADR ` の直後」という1箇所しか見ない。**⟹ `ADR 0270 / 0271` のように
 * `/` で連なる略記では、**連なりの2番目以降（この例では `0271`）は
 * `ADR ` の直後ではないので、対象が同じ oldNumber であっても一切書き換わらない。**
 *
 * これは想像ではない——PR #614（`74c5295`）が実際に踏んだ。ADR 0271 が別の PR に
 * 取られて 0271 → 0272 へ付け替わった際、`scripts/__tests__/runtime-method-count-not-baked.test.mjs`
 * の2箇所（doc コメントと `describe` の題）にあった `ADR 0270 / 0271` という地の文の
 * 略記が、`0271` だけ旧番号のまま `main`（`74c5295`）へ焼かれた。**焼かれた `0271` は
 * 無関係な ADR 0271（Issue #608 項目①、PR #612）を指す状態になり**、事後に PR #618
 * （`bf6e9e7`）で人が読んで直すまでそのままだった。
 *
 * ## 採らなかった案 —— `rewriteReferencesInText` の書き換え射程を広げる
 *
 * ⛔ **この関数は何も書き換えない。**`rewriteReferencesInText` 側の正規表現を
 * 「連なりの2番目以降も拾う」形に広げれば、この事故そのものは機械的に直せる
 * ように*見える*。**だが広げなかった**——`AGENTS.md`「⚠ 機械には『検出』まで
 * ——確定と書き込みは人に残す」の「⭐ 線は『repo の中（戻せる）か、GitHub 側の
 * 取り消しにくい面か』である」節が言う通り、`adr-renumber.mjs` は既に repo の
 * 中に書き込む道具（ADR 0179）だが、**書き込む道具は、間違えたときに*静かに*
 * 壊れる**——無関係な4桁数字を書き換えてもエラーは出ない。射程を広げるほど、
 * 「たまたま `ADR NNNN / MMMM` の形をした、無関係な MMMM」まで巻き込む危険が
 * 増える（`AGENTS.md`「⚠ 偽陽性率に上限を置けない検査は門にしない」と同じ形の
 * 判断）。⟹ **検出（この関数）なら、偽陽性が出ても「人が確認する」だけで済む。**
 * `rewriteReferencesInText` 自身の docstring が宣言する射程（「`ADR ` に続く旧番号」
 * だけ、「裸の4桁数字は一切触らない」）は、この関数を足しても1バイトも変えない。
 *
 * ## 射程 —— 主語の錨は「`ADR` という語」、区切りは実在するものだけ
 *
 * 【実測】`git grep -hoE "ADR [0-9]{4}( ?[/・,、及びと] ?[0-9]{4})+"` をこの repo に
 * 当てると、**実在する区切りは `/` だけ**である（`ADR NNNN/NNNN` や
 * `ADR NNNN / NNNN` が多数、3連・4連…10連まで実在する。`・` や `,` の実例は無い）。
 * ⟹ この関数が見るのは `ADR \d{4}` に `/` 区切りの4桁数字が1回以上続く形だけ。
 * **`/` の前後の空白は有り無し両方を許す**（両方が実測で実在するため）。
 *
 * 連なりの**1番目**（`ADR ` に直接続く数字）は、`rewriteReferencesInText` の
 * `adrRe` が構造的に届く位置なので、この関数は見ない（`.slice(1)`）——**この関数が
 * 報告するのは、既存の書き換えが届かない位置だけである。**
 *
 * ## この検出が捕まえないもの（⛔ 対象外）
 *
 * - **`ADR` の錨が無い裸の4桁数字**（日付・issue番号等）。
 * - **`/` 以外の区切り**（実測で実在しないため対象にしていない——広げるなら
 *   新しい実例が出てから）。
 * - **PR タイトル・本文**——それは `scripts/check-pr-adr-reference.mjs`
 *   （[ADR 0211](../docs/decisions/0211-check-pr-adr-reference-catches-abandoned-numbers-in-title-and-body.md)）
 *   の担当であり、repo 内のファイルではない。
 * - **今日の実例（`runtime-method-count-not-baked.test.mjs`）以外に、同種の
 *   取りこぼしが既に `main` に在るかは、この関数を書いた時点では掃いていない。**
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
    // 1番目（"ADR " に直接続く数字）は rewriteReferencesInText 自身の射程なので
    // 対象から外す——ここで見るのは、その先の位置だけ。
    for (const number of numbers.slice(1)) {
      if (oldNumbers.has(number)) {
        results.push({ oldNumber: number, match: chain });
      }
    }
  }
  return results;
}

/**
 * `adr-renumber.mjs`（引数無し）が ADR 番号を実際に付け替えたときに表示する
 * 警告文を作る（[Issue #405](https://github.com/takecchi/mnemora/issues/405)）。
 *
 * **付け替えが1本も起きなかったとき（`renames` が空）は `null` を返す**——
 * 毎回出ると読み飛ばされる。呼び出し側は `null` のとき何も出力しないこと。
 *
 * この警告が要る理由: `adr-renumber.mjs` はファイル名・見出し・このブランチが
 * 追加した行の中の参照を書き換えるが、**PR タイトルと PR 本文——squash merge が
 * 生成するコミットのタイトルと本文の両方——だけは書き換えられない**（GitHub 側の
 * 状態であり、このリポジトリ内のファイルではないため）。このリポジトリは
 * `squash_merge_commit_title=PR_TITLE` / `squash_merge_commit_message=PR_BODY`
 * （`gh api repos/takecchi/mnemora` で確認済み）なので、**タイトルだけでなく本文も**
 * そのまま `main` の履歴に永久に残る。⟹ 付け替えが起きたら、**マージする側が
 * `gh pr edit <PR番号> --title ... --body ...` で PR タイトルと本文の両方を直す
 * 必要がある**——`docs/autonomy.md` §4 が「マージ前でなければならない」と
 * 説明している理由と同じで、squash commit のタイトル・本文は PR のタイトル・本文
 * から作られるため、マージ後は履歴になって直せない。
 *
 * ⚠ **この関数自身は「タイトルを直せ」としか言っていなかった**（[ADR
 * 0200](../docs/decisions/0200-adr-renumber-warns-when-titles-need-fixing.md) の時点）。
 * 本文の直し忘れは、その警告を実装した当の PR（[PR
 * #436](https://github.com/takecchi/mnemora/pull/436)、`aacb982e`）自身が
 * 実際に踏んでいる——タイトルは正しく直したが、本文中の6箇所は旧番号のまま
 * `main` に着地した。この関数はその実例を受けて、本文についても同じ強さで警告する
 * ように直した。機械的な検査（読み飛ばされない門）は
 * `scripts/check-pr-adr-reference.mjs` が CI で持つ——ただしそれも
 * 「最後の push の後にタイトル・本文だけを編集した」場合までは捕捉できない
 * （同スクリプトの docstring 参照）。
 *
 * @param {{ oldNumber: string, newNumber: string }[]} renames 実際に付け替えた
 *   ADR の一覧（`planRenumbering` が返す配列のうち `renamed: true` のもの）
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
    "本文が旧番号を名指ししたまま残っていないかは scripts/check-pr-adr-reference.mjs が CI で検査します" +
      "（ただしこの push の後にタイトル・本文だけを編集した場合は、次に push するまで検査されません）。",
  ].join("\n");
}

const HUNK_HEADER_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * `git diff --unified=0 <base> -- <file>` の出力から、**新ファイル側**で
 * 追加された行の行番号（1-indexed）の集合を取り出す。削除だけの行や、
 * 変更されていない行は含まない。
 *
 * `--unified=0` を前提にする（コンテキスト行を持たないため、ハンク内には
 * `+`/`-` 行しか現れない）。ハンクが無い（＝差分が無い）テキストを渡すと
 * 空集合を返す——`origin/main` から一切変更されていないファイルは、
 * この関数を通すと「書き換え対象の行が無い」と正しく判定される。
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
      // --unified=0 ではコンテキスト行は出ないはずだが、万一出た場合に
      // 備えて行番号だけは進めておく（安全側に倒す）。
      curLine += 1;
    }
  }
  return added;
}

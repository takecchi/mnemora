/**
 * ⛔ 門にしない。基準値ファイルも置かない。regime の値(UTF8 か SQL_ASCII か、`nonAsciiIsIndexed` が true か false か)の良し悪しは一切門にしない。
 * SQL_ASCII はサポート対象と決まっている(ADR 0106)ので、「悪い値」として門にしてはならない。LATIN1 は未回答で、その決定の対象外。
 * 基準値は `.github/workflows/ci.yml` の `POSTGRES_INITDB_ARGS` に在り、`--expect-encoding` で受け取る。別ファイルに二重に置かない。
 *
 * 🔴 非0になる経路は、意図して別々のメッセージにしている。
 * 1. ファイルが無い(ENOENT)。「値が出ていない」。測定段自体が落ちていないかを先に見る。
 * 2. JSON の parse に失敗する。
 * 3. `validateMeasured` が拒否する。「値が空だった」。
 * 4. `compareDeclaredEncoding` が、ci.yml の宣言値と実測値の食い違いを見つける。
 * いずれも「可視化・宣言が壊れたこと」の門で、製品判断(どの regime をサポートするか)には踏み込まない。
 */

const REQUIRED_STRING_FIELDS = [
  "serverVersion",
  "serverEncoding",
  "rawTsvector",
  "regime",
  "lcCollate",
  "lcCtype",
  "defaultTextSearchConfig",
];
const REQUIRED_BOOLEAN_FIELDS = ["nonAsciiIsIndexed", "rawIdentifierHit", "rawJapaneseWordHit"];

function isObject(value) {
  return typeof value === "object" && value !== null;
}

/**
 * ⚠ regime の値そのものの良し悪しは判定しない。検査するのは値が空・欠けていないかという構造だけ。
 *
 * @param {unknown} data
 * @returns {{ ok: true, value: Record<string, unknown> } | { ok: false, error: string }}
 */
export function validateMeasured(data) {
  if (!isObject(data)) {
    return { ok: false, error: "regime JSON がオブジェクトでない" };
  }
  const problems = [];
  if (typeof data.schemaVersion !== "number") {
    problems.push("schemaVersion が数値でない");
  }
  if (typeof data.measuredAt !== "string" || data.measuredAt === "") {
    problems.push("measuredAt が文字列でない、または空");
  }
  for (const field of REQUIRED_STRING_FIELDS) {
    if (typeof data[field] !== "string" || data[field] === "") {
      problems.push(`${field} が文字列でない、または空`);
    }
  }
  for (const field of REQUIRED_BOOLEAN_FIELDS) {
    if (typeof data[field] !== "boolean") {
      problems.push(`${field} が真偽値でない`);
    }
  }
  if (problems.length > 0) {
    return {
      ok: false,
      error: `regime JSON の値が空だった、または壊れている: ${problems.join("; ")}`,
    };
  }
  return { ok: true, value: /** @type {Record<string, unknown>} */ (data) };
}

/**
 * 🔴 `error` は「赤の意味」を書く。
 * 1. 実装のバグではない。CI の regime が動いたから赤くなった(`mnemora_lexical_normalize`/`PostgresLexicalStore` 側を疑わない)。
 * 2. 疑うのは ci.yml の `POSTGRES_INITDB_ARGS`、または service image の既定が変わったこと。
 * 3. 宣言値と実測値の両方を書く。片方だけでは一次診断にならない。
 *
 * ⚠ UTF8 か SQL_ASCII かは問わない。見るのは一致したかだけ。
 *
 * @param {Record<string, any>} measured
 * @param {string} declaredEncoding
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function compareDeclaredEncoding(measured, declaredEncoding) {
  if (measured.serverEncoding === declaredEncoding) {
    return { ok: true };
  }
  return {
    ok: false,
    error:
      "🔴 これは実装のバグではない。赤くなったのは CI の regime が動いたからである" +
      "——疑うのは実装(mnemora_lexical_normalize 等)ではなく、" +
      "`.github/workflows/ci.yml` の `POSTGRES_INITDB_ARGS`、または " +
      "service image(pgvector/pgvector:pg17)の既定が変わったことである。 " +
      `宣言値(--expect-encoding)=${declaredEncoding} / ` +
      `実測値(server_encoding)=${measured.serverEncoding}`,
  };
}

/**
 * 🔴 良し悪しを含めない。「UTF8 が正しい」「SQL_ASCII が悪い」とは書かず、宣言と実測が一致したかだけを表に出す。
 * 一致の判定は `compareDeclaredEncoding` の役目で、この関数は呼ばない(呼び出し側が組み合わせる)。
 *
 * @param {Record<string, any>} measured
 * @param {string} declaredEncoding
 */
export function buildSummaryMarkdown(measured, declaredEncoding) {
  const regimeLabel =
    measured.regime === "non_ascii_indexed"
      ? "non_ascii_indexed(非ASCIIが語として残る側)"
      : measured.regime === "non_ascii_dropped"
        ? "non_ascii_dropped(非ASCIIが丸ごと落ちる側)"
        : `${measured.regime}(未知の値——歯側の分岐が増えた可能性がある)`;
  const encodingMatch = measured.serverEncoding === declaredEncoding;

  return [
    "# lexical の server_encoding regime の実測(Issue #148)",
    "",
    "⛔ **値の良し悪しは門ではない。**下の server_encoding / nonAsciiIsIndexed が" +
      "どちらであっても、それ自体でこのステップが exit 0 でなくなることはない" +
      "——オーナー(takecchi)は 2026-09-12T00:09Z に、server_encoding が SQL_ASCII の" +
      "PostgreSQL をサポート対象にすると決めた(ADR 0106)。だからこそ SQL_ASCII を" +
      "「悪い値」として門にすることはできない——この可視化が門にするのは規範の判断では" +
      "なく、宣言と実測の一致だけである(LATIN1 は未回答であり、この決定の対象外)。",
    "",
    "🔴 **ただし「宣言と実測の食い違い」は門である(Issue #148 ②)。**" +
      "`.github/workflows/ci.yml` の `POSTGRES_INITDB_ARGS` が宣言した encoding と、" +
      "実際に測れた server_encoding が一致しなかったときだけ、このステップは非0で終わる。",
    "",
    "| 項目 | 値 |",
    "|---|---|",
    `| server_version | ${measured.serverVersion} |`,
    `| server_encoding | ${measured.serverEncoding} |`,
    `| nonAsciiIsIndexed | ${measured.nonAsciiIsIndexed} |`,
    `| regime | ${regimeLabel} |`,
    `| rawIdentifierHit(素の tsvector で識別子が引けるか) | ${measured.rawIdentifierHit} |`,
    `| rawJapaneseWordHit(素の tsvector で日本語の語が引けるか) | ${measured.rawJapaneseWordHit} |`,
    `| lc_collate | ${measured.lcCollate} |`,
    `| lc_ctype | ${measured.lcCtype} |`,
    `| default_text_search_config | ${measured.defaultTextSearchConfig} |`,
    `| 宣言(ci.yml の \`POSTGRES_INITDB_ARGS\`) | ${declaredEncoding} |`,
    `| 宣言と実測(server_encoding)は一致したか | ${encodingMatch} |`,
    `| measuredAt | ${measured.measuredAt} |`,
    "",
    "生の tsvector(参考。長いことがある):",
    "",
    "```",
    String(measured.rawTsvector),
    "```",
    "",
    "⚠ この値の読み方は " +
      "[ADR 0103](https://github.com/takecchi/mnemora/blob/main/docs/decisions/" +
      "0103-negative-tooth-declares-its-precondition.md)、" +
      "[ADR 0106](https://github.com/takecchi/mnemora/blob/main/docs/decisions/" +
      "0106-ci-declares-the-regime-it-measures.md) と " +
      "[Issue #145](https://github.com/takecchi/mnemora/issues/145) を見ること" +
      "——`server_encoding` によって「素の to_tsvector で識別子を引けるか」の結論そのものが" +
      "反転する(反転しても `mnemora_lexical_normalize` を通した本番経路の結論は変わらない)。",
  ].join("\n");
}

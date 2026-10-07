/**
 * 「同じ内容か」を比べるときだけ使う、content の正規化（ADR 0424）。
 *
 * 規則は NFC の後に `trim()`。**比較の前だけで使い、保存値と `content_hash` は変えない**
 * （`content_hash` は生の文字列の sha256 で、値を変えると既存の行と互換がなくなる）。
 * SQL 側に入れない理由（Postgres の `normalize()` は SQL_ASCII で使えない）と、
 * store の口の契約を変えない理由は ADR 0424。
 */
export function normalizeContentForComparison(content: string): string {
  return content.normalize("NFC").trim();
}

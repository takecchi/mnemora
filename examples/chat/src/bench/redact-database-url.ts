/**
 * `DATABASE_URL` を画面へ出す前にパスワードを隠す。
 *
 * ## 経緯
 *
 * `association-scale-investigate.ts` は「別データベースで走らせること（⛔ 破壊的な
 * TRUNCATE を挟むため）」という安全確認の目的で、`main()` の先頭近くで実際に接続する
 * `DATABASE_URL` をそのまま `console.log` していた——`postgresql://user:password@host/db`
 * 形式ならパスワードもそのまま標準出力に出る。**このファイルの他の bench（
 * `association-scale-bench.ts` 等）・`packages/postgres/src/bin/migrate.ts` は
 * `DATABASE_URL` の値そのものを画面へ出していない**（この作業で `grep` して確かめた——
 * 対象は `examples/chat/src` と `packages/postgres/src` 配下）。
 *
 * 安全確認という目的自体は残す価値がある（どの DB に対して TRUNCATE するかを、
 * 実行前に目で確認できる）——⟹ **パスワードだけを隠して同じ目的を保つ。**
 */
export function redactDatabaseUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // パースできない形式をそのまま画面に出すと、それ自体が秘密を含みうる
    // （例: パースに失敗する崩れた接続文字列の中にパスワードの断片が残る）。
    return "<invalid-database-url>";
  }
  if (parsed.password !== "") {
    parsed.password = "***";
  }
  return parsed.toString();
}

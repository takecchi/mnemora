/**
 * `DATABASE_URL` を画面へ出す前にパスワードを隠す。
 *
 * どの DB に TRUNCATE するかを実行前に目で確認できるよう、URL 自体は出す。パスワードだけを隠す。
 */
export function redactDatabaseUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // パースできない形式をそのまま出すと、崩れた接続文字列にパスワードの断片が残りうるので、中身は出さない。
    return "<invalid-database-url>";
  }
  if (parsed.password !== "") {
    parsed.password = "***";
  }
  // libpq はクエリの `password` パラメータでもパスワードを受け付ける。`set` は同名の重複もまとめて置き換える。
  if (parsed.searchParams.has("password")) {
    parsed.searchParams.set("password", "***");
  }
  return parsed.toString();
}

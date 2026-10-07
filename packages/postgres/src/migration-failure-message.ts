/** `runMigrations` が1ファイルの適用に失敗したときの文言。公開しない（`index.ts` から再輸出しない）。 */
/**
 * 拡張を作る権限が無いときに文言の後ろへ足す案内。Postgres の文言（`permission denied to create extension "vector"`）は
 * 何が足りないかしか言わないので、どうすればよいかを添える。拡張の名前と数は写さない（`REQUIRED_EXTENSIONS` が出所）。
 */
export const CREATE_EXTENSION_PERMISSION_HINT =
  "\n接続ロールに拡張を作る権限がありません。DBA 側で拡張を作ってから、" +
  'extensionMode: "verify"（CLI では --extension-mode verify）で流してください' +
  "（packages/postgres/README.md の、接続先に要る拡張の項目）。";

/**
 * `CREATE EXTENSION` が権限不足で失敗した pg のエラーか。
 *
 * `code` が `42501` なだけでは足りない（スキーマへの `CREATE` 権限が無い `CREATE TABLE` でも出る）。
 * Postgres の関数名 `routine` が `execute_extension_script` であることも見る（スキーマの権限不足は `aclcheck_error`）。
 * `message` は `lc_messages` で訳されるので見ない。
 */
export function isCreateExtensionPermissionDenied(err: unknown): boolean {
  // drizzle の `db.execute()` は pg のエラーを包み、`code` / `routine` は `cause` 側にしか無い
  // （`runMigrations` は生の pg クライアントなので外側に在る）。両方で判定できるよう `cause` の連鎖を辿る。
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    const { code, routine } = current as { code?: unknown; routine?: unknown };
    if (code === "42501" && routine === "execute_extension_script") {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * `migration <file> failed: <元の message>` を作る。先頭は変えない（先頭を正規表現で拾う呼び手が居うる）。
 * 案内は、拡張を作る権限が無いときだけ改行の後ろに足す。
 */
export function describeMigrationFailure(file: string, err: unknown): string {
  const message = `migration ${file} failed: ${(err as Error).message}`;
  return isCreateExtensionPermissionDenied(err)
    ? message + CREATE_EXTENSION_PERMISSION_HINT
    : message;
}

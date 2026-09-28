/**
 * `runMigrations` が1ファイルの適用に失敗したときの文言（Issue #1212）。
 *
 * **公開しない**（`index.ts` から再輸出しない）。`migrate.ts` とテストだけが使う。
 */

/**
 * 拡張を作る権限が無いときに、文言の後ろに足す案内。
 *
 * 既定（`extensionMode: "create"`）で、`CREATE EXTENSION` の権限を持たないロールが流すと、
 * Postgres の文言（`permission denied to create extension "vector"`）は何が足りないかしか言わない。
 * どうすればよいか（`packages/postgres/README.md` の、接続先に要る拡張の項目）を、ここで添える。
 * ⚠ 拡張の名前と数は文言に写さない（`REQUIRED_EXTENSIONS` が出所で、写すとずれる）。
 */
export const CREATE_EXTENSION_PERMISSION_HINT =
  "\n接続ロールに拡張を作る権限がありません。DBA 側で拡張を作ってから、" +
  'extensionMode: "verify"（CLI では --extension-mode verify）で流してください' +
  "（packages/postgres/README.md の、接続先に要る拡張の項目）。";

/**
 * `CREATE EXTENSION` が権限不足で失敗した pg のエラーか。
 *
 * `code` が `42501`（insufficient_privilege）なだけでは足りない——同じ `42501` は、スキーマへの
 * `CREATE` 権限が無い `CREATE TABLE` でも出る（`permission denied for schema public`）。そこで、
 * エラーを出した Postgres の関数名（`routine`）が `execute_extension_script` であることも見る
 * （【実測】PostgreSQL 17: `CREATE EXTENSION` の権限不足は `routine = "execute_extension_script"`、
 * スキーマの権限不足は `routine = "aclcheck_error"`）。`message` は `lc_messages` で訳されるので見ない。
 */
function isCreateExtensionPermissionDenied(err: unknown): boolean {
  if (typeof err !== "object" || err === null) {
    return false;
  }
  const { code, routine } = err as { code?: unknown; routine?: unknown };
  return code === "42501" && routine === "execute_extension_script";
}

/**
 * `migration <file> failed: <元の message>` を作る。
 *
 * ⚠ **先頭は変えない**（先頭を正規表現で拾う呼び手が居うる）。案内は、拡張を作る権限が
 * 無いときだけ、改行の後ろに足す。例外の種類・投げる条件は呼び出し側（`runMigrations`）のまま。
 */
export function describeMigrationFailure(file: string, err: unknown): string {
  const message = `migration ${file} failed: ${(err as Error).message}`;
  return isCreateExtensionPermissionDenied(err)
    ? message + CREATE_EXTENSION_PERMISSION_HINT
    : message;
}

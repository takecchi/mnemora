/**
 * examples/chat の CLI が DB のエラーで止まったときに、元のエラーの後ろへ出す「次の一手」の一行。
 *
 * 元のエラーは消さない（`cli.ts` の `main` がそのまま出す）。当てはまるときだけ README の「DB を用意する」節を指す一行を返し、
 * 当てはまらなければ `undefined` を返す。判定はエラーの `code` だけで行い、`cause` の連鎖も辿る
 * （`runMigrations` は元のエラーを `cause` に包む）。
 */

const SECTION = "examples/chat/README.md「DB を用意する」";

const NETWORK_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "EHOSTUNREACH"]);

function codesAndMessages(err: unknown): { code: string | undefined; message: string }[] {
  const out: { code: string | undefined; message: string }[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    const code = (current as { code?: unknown }).code;
    out.push({ code: typeof code === "string" ? code : undefined, message: current.message });
    current = (current as { cause?: unknown }).cause;
  }
  return out;
}

export function databaseErrorHint(err: unknown): string | undefined {
  for (const { code, message } of codesAndMessages(err)) {
    if (code !== undefined && NETWORK_CODES.has(code)) {
      return `DB に接続できない。Postgres が起動しているか、DATABASE_URL のホスト・ポートが合っているかを確かめること（${SECTION}）。`;
    }
    if (code === "3D000") {
      return `DATABASE_URL のデータベースが存在しない。createdb（または CREATE DATABASE）で先に作ること（${SECTION}）。`;
    }
    if (code === "28000" || code === "28P01") {
      return `DATABASE_URL のユーザー（ロール）が存在しないか、認証に失敗した。ユーザー名・パスワードを確かめること（${SECTION}）。`;
    }
    if (code === "42501" && /extension/.test(message)) {
      return `拡張を作る権限が無い。superuser で CREATE EXTENSION vector / btree_gin / pgcrypto を先に実行してから、もう一度 migrate すること（${SECTION}）。`;
    }
  }
  return undefined;
}

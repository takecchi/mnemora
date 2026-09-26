import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { redactDatabaseUrl } from "../redact-database-url.js";

/**
 * 実測で見つけたこと: `association-scale-investigate.ts` は（DATABASE_URL を要求しつつ、
 * `main()` がモジュール読み込み時にそのまま走る作りのため、`import` してユニット検査
 * できない）`DATABASE_URL=...` を含む行を `console.log` していた——実際に走らせて
 * 標準出力に生の `DATABASE_URL`（例: `postgresql://worker@127.0.0.1:55432/...`）が
 * そのまま出ることを確認した（この作業のログ）。`grep -rn` で
 * `examples/chat/src` と `packages/postgres/src` を当たった限り、`DATABASE_URL` の値
 * そのものを画面へ出しているのはこの1箇所だけだった（探索は網羅を主張しない）。
 *
 * `main()` を安全に import できないため、この歯は2段に分ける:
 * 1. 抽出した純関数 `redactDatabaseUrl` がパスワードを隠すこと（ユニット）。
 * 2. `association-scale-investigate.ts` のソースが、その関数を経由せずに
 *    `DATABASE_URL=${databaseUrl}` の形で生の値を埋め込んでいないこと（ソース検査、
 *    `correction-scenario-compare-isolation.test.ts` と同じ作法）。
 */

describe("redactDatabaseUrl", () => {
  it("user:password@host 形式のパスワードを隠す", () => {
    const url = "postgresql://worker:s3cr3t@127.0.0.1:55432/mnemora_test";
    const redacted = redactDatabaseUrl(url);
    expect(redacted).not.toContain("s3cr3t");
    expect(redacted).toContain("worker");
    expect(redacted).toContain("127.0.0.1:55432");
    expect(redacted).toContain("mnemora_test");
  });

  it("パスワードが無い URL は変えない(実体として同じ URL を指す)", () => {
    const url = "postgresql://worker@127.0.0.1:55432/mnemora_test?host=/tmp/pgsock";
    expect(new URL(redactDatabaseUrl(url)).toString()).toBe(new URL(url).toString());
  });

  it("クエリの password パラメータも隠す(libpq の接続 URI はクエリでもパスワードを受け付ける)", () => {
    const url = "postgresql://worker@127.0.0.1:55432/mnemora_test?password=q5ecr3t&sslmode=disable";
    const redacted = redactDatabaseUrl(url);
    expect(redacted).not.toContain("q5ecr3t");
    expect(new URL(redacted).searchParams.get("password")).toBe("***");
    expect(new URL(redacted).searchParams.get("sslmode")).toBe("disable");
  });

  it("userinfo とクエリの両方にあるパスワードを、どちらも隠す", () => {
    const url = "postgresql://worker:u5ecr3t@127.0.0.1:55432/mnemora_test?password=q5ecr3t";
    const redacted = redactDatabaseUrl(url);
    expect(redacted).not.toContain("u5ecr3t");
    expect(redacted).not.toContain("q5ecr3t");
  });

  it("URL としてパースできない値は、そのまま画面に出さない", () => {
    expect(redactDatabaseUrl("not a url")).toBe("<invalid-database-url>");
  });
});

function readSourceText(relativePath: string): string {
  const url = new URL(relativePath, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf-8");
}

describe("association-scale-investigate.ts は DATABASE_URL の生の値を画面へ出さない", () => {
  it("console.log の中で databaseUrl を直接展開していない(redactDatabaseUrl 経由であること)", () => {
    const source = readSourceText("../association-scale-investigate.ts");
    expect(source).not.toContain("DATABASE_URL=${databaseUrl}");
    expect(source).toContain("redactDatabaseUrl(databaseUrl)");
  });
});

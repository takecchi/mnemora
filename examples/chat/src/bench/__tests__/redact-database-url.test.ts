import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { redactDatabaseUrl } from "../redact-database-url.js";

// association-scale-investigate.ts は main() がモジュール読み込み時に走るので import できない。
// 抽出した純関数のユニット検査と、ソースが生の DATABASE_URL を埋め込んでいないことのソース検査の2段に分ける。

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

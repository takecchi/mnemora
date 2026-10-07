import { describe, expect, it } from "vitest";
import { databaseErrorHint } from "../db-error-hint.js";

function withCode(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

describe("databaseErrorHint", () => {
  it("DB に繋がらない（ECONNREFUSED・ENOTFOUND）は、起動と DATABASE_URL を確かめる一行を返す", () => {
    for (const code of ["ECONNREFUSED", "ENOTFOUND"]) {
      const hint = databaseErrorHint(withCode(`connect ${code} 127.0.0.1:5432`, code));
      expect(hint, code).toMatch(/DATABASE_URL/);
      expect(hint, code).toMatch(/README/);
    }
  });

  it("データベースが無い（3D000）は、データベースを作る一行を返す", () => {
    expect(databaseErrorHint(withCode('database "x" does not exist', "3D000"))).toMatch(
      /createdb|CREATE DATABASE/,
    );
  });

  it("ロールが無い・認証に失敗した（28000・28P01）は、DATABASE_URL のユーザーを確かめる一行を返す", () => {
    for (const code of ["28000", "28P01"]) {
      expect(databaseErrorHint(withCode("role/auth", code)), code).toMatch(/ユーザー|ロール/);
    }
  });

  it("拡張を作る権限が無い（runMigrations が包んだ cause の 42501）は、superuser で拡張を先に入れる一行を返す", () => {
    const cause = withCode('permission denied to create extension "vector"', "42501");
    const err = new Error(
      'migration 0001_init.sql failed: permission denied to create extension "vector"',
      { cause },
    );
    const hint = databaseErrorHint(err);
    expect(hint).toMatch(/superuser/);
    expect(hint).toMatch(/CREATE EXTENSION/);
  });

  it("DB と関係のないエラーには何も足さない", () => {
    expect(databaseErrorHint(new Error("何か別の失敗"))).toBeUndefined();
    expect(databaseErrorHint(withCode("permission denied for table x", "42501"))).toBeUndefined();
    expect(databaseErrorHint("文字列")).toBeUndefined();
  });
});

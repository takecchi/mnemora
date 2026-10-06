import { describe, expect, it } from "vitest";
import {
  deriveAdvisoryLockKeys,
  deriveMigrationObjects,
  extractBulletedIdentifiers,
  extractHeadingCount,
  extractMarkdownSection,
} from "../readme-postgres-objects-lib.mjs";

/**
 * `readme-postgres-objects-lib.mjs`（Issue #168、ADR 0202・0204）の歯の足し
 * （Issue #1815、09/16 マージ分の #438・#444 の確かめ直し）。
 *
 * 既存の `readme-postgres-objects-lib.test.mjs` は、DDL の書き方の揺れ（`IF NOT EXISTS`・`CONCURRENTLY`・`IF EXISTS`・
 * 小文字）と、節・見出し・箇条書きの拾い方の境界を見ていなかった。**ここを取りこぼすと、README の一覧と migrations の
 * 最終形の突き合わせが、その書き方のオブジェクトを黙って数えない**（過不足なしの主張が緩む）。実装は変えない。
 * **これはクローン（miku）の判断で足した歯で、オーナーの判断ではない**（ADR 0220）。
 */

describe("deriveMigrationObjects は DDL の書き方の揺れを拾う", () => {
  it("`CREATE TABLE IF NOT EXISTS` のテーブルを拾う", () => {
    expect(deriveMigrationObjects(["CREATE TABLE IF NOT EXISTS foo (id int);"]).tables).toEqual([
      "foo",
    ]);
  });

  it("`CREATE INDEX CONCURRENTLY` の索引を拾う（`CONCURRENTLY` を名前と取り違えない）", () => {
    const { indexes } = deriveMigrationObjects(["CREATE INDEX CONCURRENTLY idx_a ON t (c);"]);
    expect(indexes).toEqual(["idx_a"]);
  });

  it("`CREATE INDEX CONCURRENTLY IF NOT EXISTS` も拾う", () => {
    const { indexes } = deriveMigrationObjects([
      "CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_b ON t (c);",
    ]);
    expect(indexes).toEqual(["idx_b"]);
  });

  it("動的 DDL の `CREATE INDEX CONCURRENTLY %I` の `CONCURRENTLY` を、索引名として拾わない", () => {
    const { indexes } = deriveMigrationObjects([
      "EXECUTE format('CREATE INDEX CONCURRENTLY %I ON %I (c)', n, t);",
    ]);
    expect(indexes).toEqual([]);
  });

  it("`DROP INDEX CONCURRENTLY` が、先に作った索引を最終集合から消す", () => {
    const { indexes } = deriveMigrationObjects([
      "CREATE INDEX idx_a ON t (c);",
      "DROP INDEX CONCURRENTLY idx_a;",
    ]);
    expect(indexes).toEqual([]);
  });

  it("`DROP INDEX CONCURRENTLY IF EXISTS` も消す", () => {
    const { indexes } = deriveMigrationObjects([
      "CREATE INDEX idx_a ON t (c);",
      "DROP INDEX CONCURRENTLY IF EXISTS idx_a;",
    ]);
    expect(indexes).toEqual([]);
  });

  it("`DROP FUNCTION IF EXISTS` が、先に作った関数を最終集合から消す", () => {
    const { functions } = deriveMigrationObjects([
      "CREATE FUNCTION f() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql;",
      "DROP FUNCTION IF EXISTS f();",
    ]);
    expect(functions).toEqual([]);
  });

  it("`DROP TABLE IF EXISTS` が、先に作ったテーブルを最終集合から消す", () => {
    const { tables } = deriveMigrationObjects([
      "CREATE TABLE foo (id int);",
      "DROP TABLE IF EXISTS foo;",
    ]);
    expect(tables).toEqual([]);
  });

  it("小文字の DDL も拾う（`create table` / `create index` / `create function` / `drop index`）", () => {
    const result = deriveMigrationObjects([
      [
        "create table foo (id int);",
        "create index idx_a on foo (id);",
        "create index idx_b on foo (id);",
        "drop index idx_b;",
        "create or replace function f() returns int as $$ select 1 $$ language sql;",
      ].join("\n"),
    ]);
    expect(result).toEqual({ tables: ["foo"], indexes: ["idx_a"], functions: ["f"] });
  });

  it("結果は名前順に並べて返す（入力の並びに依らない）", () => {
    const result = deriveMigrationObjects([
      "CREATE TABLE zeta (id int);\nCREATE TABLE alpha (id int);",
    ]);
    expect(result.tables).toEqual(["alpha", "zeta"]);
  });

  it("複数行にまたがるブロックコメントの中の DDL は拾わない", () => {
    const { tables } = deriveMigrationObjects([
      "/* CREATE TABLE ghost (\n id int\n) */\nCREATE TABLE real (id int);",
    ]);
    expect(tables).toEqual(["real"]);
  });
});

describe("節・見出し・箇条書きの拾い方の境界", () => {
  it("節は、次の `## ` 見出しでも終わる（`### ` だけを終わりとしない）", () => {
    const md = ["### テーブル（1）", "", "- `a`", "", "## 別の節", "", "- `notATable`"].join("\n");
    expect(extractBulletedIdentifiers(extractMarkdownSection(md, "テーブル"))).toEqual(["a"]);
  });

  it("見出しは、ラベルで始まるものだけを拾う（途中にラベルを含むだけの見出しは拾わない）", () => {
    const md = [
      "### 実行時に増える系列（テーブル名の接頭辞）",
      "",
      "- `wrong`",
      "",
      "### テーブル（1）",
      "",
      "- `right`",
    ].join("\n");
    expect(extractBulletedIdentifiers(extractMarkdownSection(md, "テーブル"))).toEqual(["right"]);
    expect(extractHeadingCount(md, "テーブル")).toBe(1);
  });

  it("見出しの件数は、半角の括弧 `(N)` でも読む", () => {
    expect(extractHeadingCount("### テーブル(3)\n", "テーブル")).toBe(3);
  });

  it("字下げした箇条書きの識別子も拾う", () => {
    expect(extractBulletedIdentifiers("  - `nested_a`\n- `top_b`")).toEqual(["nested_a", "top_b"]);
  });

  it("箇条書きでない行の途中に現れる `- `x`` は、識別子として拾わない", () => {
    expect(extractBulletedIdentifiers("- `real`\n本文の途中 - `prose` は拾わない")).toEqual([
      "real",
    ]);
  });
});

describe("deriveAdvisoryLockKeys は負の MIGRATION_LOCK_KEY も読む", () => {
  it("符号つきで読む（bigint なので負もありうる）", () => {
    const migrateSourceText = [
      "export const MIGRATION_LOCK_KEY = -7190158676462701299n;",
      "  return deriveAdvisoryLockKey(`mnemora:runMigrations:advisory-lock:${schema}`);",
    ].join("\n");
    const vectorSpaceSourceText = [
      "export const REGISTER_EMBEDDING_SPACE_LOCK_KEY = 4359922960011245935n;",
      "  return deriveAdvisoryLockKey(`mnemora:registerEmbeddingSpace:advisory-lock:${schema}`);",
    ].join("\n");
    const keys = deriveAdvisoryLockKeys({ migrateSourceText, vectorSpaceSourceText });
    expect(keys.migrationLockKey).toBe("-7190158676462701299");
    expect(keys.registerEmbeddingSpaceLockKey).toBe("4359922960011245935");
  });
});

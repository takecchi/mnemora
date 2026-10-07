import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { DEFAULT_MIGRATIONS_DIR, listMigrationFiles, runMigrations } from "../migrate.js";
import { stripSqlComments } from "./sql-comments.js";

/**
 * `runMigrations` が触る面は `pool.query(...)` と `pool.connect()`（返す client の `query` / `release` / `on` / `removeListener`）だけなので、その2つを記録するだけの偽の `Pool` を作り、
 * A: `runMigrations(fakeA)`（引数1つ）と B: `runMigrations(fakeB, undefined, { schema: undefined, extensionSchema: undefined })` の発行 SQL 列が完全に一致することを確かめる（DB 無し）。
 * `migrationsDir` を省略して {@link DEFAULT_MIGRATIONS_DIR} を実際に使わせるので、既定の migrations ディレクトリの解決が壊れれば `listMigrationFiles` が `ENOENT` で落ちて赤くなる。
 *
 * ⚠ 両方の列が空でも「一致」はしてしまうので、「列が空でない・実マイグレーション本文が流れている」ことと、「schema を実際に指定すれば列が変わる」という対照（negative control）を別の `it` として置く。
 * ⚠ 検査は「発行テキストの comment」ではなく「実行される文」に当てる。`migrations/*.sql` は comment ごと `client.query()` へ渡されるので、素朴な正規表現を生テキストへかけると、説明 comment にその語を書いただけでこの歯が落ちる。
 * 1本目の `it` は `./sql-comments.ts` の `stripSqlComments` で comment を剥がしてから `.not.toMatch(...)` にかける。2本目（空振り防止）は生の `sql` が log に含まれることを確かめる必要があるので、comment を剥がさない。
 */

/** pgvector 能力検査に対して返す、「対応している」既定の1行。この歯の主題は発行する SQL 列であり、能力検査の合否ではないので、常に通す。 */
function respondToQuery(text: string): { rows: unknown[] } {
  if (text.includes("pg_settings")) {
    return { rows: [{ extversion: "0.8.0", vartype: "enum", enumvals: ["off", "relaxed_order"] }] };
  }
  return { rows: [] };
}

/** `runMigrations` が発行した SQL を記録するだけの偽の `Pool` と、その記録先の配列。 */
function createFakePool(): { pool: Pool; log: string[] } {
  const log: string[] = [];

  const client = {
    query: async (text: string) => {
      log.push(`client.query: ${text}`);
      return respondToQuery(text);
    },
    release: () => {
      // 呼ばれたことそのものは検査対象ではない。
    },
    on: () => client,
    removeListener: () => client,
  };

  const pool = {
    query: async (text: string) => {
      log.push(`pool.query: ${text}`);
      return respondToQuery(text);
    },
    connect: async () => client,
  };

  return { pool: pool as unknown as Pool, log };
}

describe("migrate.ts CLI の既定経路: options 省略と1バイトも変わらない", () => {
  it("A: runMigrations(pool) と B: runMigrations(pool, undefined, { schema: undefined, extensionSchema: undefined }) は同じ SQL 列を発行する", async () => {
    const a = createFakePool();
    const b = createFakePool();

    await runMigrations(a.pool);
    await runMigrations(b.pool, undefined, { schema: undefined, extensionSchema: undefined });

    expect(b.log).toEqual(a.log);

    // A と B は runtime 上は同じ値（undefined）を見るので、`schema === undefined` の分岐そのものが壊れて専用スキーマ用の SQL を打つようになった場合、A と B は同じように壊れ、上の toEqual だけでは見分けが付かない。
    // そのため既定経路には専用スキーマ用の SQL（`CREATE SCHEMA` / `SET LOCAL search_path`）が一切現れないことを、この列自体に対しても直接固定する。
    // ⚠ `CREATE EXTENSION` はここでは見ない。`migrations/0001_init.sql` 自身が本文に含むので、実マイグレーション本文が正しく流れている限り正当に現れる。
    // ⚠ `stripSqlComments` で comment を剥がしてから見る（このファイル冒頭の doc 参照）。
    for (const entry of a.log) {
      const executable = stripSqlComments(entry);
      expect(executable).not.toMatch(/CREATE SCHEMA/);
      expect(executable).not.toMatch(/SET LOCAL search_path/);
    }
  });

  it("空振り防止: 列は空でなく、既定の migrations ディレクトリの実ファイルが実際に流れる（Issue #110 の migrations-dir.cts が生きていることも測る）", async () => {
    const { pool, log } = createFakePool();

    await runMigrations(pool);

    expect(log.length).toBeGreaterThan(0);

    // 期待値をハードコードせず、`listMigrationFiles(DEFAULT_MIGRATIONS_DIR)` から導出する。
    const files = listMigrationFiles(DEFAULT_MIGRATIONS_DIR);
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const sql = readFileSync(join(DEFAULT_MIGRATIONS_DIR, file), "utf8");
      expect(log.some((entry) => entry.includes(sql))).toBe(true);
    }
  });

  it("対照(negative control): schema を実際に指定すれば SQL 列は変わり、CREATE SCHEMA / SET LOCAL search_path が現れる", async () => {
    const a = createFakePool();
    const c = createFakePool();

    await runMigrations(a.pool);
    await runMigrations(c.pool, undefined, { schema: "some_schema" });

    // これが無いと「比較が何も検出できない壊れた比較」でも上の歯は緑になってしまう。
    expect(c.log).not.toEqual(a.log);
    expect(c.log.some((entry) => /CREATE SCHEMA/.test(entry))).toBe(true);
    expect(c.log.some((entry) => /SET LOCAL search_path/.test(entry))).toBe(true);
  });
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * `docs/memory-model.md` の `CREATE TABLE` に書かれた列の既定（`DEFAULT …`）と、列の値を名前で縛る
 * `CHECK (col IN (…))` の名前の集合が、マイグレーションを当てた本物の DB と一致することを縛る。**doc の値は `docs/memory-model.md` を実行時に読んで**、
 * **実装の値は DB の `information_schema.columns`・`pg_constraint` から**取って突き合わせる。
 *
 * - doc の DDL は、後から migration で足した列をすべては写していない（同文書の 2026-09-27 追記）。
 *   なので、**doc に書かれた列だけ**を見る。doc に書かれた列が DB に無ければ赤にする。
 * - DB に表そのものが無いもの（空間ごとに登録時に作る埋め込みの表の例、Phase 2 の表）は飛ばす。
 *   全部を飛ばしていないこと（何かを見ていること）は `it` の中で確かめる。
 * - 比べるのは既定の式（型の後ろの `::text` などの cast は外す）と、CHECK の値の名前の集合である。
 *   列の数・値の数は比べない（名前の集合が一致すれば足りる）。
 */

const MEMORY_MODEL_DOC = readFileSync(
  fileURLToPath(new URL("../../../../docs/memory-model.md", import.meta.url)),
  "utf8",
);

interface DocDefault {
  table: string;
  column: string;
  expression: string;
}

function documentedDefaults(): DocDefault[] {
  const defaults: DocDefault[] = [];
  for (const [, table, body] of MEMORY_MODEL_DOC.matchAll(
    /^CREATE TABLE (\w+) \(\n([\s\S]*?)\n\);/gm,
  )) {
    for (const line of body!.split("\n")) {
      const code = line.replace(/--.*$/, "");
      const column = code.match(/^\s+([a-z_]+)\s+/)?.[1];
      const expression = code.match(/\bDEFAULT\s+('[^']*'|[^\s,]+)/i)?.[1];
      if (column === undefined || expression === undefined) continue;
      defaults.push({ table: table!, column, expression });
    }
  }
  return defaults;
}

function documentedChecks(): { table: string; column: string; names: string[] }[] {
  const checks: { table: string; column: string; names: string[] }[] = [];
  for (const [, table, body] of MEMORY_MODEL_DOC.matchAll(
    /^CREATE TABLE (\w+) \(\n([\s\S]*?)\n\);/gm,
  )) {
    const code = body!.replace(/--.*$/gm, "");
    for (const m of code.matchAll(/CHECK\s*\(\s*([a-z_]+)\s+IN\s*\(([^)]*)\)\s*\)/g)) {
      const names = [...m[2]!.matchAll(/'([^']*)'/g)].map((x) => x[1]!).sort();
      checks.push({ table: table!, column: m[1]!, names });
    }
  }
  return checks;
}

/** `'open'::text` → `'open'`、`'{}'::text[]` → `'{}'`（cast を外す）。 */
const stripCast = (expression: string) => expression.replace(/::[a-z ]+(\[\])?$/i, "");

const ctx: Ctx = { tenantId: "memory-model-doc-ddl-defaults" };

describe("docs/memory-model.md の CREATE TABLE の列の既定は、マイグレーション後の DB と一致する", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("doc に書かれた列の DEFAULT", async () => {
    const { pool } = await getTestClient();
    const docDefaults = documentedDefaults();
    const rows = await pool.query<{
      table_name: string;
      column_name: string;
      column_default: string | null;
    }>(
      `SELECT table_name, column_name, column_default FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = ANY($1)`,
      [[...new Set(docDefaults.map((d) => d.table))]],
    );
    const tablesInDb = new Set(rows.rows.map((r) => r.table_name));
    const actual = new Map(
      rows.rows.map((r) => [`${r.table_name}.${r.column_name}`, r.column_default]),
    );

    const compared = docDefaults.filter((d) => tablesInDb.has(d.table));
    expect(compared.length).toBeGreaterThan(0);
    const mismatches = compared
      .map((d) => {
        const db = actual.get(`${d.table}.${d.column}`);
        return { at: `${d.table}.${d.column}`, doc: d.expression, db: db ?? "(列が無い)" };
      })
      .filter((m) => m.db === "(列が無い)" || stripCast(m.db) !== m.doc);
    expect(mismatches).toEqual([]);
  });

  it("doc の CHECK (col IN (…)) の値の名前の集合", async () => {
    const { pool } = await getTestClient();
    const docChecks = documentedChecks();
    const rows = await pool.query<{ table_name: string; def: string }>(
      `SELECT t.relname AS table_name, pg_get_constraintdef(c.oid) AS def
         FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
        WHERE c.contype = 'c' AND t.relnamespace = current_schema()::regnamespace
          AND t.relname = ANY($1)`,
      [[...new Set(docChecks.map((d) => d.table))]],
    );
    const tablesInDb = new Set(rows.rows.map((r) => r.table_name));
    const compared = docChecks.filter((d) => tablesInDb.has(d.table));
    expect(compared.length).toBeGreaterThan(0);
    const mismatches = compared
      .map((d) => {
        // pg_get_constraintdef は `CHECK ((status = ANY (ARRAY['active'::text, …])))` の形で返す
        const db = rows.rows
          .filter((r) => r.table_name === d.table && r.def.includes(`((${d.column} = ANY`))
          .map((r) => [...r.def.matchAll(/'([^']*)'::/g)].map((x) => x[1]!).sort());
        return { at: `${d.table}.${d.column}`, doc: d.names, db };
      })
      .filter((m) => m.db.length !== 1 || m.db[0]!.join(",") !== m.doc.join(","));
    expect(mismatches).toEqual([]);
  });

  it("`tenant_settings` の保持期間の既定は無期限（`NULL`）で、既定のまま作った行を store は無期限として返す", async () => {
    expect(MEMORY_MODEL_DOC).toMatch(/既定は無期限（`NULL`）/);
    expect(MEMORY_MODEL_DOC).toMatch(/event_retention_days\s+integer\s+NULL,\s+-- NULL = 無期限/);

    const { db, pool } = await getTestClient();
    const store = new PostgresTenantSettingsStore(db);
    // 行が無い状態は別の状態（`unset`）であり、ここでは行を既定のまま作ってから読む
    await pool.query("INSERT INTO tenant_settings (tenant_id) VALUES ($1)", [ctx.tenantId]);
    const row = await pool.query<{ event_retention_days: number | null }>(
      "SELECT event_retention_days FROM tenant_settings WHERE tenant_id = $1",
      [ctx.tenantId],
    );
    expect(row.rows[0]?.event_retention_days).toBeNull();
    expect(await store.getEventRetention(ctx)).toEqual({ kind: "unlimited" });
  });
});

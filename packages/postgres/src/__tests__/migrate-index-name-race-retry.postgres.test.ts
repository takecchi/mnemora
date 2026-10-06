import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../migrate.js";
import { requireDatabaseUrl } from "./test-db.js";

/**
 * ADR 0638: `runMigrations` は、1つのファイルが「`registerEmbeddingSpace` が同じ名前の索引を作っている最中」と重なって
 * `23505`（`pg_class_relname_nsp_index`、名前は `idx_memory_embeddings_` で始まる）で落ちたとき、そのファイルだけを
 * 1回だけ流し直す。この線を、**走った回数を数えられる migration**（sequence は rollback されない）で縛る。
 *
 * 台本: migration の本文が `nextval` を1つ進め、「n 回目までは指定の例外を `RAISE` する」。DB 上の競合そのものは
 * `vector-space-migration-index-race.postgres.test.ts` が縛る。ここは runner の線（どの例外で・何回・どこまで）だけ。
 */
const SCHEMA = "mnemora_q30_retry";
const COUNTER_PREFIX = "q30_counter_";

let pool: Pool;
let seq = 0;

interface Raise {
  constraint?: string;
  relname?: string;
  code?: string;
}

function collisionSql(raise: Raise): string {
  const code = raise.code ?? "23505";
  const constraint = raise.constraint ?? "pg_class_relname_nsp_index";
  const relname = raise.relname ?? "idx_memory_embeddings_zero_norm_q30";
  return `RAISE EXCEPTION 'duplicate key value' USING ERRCODE = '${code}', CONSTRAINT = '${constraint}', DETAIL = 'Key (relname, relnamespace)=(${relname}, 2200) already exists.';`;
}

/** 「`failTimes` 回目までは例外、以降は成功」の migration 本文。`counter` は何回流れたかの記録。 */
function scriptedMigration(counter: string, failTimes: number, raise: Raise): string {
  return `DO $$
BEGIN
  IF nextval('public.${counter}') <= ${failTimes} THEN
    ${collisionSql(raise)}
  END IF;
END $$;
CREATE TABLE ${counter}_done (id int);
`;
}

async function counterValue(counter: string): Promise<number> {
  const { rows } = await pool.query(`SELECT last_value, is_called FROM public.${counter}`);
  return rows[0].is_called ? Number(rows[0].last_value) : 0;
}

async function newCounter(): Promise<string> {
  const name = `${COUNTER_PREFIX}${++seq}`;
  await pool.query(`DROP SEQUENCE IF EXISTS public.${name}`);
  await pool.query(`CREATE SEQUENCE public.${name}`);
  return name;
}

function dirWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "mnemora-q30-"));
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  return dir;
}

async function ledger(): Promise<string[]> {
  const { rows } = await pool.query(
    `SELECT name FROM "${SCHEMA}"._mnemora_migrations ORDER BY name`,
  );
  return rows.map((r) => r.name as string);
}

async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (e) {
    return e as Error;
  }
  throw new Error("rejected されるはずだった");
}

describe("runMigrations: 索引名の競合（23505）で落ちたファイルを1回だけ流し直す（ADR 0638）", () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: requireDatabaseUrl() });
  });

  afterEach(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  });

  afterAll(async () => {
    for (let i = 1; i <= seq; i++) {
      await pool.query(`DROP SEQUENCE IF EXISTS public.${COUNTER_PREFIX}${i}`);
      await pool.query(`DROP TABLE IF EXISTS public.${COUNTER_PREFIX}${i}_done`);
    }
    await pool.end();
  });

  it("1回目が idx_memory_embeddings_ の索引名の 23505 で落ちたら、そのファイルを1回だけ流し直して通る", async () => {
    const counter = await newCounter();
    const dir = dirWith({ "0001_a.sql": scriptedMigration(counter, 1, {}) });
    const result = await runMigrations(pool, dir, { schema: SCHEMA });
    expect(result.applied).toEqual(["0001_a.sql"]);
    expect(await counterValue(counter)).toBe(2);
    expect(await ledger()).toEqual(["0001_a.sql"]);
  });

  it("流し直しは1回だけ。2回目も落ちたら、2回目のエラーを投げる（3回目は流さない・台帳に残さない）", async () => {
    const counter = await newCounter();
    const dir = dirWith({ "0001_a.sql": scriptedMigration(counter, 99, {}) });
    const err = await rejectionOf(runMigrations(pool, dir, { schema: SCHEMA }));
    expect(err.message).toContain("0001_a.sql");
    expect((err.cause as { code?: string }).code).toBe("23505");
    expect(await counterValue(counter)).toBe(2);
    expect(await ledger()).toEqual([]);
  });

  it("別の索引名（idx_memory_embeddings_ で始まらない）の 23505 は流し直さない", async () => {
    const counter = await newCounter();
    const dir = dirWith({
      "0001_a.sql": scriptedMigration(counter, 1, { relname: "idx_users_email" }),
    });
    const err = await rejectionOf(runMigrations(pool, dir, { schema: SCHEMA }));
    expect((err.cause as { code?: string }).code).toBe("23505");
    expect(await counterValue(counter)).toBe(1);
  });

  it("別の制約の 23505 は流し直さない", async () => {
    const counter = await newCounter();
    const dir = dirWith({
      "0001_a.sql": scriptedMigration(counter, 1, { constraint: "memories_pkey" }),
    });
    await rejectionOf(runMigrations(pool, dir, { schema: SCHEMA }));
    expect(await counterValue(counter)).toBe(1);
  });

  it("別の SQLSTATE（42P07）は、同じ detail でも流し直さない", async () => {
    const counter = await newCounter();
    const dir = dirWith({ "0001_a.sql": scriptedMigration(counter, 1, { code: "42P07" }) });
    const err = await rejectionOf(runMigrations(pool, dir, { schema: SCHEMA }));
    expect((err.cause as { code?: string }).code).toBe("42P07");
    expect(await counterValue(counter)).toBe(1);
  });

  it("流し直すのは落ちたファイルだけ。適用済みのファイルはもう一度流さない", async () => {
    const first = await newCounter();
    const second = await newCounter();
    const dir = dirWith({
      "0001_a.sql": scriptedMigration(first, 0, {}),
      "0002_b.sql": scriptedMigration(second, 1, {}),
    });
    const result = await runMigrations(pool, dir, { schema: SCHEMA });
    expect(result.applied).toEqual(["0001_a.sql", "0002_b.sql"]);
    expect(await counterValue(first)).toBe(1);
    expect(await counterValue(second)).toBe(2);
    expect(await ledger()).toEqual(["0001_a.sql", "0002_b.sql"]);
  });

  it("流し直しで通ったとき、applied に同じファイルが2回入らない", async () => {
    const counter = await newCounter();
    const dir = dirWith({ "0001_a.sql": scriptedMigration(counter, 1, {}) });
    const result = await runMigrations(pool, dir, { schema: SCHEMA });
    expect(result.applied.filter((f) => f === "0001_a.sql")).toHaveLength(1);
  });
});

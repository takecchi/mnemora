import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { REQUIRED_EXTENSIONS, runMigrations } from "../migrate.js";
import { PgvectorVersionUnsupportedError } from "../pgvector-capability.js";

/** 実 DB では作れない「能力が無い」側（pgvector 0.8 未満）の経路、つまり検査が失敗したとき、握り潰されず、かつロックを持つ接続を中断したトランザクションのまま返さないことを、DB 無しで縛る。 */

const CAPABLE = { extversion: "0.8.0", vartype: "enum", enumvals: ["off", "relaxed_order"] };

function oneFileDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mnemora-capability-search-path-"));
  writeFileSync(join(dir, "0001_noop.sql"), "SELECT 1;\n");
  return dir;
}

function createFakePool(
  capabilityRow: typeof CAPABLE | null,
  options: { rollbackFails?: boolean } = {},
): {
  pool: Pool;
  log: string[];
  released: { count: number };
} {
  const log: string[] = [];
  const released = { count: 0 };
  const respond = (text: string): { rows: unknown[] } => {
    if (/FROM pg_extension WHERE extname/.test(text)) {
      return { rows: REQUIRED_EXTENSIONS.map((extname) => ({ extname })) };
    }
    if (text.includes("pg_settings")) {
      return { rows: capabilityRow === null ? [] : [capabilityRow] };
    }
    return { rows: [] };
  };
  const client = {
    query: async (text: string) => {
      log.push(text.includes("pg_settings") ? "PROBE" : text.trim());
      if (options.rollbackFails === true && text.trim() === "ROLLBACK") {
        throw new Error("ROLLBACK 自体の失敗（接続断など）");
      }
      return respond(text);
    },
    release: () => {
      released.count += 1;
      log.push("RELEASE");
    },
    on: () => client,
    removeListener: () => client,
  };
  const pool = {
    query: async (text: string) => {
      log.push(`pool: ${text.includes("pg_settings") ? "PROBE" : text.trim()}`);
      return respond(text);
    },
    connect: async () => client,
  };
  return { pool: pool as unknown as Pool, log, released };
}

const SET_PATH = 'SET LOCAL search_path TO "app_x","ext_x"';
const OPTIONS = { schema: "app_x", extensionSchema: "ext_x" } as const;

describe("runMigrations: 能力検査を囲む search_path（Issue #1780、DB 無し）", () => {
  it("create + schema/extensionSchema: 検査は BEGIN → SET LOCAL search_path → 検査 → COMMIT の順で流れる", async () => {
    const { pool, log } = createFakePool(CAPABLE);

    await runMigrations(pool, oneFileDir(), OPTIONS);

    const probe = log.lastIndexOf("PROBE");
    expect(probe).toBeGreaterThan(0);
    expect(log.slice(probe - 2, probe + 2)).toEqual(["BEGIN", SET_PATH, "PROBE", "COMMIT"]);
  });

  it("create + 能力が無い: PgvectorVersionUnsupportedError を投げ、ROLLBACK してからロックを返す（COMMIT しない・中断したトランザクションを残さない）", async () => {
    const { pool, log } = createFakePool(null);

    const err = await runMigrations(pool, oneFileDir(), OPTIONS).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PgvectorVersionUnsupportedError);
    const probe = log.lastIndexOf("PROBE");
    expect(log.slice(probe - 2, probe + 2)).toEqual(["BEGIN", SET_PATH, "PROBE", "ROLLBACK"]);
    const after = log.slice(probe + 1);
    expect(after).not.toContain("COMMIT");
    expect(after[0]).toBe("ROLLBACK");
    expect(after.some((q) => /pg_advisory_unlock/.test(q))).toBe(true);
    expect(after.indexOf("ROLLBACK")).toBeLessThan(
      after.findIndex((q) => /pg_advisory_unlock/.test(q)),
    );
  });

  it("verify + schema/extensionSchema + 能力が無い: 借りた接続で ROLLBACK し、接続を返し、ロックには進まない", async () => {
    const { pool, log, released } = createFakePool(null);

    const err = await runMigrations(pool, oneFileDir(), {
      ...OPTIONS,
      extensionMode: "verify",
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PgvectorVersionUnsupportedError);
    expect(log.slice(log.indexOf("BEGIN"))).toEqual([
      "BEGIN",
      SET_PATH,
      "PROBE",
      "ROLLBACK",
      "RELEASE",
    ]);
    expect(released.count).toBe(1);
  });

  it("verify + schema/extensionSchema + 能力が在る: BEGIN → SET LOCAL → 検査 → COMMIT で、接続を返す", async () => {
    const { pool, log } = createFakePool(CAPABLE);

    await runMigrations(pool, oneFileDir(), { ...OPTIONS, extensionMode: "verify" });

    const begin = log.indexOf("BEGIN");
    expect(log.slice(begin, begin + 5)).toEqual(["BEGIN", SET_PATH, "PROBE", "COMMIT", "RELEASE"]);
  });

  it.each(["create", "verify"] as const)(
    "%s + 能力が無い + ROLLBACK も失敗: ROLLBACK の失敗で元の PgvectorVersionUnsupportedError を上書きしない",
    async (extensionMode) => {
      const { pool } = createFakePool(null, { rollbackFails: true });

      const err = await runMigrations(pool, oneFileDir(), { ...OPTIONS, extensionMode }).catch(
        (e: unknown) => e,
      );

      expect(err).toBeInstanceOf(PgvectorVersionUnsupportedError);
    },
  );
});

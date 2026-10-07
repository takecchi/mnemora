import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { isEmbeddingSpaceIndexNameCollision } from "../create-index-race.js";
import { REQUIRED_EXTENSIONS, runMigrations } from "../migrate.js";

// 実 DB では作りにくい条件なので、DB 無しで縛る。

const SQL = "SELECT 'race-probe';";

function collisionError(): Error {
  return Object.assign(new Error("duplicate key"), {
    code: "23505",
    constraint: "pg_class_relname_nsp_index",
    detail: "Key (relname, relnamespace)=(idx_memory_embeddings_x_memory_id, 2200) already exists.",
  });
}

function fakePool(rollbackFails: boolean): { pool: Pool; migrationRuns: { count: number } } {
  const migrationRuns = { count: 0 };
  const query = async (text: string): Promise<{ rows: unknown[] }> => {
    const t = text.trim();
    if (/FROM pg_extension WHERE extname/.test(t)) {
      return { rows: REQUIRED_EXTENSIONS.map((extname) => ({ extname })) };
    }
    if (t.includes("pg_settings")) {
      return {
        rows: [{ extversion: "0.8.0", vartype: "enum", enumvals: ["off", "relaxed_order"] }],
      };
    }
    if (t === SQL) {
      migrationRuns.count += 1;
      throw collisionError();
    }
    if (t === "ROLLBACK" && rollbackFails) {
      throw new Error("ROLLBACK 自体の失敗（接続断など）");
    }
    return { rows: [] };
  };
  const client = { query, release: () => {}, on: () => client, removeListener: () => client };
  const pool = { query, connect: async () => client };
  return { pool: pool as unknown as Pool, migrationRuns };
}

function oneFileDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mnemora-index-race-rollback-"));
  writeFileSync(join(dir, "0001_race.sql"), `${SQL}\n`);
  return dir;
}

describe("runMigrations: 索引名の競合の流し直しは ROLLBACK が通ったときだけ（ADR 0638、DB 無し）", () => {
  it("陽性対照: ROLLBACK が通るなら1回だけ流し直す（計2回流れ、2回目のエラーで落ちる）", async () => {
    const { pool, migrationRuns } = fakePool(false);

    await expect(runMigrations(pool, oneFileDir())).rejects.toThrow(/0001_race\.sql/);

    expect(migrationRuns.count).toBe(2);
  });

  it("ROLLBACK が失敗したら流し直さない（1回だけ流れ、元の失敗で落ちる）", async () => {
    const { pool, migrationRuns } = fakePool(true);

    await expect(runMigrations(pool, oneFileDir())).rejects.toThrow(/0001_race\.sql/);

    expect(migrationRuns.count).toBe(1);
  });
});

describe("isEmbeddingSpaceIndexNameCollision: 接頭辞を確かめられない入力は false", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["Error（code なし）", new Error("x")],
    [
      "detail なし",
      Object.assign(new Error("x"), { code: "23505", constraint: "pg_class_relname_nsp_index" }),
    ],
    [
      "detail が文字列でない",
      Object.assign(new Error("x"), {
        code: "23505",
        constraint: "pg_class_relname_nsp_index",
        detail: 123,
      }),
    ],
  ])("%s", (_label, error) => {
    expect(isEmbeddingSpaceIndexNameCollision(error)).toBe(false);
  });

  it("陽性対照: 23505・pg_class_relname_nsp_index・idx_memory_embeddings_ の名前なら true", () => {
    expect(isEmbeddingSpaceIndexNameCollision(collisionError())).toBe(true);
  });
});

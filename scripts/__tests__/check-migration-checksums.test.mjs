import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  MANIFEST_RELATIVE_PATH,
  MIGRATIONS_RELATIVE_DIR,
  appendUnpinned,
  checksumOfMigrationText,
  compareChecksums,
  computeChecksums,
  parseManifest,
} from "../migration-checksums-lib.mjs";

/**
 * ⭐ **この歯が測っているもの**（ADR 0637）
 *
 * 出荷済みの `packages/postgres/migrations/*.sql` が、名簿
 * （`packages/postgres/migration-checksums.json`）の checksum と一致すること。
 * 台帳はファイル名だけで適用済みを判定するので、適用済みの編集は黙ってずれる。
 *
 * 赤にするもの: 書き換え・削除・名簿が読めない。
 * 赤にしないもの: 新しい migration の追加、改行（CRLF）と BOM の違いだけ。
 *
 * ⚠ 名簿に載っていない新しいファイルは固定されない（出すときに `--write` で足す運用）。
 * 足し忘れた間は、そのファイルの編集は見えない。
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const cli = join(repoRoot, "scripts/check-migration-checksums.mjs");
const tmpRoots = [];

afterAll(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
});

function runCli(root, ...extra) {
  return spawnSync(process.execPath, [cli, "--root", root, ...extra], { encoding: "utf8" });
}

/** 本物の migrations と名簿を、使い捨ての root にコピーする（本物は触らない）。 */
function copyRepoFixture() {
  const root = mkdtempSync(join(tmpdir(), "mig-checksum-"));
  tmpRoots.push(root);
  mkdirSync(join(root, "packages/postgres"), { recursive: true });
  cpSync(join(repoRoot, MIGRATIONS_RELATIVE_DIR), join(root, MIGRATIONS_RELATIVE_DIR), {
    recursive: true,
  });
  cpSync(join(repoRoot, MANIFEST_RELATIVE_PATH), join(root, MANIFEST_RELATIVE_PATH));
  return root;
}

describe("本物のリポジトリ（これが CI の門）", () => {
  it("🔴 出荷済みの migration はすべて名簿と一致する", () => {
    const result = runCli(repoRoot);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("名簿は、0027 を含む既存の migration を載せている", () => {
    const pinned = parseManifest(readFileSync(join(repoRoot, MANIFEST_RELATIVE_PATH), "utf8"));
    expect(Object.keys(pinned)).toContain("0027_erase_tenant_fk_indexes.sql");
    expect(Object.keys(pinned)).toContain("0001_init.sql");
  });
});

describe("門が噛む（使い捨ての複製に対して）", () => {
  it("🔴 既存の migration を1文字変えると赤になり、ファイル名が出る", () => {
    const root = copyRepoFixture();
    const file = join(root, MIGRATIONS_RELATIVE_DIR, "0027_erase_tenant_fk_indexes.sql");
    writeFileSync(file, `${readFileSync(file, "utf8")}x`);
    const result = runCli(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("0027_erase_tenant_fk_indexes.sql");
  });

  it("🔴 既存の migration を消すと赤になる", () => {
    const root = copyRepoFixture();
    rmSync(join(root, MIGRATIONS_RELATIVE_DIR, "0005_analyze_memories.sql"));
    const result = runCli(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("0005_analyze_memories.sql");
  });

  it("🔴 名簿が無いと、緑にせず exit 2 で止まる", () => {
    const root = copyRepoFixture();
    rmSync(join(root, MANIFEST_RELATIVE_PATH));
    expect(runCli(root).status).toBe(2);
  });

  it("🔴 名簿が壊れていても、空として通さず exit 2 で止まる", () => {
    const root = copyRepoFixture();
    writeFileSync(join(root, MANIFEST_RELATIVE_PATH), "{}");
    expect(runCli(root).status).toBe(2);
  });

  it("🔴 --write は、書き換えられたファイルに名簿を追従させない", () => {
    const root = copyRepoFixture();
    const file = join(root, MIGRATIONS_RELATIVE_DIR, "0001_init.sql");
    writeFileSync(file, `${readFileSync(file, "utf8")}-- x\n`);
    const before = readFileSync(join(root, MANIFEST_RELATIVE_PATH), "utf8");
    expect(runCli(root, "--write").status).toBe(1);
    expect(readFileSync(join(root, MANIFEST_RELATIVE_PATH), "utf8")).toBe(before);
  });
});

describe("やりすぎない（赤にしてはいけないもの）", () => {
  it("新しい番号の migration を足しても赤にならない（名簿に無いと知らせるだけ）", () => {
    const root = copyRepoFixture();
    writeFileSync(join(root, MIGRATIONS_RELATIVE_DIR, "9999_new.sql"), "SELECT 1;\n");
    const result = runCli(root);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("9999_new.sql");
  });

  it("--write は新しいファイルだけを足し、既存の行は1文字も変えない", () => {
    const root = copyRepoFixture();
    writeFileSync(join(root, MIGRATIONS_RELATIVE_DIR, "9999_new.sql"), "SELECT 1;\n");
    const before = parseManifest(readFileSync(join(root, MANIFEST_RELATIVE_PATH), "utf8"));
    expect(runCli(root, "--write").status).toBe(0);
    const after = parseManifest(readFileSync(join(root, MANIFEST_RELATIVE_PATH), "utf8"));
    expect(after["9999_new.sql"]).toMatch(/^[0-9a-f]{64}$/);
    for (const [name, sum] of Object.entries(before)) expect(after[name]).toBe(sum);
    expect(runCli(root).status).toBe(0);
  });

  it("改行を CRLF にしただけでは赤にならない", () => {
    const root = copyRepoFixture();
    const file = join(root, MIGRATIONS_RELATIVE_DIR, "0027_erase_tenant_fk_indexes.sql");
    writeFileSync(file, readFileSync(file, "utf8").replace(/\n/g, "\r\n"));
    expect(runCli(root).status).toBe(0);
  });

  it("先頭に BOM が付いただけでは赤にならない", () => {
    const root = copyRepoFixture();
    const file = join(root, MIGRATIONS_RELATIVE_DIR, "0001_init.sql");
    writeFileSync(file, String.fromCharCode(0xfeff) + readFileSync(file, "utf8"));
    expect(runCli(root).status).toBe(0);
  });

  it("コメントだけの変更は赤になる（正規化は改行と BOM だけ）", () => {
    expect(checksumOfMigrationText("SELECT 1;\n")).not.toBe(
      checksumOfMigrationText("-- c\nSELECT 1;\n"),
    );
    expect(checksumOfMigrationText("SELECT 1; \n")).not.toBe(
      checksumOfMigrationText("SELECT 1;\n"),
    );
  });
});

describe("部品", () => {
  it("compareChecksums: changed / missing / unpinned を分ける", () => {
    expect(compareChecksums({ a: "1", b: "2", c: "3" }, { a: "1", b: "x", d: "4" })).toEqual({
      changed: ["b"],
      missing: ["c"],
      unpinned: ["d"],
    });
  });

  it("appendUnpinned: 既存の値を上書きしない", () => {
    const sum = "a".repeat(64);
    const other = "b".repeat(64);
    const out = JSON.parse(appendUnpinned({ x: sum }, { x: other, y: other }));
    expect(out.files).toEqual({ x: sum, y: other });
  });

  it("computeChecksums は .sql だけを数える", () => {
    const dir = mkdtempSync(join(tmpdir(), "mig-checksum-lib-"));
    tmpRoots.push(dir);
    writeFileSync(join(dir, "0001_a.sql"), "SELECT 1;");
    writeFileSync(join(dir, "README.md"), "x");
    expect(Object.keys(computeChecksums(dir))).toEqual(["0001_a.sql"]);
  });
});

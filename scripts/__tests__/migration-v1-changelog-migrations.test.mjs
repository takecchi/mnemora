import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const MIGRATION_NAME = /\b\d{4}_[a-z0-9_]+\.sql\b/g;

function unreleasedSections(changelog) {
  const out = [];
  let inside = false;
  for (const line of changelog.split("\n")) {
    if (/^##\s+\[/.test(line)) inside = line.includes("未リリース");
    else if (inside) out.push(line);
  }
  return out.join("\n");
}

function migrationNames(text) {
  return [...new Set(text.match(MIGRATION_NAME) ?? [])].sort();
}

function missingFrom(names, doc) {
  return names.filter((n) => !doc.includes(n));
}

function missingMigrationFiles(names, dir) {
  return names.filter((n) => !existsSync(`${dir}/${n}`));
}

describe("🔴 CHANGELOG 未リリース節が名指した migration は migration-v1.md にも在る", () => {
  it("部品: 実在の検査は、無い名前だけを返す（合成の名前と一時ディレクトリ。実データが空でも赤・緑を見られる）", () => {
    const dir = mkdtempSync(join(tmpdir(), "migration-names-"));
    try {
      writeFileSync(join(dir, "0100_a_b.sql"), "");
      expect(missingMigrationFiles(["0100_a_b.sql"], dir)).toEqual([]);
      expect(missingMigrationFiles(["0100_a_b.sql", "0101_typo.sql"], dir)).toEqual([
        "0101_typo.sql",
      ]);
      expect(missingMigrationFiles([], dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("部品: 未リリース節だけを切り出し、ファイル名を拾い、欠けを返す", () => {
    const cl = [
      "## [2.0.0] - 未リリース",
      "新 `0100_a_b.sql` と `0101_c.sql`",
      "## [1.9.0] - 2026-01-01",
      "古い `0001_old.sql`",
    ].join("\n");
    const names = migrationNames(unreleasedSections(cl));
    expect(names).toEqual(["0100_a_b.sql", "0101_c.sql"]);
    expect(missingFrom(names, "…0100_a_b.sql…")).toEqual(["0101_c.sql"]);
  });

  const changelog = readFileSync(`${repoRoot}/CHANGELOG.md`, "utf8");
  const doc = readFileSync(`${repoRoot}/docs/migration-v1.md`, "utf8");
  const names = migrationNames(unreleasedSections(changelog));

  it("未リリース節が在る（節の見出しの形が変わって、歯が誰にも当たらなくなっていない）", () => {
    expect(changelog.split("\n").some((l) => /^##\s+\[/.test(l) && l.includes("未リリース"))).toBe(
      true,
    );
  });

  it("⭐ 名指された migration はすべて migration-v1.md に書かれている", () => {
    expect(
      missingFrom(names, doc),
      "CHANGELOG の未リリース節が名指した migration が、docs/migration-v1.md に無い。" +
        "その文書の未リリースの節（「DB マイグレーション」）に、何を作り・適用中に何が止まるかを足すこと。",
    ).toEqual([]);
  });

  it("名指された migration は packages/postgres/migrations に実在する（綴りの取り違えの検出）", () => {
    expect(missingMigrationFiles(names, `${repoRoot}/packages/postgres/migrations`)).toEqual([]);
  });
});

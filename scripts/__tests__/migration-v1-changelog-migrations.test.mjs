import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * ⭐ **この歯が測っているもの（消す前に読むこと）**
 *
 * **`CHANGELOG.md` の未リリース節が名指しした migration ファイルが、`docs/migration-v1.md`
 * にも書かれていること。**
 *
 * 🔴 **なぜ要るか**
 *
 * `docs/migration-v1.md` の「DB マイグレーション」は、DB を更新する利用者が「何本当てることに
 * なるか・適用中に何が止まるか」を読む場所であり、CHANGELOG の項目はそこへ案内する。
 * ところが両者を突き合わせる歯が無く、`0029`・`0030` は CHANGELOG にだけ書かれて
 * migration-v1.md から抜けたまま出荷されかけた（`mnemora-postgres-migrate` は台帳をファイル名で
 * 見るので動作は壊れず、文書の正確さだけが黙って崩れる）。
 *
 * 🔴 **数や版を持たない**（`AGENTS.md`「⚠ 数を、道具と生成物に焼き込まない」）。
 * 「未リリース節」は CHANGELOG の見出しに `未リリース` を含む節として、その場で引く。
 * tag も、migration の本数も、ファイル名も、この歯には書いていない。
 *
 * 🔴 **この歯が捕まえないもの:**
 * - **CHANGELOG が migration を名指ししていない**ときは見えない（ファイルが増えたのに
 *   CHANGELOG が黙っている、という逆向きは、tag との差が要るので測っていない）。
 * - migration-v1.md の**どの節に**書かれているかは見ていない（ファイル全体に現れればよい）。
 *   **本数の文言**（「N本」）も見ていない。
 * - 出荷済みの節が名指した migration は対象外（未リリース節だけを見る）。
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const MIGRATION_NAME = /\b\d{4}_[a-z0-9_]+\.sql\b/g;

/** 見出しに `未リリース` を含む `## [` 節の本文を、すべて連結して返す。 */
function unreleasedSections(changelog) {
  const out = [];
  let inside = false;
  for (const line of changelog.split("\n")) {
    if (/^##\s+\[/.test(line)) inside = line.includes("未リリース");
    else if (inside) out.push(line);
  }
  return out.join("\n");
}

/** テキストに現れる migration ファイル名（重複なし）。 */
function migrationNames(text) {
  return [...new Set(text.match(MIGRATION_NAME) ?? [])].sort();
}

/** `names` のうち `doc` に現れないもの。 */
function missingFrom(names, doc) {
  return names.filter((n) => !doc.includes(n));
}

describe("🔴 CHANGELOG 未リリース節が名指した migration は migration-v1.md にも在る", () => {
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
    expect(
      names.filter((n) => !existsSync(`${repoRoot}/packages/postgres/migrations/${n}`)),
    ).toEqual([]);
  });
});

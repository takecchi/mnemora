import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  deriveAdvisoryLockKeys,
  deriveEmbeddingSpaceNaming,
  deriveMigrationObjects,
  parseReadmeObjectsSection,
} from "../readme-postgres-objects-lib.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const postgresDir = `${repoRoot}/packages/postgres`;
const migrationsDir = `${postgresDir}/migrations`;

function readMigrationTextsInFileOrder() {
  const fileNames = readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  expect(fileNames.length, "packages/postgres/migrations/*.sql が1つも無い").toBeGreaterThan(0);
  return fileNames.map((name) => readFileSync(`${migrationsDir}/${name}`, "utf8"));
}

const readmeText = readFileSync(`${postgresDir}/README.md`, "utf8");
const readmeObjects = parseReadmeObjectsSection(readmeText);
const migrationObjects = deriveMigrationObjects(readMigrationTextsInFileOrder());
const embeddingNaming = deriveEmbeddingSpaceNaming(
  readFileSync(`${postgresDir}/src/embedding-space-table.ts`, "utf8"),
);
const advisoryLockKeys = deriveAdvisoryLockKeys({
  migrateSourceText: readFileSync(`${postgresDir}/src/migrate.ts`, "utf8"),
  vectorSpaceSourceText: readFileSync(`${postgresDir}/src/vector-space.ts`, "utf8"),
});

function diffSets(derived, documented) {
  const derivedSet = new Set(derived);
  const documentedSet = new Set(documented);
  const missing = derived.filter((name) => !documentedSet.has(name));
  const extra = documented.filter((name) => !derivedSet.has(name));
  return { missing, extra };
}

describe("packages/postgres/README.md の「この package が作るオブジェクト」節（Issue #168）", () => {
  it("節そのものが存在する", () => {
    expect(readmeText).toMatch(/この package が作るオブジェクト/);
  });

  it("テーブル一覧が migrations/*.sql の最終形と一致する（過不足なし）", () => {
    const { missing, extra } = diffSets(migrationObjects.tables, readmeObjects.tables);
    expect(
      { missing, extra },
      `README に無いテーブル: ${JSON.stringify(missing)} / README にしか無い（実在しない）テーブル: ${JSON.stringify(extra)}`,
    ).toEqual({ missing: [], extra: [] });
  });

  it("索引一覧が migrations/*.sql の最終形と一致する（過不足なし。DROP された索引は数えない）", () => {
    const { missing, extra } = diffSets(migrationObjects.indexes, readmeObjects.indexes);
    expect(
      { missing, extra },
      `README に無い索引: ${JSON.stringify(missing)} / README にしか無い（実在しない）索引: ${JSON.stringify(extra)}`,
    ).toEqual({ missing: [], extra: [] });
  });

  it("テーブル見出しの件数表記が実際の本数と一致する", () => {
    expect(readmeObjects.tableHeadingCount).toBe(migrationObjects.tables.length);
  });

  it("索引見出しの件数表記が実際の本数と一致する", () => {
    expect(readmeObjects.indexHeadingCount).toBe(migrationObjects.indexes.length);
  });

  it("関数一覧が migrations/*.sql の最終形と一致する（過不足なし。DROP された関数は数えない）", () => {
    const { missing, extra } = diffSets(migrationObjects.functions, readmeObjects.functions);
    expect(
      { missing, extra },
      `README に無い関数: ${JSON.stringify(missing)} / README にしか無い（実在しない）関数: ${JSON.stringify(extra)}`,
    ).toEqual({ missing: [], extra: [] });
  });

  it("関数見出しの件数表記が実際の本数と一致する", () => {
    expect(readmeObjects.functionHeadingCount).toBe(migrationObjects.functions.length);
  });

  it("埋め込み空間ごとのテーブル名の接頭辞が embedding-space-table.ts の TABLE_PREFIX と一致する", () => {
    expect(
      readmeObjects.embeddingTablePattern,
      "README にテーブル名パターンの記載が無い",
    ).toBeDefined();
    expect(readmeObjects.embeddingTablePattern.startsWith(embeddingNaming.tablePrefix)).toBe(true);
  });

  it("埋め込み空間ごとの HNSW 索引名の接頭辞が embedding-space-table.ts の HNSW_INDEX_PREFIX と一致する", () => {
    expect(
      readmeObjects.embeddingIndexPattern,
      "README に索引名パターンの記載が無い",
    ).toBeDefined();
    expect(readmeObjects.embeddingIndexPattern.startsWith(embeddingNaming.indexPrefix)).toBe(true);
  });

  it("埋め込み空間ごとのゼロベクトル用部分索引名の接頭辞が embedding-space-table.ts の ZERO_NORM_INDEX_PREFIX と一致する（Issue #956 / ADR 0343）", () => {
    expect(
      readmeObjects.embeddingZeroNormIndexPattern,
      "README にゼロベクトル用部分索引名パターンの記載が無い",
    ).toBeDefined();
    expect(
      readmeObjects.embeddingZeroNormIndexPattern.startsWith(embeddingNaming.zeroNormIndexPrefix),
    ).toBe(true);
  });

  it("runMigrations の既定 advisory lock キー（MIGRATION_LOCK_KEY）が README に書いてある", () => {
    expect(readmeObjects.advisoryLockKeys).toContain(advisoryLockKeys.migrationLockKey);
  });

  it("registerEmbeddingSpace の既定 advisory lock キー（REGISTER_EMBEDDING_SPACE_LOCK_KEY）が README に書いてある", () => {
    expect(readmeObjects.advisoryLockKeys).toContain(
      advisoryLockKeys.registerEmbeddingSpaceLockKey,
    );
  });

  it("--schema 指定時のキー導出シード（runMigrations 側）の接頭辞が README に書いてある", () => {
    expect(readmeObjects.advisoryLockSeedPrefixes).toContain(
      advisoryLockKeys.migrationLockSeedPrefix,
    );
  });

  it("--schema 指定時のキー導出シード（registerEmbeddingSpace 側）の接頭辞が README に書いてある", () => {
    expect(readmeObjects.advisoryLockSeedPrefixes).toContain(
      advisoryLockKeys.registerEmbeddingSpaceLockSeedPrefix,
    );
  });

  it("関数の一覧が空でない（対象に含めたことの回帰止め。0件のまま過不足なしを主張しない）", () => {
    expect(migrationObjects.functions.length).toBeGreaterThan(0);
    expect(readmeObjects.functions.length).toBeGreaterThan(0);
  });
});

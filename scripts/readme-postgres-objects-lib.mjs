/**
 * 全移行ファイルを結合し、ファイル名順・出現順に1回だけ走査して `CREATE` / `DROP` を順に適用した
 * 「最終的に生き残っている集合」を導く。素朴に `CREATE INDEX` の出現回数を数えると、後の移行で
 * 落とされたものを二重に数える。
 *
 * ⚠ 関数の引数シグネチャは見ない。`CREATE OR REPLACE FUNCTION` で同名を別シグネチャに
 * 置き換えても気づかない(ADR 0204)。
 *
 * 動的 DDL(`EXECUTE format('CREATE INDEX IF NOT EXISTS %I ...')`)の文字列リテラルの中の
 * `CREATE INDEX` を静的な宣言と誤認すると、`IF NOT EXISTS` を呑み込まない側へバックトラックして
 * `IF` という語が索引名として捕捉される。そのため各捕捉グループの前に SQL 予約語の否定先読み
 * (`RESERVED_WORD_LOOKAHEAD`)を挟んでいる(ADR 0343)。
 *
 * `--` 行コメントもブロックコメントも、剥がしてから走査する。
 */

/**
 * 正規表現だけの簡易実装。この repo の migrations は `--` が文字列リテラルの中に現れない前提。
 *
 * @param {string} sqlText
 * @returns {string}
 */
export function stripSqlLineComments(sqlText) {
  return sqlText
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

/**
 * 正規表現だけの簡易実装。この repo の migrations はブロックコメントの区切りが文字列リテラルの中に現れない前提。
 *
 * @param {string} sqlText
 * @returns {string}
 */
export function stripSqlBlockComments(sqlText) {
  return sqlText.replace(/\/\*[\s\S]*?\*\//g, "");
}

const RESERVED_WORD_LOOKAHEAD = "(?!(?:IF|NOT|EXISTS|CONCURRENTLY|OR|REPLACE)\\b)";

const STATEMENT_RE = new RegExp(
  `CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${RESERVED_WORD_LOOKAHEAD}(?<createTable>[a-zA-Z_][a-zA-Z0-9_]*)` +
    `|DROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?${RESERVED_WORD_LOOKAHEAD}(?<dropTable>[a-zA-Z_][a-zA-Z0-9_]*)` +
    `|CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:CONCURRENTLY\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?${RESERVED_WORD_LOOKAHEAD}(?<createIndex>[a-zA-Z_][a-zA-Z0-9_]*)` +
    `|DROP\\s+INDEX\\s+(?:CONCURRENTLY\\s+)?(?:IF\\s+EXISTS\\s+)?${RESERVED_WORD_LOOKAHEAD}(?<dropIndex>[a-zA-Z_][a-zA-Z0-9_]*)` +
    `|CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+${RESERVED_WORD_LOOKAHEAD}(?<createFunction>[a-zA-Z_][a-zA-Z0-9_]*)\\s*\\(` +
    `|DROP\\s+FUNCTION\\s+(?:IF\\s+EXISTS\\s+)?${RESERVED_WORD_LOOKAHEAD}(?<dropFunction>[a-zA-Z_][a-zA-Z0-9_]*)`,
  "gi",
);

/**
 * 呼び出し側がファイル名順に並べてから渡すこと。
 *
 * @param {string[]} migrationTextsInFileOrder
 * @returns {{ tables: string[], indexes: string[], functions: string[] }} 最終的に生き残っている名前の集合（各々ソート済み・重複無し）
 */
export function deriveMigrationObjects(migrationTextsInFileOrder) {
  const combined = migrationTextsInFileOrder
    .map(stripSqlLineComments)
    .map(stripSqlBlockComments)
    .join("\n");
  /** @type {Set<string>} */
  const tables = new Set();
  /** @type {Set<string>} */
  const indexes = new Set();
  /** @type {Set<string>} */
  const functions = new Set();

  for (const match of combined.matchAll(STATEMENT_RE)) {
    const groups = /** @type {Record<string, string | undefined>} */ (match.groups ?? {});
    if (groups.createTable) {
      tables.add(groups.createTable);
    } else if (groups.dropTable) {
      tables.delete(groups.dropTable);
    } else if (groups.createIndex) {
      indexes.add(groups.createIndex);
    } else if (groups.dropIndex) {
      indexes.delete(groups.dropIndex);
    } else if (groups.createFunction) {
      functions.add(groups.createFunction);
    } else if (groups.dropFunction) {
      functions.delete(groups.dropFunction);
    }
  }

  return {
    tables: [...tables].sort(),
    indexes: [...indexes].sort(),
    functions: [...functions].sort(),
  };
}

/**
 * @param {string} embeddingSpaceTableSourceText
 * @returns {{ tablePrefix: string, indexPrefix: string, zeroNormIndexPrefix: string }}
 */
export function deriveEmbeddingSpaceNaming(embeddingSpaceTableSourceText) {
  const tableMatch = /const TABLE_PREFIX = "([^"]+)";/.exec(embeddingSpaceTableSourceText);
  const indexMatch = /const HNSW_INDEX_PREFIX = "([^"]+)";/.exec(embeddingSpaceTableSourceText);
  const zeroNormIndexMatch = /const ZERO_NORM_INDEX_PREFIX = "([^"]+)";/.exec(
    embeddingSpaceTableSourceText,
  );
  if (!tableMatch || !indexMatch || !zeroNormIndexMatch) {
    throw new Error(
      "embedding-space-table.ts から TABLE_PREFIX / HNSW_INDEX_PREFIX / " +
        "ZERO_NORM_INDEX_PREFIX を読み取れなかった。" +
        "定数名か書き方が変わった——この歯の正規表現を直すこと（歯を消さないこと）。",
    );
  }
  return {
    tablePrefix: tableMatch[1],
    indexPrefix: indexMatch[1],
    zeroNormIndexPrefix: zeroNormIndexMatch[1],
  };
}

/**
 * @param {{ migrateSourceText: string, vectorSpaceSourceText: string }} sources
 * @returns {{
 *   migrationLockKey: string,
 *   registerEmbeddingSpaceLockKey: string,
 *   migrationLockSeedPrefix: string,
 *   registerEmbeddingSpaceLockSeedPrefix: string,
 * }}
 */
export function deriveAdvisoryLockKeys({ migrateSourceText, vectorSpaceSourceText }) {
  const migrationKeyMatch = /export const MIGRATION_LOCK_KEY = (-?\d+)n;/.exec(migrateSourceText);
  const registerKeyMatch = /export const REGISTER_EMBEDDING_SPACE_LOCK_KEY = (-?\d+)n;/.exec(
    vectorSpaceSourceText,
  );
  const migrationSeedMatch =
    /deriveAdvisoryLockKey\(`(mnemora:runMigrations:advisory-lock:)\$\{schema\}`\)/.exec(
      migrateSourceText,
    );
  const registerSeedMatch =
    /deriveAdvisoryLockKey\(`(mnemora:registerEmbeddingSpace:advisory-lock:)\$\{schema\}`\)/.exec(
      vectorSpaceSourceText,
    );
  if (!migrationKeyMatch || !registerKeyMatch || !migrationSeedMatch || !registerSeedMatch) {
    throw new Error(
      "migrate.ts / vector-space.ts から advisory lock キーの定数・シード文字列を読み取れなかった。" +
        "定数名か書き方が変わった——この歯の正規表現を直すこと（歯を消さないこと）。",
    );
  }
  return {
    migrationLockKey: migrationKeyMatch[1],
    registerEmbeddingSpaceLockKey: registerKeyMatch[1],
    migrationLockSeedPrefix: migrationSeedMatch[1],
    registerEmbeddingSpaceLockSeedPrefix: registerSeedMatch[1],
  };
}

/**
 * @param {string} markdownText
 * @param {string} headingLabel 見出し文字列の先頭一致（例: "テーブル"。"テーブル（8）" にも一致する）
 * @returns {string | undefined}
 */
export function extractMarkdownSection(markdownText, headingLabel) {
  const lines = markdownText.split("\n");
  const startIdx = lines.findIndex((line) => {
    const matched = /^### (.+)$/.exec(line);
    return matched !== null && matched[1].startsWith(headingLabel);
  });
  if (startIdx === -1) {
    return undefined;
  }
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i += 1) {
    if (/^#{2,3} /.test(lines[i])) {
      endIdx = i;
      break;
    }
  }
  return lines.slice(startIdx, endIdx).join("\n");
}

/**
 * @param {string} markdownText
 * @param {string} headingLabel
 * @returns {number | undefined}
 */
export function extractHeadingCount(markdownText, headingLabel) {
  const lines = markdownText.split("\n");
  for (const line of lines) {
    const matched = /^### (.+)$/.exec(line);
    if (matched !== null && matched[1].startsWith(headingLabel)) {
      const countMatch = /[（(](\d+)[）)]/.exec(matched[1]);
      return countMatch ? Number(countMatch[1]) : undefined;
    }
  }
  return undefined;
}

/**
 * 行頭が箇条書きの行だけを対象にする。節中の説明文にある他の識別子への言及を巻き込まないため。
 *
 * @param {string} sectionText
 * @returns {string[]} 出現順（重複はそのまま残す。呼び出し側で必要なら dedupe すること）
 */
export function extractBulletedIdentifiers(sectionText) {
  const names = [];
  for (const rawLine of sectionText.split("\n")) {
    const line = rawLine.trim();
    const matched = /^-\s+`([a-zA-Z_][a-zA-Z0-9_]*)`/.exec(line);
    if (matched) {
      names.push(matched[1]);
    }
  }
  return names;
}

/**
 * @param {string} readmeText
 * @returns {{
 *   tables: string[],
 *   indexes: string[],
 *   functions: string[],
 *   tableHeadingCount: number | undefined,
 *   indexHeadingCount: number | undefined,
 *   functionHeadingCount: number | undefined,
 *   embeddingTablePattern: string | undefined,
 *   embeddingIndexPattern: string | undefined,
 *   embeddingZeroNormIndexPattern: string | undefined,
 *   advisoryLockKeys: string[],
 *   advisoryLockSeedPrefixes: string[],
 * }}
 */
export function parseReadmeObjectsSection(readmeText) {
  const tableSection = extractMarkdownSection(readmeText, "テーブル");
  const indexSection = extractMarkdownSection(readmeText, "索引");
  const functionSection = extractMarkdownSection(readmeText, "関数");
  const embeddingSection = extractMarkdownSection(readmeText, "実行時に増える系列");
  const advisorySection = extractMarkdownSection(readmeText, "advisory lock のキー");

  const tableMatch = embeddingSection ? /`(memory_embeddings_[^`]*)`/.exec(embeddingSection) : null;
  const indexMatch = embeddingSection
    ? /`(idx_memory_embeddings_hnsw_[^`]*)`/.exec(embeddingSection)
    : null;
  const zeroNormIndexMatch = embeddingSection
    ? /`(idx_memory_embeddings_zero_norm_[^`]*)`/.exec(embeddingSection)
    : null;

  const advisoryLockKeys = advisorySection
    ? [...advisorySection.matchAll(/`(-?\d+)`/g)].map((m) => m[1])
    : [];
  const advisoryLockSeedPrefixes = advisorySection
    ? [...advisorySection.matchAll(/`(mnemora:[a-zA-Z]+:advisory-lock:)/g)].map((m) => m[1])
    : [];

  return {
    tables: tableSection ? extractBulletedIdentifiers(tableSection) : [],
    indexes: indexSection ? extractBulletedIdentifiers(indexSection) : [],
    functions: functionSection ? extractBulletedIdentifiers(functionSection) : [],
    tableHeadingCount: extractHeadingCount(readmeText, "テーブル"),
    indexHeadingCount: extractHeadingCount(readmeText, "索引"),
    functionHeadingCount: extractHeadingCount(readmeText, "関数"),
    embeddingTablePattern: tableMatch ? tableMatch[1] : undefined,
    embeddingIndexPattern: indexMatch ? indexMatch[1] : undefined,
    embeddingZeroNormIndexPattern: zeroNormIndexMatch ? zeroNormIndexMatch[1] : undefined,
    advisoryLockKeys,
    advisoryLockSeedPrefixes,
  };
}

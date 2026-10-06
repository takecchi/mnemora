import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * 出荷済みの `packages/postgres/migrations/*.sql` が書き換えられていないことを、
 * 内容の sha256 で固定する門の判定部（ADR 0637、オーナー回答 374f6f88 の問29）。
 *
 * ⭐ **なぜ要るか**: `_mnemora_migrations` 台帳はファイル名だけで適用済みを判定する
 * （`packages/postgres/src/migrate.ts` の `runMigrations`）。適用済みのファイルを後から
 * 編集しても、既に当てた DB では再実行されないので、「実行された内容」と「リポジトリの正本」が
 * 黙ってずれる。ここはその編集を CI で赤にする。
 *
 * ⭐ **何を固定し、何を固定しないか**
 * - 固定する: 名簿（manifest）に載っているファイルの内容。**書き換え**も**削除**も赤。
 * - 固定しない: 名簿に載っていない**新しい**ファイルの追加。追加は赤にしない
 *   （新しい migration を足すこと自体が、直し方の正道だから）。名簿に載せるのは `--write`
 *   （既存の行は決して書き換えず、足すだけ）。
 * - 正規化: 先頭の BOM と、改行の CRLF/CR は LF に揃えてから hash する。エディタや
 *   `core.autocrlf` が入れる改行・BOM の違いだけで赤にしない。それ以外の空白・コメントの
 *   変更は、内容の変更として赤にする。
 *
 * この関数群は副作用（console / process.exit / 書き込み）を持たない。入口は
 * `scripts/check-migration-checksums.mjs`。
 */

/** 名簿（manifest）の置き場。publish 対象（`files`: dist・migrations）の外。 */
export const MANIFEST_RELATIVE_PATH = "packages/postgres/migration-checksums.json";
export const MIGRATIONS_RELATIVE_DIR = "packages/postgres/migrations";

export const MANIFEST_ALGORITHM =
  "sha256 of the file text after removing a leading BOM and normalizing CRLF/CR to LF";

/** @param {string} text */
export function normalizeMigrationText(text) {
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return withoutBom.replace(/\r\n?/g, "\n");
}

/** @param {string} text */
export function checksumOfMigrationText(text) {
  return createHash("sha256").update(normalizeMigrationText(text), "utf8").digest("hex");
}

/**
 * @param {string} migrationsDir
 * @returns {Record<string, string>} ファイル名 → checksum（名前の昇順）
 */
export function computeChecksums(migrationsDir) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const name of readdirSync(migrationsDir)
    .filter((n) => n.endsWith(".sql"))
    .sort()) {
    out[name] = checksumOfMigrationText(readFileSync(join(migrationsDir, name), "utf8"));
  }
  return out;
}

/**
 * @param {Record<string, string>} pinned 名簿の files
 * @param {Record<string, string>} actual 手元の現物
 * @returns {{ changed: string[]; missing: string[]; unpinned: string[] }}
 *   changed: 名簿にあり、内容が違う。missing: 名簿にあり、ファイルが無い。
 *   unpinned: ファイルはあるが名簿に無い（赤にしない。新しい migration）。
 */
export function compareChecksums(pinned, actual) {
  const changed = [];
  const missing = [];
  for (const [name, sum] of Object.entries(pinned)) {
    if (!(name in actual)) missing.push(name);
    else if (actual[name] !== sum) changed.push(name);
  }
  const unpinned = Object.keys(actual).filter((name) => !(name in pinned));
  return { changed, missing, unpinned };
}

/**
 * 名簿の JSON 文字列を読む。形が違えば例外（黙って空として扱わない）。
 * @param {string} json
 * @returns {Record<string, string>}
 */
export function parseManifest(json) {
  const parsed = JSON.parse(json);
  const files = parsed?.files;
  if (typeof files !== "object" || files === null || Array.isArray(files)) {
    throw new Error("migration-checksums.json: `files` がオブジェクトでない");
  }
  for (const [name, sum] of Object.entries(files)) {
    if (typeof sum !== "string" || !/^[0-9a-f]{64}$/.test(sum)) {
      throw new Error(`migration-checksums.json: ${name} の値が sha256 の16進64桁でない`);
    }
  }
  return files;
}

/**
 * 既存の行は一切書き換えず、名簿に無いファイルだけを足した名簿を返す。
 * @param {Record<string, string>} pinned
 * @param {Record<string, string>} actual
 */
export function appendUnpinned(pinned, actual) {
  /** @type {Record<string, string>} */
  const files = { ...pinned };
  for (const [name, sum] of Object.entries(actual)) {
    if (!(name in files)) files[name] = sum;
  }
  const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1)));
  return `${JSON.stringify({ algorithm: MANIFEST_ALGORITHM, files: sorted }, null, 2)}\n`;
}

/**
 * 赤のときの出力（読み手が次の一手を決められる形）。
 * @param {{ changed: string[]; missing: string[] }} result
 */
export function describeFailure({ changed, missing }) {
  const lines = [];
  for (const name of changed) lines.push(`  書き換えられている: ${name}`);
  for (const name of missing) lines.push(`  無くなっている: ${name}`);
  lines.push(
    "出荷済みの migration は編集しない・消さない（台帳はファイル名だけで適用済みを判定するため、",
    "既に当てた DB には編集が届かない）。直すなら新しい番号の migration を足すこと（ADR 0637）。",
  );
  return lines.join("\n");
}

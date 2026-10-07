import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Pool, PoolClient } from "pg";
import { DEFAULT_MIGRATIONS_DIR } from "./migrations-dir.cjs";
import {
  AdvisoryLockTimeoutError,
  AdvisoryLockUnavailableError,
  DEFAULT_LOCK_TIMEOUT_MS,
  acquireAdvisoryLock,
  acquireAdvisoryLockOnClient,
  deriveAdvisoryLockKey,
  releaseAdvisoryLock,
  releaseAdvisoryLockOnClient,
} from "./advisory-lock.js";
import { isEmbeddingSpaceIndexNameCollision } from "./create-index-race.js";
import { describeMigrationFailure } from "./migration-failure-message.js";
import { POOL_ERROR_WARNING_PREFIX } from "./pool-error-warning.js";
import { assertPgvectorCapabilityViaQuery } from "./pgvector-capability.js";
import { resolveCurrentSchema } from "./resolve-current-schema.js";
import {
  DEFAULT_EXTENSION_SCHEMA,
  type SchemaNamespaceOptions,
  assertSafeSchemaName,
  qualifiedLiteral,
  qualify,
  searchPathFor,
} from "./schema-namespace.js";

/**
 * `SET LOCAL search_path TO ...` として発行する直前だけ、`searchPathFor` の返り値を二重引用符で囲み直す。
 *
 * `searchPathFor` 自身は変えない。あちらは libpq の起動パラメータ（`-c search_path=...`）にも使われ、
 * SQL の構文解析を経ないので引用符を持ち込まない設計が正しい。ここは通常の SQL 文としてパースされるので、
 * 予約語（`user`/`select`/`table` 等）が引用符無しで渡ると構文エラーになる。`assertSafeSchemaName` は文字種と長さしか
 * 見ず予約語は判定しない。分割・引用符化・再結合だけで安全なのは、`assertSafeSchemaName` を通った名前が
 * 二重引用符・コンマ・空白を含み得ないため。
 */
function quotedSearchPathFor(schema: string, extensionSchema: string): string {
  return searchPathFor(schema, extensionSchema)
    .split(",")
    .map((part) => `"${part}"`)
    .join(",");
}

/**
 * pgvector の能力検査（ADR 0367）を、呼び出し元の `schema`/`extensionSchema` に合わせた `search_path` の下で流す。
 *
 * 検査の SQL（`PGVECTOR_CAPABILITY_QUERY`）は `'[0]'::vector` と型をスキーマ修飾せずに書く。
 * `SET LOCAL search_path` の外で流すと、`vector` を `public` 以外に置いた呼び出しでは接続の既定の
 * `search_path` に `extensionSchema` が無く `type "vector" does not exist` で落ちる。共有の文字列は
 * `vector-store.ts` も使い、そちらは `extensionSchema` を知らないので変えない。
 *
 * - `schema` 未指定: `search_path` に触れず、そのまま流す。
 * - `schema` 指定: `BEGIN` → `SET LOCAL search_path TO <各ファイルと同じ>` → 検査 → `COMMIT`。`SET LOCAL` なので
 *   値が元に戻り、pool の接続に状態が残らない。失敗したら `ROLLBACK` する（ロックを持つ接続を中断したトランザクションのまま返さない）。
 */
async function assertPgvectorCapabilityUnderSearchPath(
  client: { query(text: string): Promise<{ rows: unknown[] }> },
  schema: string | undefined,
  extensionSchema: string | undefined,
): Promise<void> {
  if (schema === undefined || extensionSchema === undefined) {
    await assertPgvectorCapabilityViaQuery(client);
    return;
  }
  await client.query("BEGIN");
  try {
    await client.query(`SET LOCAL search_path TO ${quotedSearchPathFor(schema, extensionSchema)}`);
    await assertPgvectorCapabilityViaQuery(client);
    await client.query("COMMIT");
  } catch (err) {
    // ROLLBACK 自体の失敗（接続断等）で元の失敗を上書きしない。
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  }
}

/** `verify` 用: `pool` から接続を1本借りて {@link assertPgvectorCapabilityUnderSearchPath} を流す。 */
async function assertPgvectorCapabilityOnPool(
  pool: Pool,
  schema: string | undefined,
  extensionSchema: string | undefined,
): Promise<void> {
  if (schema === undefined || extensionSchema === undefined) {
    await assertPgvectorCapabilityViaQuery(pool);
    return;
  }
  const client = await pool.connect();
  // 借りた接続の `error`（接続断）で Node が落ちないよう、`acquireAdvisoryLock` と同じく空リスナーを付ける。
  const onError = (): void => {};
  client.on("error", onError);
  try {
    await assertPgvectorCapabilityUnderSearchPath(client, schema, extensionSchema);
  } finally {
    client.removeListener("error", onError);
    client.release();
  }
}

/** `migrations/*.sql` の既定のディレクトリ。解決を `./migrations-dir.cts`（CommonJS）へ追い出してあるのは、ここで `import.meta.url` を使うと、CommonJS へ変換するテストランナーから `@mnemora/postgres` を読み込めなくなるため。 */
export { DEFAULT_MIGRATIONS_DIR };

interface AppliedMigration {
  name: string;
}

/**
 * `runMigrations` がプロセス間排他に使う advisory lock のキー（ADR 0017）。
 *
 * キー空間は DB 全体で共有されるので、アプリケーションが同じ整数を別用途に使えば干渉する。衝突を実用上無視できる
 * 水準に下げるため、固定文字列 `"mnemora:runMigrations:advisory-lock"` の SHA-256 先頭8バイトを符号付き64bit整数として
 * 解釈した値を、実行時に変わらない定数としてハードコードしてある。値を変えると、新旧のプロセスが違うキーでロックを取り
 * 排他が効かなくなり、ローリングデプロイ中の互換性が壊れる。
 */
export const MIGRATION_LOCK_KEY = 7190158676462701299n;

/**
 * 拡張（`REQUIRED_EXTENSIONS`）を作る段だけを直列化する、schema に依らない共有の advisory lock キー。
 *
 * `pg_extension_name_index` は `extname` 単独に張られ、拡張は `schema` に関わらず DB 全体に1つしか置けない（ADR 0057）。
 * 一方 {@link migrationLockKeyFor} は schema ごとに別のキーを返すので、schema の違う `runMigrations` を
 * まっさらな DB へ同時に流すと、互いの schema ロックは待ち合わず、`CREATE EXTENSION IF NOT EXISTS` 同士が衝突して
 * どちらかが落ちる。そのため拡張を作る段だけをこのキーで直列化する。
 *
 * schema ごとのロックに追加で取る2本目のロックで、取得順は常に「schema ごとのロック → この共有拡張ロック」に固定する
 * （逆順の経路は無く、デッドロックを避ける）。新しい接続は借りない。schema ロックを保持している `lockClient` の同じ
 * セッション上で `pg_advisory_lock`/`pg_advisory_unlock` を撃つ。別の接続を借りる形は `runMigrations` が要る接続数が
 * 増え、`max: 2` の pool で3本目の `pool.connect()` が待ち続けてデッドロックする。
 *
 * `extensionMode: "create"`（既定）のときだけ使う。`"verify"` は `CREATE EXTENSION` を発行しない。
 * `schema` 指定の経路は拡張を作るループの前後で、`schema` 未指定の経路は、`CREATE_EXTENSION_LINE_PATTERN` に一致する行を
 * 含む未適用のファイルを適用する間だけ持つ。該当ファイルが適用済みなら、このロックは取得されない。
 *
 * 固定文字列 `"mnemora:runMigrations:extension-lock"` の SHA-256 先頭8バイトを符号付き64bit整数として解釈した値で、
 * `MIGRATION_LOCK_KEY` / `REGISTER_EMBEDDING_SPACE_LOCK_KEY` と衝突しない。値を変えるとローリングデプロイ中の互換性が壊れる。
 * 上書き口（`options.lockKey`）は持たない。`options.lockKey` は schema ごとのロックだけに効き、この共有ロックは常にこの定数を使う。
 */
export const EXTENSION_LOCK_KEY = -1670586062650017388n;

/**
 * `REQUIRED_EXTENSIONS` を要求する DDL は `migrations/0001_init.sql` にも `CREATE EXTENSION IF NOT EXISTS ...` として存在する（二重管理）。
 * 意図して許してある。`0001_init.sql` は「まっさらな DB へ素の `search_path` で流す」経路の一部として拡張を要求し、
 * ここは「専用スキーマを指定したときだけ、拡張を `extensionSchema` へ事前に用意する」別の経路のためにある。
 * どちらか一方に統合すると、もう一方の経路が壊れる。ずれはテストが検出する。
 */
export const REQUIRED_EXTENSIONS = ["vector", "btree_gin", "pgcrypto"] as const;

/**
 * `migrations/*.sql` 本文の「`CREATE EXTENSION IF NOT EXISTS <name>;` だけの行」に一致する正規表現のパターン文字列
 * （フラグは付けない）。テストの突き合わせと {@link matchCreateExtensionLines} / {@link stripCreateExtensionStatements}
 * （`extensionMode: "verify"` 用、ADR 0093）が、この1つの抽出規則を共有する（書き写すと片方だけ直して食い違うため）。
 * `g` フラグ付きの `RegExp` は呼ぶたびに `new RegExp(...)` で作り直すこと（`lastIndex` を共有すると結果が呼び出し順に依存する）。
 */
const CREATE_EXTENSION_LINE_PATTERN =
  "^[ \\t]*CREATE EXTENSION IF NOT EXISTS[ \\t]+(\\S+?);[ \\t]*\\r?\\n?";

/**
 * `migrations/*.sql` 本文から `CREATE EXTENSION IF NOT EXISTS <name>;` の行をすべて抽出する。
 * 一致するのは、行頭（前の空白は許す）から `CREATE EXTENSION IF NOT EXISTS`、空白、空白を含まない名前、`;` まで
 * （大文字小文字は区別しない）。`WITH SCHEMA` などを伴う書き方は一致せず、複数の `CREATE EXTENSION` を1行にまとめると
 * 先頭の1つだけが一致する。
 *
 * - `;` の後ろは行末でなくてもよい。`line` は `;` とその直後の空白・改行までで、後ろのコメントは含まない
 *   （`stripCreateExtensionStatements` はその部分だけを取り除くので、後ろのコメントは本文に残る）。
 * - `name` は書かれたとおりの綴りで、引用符を外さない（`"btree_gin"` なら二重引用符を含む）。
 */
export function matchCreateExtensionLines(
  sql: string,
): Array<{ readonly line: string; readonly name: string }> {
  const re = new RegExp(CREATE_EXTENSION_LINE_PATTERN, "gim");
  return Array.from(sql.matchAll(re), (m) => ({ line: m[0], name: m[1]! }));
}

/**
 * `extensionMode: "verify"`（ADR 0093）専用。`sql` から `CREATE EXTENSION` の行を取り除いた本文を返す。
 *
 * `migrations/*.sql` のファイル自体は書き換えない。台帳はファイル名だけで適用済みを判定するので、出荷済みの本文を
 * 編集しても既適用の DB では再実行されず、実行済み内容と正本がずれるだけになる（ADR 0057・ADR 0001）。
 * 実行時にだけ、この関数を通した後の文字列を流す。
 */
export function stripCreateExtensionStatements(sql: string): {
  readonly sql: string;
  readonly removed: readonly string[];
} {
  const removed = matchCreateExtensionLines(sql).map((m) => m.name);
  const stripped = sql.replace(new RegExp(CREATE_EXTENSION_LINE_PATTERN, "gim"), "");
  return { sql: stripped, removed };
}

/**
 * 拡張（`REQUIRED_EXTENSIONS`）の用意のしかた（ADR 0093）。
 *
 * - `"create"`（既定）: `CREATE EXTENSION IF NOT EXISTS` を発行する。
 * - `"verify"`: `CREATE EXTENSION` を発行しない。代わりに `pg_extension` を読み、`REQUIRED_EXTENSIONS` が
 *   すべて既に存在することだけを確認する。1つでも無ければ {@link MissingExtensionsError} を投げる
 *   （`CREATE EXTENSION` 権限を持たないロールで接続する導入者のための口）。
 */
export type ExtensionMode = "create" | "verify";

/**
 * `extensionMode: "verify"` で、`REQUIRED_EXTENSIONS` のいずれかが `pg_extension` に見当たらなかったことを表す。
 * 「検査していない」（`extensionMode` 省略）・「検査したが無かった」（このエラー）・「在った」（例外なく完了）の
 * 3状態を呼び出し側が区別できる（ADR 0093）。メッセージには足りない拡張の名前と、DBA がそのまま実行できる
 * `CREATE EXTENSION` 文を書く。
 */
export class MissingExtensionsError extends Error {
  /** `pg_extension` に見当たらなかった拡張名（`REQUIRED_EXTENSIONS` の部分集合）。 */
  readonly missing: readonly string[];

  constructor(missing: readonly string[], extensionSchema: string | undefined) {
    const withSchema = extensionSchema !== undefined ? ` WITH SCHEMA "${extensionSchema}"` : "";
    const suggestions = missing
      .map((ext) => `  CREATE EXTENSION IF NOT EXISTS ${ext}${withSchema};`)
      .join("\n");
    super(
      `runMigrations: extensionMode: "verify" — 必要な拡張が見当たりません: ` +
        `${missing.join(", ")}。\n` +
        `CREATE EXTENSION 権限を持つロールで、以下を実行してください:\n${suggestions}`,
    );
    this.name = "MissingExtensionsError";
    this.missing = missing;
  }
}

/** `REQUIRED_EXTENSIONS` のうち `pg_extension` に実在するものの集合を返す。拡張はスキーマでなく DB に属する（ADR 0057）ので、`schema` に関わらず DB 全体を1回確認すれば足りる。 */
async function fetchInstalledExtensions(pool: Pool): Promise<Set<string>> {
  const literals = REQUIRED_EXTENSIONS.map((ext) => `'${ext}'`).join(", ");
  const { rows } = await pool.query<{ extname: string }>(
    `SELECT extname FROM pg_extension WHERE extname = ANY(ARRAY[${literals}])`,
  );
  return new Set(rows.map((row) => row.extname));
}

/** `extensionMode: "verify"` の中心処理。足りない拡張があれば {@link MissingExtensionsError} を投げる。 */
async function verifyRequiredExtensions(
  pool: Pool,
  extensionSchema: string | undefined,
): Promise<void> {
  const installed = await fetchInstalledExtensions(pool);
  const missing = REQUIRED_EXTENSIONS.filter((ext) => !installed.has(ext));
  if (missing.length > 0) {
    throw new MissingExtensionsError(missing, extensionSchema);
  }
}

/** {@link runMigrations} の設定。スキーマの指定は {@link SchemaNamespaceOptions} から継ぐ。 */
export interface RunMigrationsOptions extends SchemaNamespaceOptions {
  /**
   * advisory lock を待つ上限（ミリ秒）。既定は {@link DEFAULT_LOCK_TIMEOUT_MS}。
   * schema ごとのロックと {@link EXTENSION_LOCK_KEY} の共有拡張ロックの両方に同じ値を使う。
   */
  lockTimeoutMs?: number | undefined;
  /**
   * advisory lock のキー。テスト以外で既定の {@link MIGRATION_LOCK_KEY} を変える理由は無い。
   * schema ごとのロック（`migrationLockKeyFor` が返すもの）だけに効く。{@link EXTENSION_LOCK_KEY} は
   * schema を跨いで全員が同じキーを見ることが目的なので、この上書きの対象ではない。
   */
  lockKey?: bigint | undefined;
  /** 拡張（`REQUIRED_EXTENSIONS`）の用意のしかた。既定は `"create"`。`"verify"` は {@link ExtensionMode}（ADR 0093）。 */
  extensionMode?: ExtensionMode | undefined;
}

/**
 * `schema` から `runMigrations` の advisory lock キーを導く。
 *
 * キー空間は DB 全体で共有される。2つの mnemora が同じ DB の別スキーマに同居すると、片方の migrate が
 * もう片方を黙ってブロックする（エラーにならないので気付けない）ので、`schema` ごとに別のキーを使う。
 *
 * - `schema === undefined` または `"public"`: 既存の {@link MIGRATION_LOCK_KEY} を返す。
 *   ローリングデプロイ中の旧プロセスは常に旧キーを使うので、既定経路のキーを変えると排他が効かなくなる。
 *   同期関数で DB 接続を持たず、`schema` 未指定時に実際に使われるスキーマを知らない。`runMigrations` が
 *   {@link resolveCurrentSchema} で読んだ値を渡す（`current_schema()` が `NULL` なら `undefined` のまま渡され、
 *   `MIGRATION_LOCK_KEY` になる）。ロックを取りすぎる誤りは無関係な処理を待たせるだけで無害だが、
 *   取らなすぎる誤りは排他を壊すので、保守的に `undefined` と `"public"` を同じキーへ寄せる。
 * - それ以外: `deriveAdvisoryLockKey` で `schema` ごとに別のキーを導出する。
 */
export function migrationLockKeyFor(schema?: string): bigint {
  if (schema === undefined || schema === "public") {
    return MIGRATION_LOCK_KEY;
  }
  return deriveAdvisoryLockKey(`mnemora:runMigrations:advisory-lock:${schema}`);
}

/** {@link runMigrations} の戻り値。 */
export interface RunMigrationsResult {
  /** この呼び出しで当てた migration のファイル名（当てた順）。適用済みのものは含まない。何も当てなければ空配列。 */
  applied: string[];
  /** 排他の観測値。`waitedMs` は、ロックが空くまで実際に待った時間（ミリ秒）。他プロセスが同時に migrate していなければ 0 に近い。 */
  lock: { waitedMs: number };
  /**
   * `extensionMode: "verify"`（ADR 0093）のときだけ載る、拡張検査の観測値。
   *
   * - `extensionMode` 省略（既定 `"create"`）: `undefined`（検査していない）。
   * - `"verify"` で1つでも足りない: この値は載らず {@link MissingExtensionsError} を投げる（検査したが無かった）。
   * - `"verify"` で全て揃っている: `verified` に確認できた拡張名が載る（在った）。
   *
   * この3値を同じ顔（`undefined` や空配列）に潰さないこと。
   */
  extensionCheck?: { verified: readonly string[] };
}

/**
 * advisory lock の取得が待ち時間切れで失敗したことを表す。「待って取れた」「時間切れ」「ロック機構自体が使えなかった」の
 * 3つを呼び出し側が区別できる。これは2番目の状態専用で、`MigrationLockUnavailableError`（3番目）と混同しないこと。
 * 機構は `AdvisoryLockTimeoutError`（`./advisory-lock.ts`）にあり、ここはメッセージに `runMigrations:` を埋め込んだ
 * サブクラス（既存の `instanceof` 検査とメッセージ文言を壊さないため）。
 */
export class MigrationLockTimeoutError extends AdvisoryLockTimeoutError {
  constructor(waitedMs: number, cause: unknown) {
    super(
      `runMigrations: advisory lock を ${waitedMs}ms 待ったが取得できなかった（タイムアウト）。` +
        `他プロセスが migrate を握ったまま応答していない可能性がある。`,
      cause,
    );
    this.name = "MigrationLockTimeoutError";
  }
}

/**
 * advisory lock を取得する操作自体が失敗したこと（権限不足・接続不可など）を表す。`MigrationLockTimeoutError` とは別原因。
 * この区別が無いと、権限設定の誤りを「混んでいるだけ」と誤診してリトライし続けてしまう。
 */
export class MigrationLockUnavailableError extends AdvisoryLockUnavailableError {
  constructor(cause: unknown) {
    super(
      `runMigrations: advisory lock を取得する操作自体が失敗した` +
        `（権限不足・接続不可などで、待ち時間切れとは別の原因）。`,
      cause,
    );
    this.name = "MigrationLockUnavailableError";
  }
}

const MIGRATION_LOCK_ERRORS = {
  timeout: (waitedMs: number, cause: unknown) => new MigrationLockTimeoutError(waitedMs, cause),
  unavailable: (cause: unknown) => new MigrationLockUnavailableError(cause),
};

async function acquireMigrationLock(
  pool: Pool,
  lockKey: bigint,
  lockTimeoutMs: number,
): Promise<{ client: PoolClient; waitedMs: number }> {
  return acquireAdvisoryLock(pool, lockKey, lockTimeoutMs, MIGRATION_LOCK_ERRORS);
}

async function releaseMigrationLock(client: PoolClient, lockKey: bigint): Promise<void> {
  return releaseAdvisoryLock(client, lockKey);
}

/**
 * {@link EXTENSION_LOCK_KEY} を取得する。エラーの語彙は schema ロックと共有し、`MigrationLockTimeoutError` /
 * `MigrationLockUnavailableError` をそのまま使う。どちらのロックで起きたかを型で分けない（両者は `lockTimeoutMs` を共用し、
 * 呼び出し側の対処も変わらない）。
 */
async function acquireExtensionLock(lockClient: PoolClient, lockTimeoutMs: number): Promise<void> {
  // `lockClient` の `lock_timeout` は schema ロックを取った直後に既定へ戻してある（本体の DDL に効かせないため）。
  // この共有ロックを待つ間だけ敷き直し、待ち時間の上限を schema ロックと同じ `lockTimeoutMs` に保つ。
  await lockClient.query("SELECT set_config('lock_timeout', $1, false)", [String(lockTimeoutMs)]);
  try {
    await acquireAdvisoryLockOnClient(lockClient, EXTENSION_LOCK_KEY, MIGRATION_LOCK_ERRORS);
  } finally {
    await lockClient.query("RESET lock_timeout");
  }
}

async function releaseExtensionLock(lockClient: PoolClient): Promise<void> {
  await releaseAdvisoryLockOnClient(lockClient, EXTENSION_LOCK_KEY);
}

/**
 * 旧名の台帳 `_mnemo_migrations` を新名 `_mnemora_migrations` へ引き継ぐ。
 *
 * `mnemo` → `mnemora` の改名より前に作られた DB は、適用済みの記録が旧名のテーブルに入っている。引き継がずに
 * 新名の台帳を作ると、空の台帳を読んで `migrations/*.sql` を最初からやり直そうとして落ちる
 * （`0001_init.sql` の `CREATE TABLE observations` は `IF NOT EXISTS` を付けていない）。
 *
 * 旧名が在り新名が無ければ RENAME する。旧名が無ければ何もしない。新旧どちらも在る場合も何もしない
 * （新名の台帳を上書きせず、旧名も消さない。中身の突き合わせは人間の判断に属する）。いずれも冪等。
 *
 * `ensureMigrationsTable` より前に呼ぶこと。逆順だと、先に空の台帳が出来て「新旧どちらも在る」に落ち、引き継ぎが起きない。
 * `ALTER TABLE ... RENAME TO` の新しい名前は修飾しない（`RENAME TO` は修飾名を受け付けず、構文エラーになる）。
 */
async function handOverLegacyMigrationsTable(client: PoolClient, schema?: string): Promise<void> {
  const legacyTable = qualify(schema, "_mnemo_migrations");
  const legacyLiteral = qualifiedLiteral(schema, "_mnemo_migrations");
  const newLiteral = qualifiedLiteral(schema, "_mnemora_migrations");
  await client.query(`
    DO $handover$
    BEGIN
      IF to_regclass('${legacyLiteral}') IS NOT NULL
         AND to_regclass('${newLiteral}') IS NULL THEN
        ALTER TABLE ${legacyTable} RENAME TO _mnemora_migrations;
      END IF;
    END
    $handover$;
  `);
}

async function ensureMigrationsTable(client: PoolClient, schema?: string): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${qualify(schema, "_mnemora_migrations")} (
      name         text        PRIMARY KEY,
      applied_at   timestamptz NOT NULL DEFAULT now()
    );
  `);
}

/**
 * `migrationsDir` にある `*.sql` を適用順（ファイル名の昇順）で列挙する。
 *
 * export するのは、テストが期待値をハードコードせずこの関数から導出できるようにするため
 * （`migrations/` が増えるたびに期待値を書き換える羽目になり、1本のときしか通らない歯になる）。
 *
 * `.sql` が1本も無ければ空配列を返す（例外にしない。ADR 0552）。`migrationsDir` を読めないとき
 * （存在しない・ディレクトリでない・権限が無い）は、`readdirSync` の例外がそのまま伝わる。
 */
export function listMigrationFiles(migrationsDir: string): string[] {
  return readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

/**
 * {@link listMigrationFiles} を、`runMigrations` の入口（DB に触れる前）で呼ぶ版（ADR 0448）。
 * `migrationsDir` を読めないとき、ロック・`CREATE SCHEMA`・`CREATE EXTENSION`・台帳の作成が済んだ後に fs の生の例外で
 * 落ちるのでなく、DB に触れる前に、どの引数が読めなかったかを言う `Error`（`cause` に元の例外、`code` は元のもの）で落ちる。
 */
function listMigrationFilesOrExplain(migrationsDir: string): string[] {
  try {
    return listMigrationFiles(migrationsDir);
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    throw Object.assign(
      new Error(
        `runMigrations: migrationsDir を読めない（${migrationsDir}）: ${(err as Error).message}`,
        { cause: err },
      ),
      typeof code === "string" ? { code } : {},
    );
  }
}

/** ファイル名の先頭の数字（`0011_x.sql` → `11n`）。先頭が数字でなければ `undefined`。 */
function migrationNumber(name: string): bigint | undefined {
  const m = /^(\d+)/.exec(name);
  return m ? BigInt(m[1]!) : undefined;
}

/**
 * 台帳（`alreadyApplied`）と手元のファイル（`files`）のずれを探して、警告の文面を返す（ADR 0425）。
 * 止めない・順序も中身も変えない。文面を返すだけで、呼び出し側は `console.warn` して続行する。
 *
 * export しない（`index.ts` は `export * from "./migrate.js"` なので、export すると公開 API になる）。
 *
 * - (a) 未適用のファイルのうち、台帳の最大の番号より番号が小さいものが在る。
 * - (b) 台帳にある名前が、手元のファイルに無い。
 * - (c) 手元のファイルが1本も無い（ADR 0448）。
 */
function describeLedgerDrift(
  alreadyApplied: ReadonlySet<string>,
  files: readonly string[],
): string[] {
  const messages: string[] = [];

  // (c) `.sql` が1本も無い。`migrationsDir` の指定違い・パッケージの展開の欠けを疑う。止めない。
  if (files.length === 0) {
    messages.push(
      `${POOL_ERROR_WARNING_PREFIX} migrate: migrationsDir に .sql が1本も無い。何も適用しない。` +
        `migrationsDir の指定、またはパッケージの migrations/ が欠けていないかを確かめること。`,
    );
  }

  let maxName: string | undefined;
  let maxNumber: bigint | undefined;
  for (const name of alreadyApplied) {
    const n = migrationNumber(name);
    if (n !== undefined && (maxNumber === undefined || n > maxNumber)) {
      maxNumber = n;
      maxName = name;
    }
  }
  if (maxNumber !== undefined) {
    const limit = maxNumber;
    const behind = files.filter((file) => {
      if (alreadyApplied.has(file)) {
        return false;
      }
      const n = migrationNumber(file);
      return n !== undefined && n < limit;
    });
    if (behind.length > 0) {
      messages.push(
        `${POOL_ERROR_WARNING_PREFIX} migrate: 台帳（_mnemora_migrations）の最大の番号（${maxName}）より ` +
          `小さい番号の未適用の migration がある: ${behind.join(", ")}。続行してこれらも適用するが、` +
          `後から適用済みの migration が変えた内容を、これらの当たり直しが巻き戻しうる ` +
          `（例: 台帳の行が消えた migration が、後の migration の変更を上書きする）。` +
          `台帳の行を誤って消していないか、別の版の migrations から流していないかを確かめること。`,
      );
    }
  }

  const fileSet = new Set(files);
  const unknown = [...alreadyApplied].filter((name) => !fileSet.has(name)).sort();
  if (unknown.length > 0) {
    messages.push(
      `${POOL_ERROR_WARNING_PREFIX} migrate: 台帳（_mnemora_migrations）に、手元の migrations に無い名前がある: ` +
        `${unknown.join(", ")}。続行するが、手元の版がこの DB より古い可能性がある ` +
        `（新しい版で上げた DB に古い版から流している）。この DB を使うアプリの版を確かめること。`,
    );
  }
  return messages;
}

/**
 * 未適用の `migrations/*.sql` を名前の昇順で適用する。適用済みは `_mnemora_migrations` に記録し、二重適用しない（冪等）。
 * `packages/postgres` の唯一のマイグレーション実行口（ADR 0001・docs/memory-model.md §10）。DDL は `migrations/*.sql` に
 * 手書きで置き、`drizzle-kit push` には頼らない。埋め込み空間ごとのテーブルはここでは作らず、`registerEmbeddingSpace` が作る。
 *
 * 台帳を読む前に、旧名 `_mnemo_migrations` からの引き継ぎを一度通す（`handOverLegacyMigrationsTable`）。
 * `migrationsDir` はテスト用の差し替え口で、省略時は本番の `migrations/` を使う。
 *
 * `migrationsDir` に `.sql` が1本も無くても失敗しない（ADR 0552）。`console.warn` を出して `{ applied: [] }` を返す
 * （警告を止める・失敗にするオプションは無い）。指定違い・パッケージの `migrations/` の欠けを疑うこと。
 * `options.schema` を指定していると、スキーマと拡張はこの時点で作られる。読めない（存在しない等）ときは別で、DB に触れる前に落ちる。
 *
 * ## 排他（ADR 0017）
 *
 * `handOverLegacyMigrationsTable` の前から最後のマイグレーションの COMMIT までを advisory lock（`MIGRATION_LOCK_KEY`）で包む。
 * まっさらな DB へ複数プロセスが同時に呼ぶと、`ensureMigrationsTable` の `CREATE TABLE IF NOT EXISTS`・`0001_init.sql` 冒頭の
 * `CREATE EXTENSION IF NOT EXISTS`・同ファイルの無印 `CREATE TABLE` の3層のどこかで落ちる。個々の DDL に `IF NOT EXISTS` を
 * 積み増す方向は採らない（症状が別の層へ移るだけで、並行に呼んでよい保証にならない）ので、入り口を1つのロックで塞ぐ。
 *
 * ロックの下で流すものは、すべてロックを持つ接続そのもので流す。advisory lock はセッションに付くので、ロックを持つ接続だけが
 * 切れるとサーバーはロックを手放す。本体を別の接続で流すと、その間に別の実行が同じロックを取って重なりうる。同じ接続なら、
 * 切れれば本体のトランザクションも終わりコミットされない。失敗は `migration <file> failed: ...` として報告し、
 * 最後のロックの返却の失敗では上書きしない。ロックを待つために敷く `lock_timeout` は取った直後に `RESET` して本体の DDL に
 * 効かせない（共有の拡張ロックを待つ間だけ敷き直す。{@link acquireExtensionLock}）。
 *
 * mnemora は `statement_timeout` を設定しない（ADR 0552）。runner が触るセッション設定は `lock_timeout` だけ。
 * 利用者側の設定（`ALTER ROLE … SET`・`ALTER DATABASE … SET`・`PGOPTIONS`・接続文字列の `options`）の `statement_timeout` などは
 * 本体の DDL にそのまま効き、runner は上書きしない。短いと、時間のかかる DDL（大きい表への `CREATE INDEX` など）が毎回
 * `migration <file> failed: canceling statement due to statement timeout` になる（そのファイルは巻き戻り、台帳に載らない）。
 * `ALTER ROLE … SET lock_timeout` も同じで、`RESET` はその値へ戻る。migrate を流す接続だけ無効にするなら、
 * 接続文字列の `options`（`?options=-c%20statement_timeout%3D0`）か `PGOPTIONS="-c statement_timeout=0"` を使う。
 * 手順は `packages/postgres/README.md` の「接続・ロール・DB の `statement_timeout` などは、migration の本体にも効く」節。
 *
 * 起こりうる3つの状態を呼び出し側が区別できる:
 * - 待って取れた: 通常どおり完了し、戻り値の `lock.waitedMs` に待った時間が載る。
 * - 待ったが時間切れ: {@link MigrationLockTimeoutError} を投げる（黙って続行しない）。
 * - ロック取得の操作自体が失敗（権限不足・接続不可等）: {@link MigrationLockUnavailableError} を投げる。
 * `lockTimeoutMs` 未指定なら {@link DEFAULT_LOCK_TIMEOUT_MS}。
 *
 * ## 拡張を作る段の共有ロック
 *
 * schema ごとのロックとは別に、`CREATE EXTENSION` を発行する段だけを {@link EXTENSION_LOCK_KEY} で直列化する。
 * 拡張は DB 全体に1つしか置けず（`pg_extension_name_index` は `extname` 単独）、schema ごとのロックだけでは
 * schema の違う `runMigrations` 同士が待ち合わず衝突する。取得順は常に「schema ごとのロック → この共有ロック」。
 * `extensionMode: "verify"` では参照しない。詳細は {@link EXTENSION_LOCK_KEY} と ADR 0331。
 *
 * ## `options.schema`
 *
 * `schema` 未指定なら、DDL・DML は同じ順番で発行される。例外は2つ。`options.lockKey` を上書きしない呼び出しは、
 * ロック取得より前に `SELECT current_schema()` を1回発行する（lock キーを実際のスキーマに揃えるため。`migrationLockKeyFor` を参照）。
 * 初回適用時だけ、共有ロックの `pg_advisory_lock`/`pg_advisory_unlock` が `lockClient` に対して増える（新しい接続は増えない。ADR 0331）。
 *
 * `schema` を指定すると:
 *
 * 1. `assertSafeSchemaName` で `schema`（と、指定されていれば `extensionSchema`）を、ロック取得より前に検証する
 *    （不正な入力のためにロックを取って他プロセスを待たせる意味が無い）。
 * 2. ロック取得後、`CREATE SCHEMA IF NOT EXISTS "<schema>"` と、`REQUIRED_EXTENSIONS` 各拡張の
 *    `CREATE EXTENSION IF NOT EXISTS <ext> WITH SCHEMA "<extensionSchema>"` を実行する（省略時は {@link DEFAULT_EXTENSION_SCHEMA}）。
 * 3. 台帳の引き継ぎ・存在検査・作成・SELECT/INSERT はすべて `qualify` 経由でスキーマ修飾する。
 * 4. 各マイグレーションのトランザクション内、`BEGIN` の直後に `SET LOCAL search_path TO <schema>[,<extensionSchema>]` を発行する。
 *    `SET LOCAL` なので、pool のコネクションに session 状態が漏れない。
 *
 * ## `options.extensionMode`（ADR 0093）
 *
 * 未指定（既定 `"create"`）なら関係ない。`"verify"` を指定すると:
 *
 * 1. ロック取得より前に `pg_extension` を読み、`REQUIRED_EXTENSIONS` が全て存在するか確認する。1つでも無ければ
 *    {@link MissingExtensionsError} を投げ、ロックの取得もマイグレーションの適用も行わない。
 * 2. `schema` を指定していても、`CREATE EXTENSION ... WITH SCHEMA` は発行しない。
 * 3. `migrations/*.sql` 本文の `CREATE EXTENSION IF NOT EXISTS ...;` 行は、送信前に取り除く
 *    （{@link stripCreateExtensionStatements}）。ファイルそのものは変えない。
 *
 * つまり `"verify"` は `CREATE EXTENSION` を一切発行させない。`CREATE EXTENSION` の権限を持たないロールで接続する導入者のための口。
 */
export async function runMigrations(
  pool: Pool,
  migrationsDir: string = DEFAULT_MIGRATIONS_DIR,
  options: RunMigrationsOptions = {},
): Promise<RunMigrationsResult> {
  const { schema } = options;
  if (schema !== undefined) {
    assertSafeSchemaName(schema);
  }
  const extensionSchema =
    schema === undefined ? undefined : (options.extensionSchema ?? DEFAULT_EXTENSION_SCHEMA);
  if (extensionSchema !== undefined) {
    assertSafeSchemaName(extensionSchema);
  }
  const extensionMode: ExtensionMode = options.extensionMode ?? "create";
  // ADR 0448: migrationsDir を読めないなら、DB に触れる前（ロック・CREATE SCHEMA・台帳の作成の前）に落ちる。
  const migrationFiles = listMigrationFilesOrExplain(migrationsDir);

  // `extensionMode: "verify"` はロック取得より前に決着させる（不正/不足のためにロックを取って他プロセスを待たせる意味が無い）。
  // 拡張はスキーマでなく DB に属する（ADR 0057）ので、`schema` の有無に関わらず、この1回の確認で
  // 経路1（CREATE SCHEMA の隣の CREATE EXTENSION ループ）と経路2（`0001_init.sql` 本文）の両方を代替する。
  let extensionCheck: RunMigrationsResult["extensionCheck"];
  if (extensionMode === "verify") {
    await verifyRequiredExtensions(pool, extensionSchema);
    // 拡張の存在だけでなく、pgvector が `hnsw.iterative_scan = relaxed_order` を解釈できるか（ADR 0367）も、
    // ロック取得・マイグレーション適用より前に確認する。`verify` は `CREATE EXTENSION` を発行しないだけで、この `SELECT` は打てる。
    await assertPgvectorCapabilityOnPool(pool, schema, extensionSchema);
    extensionCheck = { verified: REQUIRED_EXTENSIONS };
  }

  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  // `schema` 未指定かつ `options.lockKey` の上書きも無いときだけ、ロック取得より前に同じ `pool` で
  // `SELECT current_schema()` を読み、実際に解決されたスキーマ名で `migrationLockKeyFor` を呼ぶ（ADR 0331）。
  const lockKey =
    options.lockKey ??
    migrationLockKeyFor(schema === undefined ? await resolveCurrentSchema(pool) : schema);

  const { client: lockClient, waitedMs } = await acquireMigrationLock(pool, lockKey, lockTimeoutMs);
  // ロックの下で流すものは、すべてロックを持つ接続（`lockClient`）で流す。途中で失敗したときは、最後のロックの返却の失敗でその失敗を上書きしない。
  let failed = false;
  try {
    // ロックを待つために敷いた `lock_timeout` を、本体の DDL に効かせない。
    await lockClient.query("RESET lock_timeout");
    if (schema !== undefined) {
      await lockClient.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
      // `verify` では存在を確認済みなので `CREATE EXTENSION` を発行しない（`CREATE EXTENSION` 権限を持たないロールでも呼べるようにする。ADR 0093）。
      if (extensionMode === "create") {
        // 拡張は DB 全体に1つしか置けない。schema ごとのロックは schema が違えば互いを待たないので、この
        // CREATE EXTENSION ループだけを {@link EXTENSION_LOCK_KEY} の共有ロックで追加に直列化する。
        await acquireExtensionLock(lockClient, lockTimeoutMs);
        let extensionsFailed = false;
        try {
          for (const ext of REQUIRED_EXTENSIONS) {
            await lockClient.query(
              `CREATE EXTENSION IF NOT EXISTS ${ext} WITH SCHEMA "${extensionSchema}"`,
            );
          }
        } catch (err) {
          extensionsFailed = true;
          throw err;
        } finally {
          const releasing = releaseExtensionLock(lockClient);
          await (extensionsFailed ? releasing.catch(() => {}) : releasing);
        }
      }
    }

    await handOverLegacyMigrationsTable(lockClient, schema);
    await ensureMigrationsTable(lockClient, schema);

    const { rows } = await lockClient.query<AppliedMigration>(
      `SELECT name FROM ${qualify(schema, "_mnemora_migrations")}`,
    );
    const alreadyApplied = new Set(rows.map((row) => row.name));

    const applied: string[] = [];
    for (const message of describeLedgerDrift(alreadyApplied, migrationFiles)) {
      console.warn(message);
    }
    for (const file of migrationFiles) {
      if (alreadyApplied.has(file)) {
        continue;
      }
      const fileSql = readFileSync(join(migrationsDir, file), "utf8");
      // `verify` では、この本文を送る前に `CREATE EXTENSION` の行だけを取り除く。ファイル自体は変えず、実行時にだけ
      // 流す文字列を変える（`stripCreateExtensionStatements`）。
      const sql =
        extensionMode === "verify" ? stripCreateExtensionStatements(fileSql).sql : fileSql;

      // `schema` 未指定の経路は、拡張が *この* ファイル本文のトランザクション内（今のところ 0001_init.sql）で作られる。
      // schema を指定した別の呼び出し（別キー）とは待ち合わないので、このファイルを適用する間だけ共有の
      // {@link EXTENSION_LOCK_KEY} を追加に取る。`create` かつ、このファイルが `CREATE EXTENSION` 行を含むときだけ。
      // 該当する未適用のファイルが無ければ（定常状態）取得されない。
      const needsSharedExtensionLock =
        schema === undefined &&
        extensionMode === "create" &&
        matchCreateExtensionLines(fileSql).length > 0;
      if (needsSharedExtensionLock) {
        await acquireExtensionLock(lockClient, lockTimeoutMs);
      }
      let fileFailed = false;
      try {
        // 本体はロックを持つ接続（`lockClient`）そのもので流す。別の接続で流すと、ロックを持つ接続だけが切れたとき
        // （サーバーはロックを手放す）に本体が流れ続け、別の実行と重なりうる。同じ接続なら、切れれば本体のトランザクションも終わる。
        // `lockClient` には `acquireAdvisoryLock` が空の `error` リスナーを付けてあり、アイドル中の接続断でプロセスが落ちない。
        // 接続断は下の `await client.query(...)` の reject として捕まり、`migration <file> failed: ...` に包んで投げる。
        const client = lockClient;
        // 1ファイルにつき最大2回。流し直すのは、1回目が `registerEmbeddingSpace` の索引作りと重なった `23505`
        // （`isEmbeddingSpaceIndexNameCollision`）で落ち、かつ ROLLBACK が通ったときだけ（ADR 0638）。台帳の行はこの
        // トランザクションごと巻き戻っているので、同じファイルを BEGIN からやり直すだけでよい。2回目に落ちたらそのエラーを包んで投げる。
        for (let attempt = 1; ; attempt++) {
          try {
            await client.query("BEGIN");
            if (schema !== undefined) {
              await client.query(
                `SET LOCAL search_path TO ${quotedSearchPathFor(schema, extensionSchema!)}`,
              );
            }
            await client.query(sql);
            await client.query(
              `INSERT INTO ${qualify(schema, "_mnemora_migrations")} (name) VALUES ($1)`,
              [file],
            );
            await client.query("COMMIT");
            applied.push(file);
            break;
          } catch (err) {
            // ROLLBACK 自体の失敗（接続断等）で元の失敗（`err`）を上書きしない。下の throw は常に `err` を基にする。
            let rolledBack = true;
            await client.query("ROLLBACK").catch(() => {
              rolledBack = false;
            });
            if (attempt === 1 && rolledBack && isEmbeddingSpaceIndexNameCollision(err)) {
              continue;
            }
            throw new Error(describeMigrationFailure(file, err), { cause: err });
          }
        }
      } catch (err) {
        fileFailed = true;
        throw err;
      } finally {
        if (needsSharedExtensionLock) {
          const releasing = releaseExtensionLock(lockClient);
          await (fileFailed ? releasing.catch(() => {}) : releasing);
        }
      }
    }
    // `create`（既定）では、ここまでに `vector` 拡張は必ず作られている（`schema` 指定時は上の `CREATE EXTENSION` ループ、
    // 未指定時は `0001_init.sql` 本文）。拡張の存在確認を待たず、毎回この位置で無条件に pgvector の能力を検査する（ADR 0367）。
    //
    // `create` の新規インストールでは「マイグレーションを何も適用しないうちに投げる」を満たせない
    // （拡張そのものが `0001_init.sql` の適用で初めて作られる）。毎回検査する単一の経路を選んだのは、
    // pgvector を後からダウングレードされても次の起動で拾えることを、初回だけ最速で落ちることより優先したため。
    if (extensionMode === "create") {
      await assertPgvectorCapabilityUnderSearchPath(lockClient, schema, extensionSchema);
    }
    return { applied, lock: { waitedMs }, extensionCheck };
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    const releasing = releaseMigrationLock(lockClient, lockKey);
    await (failed ? releasing.catch(() => {}) : releasing);
  }
}

/** `analyzeMemories` の設定。 */
export interface AnalyzeMemoriesOptions {
  /** `memories` テーブルを置くスキーマ。`RunMigrationsOptions.schema` と同じ意味・同じ検証。省略時は接続の `search_path` 任せ（識別子を修飾しない）。 */
  schema?: string | undefined;
}

/** `analyzeMemories` の戻り値。 */
export interface AnalyzeMemoriesResult {
  /** 実際に `ANALYZE` を発行した対象（`schema` を指定した場合はスキーマ修飾済み）。 */
  table: string;
}

/**
 * `memories` に対して `ANALYZE memories;` を、マイグレーションのライフサイクルから独立に、いつでも呼べる形で実行する（ADR 0143）。
 * 何度呼んでも安全（冪等）。CLI からは `mnemora-postgres-migrate --analyze-memories` で呼べる。
 *
 * `runMigrations` の中に混ぜない。`0005_analyze_memories.sql` は `ANALYZE memories;` を持つが、新規インストールでは
 * マイグレーションがアプリケーションの最初の書き込みより前に適用され、その時点で `memories` は空なので効果が無い
 * （ADR 0062）。`runMigrations` の最後に `ANALYZE` を打つ形にしても、実行されるタイミングが「データがまだ無い」ことは変わらない。
 * だから、データを投入した後に運用側が明示的に呼ぶ。
 *
 * 単体の `ANALYZE` は `SHARE UPDATE EXCLUSIVE` ロックを取り、通常の `SELECT`/`INSERT`/`UPDATE`/`DELETE` と競合しない
 * （PostgreSQL 17 で `createMemory` が止まらないことを確かめた）。固定サイズのサンプル行だけを読む。
 * 測っていないのは、大きなテーブルでのサンプリングの壁時計時間と、プランキャッシュの無効化など統計情報以外の副作用（ADR 0143）。
 */
export async function runAnalyzeMemories(
  pool: Pool,
  options: AnalyzeMemoriesOptions = {},
): Promise<AnalyzeMemoriesResult> {
  const { schema } = options;
  if (schema !== undefined) {
    assertSafeSchemaName(schema);
  }
  const table = qualify(schema, "memories");
  await pool.query(`ANALYZE ${table}`);
  return { table };
}

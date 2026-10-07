import { assertSafeIdentifier } from "./embedding-space-table.js";

/**
 * 専用スキーマ（namespace）対応の共通部品。共有 DB の中に他システムが同名テーブルを持っていても衝突しないよう、
 * 使う側が専用の PostgreSQL スキーマを指定できる。
 *
 * DML は裸のテーブル名のままにして `search_path`（`createPostgresClient` が先頭を `<schema>` にする）に任せ、
 * DDL と存在検査は `qualify` / `qualifiedLiteral` で明示修飾する。存在検査を `search_path` 任せにしてはならない。
 * `to_regclass('_mnemora_migrations')` は `search_path` 全体を探すので、`public` に台帳が在ると
 * `<schema>` に台帳が無くても「在る」と誤判定する。`CREATE TABLE IF NOT EXISTS` の可視性判定も同じ危険を持つ。
 *
 * `schema` を指定しない経路は、発行される SQL 文字列を変えない。このファイルの関数は `schema === undefined` を
 * 素通しにする。
 */

/**
 * `schema` を指定したときに、拡張（`vector` / `btree_gin` / `pgcrypto`）を置く既定のスキーマ。
 * `schema` を指定しなければ参照されない。
 */
export const DEFAULT_EXTENSION_SCHEMA = "public";

/**
 * mnemora のテーブルと拡張を置くスキーマの指定。`runMigrations`・`registerEmbeddingSpace`・`createPostgresClient` が受け取る。
 * どちらも省略すれば、接続の `search_path` 任せ（今日どおり）。
 */
export interface SchemaNamespaceOptions {
  /**
  /** mnemora のテーブル・索引・マイグレーション台帳を置くスキーマ。省略時は接続の `search_path` 任せ（`SET search_path` も `CREATE SCHEMA` も発行しない）。 */
  schema?: string | undefined;
  /**
   * `vector` / `btree_gin` / `pgcrypto` を置くスキーマ。`schema` を指定したときだけ効く。
   * 既定は {@link DEFAULT_EXTENSION_SCHEMA}。
   */
  extensionSchema?: string | undefined;
}

/** PostgreSQL の識別子の上限（NAMEDATALEN - 1）。`embedding-space-table.ts` のものは private なので定義し直す。 */
const MAX_SCHEMA_NAME_BYTES = 63;

/**
 * スキーマ名として安全であることを検査する。
 *
 * 文字種の検査は `assertSafeIdentifier` をそのまま呼ぶ（正規表現を書き写すと、片方だけ直して食い違うため）。
 * それに加えて、UTF-8 で 63 バイトを超えたら投げる。文字種の失敗と長さの失敗はメッセージで区別できる。
 *
 * 見るのは文字種と長さだけで、PostgreSQL がスキーマ名として受け付けるかは見ない。`pg_` で始まる名前
 * （例: `pg_mnemora`）はこの検査を通るが、PostgreSQL が接頭辞を予約しているので、`runMigrations` の
 * `CREATE SCHEMA` が DB の例外（`unacceptable schema name`）で失敗する。
 */
export function assertSafeSchemaName(schema: string): void {
  assertSafeIdentifier(schema);
  if (Buffer.byteLength(schema, "utf8") > MAX_SCHEMA_NAME_BYTES) {
    throw new Error(
      `unsafe SQL schema name: ${schema} (${Buffer.byteLength(schema, "utf8")} bytes, ` +
        `limit is ${MAX_SCHEMA_NAME_BYTES} bytes — PostgreSQL の NAMEDATALEN 制限)`,
    );
  }
}

/**
 * SQL 文の中で使う、スキーマ修飾済みの識別子を組み立てる。
 * `schema === undefined` なら `name` をそのまま返し、それ以外は `"<schema>"."<name>"` にする。
 *
 * 名前の検査も引用文字のエスケープもしない。`schema` には `assertSafeSchemaName`、`name` には
 * `assertSafeIdentifier` を通した名前だけを渡すこと。
 */
export function qualify(schema: string | undefined, name: string): string {
  if (schema === undefined) {
    return name;
  }
  return `"${schema}"."${name}"`;
}

/**
 * `to_regclass('...')` のようにシングルクォート文字列の中に置く識別子を組み立てる。
 * `to_regclass` は二重引用符付き識別子（`"s"."t"`）をそのまま受け付けるので、`qualify` を使い回し、意図を示す別名として置く。
 * 検査もエスケープもしない点は `qualify` と同じ。
 */
export function qualifiedLiteral(schema: string | undefined, name: string): string {
  return qualify(schema, name);
}

/**
 * libpq の startup parameter `options`（`-c search_path=...`）とセッション内の `SET search_path` の両方で使える値を返す。
 *
 * 引用符を付けない。`options` の中では値の空白がパラメータの区切りになるので、引用やエスケープを持ち込むと
 * 組み立てが厄介になる。検証済みの識別子（`^[a-z_][a-z0-9_]*$`）という前提に頼る。
 * `schema === extensionSchema` のときは重複を落として1つだけ返す。
 *
 * `schema`・`extensionSchema` には、`assertSafeSchemaName` を通した名前だけを渡すこと。
 */
export function searchPathFor(schema: string, extensionSchema: string): string {
  if (schema === extensionSchema) {
    return schema;
  }
  return `${schema},${extensionSchema}`;
}

/**
 * pgvector が `hnsw.iterative_scan = relaxed_order`（ADR 0284、`vector-store.ts` の
 * `withRelaxedOrderScan`）を実際に解釈できるかどうかを検査する（Issue #1301、ADR 0367）。
 *
 * ## 版の文字列ではなく、能力で判定する
 *
 * 素朴には `pg_extension.extversion` を読んで `>= 0.8.0` かどうかを比べたくなる。
 * だが `current_setting('hnsw.iterative_scan', true)` を先に読んで「動くか」を確かめる
 * ような能力ベースの検査には、**placeholder の穴**がある——実測（ADR 0367 決定2）:
 *
 * - PostgreSQL の GUC は、`SET`/`ALTER DATABASE ... SET`/`ALTER ROLE ... SET`/
 *   `postgresql.conf` のいずれであっても、**それを定義するモジュールが読み込まれる前**は
 *   ただの文字列 placeholder として保持される。
 * - `current_setting(name, true)` は placeholder の値もそのまま返す——本物の GUC か
 *   placeholder かを区別しない。実測: 一度も予約されない prefix の下に
 *   `SET LOCAL mnemora_probe.iterative_scan = 'relaxed_order'` を置いただけで、
 *   `current_setting('mnemora_probe.iterative_scan', true)` は `'relaxed_order'` を返す
 *   ——本物の pgvector が定義した GUC は1つも読み込まれていないのに、である。
 * - 一方 `pg_settings` は placeholder を一切載せない（該当 SQL を実行すると0行）。
 *   実際にモジュールがロードされ、`DefineCustomEnumVariable` で定義された GUC だけが
 *   `vartype = 'enum'` の行として現れる。
 *
 * ⟹ **判定は `pg_settings` の行の有無と `vartype`/`enumvals` で行う。**
 * `current_setting` は使わない。
 *
 * ## 同じ接続で vector を使ってから読む
 *
 * pgvector のモジュールは、その接続（バックエンド）で初めて `vector` 型に触れたときに
 * ロードされる。ロードされるまでは `hnsw.iterative_scan` は（0.6.0 以降でも）
 * `pg_settings` に現れない。⟹ 同じ SQL 文の中で `vector` を使ってから `pg_settings` を
 * 読む——実測により、`LATERAL` は不要で、単純な `LEFT JOIN` で1往復に収まる
 * （`SELECT '[0]'::vector` を含む副問い合わせに `pg_extension`/`pg_settings` を
 * `LEFT JOIN` するだけで、モジュールのロードと読み取りが同じ文の中で順番に起こる）。
 *
 * `LEFT JOIN` にしてあるのは、`pg_settings` に行が無い場合（0.8 未満・拡張が無い等）でも
 * 常にちょうど1行を返すようにするため——「0行だから未対応」と「クエリの形が壊れて0行」を
 * 呼び出し側で区別しやすくする。
 *
 * ## 実測環境
 *
 * PostgreSQL 17.11 + pgvector 0.8.0（自分専用の `initdb` インスタンス、
 * `AGENTS.md`「手元で Postgres を立てる」の手順）。0.7 系以下の実物は手元に無い
 * （ビルド道具が無い）ため、Issue #1301 本文と同じ代理実測
 * （予約されない prefix の下で `SET LOCAL` を打つ）で placeholder の挙動を確認した。
 * 詳細と実測ログは ADR 0367。
 */

/**
 * pgvector の能力検査クエリ。**(a) `vector-store.ts` の `withRelaxedOrderScan`・
 * (b) `migrate.ts` の `runMigrations`（`create`/`verify` 両モード）の、唯一の発行元**
 * ——文字列は1つしか持たない（この定数を経由しない限り、同じ文を書き直さない）。
 *
 * - `load`: `vector` 型を1回使い、その接続でまだロードされていなければロードさせる。
 * - `ext`: `pg_extension` から `vector` の `extversion` を読む（エラーメッセージ用。
 *   判定そのものには使わない）。
 * - `s`: `pg_settings` から `hnsw.iterative_scan` の行を読む。`vartype`/`enumvals` が
 *   判定の根拠。
 *
 * ⚠ **このクエリは `vector` extension が既に存在することを呼び出し側が保証した上で
 * 呼ぶ**（`load` の `'[0]'::vector` キャストは、型が無ければ `type "vector" does not
 * exist` で例外になる——両方の呼び出し元は、既に extension の存在を確認済みの地点で
 * だけこの関数を呼ぶ）。
 */
export const PGVECTOR_CAPABILITY_QUERY = `SELECT ext.extversion AS extversion, s.vartype AS vartype, s.enumvals AS enumvals
FROM (SELECT '[0]'::vector AS probe) AS load
LEFT JOIN pg_extension ext ON ext.extname = 'vector'
LEFT JOIN pg_settings s ON s.name = 'hnsw.iterative_scan'`;

/** {@link PGVECTOR_CAPABILITY_QUERY} が返す1行の形。 */
export interface PgvectorCapabilityRow {
  extversion: string | null;
  vartype: string | null;
  enumvals: readonly string[] | null;
}

/** mnemora が要求する pgvector の最小版（`docs/memory-model.md`「前提: pgvector のバージョン」）。 */
export const PGVECTOR_REQUIRED_VERSION = "0.8.0";

/** {@link PgvectorVersionUnsupportedError.missingCapability} の値。今のところ1種類だけ。 */
export type PgvectorMissingCapability = "hnsw.iterative_scan";

/**
 * pgvector が {@link PGVECTOR_REQUIRED_VERSION} 未満（正確には、
 * `hnsw.iterative_scan` に `relaxed_order` が無い）ことを表す。
 *
 * `installed` は `pg_extension.extversion`（読めなければ `undefined`——`vector` 拡張
 * そのものが無いか、読む前に別の理由で落ちている場合）。文言には直し方
 * （ライブラリを上げる／`ALTER EXTENSION vector UPDATE;`）を具体的に書く——
 * `MissingExtensionsError`（`migrate.ts`）と同じ方針。
 */
export class PgvectorVersionUnsupportedError extends Error {
  /** `pg_extension.extversion`。拡張行が無ければ `undefined`。 */
  readonly installed: string | undefined;
  /** mnemora が要求する最小版。{@link PGVECTOR_REQUIRED_VERSION} と同じ。 */
  readonly required: string;
  /** 見当たらなかった能力。今のところ常に `"hnsw.iterative_scan"`。 */
  readonly missingCapability: PgvectorMissingCapability;

  constructor(installed: string | undefined) {
    const installedText =
      installed !== undefined
        ? `インストールされている版は ${installed} です`
        : `pg_extension に "vector" 拡張が見当たりません`;
    super(
      `pgvector が hnsw.iterative_scan の relaxed_order（ADR 0284）に対応していません。` +
        `${installedText}（必要な版: >= ${PGVECTOR_REQUIRED_VERSION}）。\n` +
        `pgvector のライブラリを ${PGVECTOR_REQUIRED_VERSION} 以上へ上げてください。` +
        `サーバー側のライブラリは既に上がっているのに拡張だけ古いままの場合は、` +
        `\`ALTER EXTENSION vector UPDATE;\` を実行してください。`,
    );
    this.name = "PgvectorVersionUnsupportedError";
    this.installed = installed;
    this.required = PGVECTOR_REQUIRED_VERSION;
    this.missingCapability = "hnsw.iterative_scan";
  }
}

/**
 * {@link PGVECTOR_CAPABILITY_QUERY} の結果1行から、対応しているかどうかを判定する。
 * 対応していなければ {@link PgvectorVersionUnsupportedError} を投げる（対応していれば
 * 何もしない）。
 *
 * 判定条件（すべて満たして初めて「対応」）:
 * - 行が存在する（`row !== undefined`。`LEFT JOIN` なので、クエリ自体が実行できていれば
 *   通常は常に1行返る——`undefined` は「クエリを一度も実行していない」呼び出し側の誤りを
 *   拾うための防御）。
 * - `vartype === "enum"`（placeholder はここに現れない——`pg_settings` に行が無ければ
 *   `LEFT JOIN` の結果として `vartype` は `null` になる）。
 * - `enumvals` が配列で、`"relaxed_order"` を含む。
 *
 * **版の文字列は一切見ない**（`extversion` は {@link PgvectorVersionUnsupportedError} の
 * メッセージに添えるだけ）——上のファイル doc コメント「版の文字列ではなく、能力で判定する」
 * を参照。
 */
export function assertPgvectorCapabilityRow(row: PgvectorCapabilityRow | undefined): void {
  const supported =
    row !== undefined &&
    row.vartype === "enum" &&
    Array.isArray(row.enumvals) &&
    row.enumvals.includes("relaxed_order");
  if (!supported) {
    throw new PgvectorVersionUnsupportedError(row?.extversion ?? undefined);
  }
}

/**
 * `pg`（`Pool`/`PoolClient` どちらも可——`.query(text)` を持つ最小の形）で
 * {@link PGVECTOR_CAPABILITY_QUERY} を発行し、{@link assertPgvectorCapabilityRow} で判定する。
 * `migrate.ts`（`runMigrations` の `create`/`verify` 両モード）専用。
 *
 * `vector-store.ts` は drizzle 経由（`db.execute`）で同じクエリ文字列を発行するため、
 * こちらのヘルパーは使わない（`PostgresVectorStore` 内の `assertPgvectorCapability` 参照）
 * ——`.query`/`.execute` のインターフェースの違いを、この2つの薄い呼び出し元にだけ
 * 閉じ込め、判定ロジック（{@link assertPgvectorCapabilityRow}）と SQL 文
 * （{@link PGVECTOR_CAPABILITY_QUERY}）は完全に共有する。
 */
export async function assertPgvectorCapabilityViaQuery(queryable: {
  query(text: string): Promise<{ rows: unknown[] }>;
}): Promise<void> {
  const { rows } = await queryable.query(PGVECTOR_CAPABILITY_QUERY);
  assertPgvectorCapabilityRow(rows[0] as PgvectorCapabilityRow | undefined);
}

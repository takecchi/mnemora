/**
 * pgvector が `hnsw.iterative_scan = relaxed_order`（ADR 0284）を実際に解釈できるかを検査する（ADR 0367）。
 *
 * 判定は版の文字列（`extversion >= 0.8.0`）でなく、`pg_settings` の行の有無と `vartype`/`enumvals` で行う。
 * `current_setting('hnsw.iterative_scan', true)` で「動くか」を確かめる書き方にしないこと。GUC は定義するモジュールが
 * 読み込まれる前は文字列の placeholder として保持され、`current_setting` は placeholder の値もそのまま返すので、
 * 本物の GUC と区別できない。`pg_settings` は placeholder を載せない。
 *
 * pgvector のモジュールは、その接続で初めて `vector` 型に触れたときにロードされ、それまで `pg_settings` に
 * `hnsw.iterative_scan` が現れない。そのため同じ SQL 文の中で `vector` を使ってから `pg_settings` を読む。
 * `LEFT JOIN` にしてあるのは、行が無い場合（0.8 未満・拡張が無い等）でも常にちょうど1行を返すため。
 */

/**
 * pgvector の能力検査クエリ。`vector-store.ts` の `withRelaxedOrderScan` と `runMigrations`（`create`/`verify` 両モード）の
 * 唯一の発行元で、同じ文を書き直さない。`extversion` はエラーメッセージ用で、判定には使わない。
 *
 * `vector` extension が既に存在することを呼び出し側が保証してから呼ぶ（`'[0]'::vector` のキャストは、型が無ければ例外になる）。
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

/** mnemora が要求する pgvector の最小版。 */
export const PGVECTOR_REQUIRED_VERSION = "0.8.0";

/** {@link PgvectorVersionUnsupportedError.missingCapability} の値。今のところ1種類だけ。 */
export type PgvectorMissingCapability = "hnsw.iterative_scan";

/**
 * pgvector が {@link PGVECTOR_REQUIRED_VERSION} 未満（正確には `hnsw.iterative_scan` に `relaxed_order` が無い）ことを表す。
 * `installed` は `pg_extension.extversion`（読めなければ `undefined`）。文言には直し方を具体的に書く。
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
 * {@link PGVECTOR_CAPABILITY_QUERY} の結果1行から、対応しているかを判定する。対応していなければ
 * {@link PgvectorVersionUnsupportedError} を投げる。
 *
 * 次をすべて満たして初めて対応とみなす: 行が存在する（`undefined` はクエリを実行していない呼び出し側の誤りを拾う防御）、
 * `vartype === "enum"`、`enumvals` が `"relaxed_order"` を含む。版の文字列は見ない。
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
 * `Pool`/`PoolClient`（`.query(text)` を持つ最小の形）で {@link PGVECTOR_CAPABILITY_QUERY} を発行し、
 * {@link assertPgvectorCapabilityRow} で判定する。`vector-store.ts` は drizzle 経由で同じ文を発行するので、
 * このヘルパーは使わない。
 */
export async function assertPgvectorCapabilityViaQuery(queryable: {
  query(text: string): Promise<{ rows: unknown[] }>;
}): Promise<void> {
  const { rows } = await queryable.query(PGVECTOR_CAPABILITY_QUERY);
  assertPgvectorCapabilityRow(rows[0] as PgvectorCapabilityRow | undefined);
}

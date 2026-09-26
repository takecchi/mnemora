import type { Pool } from "pg";
import type { EmbeddingSpaceId } from "@mnemora/core";
import {
  assertSafeIdentifier,
  embeddingSpaceIndexName,
  embeddingSpaceTableName,
  embeddingSpaceZeroNormIndexName,
} from "./embedding-space-table.js";
import {
  AdvisoryLockTimeoutError,
  AdvisoryLockUnavailableError,
  DEFAULT_LOCK_TIMEOUT_MS,
  acquireAdvisoryLock,
  deriveAdvisoryLockKey,
  releaseAdvisoryLock,
} from "./advisory-lock.js";
import { resolveCurrentSchema } from "./resolve-current-schema.js";
import {
  DEFAULT_EXTENSION_SCHEMA,
  type SchemaNamespaceOptions,
  assertSafeSchemaName,
  qualify,
} from "./schema-namespace.js";

/**
 * `registerEmbeddingSpace` がプロセス間排他に使う advisory lock のキー（段階2・ADR 0018）。
 *
 * `MIGRATION_LOCK_KEY`（`./migrate.ts`）と**意図的に別の値**にしてある——`runMigrations`
 * と `registerEmbeddingSpace` が互いを無関係にブロックしないため（同じキーを使うと、
 * 例えば「マイグレーション中の別プロセス」が「埋め込み空間を登録しようとしたプロセス」を
 * 意図せず待たせることになる）。
 *
 * `MIGRATION_LOCK_KEY` と**同じ導出手順**（固定文字列
 * `"mnemora:registerEmbeddingSpace:advisory-lock"` の SHA-256 先頭8バイトを符号付き64bit
 * 整数として解釈した値）で計算してあり、**実行時に変わらない定数**としてハードコードして
 * ある（`node -e 'const c=require("crypto");console.log(c.createHash("sha256").update("mnemora:registerEmbeddingSpace:advisory-lock").digest().readBigInt64BE(0).toString())'`
 * で再計算できる。値そのものに意味は無く、衝突回避のためだけに存在する）。
 *
 * **埋め込み空間ごとにキーを分けない**（`EmbeddingSpaceId` から導出したりしない）。
 * 理由と引き受けるトレードオフ（別空間の同時登録が直列化される）は ADR 0018 参照。
 *
 * 値を変えると、新旧のプロセスが違うキーで別々にロックを取り、排他が効かなくなる
 * ため、ローリングデプロイ中の互換性が壊れる。変える理由が生まれたら ADR を書くこと。
 */
export const REGISTER_EMBEDDING_SPACE_LOCK_KEY = -4359922960011245935n;

/**
 * pgvector の hnsw 索引が `vector` 型に対して受け付ける次元数の上限（ADR 0018 C-2 →
 * Issue #776 で直した）。
 *
 * **出典**:
 * - pgvector の README（`vector` 型に対する HNSW 索引の節）: "up to 2,000 dimensions"
 *   （`halfvec` は 4,000、`sparsevec` は 1,000 と別の上限を持つが、`registerEmbeddingSpace`
 *   が発行する DDL は常に `vector` 型・`hnsw` 索引で、分岐は無い——下の `CREATE TABLE` /
 *   `CREATE INDEX ... USING hnsw` を参照。この上限がそのまま当たる）。
 * - 実測（手元の pgvector 0.8.0、ADR 0018 C-2 追記と同じ形）: `dimensions=2000` は
 *   `CREATE TABLE` / `CREATE INDEX ... USING hnsw` とも成功し、`dimensions=2001` は
 *   索引作成が `54000`（"column cannot have more than 2000 dimensions for hnsw index"）
 *   で失敗する（`__tests__/vector-space-dimensions-limit.test.ts` が固定）。
 *
 * **この値は pgvector 側のコンパイル時定数に由来し、mnemora の `main` が動いても変わらない**
 * ——AGENTS.md「数を、道具と生成物に焼き込まない」の対象外（`embedding-space-table.ts` の
 * `MAX_IDENTIFIER_BYTES`、PostgreSQL の `NAMEDATALEN` 由来の定数と同じ形）。将来 pgvector が
 * この上限を変えたら、実測し直してここを直すこと。
 */
const HNSW_VECTOR_INDEX_MAX_DIMENSIONS = 2000;

export interface RegisterEmbeddingSpaceOptions extends SchemaNamespaceOptions {
  /** advisory lock を待つ上限（ミリ秒）。既定は {@link DEFAULT_LOCK_TIMEOUT_MS}。 */
  lockTimeoutMs?: number;
  /** advisory lock のキー。テスト以外で既定の {@link REGISTER_EMBEDDING_SPACE_LOCK_KEY} を変える理由は無い。 */
  lockKey?: bigint;
}

/**
 * `schema` から `registerEmbeddingSpace` の advisory lock キーを導く（feat/dedicated-schema）。
 *
 * `migrationLockKeyFor`（`./migrate.ts`）と**同じ規則**（`schema === undefined` または
 * `"public"` なら既存の {@link REGISTER_EMBEDDING_SPACE_LOCK_KEY} を、それ以外は
 * `deriveAdvisoryLockKey` で `schema` ごとに導出したキーを返す）。理由も同じ——
 * ローリングデプロイ中の旧プロセスとの排他を壊さないため、既定経路のキーは変えない。
 *
 * ⚠ **ADR 0018 は「埋め込み空間ごとにキーを分けない」と決めている。** ここで分けるのは
 * **スキーマ**の軸であって**空間**の軸ではない——`EmbeddingSpaceId` は一切関与しない。
 * ADR 0018 の決定（別空間の同時登録は直列化されるトレードオフを引き受ける）はそのまま
 * 保たれる。`schema` ごとに別キーにする理由は `migrationLockKeyFor` と同一で、
 * 「2つの mnemora が同じ DB の別スキーマに同居すると、片方の registerEmbeddingSpace が
 * もう片方を黙ってブロックする」ことを防ぐため。
 *
 * **この関数自身は同期関数で DB 接続を持たない**ため、`schema` 未指定のときに実際どの
 * スキーマが使われるかはそれ自身では特定できない——`registerEmbeddingSpace` が呼び出し側
 * として、ロック取得より前に {@link resolveCurrentSchema} で読んだ値をこの引数へ渡す
 * （Issue #779。`migrate.ts` の `migrationLockKeyFor` と同じ形）。読めなかった場合
 * （`current_schema()` が `NULL`）は `undefined` のまま渡され、既存の
 * {@link REGISTER_EMBEDDING_SPACE_LOCK_KEY} になる。
 *
 * ⚠ **この関数のシグネチャ・戻り値は公開 API であり、変えていない。** `schema` を渡す
 * *前*に実行時解決を挟む責務は呼び出し側（`registerEmbeddingSpace`）にある。
 */
export function registerEmbeddingSpaceLockKeyFor(schema?: string): bigint {
  if (schema === undefined || schema === "public") {
    return REGISTER_EMBEDDING_SPACE_LOCK_KEY;
  }
  return deriveAdvisoryLockKey(`mnemora:registerEmbeddingSpace:advisory-lock:${schema}`);
}

export interface RegisterEmbeddingSpaceResult {
  /**
   * 排他の観測値。`waitedMs` は「ロックが空くまで実際に待った時間」（ミリ秒）。
   * 他プロセスが同時に registerEmbeddingSpace を呼んでいなければ 0 に近い値になる。
   * `runMigrations` の `RunMigrationsResult.lock` と同じ形（ADR 0018、「学ぶことが
   * 1つで済む」という要求に対応する）。
   */
  lock: { waitedMs: number };
}

/**
 * advisory lock の取得が「待ち時間切れで失敗した」ことを表す。`registerEmbeddingSpace` 版。
 * 詳細は `./advisory-lock.ts` の `AdvisoryLockTimeoutError` と
 * `./migrate.ts` の `MigrationLockTimeoutError` を参照（同じ3状態の区別をここでも保つ）。
 */
export class RegisterEmbeddingSpaceLockTimeoutError extends AdvisoryLockTimeoutError {
  constructor(waitedMs: number, cause: unknown) {
    super(
      `registerEmbeddingSpace: advisory lock を ${waitedMs}ms 待ったが取得できなかった` +
        `（タイムアウト）。他プロセスが registerEmbeddingSpace を握ったまま応答していない可能性がある。`,
      cause,
    );
    this.name = "RegisterEmbeddingSpaceLockTimeoutError";
  }
}

/**
 * advisory lock を取得する**操作自体**が失敗したことを表す。`registerEmbeddingSpace` 版。
 * 権限不足・接続不可などが原因で、待ち時間切れ（`RegisterEmbeddingSpaceLockTimeoutError`）
 * とは別物として区別できる。
 */
export class RegisterEmbeddingSpaceLockUnavailableError extends AdvisoryLockUnavailableError {
  constructor(cause: unknown) {
    super(
      `registerEmbeddingSpace: advisory lock を取得する操作自体が失敗した` +
        `（権限不足・接続不可などで、待ち時間切れとは別の原因）。`,
      cause,
    );
    this.name = "RegisterEmbeddingSpaceLockUnavailableError";
  }
}

const REGISTER_EMBEDDING_SPACE_LOCK_ERRORS = {
  timeout: (waitedMs: number, cause: unknown) =>
    new RegisterEmbeddingSpaceLockTimeoutError(waitedMs, cause),
  unavailable: (cause: unknown) => new RegisterEmbeddingSpaceLockUnavailableError(cause),
};

/**
 * 埋め込み空間ごとのテーブル（`memory_embeddings_<space>`）を登録する
 * （docs/memory-model.md §10「決定: 埋め込み空間を登録する操作の一部として...テーブルを作る」）。
 *
 * `migrate.ts`（`migrations/*.sql`）とは別の口だが、同じ規約に従う——
 * **DDL はすべてこの関数の中に手書きで置き、drizzle-kit には一切頼らない**
 * （ADR 0001）。HNSW 索引の operator class もここで明示する。
 *
 * ## 排他（段階2・ADR 0018）
 *
 * **`IF NOT EXISTS` は「べき等」であって「並行安全」ではない。** 単独プロセスから
 * 何度呼んでも同じ結果に収束する（べき等）が、`CREATE TABLE IF NOT EXISTS` /
 * `CREATE INDEX IF NOT EXISTS` はいずれも「存在チェック」と「作成」がアトミックではない
 * ため、複数プロセスが同時に呼ぶと**決定的に**（段階1の実測で試行した全件で）どちらか
 * 一方が `duplicate key value violates unique constraint` で落ちる
 * （テーブル層は `pg_type_typname_nsp_index`、索引層は `pg_class_relname_nsp_index`。
 * 詳細は ADR 0018）。そのため呼び出し全体を advisory lock
 * （`REGISTER_EMBEDDING_SPACE_LOCK_KEY`）で包む——`runMigrations`（ADR 0017）と
 * 同じ機構を `./advisory-lock.ts` から共有している。
 *
 * バリデーション（`dimensions` の検査・識別子の安全性チェック）は**ロック取得より前**に
 * 行う——不正な入力のためにロックを取って他プロセスを待たせる意味が無いため。
 *
 * 起こりうる3つの状態（`runMigrations` と同じ語彙、オーナーが引いた線1）:
 * - 待って取れた → 通常どおり完了し、戻り値の `lock.waitedMs` に待った時間が載る
 * - 待ったが時間切れ → {@link RegisterEmbeddingSpaceLockTimeoutError} を投げる
 *   （黙って続行しない）
 * - ロック取得の操作自体が失敗（権限不足・接続不可等） →
 *   {@link RegisterEmbeddingSpaceLockUnavailableError} を投げる（時間切れと取り違えない）
 *
 * テーブル名・索引名は `EmbeddingSpaceId` から機械的に導出するため、呼び出し側が
 * 直接テーブル名を書く必要はない（`VectorStore` 実装がこの関数と同じ導出規則を使う）。
 *
 * ## `options.schema`（feat/dedicated-schema）
 *
 * **`schema` 未指定なら、発行される DDL は今日と1バイトも変わらない**（`qualify` が
 * 識別子を素通しするため）。ただし **`options.lockKey` を上書きしない呼び出しは、
 * ロック取得より前に `SELECT current_schema()` を1回発行する**（Issue #779、
 * {@link registerEmbeddingSpaceLockKeyFor} の doc 参照）——DDL には触れない、
 * advisory lock のキーを実際のスキーマに揃えるためだけの読み取りである。
 * `schema` を指定すると、テーブル・外部キー参照先・索引を
 * `qualify(schema, ...)` で完全修飾し、`vector` / `vector_cosine_ops` の型・operator
 * class を `qualify(extensionSchema, ...)` で修飾する（`extensionSchema` 省略時は
 * {@link DEFAULT_EXTENSION_SCHEMA}）。**`search_path` は一切触らない**——`migrate.ts`
 * の `SET LOCAL` と違い、`registerEmbeddingSpace` は `pool.query` を直接使う
 * （専用コネクションを保持しない）ため、`SET LOCAL` で守れる範囲のトランザクションを
 * 持たない。完全修飾すれば `search_path` に依存する必要が無く、pool のコネクションに
 * session 状態を残す心配も無くなる。
 *
 * **索引名は修飾しない**——索引は常にテーブルと同じスキーマに作られるので、
 * `CREATE INDEX ... ON <table>` の索引名の位置にスキーマ修飾を書くと構文エラーになる。
 */
export async function registerEmbeddingSpace(
  pool: Pool,
  space: EmbeddingSpaceId,
  options: RegisterEmbeddingSpaceOptions = {},
): Promise<RegisterEmbeddingSpaceResult> {
  if (!Number.isInteger(space.dimensions) || space.dimensions <= 0) {
    throw new Error(`invalid embedding space dimensions: ${space.dimensions}`);
  }
  // ADR 0018 C-2: pgvector の hnsw 索引は vector 型に対して2000次元までしか受け付けない
  // （HNSW_VECTOR_INDEX_MAX_DIMENSIONS のコメントに出典）。テーブルを作る前に、この上限を
  // ロック取得より前で検査して拒否する——検査しないと、テーブルだけ作られて索引作成が
  // `54000` で落ち、テーブルが残ったまま失敗する（ADR 0018 C-2 が N=1 で実測済み）。
  if (space.dimensions > HNSW_VECTOR_INDEX_MAX_DIMENSIONS) {
    throw new Error(
      `invalid embedding space dimensions: ${space.dimensions} ` +
        `(pgvector の hnsw 索引は vector 型に対して最大 ${HNSW_VECTOR_INDEX_MAX_DIMENSIONS} ` +
        `次元までしか受け付けない。テーブルは作成していない)`,
    );
  }

  const { schema } = options;
  if (schema !== undefined) {
    assertSafeSchemaName(schema);
  }
  const extensionSchema =
    schema === undefined ? undefined : (options.extensionSchema ?? DEFAULT_EXTENSION_SCHEMA);
  if (extensionSchema !== undefined) {
    assertSafeSchemaName(extensionSchema);
  }

  const table = embeddingSpaceTableName(space);
  const index = embeddingSpaceIndexName(space);
  const zeroNormIndex = embeddingSpaceZeroNormIndexName(space);
  assertSafeIdentifier(table);
  assertSafeIdentifier(index);
  assertSafeIdentifier(zeroNormIndex);

  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  // Issue #779: `migrate.ts` の `runMigrations` と同じ形——`schema` 未指定かつ
  // `options.lockKey` の上書きも無いときだけ、ロック取得より前に同じ `pool` で
  // `SELECT current_schema()` を読み、実際に解決されたスキーマ名で
  // `registerEmbeddingSpaceLockKeyFor` を呼ぶ。
  const lockKey =
    options.lockKey ??
    registerEmbeddingSpaceLockKeyFor(
      schema === undefined ? await resolveCurrentSchema(pool) : schema,
    );

  const { client: lockClient, waitedMs } = await acquireAdvisoryLock(
    pool,
    lockKey,
    lockTimeoutMs,
    REGISTER_EMBEDDING_SPACE_LOCK_ERRORS,
  );
  try {
    // dimensions は上で正整数であることを確認済みなので、そのまま埋め込んでよい
    // （パラメータ化できない — vector(N) の N は SQL の識別子/型修飾子の位置にある）。
    // `"public"."vector"(1536)` は正しい型構文である（`qualify` が schema 未指定なら
    // 素通しするので、schema 未指定時は今日と同じ `vector(1536)` になる）。
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${qualify(schema, table)} (
        tenant_id   text         NOT NULL,
        memory_id   uuid         NOT NULL REFERENCES ${qualify(schema, "memories")}(id) ON DELETE CASCADE,
        embedding   ${qualify(extensionSchema, "vector")}(${space.dimensions}) NOT NULL,
        model       text         NOT NULL,
        created_at  timestamptz  NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, memory_id)
      );
    `);

    // HNSW 索引。operator class を明示する（cosine 距離を採用する。
    // docs/memory-model.md §10 の例と同じ形）。索引名は修飾しない（索引は
    // テーブルと同じスキーマに作られる）。
    await pool.query(`
      CREATE INDEX IF NOT EXISTS ${index}
        ON ${qualify(schema, table)}
        USING hnsw (embedding ${qualify(extensionSchema, "vector_cosine_ops")});
    `);

    // Issue #956: 上の HNSW 索引（cosine 距離）は norm が0のベクトル（ゼロベクトル）を
    // そもそも索引へ入れない——pgvector の README「Why are there less results for a
    // query after adding an HNSW index?」の "Also, note that `NULL` vectors are not
    // indexed (as well as zero vectors for cosine distance)."、実装は pgvector
    // `src/hnswutils.c` の `HnswFormIndexValue`/`HnswCheckNorm`（norm が0以下なら
    // `false` を返し、そのタプルは索引に追加されない）。⟹ `search()`/`searchMany()`
    // が HNSW Index Scan を選ぶと、ゼロベクトルの候補は ADR 0040 の契約
    // （比較不能でも候補として返す）に反して結果から消える。
    //
    // この部分索引は、`search()`/`searchMany()` がゼロベクトルの候補だけを別枝
    // （`UNION ALL`）で拾うために使う。`WHERE vector_norm(embedding) = 0` に絞るため、
    // テーブル全体の行数に関係なく、この索引が持つ行数（通常0件）だけを読む
    // （`vector-store.ts` の doc コメント参照。`EXPLAIN` で実測済み）。
    //
    // ⚠ **この索引を作る経路はここ1箇所だけである。** `memory_embeddings_<space>`
    // テーブルと HNSW 索引自体も migrations/*.sql には無く、`registerEmbeddingSpace`
    // （このプロセス起動のたびに呼ばれる、べき等な `CREATE ... IF NOT EXISTS`）だけが
    // 作る——`<space>` はテーブル名に埋め込まれる動的な値であり、migration 作成時点では
    // 個々の空間名を列挙できない（`docs/decisions/0202-postgres-shared-db-object-names.md`
    // 「実行時に増える系列」と同じ理由）。⟹ **「新しく作る空間」と「この修正より前から
    // 存在する空間」は同じコードパスを通る**——違うのは `IF NOT EXISTS` が実行される
    // タイミング（初回作成時か、この修正を含むバージョンへ上げた後の次回起動時か）だけ。
    // 既存の HNSW 索引自体も同じ性質（`registerEmbeddingSpace` の再実行に依存する）を
    // 持っており、この部分索引が新しく背負う運用上の負債ではない。
    //
    // ⚠ **既存の大きな embedding テーブルに対しては、この `CREATE INDEX`（`CONCURRENTLY`
    // を使わない素の形）が対象テーブルに `ACCESS EXCLUSIVE` ロックを取り、構築が終わる
    // まで読み書きを止める**（ADR 0059/0062 が `memories` の索引で同じ形を記録済み。
    // `CONCURRENTLY` を使えない理由も同じ——`migrate.ts` は1ファイル=1トランザクション
    // だが、`registerEmbeddingSpace` 自体はトランザクションを開かない代わりに
    // advisory lock で直列化しており、`CONCURRENTLY` は別の理由（索引が2本同時に
    // 作られる競合を pgvector 側で検査していない）で見送っている——詳細は ADR 0356
    // 「引き受けた負債」）。実測した構築時間は同 ADR を参照。
    await pool.query(`
      CREATE INDEX IF NOT EXISTS ${zeroNormIndex}
        ON ${qualify(schema, table)} (tenant_id, memory_id)
        WHERE ${qualify(extensionSchema, "vector_norm")}(embedding) = 0;
    `);
  } finally {
    await releaseAdvisoryLock(lockClient, lockKey);
  }

  return { lock: { waitedMs } };
}

import type { Pool, PoolClient } from "pg";
import { escapeLiteral } from "pg";
import type { EmbeddingSpaceId } from "@mnemora/core";
import {
  assertSafeIdentifier,
  embeddingSpaceIndexName,
  embeddingSpaceMemoryIdIndexName,
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
import { createIndexIfNotExistsAbsorbingRace } from "./create-index-race.js";
import { resolveCurrentSchema } from "./resolve-current-schema.js";
import {
  DEFAULT_EXTENSION_SCHEMA,
  type SchemaNamespaceOptions,
  assertSafeSchemaName,
  qualifiedLiteral,
  qualify,
} from "./schema-namespace.js";

/** 空間ごとのテーブルのコメントに記録する、空間の組の接頭辞。この接頭辞で始まらないコメントは利用者が付けたものとして扱う。 */
const EMBEDDING_SPACE_COMMENT_PREFIX = "mnemora:embedding-space:";

function embeddingSpaceComment(space: EmbeddingSpaceId): string {
  return `${EMBEDDING_SPACE_COMMENT_PREFIX}${JSON.stringify({
    provider: space.provider,
    model: space.model,
    dimensions: space.dimensions,
  })}`;
}

/**
 * `embeddingSpaceTableName` は単射ではなく、正規化の後に同じ綴りになる空間どうしは同じテーブルになる。
 * 導出は変えず、テーブルのコメントに空間の組（元の値）を記録して見張る。
 *
 * - コメントが無い: この登録の組を記録する。既存のテーブルは、この後で最初に登録した組が持ち主になる。
 * - mnemora の記録で、組が同じ: 何もしない。
 * - mnemora の記録で、組が違う: 何も書かずに、`name` が `"EmbeddingSpaceTableConflictError"` の `Error` を投げる。
 * - mnemora の形ではないコメント: 利用者のものとして上書きせず、見張らない。
 *
 * advisory lock の内側で呼ぶこと（読んでから書くまでに、別の登録が割り込まないため）。
 */
async function recordOrCheckEmbeddingSpace(
  db: Pick<PoolClient, "query">,
  schema: string | undefined,
  table: string,
  space: EmbeddingSpaceId,
): Promise<void> {
  const result = await db.query<{ comment: string | null }>(
    `SELECT obj_description(to_regclass($1), 'pg_class') AS comment`,
    [qualifiedLiteral(schema, table)],
  );
  const recorded = result.rows[0]?.comment ?? null;
  const expected = embeddingSpaceComment(space);
  if (recorded === null) {
    await db.query(`COMMENT ON TABLE ${qualify(schema, table)} IS ${escapeLiteral(expected)}`);
    return;
  }
  if (!recorded.startsWith(EMBEDDING_SPACE_COMMENT_PREFIX) || recorded === expected) {
    return;
  }
  const error = new Error(
    `registerEmbeddingSpace: テーブル ${table} は別の埋め込み空間が使っている` +
      `（記録: ${recorded.slice(EMBEDDING_SPACE_COMMENT_PREFIX.length)}、` +
      `今回: ${expected.slice(EMBEDDING_SPACE_COMMENT_PREFIX.length)}）。` +
      `provider・model を小文字にし英数字以外を _ にした綴りが同じになる空間は、同じテーブルに潰れる` +
      `（Issue #1151）。正規化の後にも区別が残る provider・model を選ぶこと。`,
  );
  error.name = "EmbeddingSpaceTableConflictError";
  throw error;
}

/**
 * `registerEmbeddingSpace` がプロセス間排他に使う advisory lock のキー（ADR 0018）。
 *
 * `MIGRATION_LOCK_KEY` と意図して別の値にしてある。同じキーだと、マイグレーション中の別プロセスが
 * 埋め込み空間の登録を無関係に待たせる。導出は `MIGRATION_LOCK_KEY` と同じで（固定文字列
 * `"mnemora:registerEmbeddingSpace:advisory-lock"` の SHA-256 先頭8バイトを符号付き64bit整数として解釈）、
 * 実行時に変わらない定数としてハードコードしてある。
 *
 * 埋め込み空間ごとにキーを分けない（別空間の同時登録が直列化されるトレードオフを引き受ける。ADR 0018）。
 * 値を変えると、新旧のプロセスが違うキーでロックを取り、ローリングデプロイ中の排他が効かなくなる。
 */
export const REGISTER_EMBEDDING_SPACE_LOCK_KEY = -4359922960011245935n;

/**
 * pgvector の hnsw 索引が `vector` 型に対して受け付ける次元数の上限（ADR 0018）。
 * pgvector の README は "up to 2,000 dimensions" と書く。`dimensions=2001` は索引作成が
 * `54000` で失敗する。pgvector 側のコンパイル時定数に由来するので、将来変わったら実測し直してここを直すこと。
 */
const HNSW_VECTOR_INDEX_MAX_DIMENSIONS = 2000;

/** {@link registerEmbeddingSpace} の設定。スキーマの指定は {@link SchemaNamespaceOptions} から継ぐ。 */
export interface RegisterEmbeddingSpaceOptions extends SchemaNamespaceOptions {
  /** advisory lock を待つ上限（ミリ秒）。既定は {@link DEFAULT_LOCK_TIMEOUT_MS}。 */
  lockTimeoutMs?: number | undefined;
  /** advisory lock のキー。テスト以外で既定の {@link REGISTER_EMBEDDING_SPACE_LOCK_KEY} を変える理由は無い。 */
  lockKey?: bigint | undefined;
}

/**
 * `schema` から `registerEmbeddingSpace` の advisory lock キーを導く。`migrationLockKeyFor` と同じ規則で、
 * `schema === undefined` または `"public"` なら既存の {@link REGISTER_EMBEDDING_SPACE_LOCK_KEY}、
 * それ以外は `deriveAdvisoryLockKey` で `schema` ごとに導出したキーを返す。
 * 既定経路のキーを変えないのは、ローリングデプロイ中の旧プロセスとの排他を壊さないため。
 *
 * ADR 0018 の「埋め込み空間ごとにキーを分けない」は保たれる。分けるのはスキーマの軸で、`EmbeddingSpaceId` は関与しない。
 * 2つの mnemora が同じ DB の別スキーマに同居しても、片方が他方を黙ってブロックしないようにするため。
 *
 * 同期関数で DB 接続を持たないので、`schema` 未指定時に実際に使われるスキーマは知らない。
 * `registerEmbeddingSpace` が `resolveCurrentSchema` で読んだ値を渡す（`current_schema()` が `NULL` なら
 * `undefined` のまま渡され、既存のキーになる）。
 */
export function registerEmbeddingSpaceLockKeyFor(schema?: string): bigint {
  if (schema === undefined || schema === "public") {
    return REGISTER_EMBEDDING_SPACE_LOCK_KEY;
  }
  return deriveAdvisoryLockKey(`mnemora:registerEmbeddingSpace:advisory-lock:${schema}`);
}

/** {@link registerEmbeddingSpace} の戻り値。 */
export interface RegisterEmbeddingSpaceResult {
  /**
   * 排他の観測値。`waitedMs` は、ロックが空くまで実際に待った時間（ミリ秒）。
   * 他プロセスが同時に呼んでいなければ 0 に近い。`runMigrations` の `RunMigrationsResult.lock` と同じ形。
   */
  lock: { waitedMs: number };
}

/** advisory lock の取得が待ち時間切れで失敗したことを表す。`registerEmbeddingSpace` 版（`AdvisoryLockTimeoutError` の派生）。 */
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
 * advisory lock を取得する操作自体が失敗したこと（権限不足・接続不可など）を表す。`registerEmbeddingSpace` 版。
 * 待ち時間切れ（`RegisterEmbeddingSpaceLockTimeoutError`）とは区別できる。
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
 * 埋め込み空間ごとのテーブル（`memory_embeddings_<space>`）を登録する（docs/memory-model.md §10）。
 *
 * `migrations/*.sql` とは別の口だが、DDL はこの関数の中に手書きで置き、drizzle-kit には頼らない（ADR 0001）。
 * HNSW 索引の operator class もここで明示する。
 *
 * ## 排他（ADR 0018）
 *
 * `IF NOT EXISTS` は冪等だが並行安全ではない。`CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` は
 * 存在チェックと作成がアトミックでないので、複数プロセスが同時に呼ぶと、どちらかが
 * `duplicate key value violates unique constraint` で落ちる。そのため呼び出し全体を advisory lock
 * （`REGISTER_EMBEDDING_SPACE_LOCK_KEY`）で包む。
 *
 * バリデーションはロック取得より前に行う（不正な入力のためにロックを取って他プロセスを待たせる意味が無い）。
 * `space.dimensions` が数でなければ `TypeError`、正の整数でない・pgvector の hnsw 索引の上限を超えるときは
 * `RangeError`（どちらもテーブルは作らない）。`schema`・`extensionSchema` が `assertSafeSchemaName` を通らなければ
 * 通常の `Error`（`extensionSchema` は `schema` を指定したときだけ検査する）。
 *
 * 起こりうる3つの状態:
 * - 待って取れた: 通常どおり完了し、戻り値の `lock.waitedMs` に待った時間が載る。
 * - 待ったが時間切れ: {@link RegisterEmbeddingSpaceLockTimeoutError} を投げる（黙って続行しない）。
 * - ロック取得の操作自体が失敗（権限不足・接続不可等）: {@link RegisterEmbeddingSpaceLockUnavailableError} を投げる。
 *
 * テーブル名・索引名は `EmbeddingSpaceId` から機械的に導出するので、呼び出し側がテーブル名を書く必要はない。
 *
 * ## 正規化の後に同じ綴りになる空間は、同じテーブルに潰れる
 *
 * 導出（{@link embeddingSpaceTableName}）は provider・model を小文字にし、英数字以外の並びを `_` に置き換えてから繋ぐ。
 * `{a_b, c}` と `{a, b_c}`、`{openai, text-embedding-3-small}` と `{OpenAI, text_embedding_3_small}`、
 * ASCII 以外の文字だけが違う model 名は、次元が同じなら同じテーブルになる。
 * この関数がテーブルのコメントに空間の組（元の値）を記録して突き合わせ、別の組が記録されたテーブルへの登録は
 * 何も書かずに `name` が `"EmbeddingSpaceTableConflictError"` の `Error` で拒む（新しい export は無いので `err.name` で見分ける）。
 * コメントの無いテーブルは、この登録の組を記録して通す（既存のテーブルは、この後で最初に登録した組が持ち主になる）。
 * mnemora の形ではないコメントは上書きせずに通す（そのテーブルは見張れない）。見張るのは登録の口だけで、
 * `upsert`・`search` はコメントを見ない。1つの DB で複数の空間を使うなら、正規化の後にも区別が残る
 * provider・model を選ぶこと。
 *
 * コメントの記録は `COMMENT ON TABLE` なのでテーブルの所有者の権限が要る。`CREATE INDEX IF NOT EXISTS` も
 * 同じ権限を要するので、登録を通せるロールの範囲は変わらない。
 *
 * ## `options.schema`
 *
 * `schema` 未指定なら、DDL は schema を指定しない形のまま。ただし `options.lockKey` を上書きしない呼び出しは、
 * ロック取得より前に `SELECT current_schema()` を1回発行する（lock キーを実際のスキーマに揃えるための読み取りで、
 * {@link registerEmbeddingSpaceLockKeyFor} を参照）。
 * `schema` を指定すると、テーブル・外部キー参照先・索引を `qualify(schema, ...)` で完全修飾し、`vector` /
 * `vector_cosine_ops` の型・operator class を `qualify(extensionSchema, ...)` で修飾する
 * （`extensionSchema` 省略時は {@link DEFAULT_EXTENSION_SCHEMA}）。
 *
 * `search_path` は触らない。`SET LOCAL` で守れるトランザクションを持たない（advisory lock を握った専用コネクションの上で、
 * `BEGIN` を開かずに DDL を打つ。ADR 0460）ので、完全修飾して `search_path` に依存せず、
 * pool のコネクションに session 状態を残さない。
 *
 * 索引名は修飾しない。索引は常にテーブルと同じスキーマに作られ、索引名の位置にスキーマ修飾を書くと構文エラーになる。
 */
export async function registerEmbeddingSpace(
  pool: Pool,
  space: EmbeddingSpaceId,
  options: RegisterEmbeddingSpaceOptions = {},
): Promise<RegisterEmbeddingSpaceResult> {
  // ADR 0525: 型の誤りは TypeError、範囲の誤りは RangeError。
  if (typeof space.dimensions !== "number") {
    throw new TypeError(
      `invalid embedding space dimensions: ${space.dimensions} ` +
        "(正の整数である必要がある。テーブルは作成していない)",
    );
  }
  if (!Number.isInteger(space.dimensions) || space.dimensions <= 0) {
    throw new RangeError(
      `invalid embedding space dimensions: ${space.dimensions} ` +
        "(正の整数である必要がある。テーブルは作成していない)",
    );
  }
  // pgvector の hnsw 索引は vector 型に対して 2000 次元までしか受け付けない。ロック取得より前に拒否する。
  // 検査しないと、テーブルだけ作られて索引作成が `54000` で落ち、テーブルが残ったまま失敗する（ADR 0018）。
  if (space.dimensions > HNSW_VECTOR_INDEX_MAX_DIMENSIONS) {
    throw new RangeError(
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
  const memoryIdIndex = embeddingSpaceMemoryIdIndexName(space);
  assertSafeIdentifier(table);
  assertSafeIdentifier(index);
  assertSafeIdentifier(zeroNormIndex);
  assertSafeIdentifier(memoryIdIndex);

  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  // `schema` 未指定かつ `options.lockKey` の上書きも無いときだけ、ロック取得より前に同じ `pool` で
  // `SELECT current_schema()` を読み、実際に解決されたスキーマ名でキーを選ぶ（`runMigrations` と同じ形）。
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
    // DDL は、advisory lock を握った接続（`lockClient`）の中で打つ（ADR 0460）。別の接続の `pool.query` を使うと、
    // `max: 1` の Pool では借り切られた接続の返却を待って止まる。`acquireAdvisoryLock` が敷いた `lock_timeout` が
    // この接続に残っていると DDL の表ロック待ちにまで効くので、ここで戻す（`runMigrations` も同じ形）。
    await lockClient.query("RESET lock_timeout");

    // dimensions は上で正整数であることを確認済みなので、そのまま埋め込んでよい（`vector(N)` の N は型修飾子の位置で、パラメータ化できない）。
    await lockClient.query(`
      CREATE TABLE IF NOT EXISTS ${qualify(schema, table)} (
        tenant_id   text         NOT NULL,
        memory_id   uuid         NOT NULL REFERENCES ${qualify(schema, "memories")}(id) ON DELETE CASCADE,
        embedding   ${qualify(extensionSchema, "vector")}(${space.dimensions}) NOT NULL,
        model       text         NOT NULL,
        created_at  timestamptz  NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, memory_id)
      );
    `);

    // このテーブルを別の空間の組が既に使っていないかを見張る。索引の作成より前に置く（衝突なら既存のテーブルに何も足さずに拒む）。
    await recordOrCheckEmbeddingSpace(lockClient, schema, table, space);

    await lockClient.query(`
      CREATE INDEX IF NOT EXISTS ${index}
        ON ${qualify(schema, table)}
        USING hnsw (embedding ${qualify(extensionSchema, "vector_cosine_ops")});
    `);

    // HNSW 索引（cosine 距離）は norm が0のベクトルを索引へ入れないので、`search()`/`searchMany()` が HNSW を選ぶと
    // ゼロベクトルの候補が結果から消え、ADR 0040 の契約（比較不能でも候補として返す）に反する。この部分索引は、
    // それを別枝（`UNION ALL`）で拾うために使う。
    //
    // この索引を作る経路は2つある。ここと `migrations/0022_embedding_zero_norm_index.sql`（migration 適用の時点で既に
    // 存在する空間に作る。再起動まで索引が無い窓を無くすため。ADR 0343）。索引名は同じ計算から一致し、
    // `IF NOT EXISTS` で後から呼ばれたほうは何もしない。
    //
    // 既存の大きな embedding テーブルでは、この `CREATE INDEX` が `ShareLock` を取り、構築が終わるまで書き込みを止める
    // （読み取りは止めない）。`CONCURRENTLY` を使えないのは、`registerEmbeddingSpace` がトランザクションを開かず
    // advisory lock で直列化しており、索引が2本同時に作られる競合を pgvector 側で検査していないため（ADR 0343）。
    // migration（0022）が同じ名前の索引を作っている最中と重なって `23505` になったら、1回だけ打ち直す（ADR 0464）。
    await createIndexIfNotExistsAbsorbingRace(
      lockClient,
      `
      CREATE INDEX IF NOT EXISTS ${zeroNormIndex}
        ON ${qualify(schema, table)} (tenant_id, memory_id)
        WHERE ${qualify(extensionSchema, "vector_norm")}(embedding) = 0;
    `,
      zeroNormIndex,
    );

    // `(memory_id)` 単一列索引（ADR 0383）。主キーは `tenant_id` 先頭の複合索引で `memory_id` 単独では引けず、
    // `memories` の行を消すたびの外部キー検査・CASCADE 削除が Seq Scan になる。
    // 作る経路は `zeroNormIndex` と同じく2つ（ここと `migrations/0027_erase_tenant_fk_indexes.sql`）で、
    // 索引名は同じ計算から一致する。`CONCURRENTLY` を使わない理由も同じ。migration（0027）と重なったときも打ち直す（ADR 0464）。
    await createIndexIfNotExistsAbsorbingRace(
      lockClient,
      `
      CREATE INDEX IF NOT EXISTS ${memoryIdIndex}
        ON ${qualify(schema, table)} (memory_id);
    `,
      memoryIdIndex,
    );
  } finally {
    await releaseAdvisoryLock(lockClient, lockKey);
  }

  return { lock: { waitedMs } };
}

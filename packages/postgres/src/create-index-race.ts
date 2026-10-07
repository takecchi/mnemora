import type { PoolClient } from "pg";

/**
 * ADR 0464: `CREATE INDEX IF NOT EXISTS` が、同名の索引を別のトランザクションが作っている最中と重なって
 * `23505`（`pg_class_relname_nsp_index`）で落ちたとき、同じ文をもう1回だけ打つ。
 *
 * 相手の索引はコミットされるまで `pg_class` に見えない。`IF NOT EXISTS` の存在確認はそれを見ずに挿入しに行き、
 * 相手のコミットを待って `23505` になる。打ち直す時点では相手がコミット済みなので「既にある」で通る。
 *
 * 吸収するのは自分が作ろうとした索引名の `23505` だけ（`detail` の `Key (relname, relnamespace)=(<名前>, …)` で照合する）。
 * 打ち直しは1回だけで、それでも落ちたらそのまま投げる。
 */
export function isOwnIndexNameCollision(error: unknown, indexName: string): boolean {
  const e = error as { code?: unknown; constraint?: unknown; detail?: unknown } | null | undefined;
  if (e === null || e === undefined) return false;
  if (e.code !== "23505" || e.constraint !== "pg_class_relname_nsp_index") return false;
  if (typeof e.detail !== "string") return false;
  return e.detail.startsWith(`Key (relname, relnamespace)=(${indexName},`);
}

export async function createIndexIfNotExistsAbsorbingRace(
  db: Pick<PoolClient, "query">,
  statement: string,
  indexName: string,
): Promise<void> {
  try {
    await db.query(statement);
  } catch (error) {
    if (!isOwnIndexNameCollision(error, indexName)) throw error;
    await db.query(statement);
  }
}

/**
 * ADR 0638: `registerEmbeddingSpace` が作る索引の名前の接頭辞。`runMigrations` が1ファイルを流して落ちたとき、
 * それが `registerEmbeddingSpace` との索引名の衝突（`23505`）かを、名前そのものでなくこの接頭辞で絞る。
 * migration 側は、0022・0027 の DO ブロックが空間ごとに導く名前を事前に知らないため。
 */
export const EMBEDDING_SPACE_INDEX_NAME_PREFIX = "idx_memory_embeddings_";

export function isEmbeddingSpaceIndexNameCollision(error: unknown): boolean {
  const e = error as { code?: unknown; constraint?: unknown; detail?: unknown } | null | undefined;
  if (e === null || e === undefined) return false;
  if (e.code !== "23505" || e.constraint !== "pg_class_relname_nsp_index") return false;
  if (typeof e.detail !== "string") return false;
  return e.detail.startsWith(`Key (relname, relnamespace)=(${EMBEDDING_SPACE_INDEX_NAME_PREFIX}`);
}

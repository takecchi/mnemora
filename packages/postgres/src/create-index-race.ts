import type { PoolClient } from "pg";

/**
 * ADR 0464: `CREATE INDEX IF NOT EXISTS` が、同じ名前の索引を別のトランザクションが作っている最中と重なって
 * `23505`（`pg_class_relname_nsp_index`）で落ちたとき、同じ文をもう1回だけ打つ。
 *
 * 相手（migration の0022・0027の DO ブロックなど、1ファイル1トランザクション）の索引は、コミットされるまで
 * `pg_class` に見えない。`IF NOT EXISTS` の存在確認はそれを見ずに同じ名前の行を入れようとし、一意索引の上で
 * 相手の終わりを待ち、相手がコミットすると `23505` になる。打ち直す時点では相手がコミット済みなので、
 * 「既にある」で通る。
 *
 * 吸収するのは、**自分が作ろうとした索引の名前**での `23505` だけ（`detail` の
 * `Key (relname, relnamespace)=(<名前>, …)` で照合する）。ほかの `23505` はそのまま投げる。
 * 打ち直しは**1回だけ**で、打ち直しても落ちたらそのまま投げる。
 * 公開 API ではない（`index.ts` から export しない）。
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
 * ADR 0638（ADR 0464 の負債 D1b、逆向き）: `runMigrations` が1ファイルを流して落ちたとき、それが
 * 「`registerEmbeddingSpace` が同じ名前の索引を作っている最中と重なった」ことによる `23505` かどうか。
 *
 * migration 側は、どの索引名とぶつかるかを事前に知らない（0022・0027 の DO ブロックが空間ごとに名前を導く）。
 * だから名前そのものではなく、**`registerEmbeddingSpace` が作る索引の名前の接頭辞**
 * （`idx_memory_embeddings_`。零ノルム・`memory_id`・HNSW のどれも）で絞る。それ以外の名前の `23505`・
 * 別の制約の `23505`・ほかの SQLSTATE は、今までどおりそのまま投げる。
 * 公開 API ではない（`index.ts` から export しない）。
 */
export const EMBEDDING_SPACE_INDEX_NAME_PREFIX = "idx_memory_embeddings_";

export function isEmbeddingSpaceIndexNameCollision(error: unknown): boolean {
  const e = error as { code?: unknown; constraint?: unknown; detail?: unknown } | null | undefined;
  if (e === null || e === undefined) return false;
  if (e.code !== "23505" || e.constraint !== "pg_class_relname_nsp_index") return false;
  if (typeof e.detail !== "string") return false;
  return e.detail.startsWith(`Key (relname, relnamespace)=(${EMBEDDING_SPACE_INDEX_NAME_PREFIX}`);
}

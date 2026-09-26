import { createHash } from "node:crypto";
import type { EmbeddingSpaceId } from "@mnemora/core";

/**
 * PostgreSQL の識別子は 63 バイトまで（NAMEDATALEN - 1）。
 * スラグがこれを超える場合は末尾を切り詰め、衝突を避けるためのハッシュ片を足す。
 */
const MAX_IDENTIFIER_BYTES = 63;
const TABLE_PREFIX = "memory_embeddings_";
const HNSW_INDEX_PREFIX = "idx_memory_embeddings_hnsw_";
/**
 * Issue #956: HNSW（cosine 距離）は norm が0のベクトルをそもそも索引へ入れない
 * （pgvector の README「Why are there less results for a query after adding an
 * HNSW index?」——"Also, note that `NULL` vectors are not indexed (as well as
 * zero vectors for cosine distance)."／実装は `HnswFormIndexValue`・`HnswCheckNorm`、
 * `src/hnswutils.c`）。この部分索引（`WHERE vector_norm(embedding) = 0`）は、
 * `search()`/`searchMany()` がその取りこぼしを別枝で拾うために使う
 * （`vector-store.ts` の `withRelaxedOrderScan` 呼び出し元の doc 参照）。
 */
const ZERO_NORM_INDEX_PREFIX = "idx_memory_embeddings_zero_norm_";

function sanitizeSlugPart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * `EmbeddingSpaceId` からテーブル名スラグを導出する（docs/memory-model.md §10・ADR 0002 D8）。
 * `<space>` は `(provider, model, dimensions)` の組から導出する。
 */
export function embeddingSpaceTableName(space: EmbeddingSpaceId): string {
  const rawSlug = [
    sanitizeSlugPart(space.provider),
    sanitizeSlugPart(space.model),
    String(space.dimensions),
  ].join("_");

  const fullName = `${TABLE_PREFIX}${rawSlug}`;
  if (Buffer.byteLength(fullName, "utf8") <= MAX_IDENTIFIER_BYTES) {
    return fullName;
  }

  // 63バイトを超える場合は切り詰め、内容から導いた短いハッシュを足して衝突を避ける。
  const hash = createHash("sha256").update(rawSlug).digest("hex").slice(0, 8);
  const budget = MAX_IDENTIFIER_BYTES - TABLE_PREFIX.length - hash.length - 1;
  const truncated = rawSlug.slice(0, Math.max(budget, 0));
  return `${TABLE_PREFIX}${truncated}_${hash}`;
}

/** HNSW 索引名。テーブル名と同じ導出規則から機械的に決める。 */
export function embeddingSpaceIndexName(space: EmbeddingSpaceId): string {
  const table = embeddingSpaceTableName(space);
  const suffix = table.slice(TABLE_PREFIX.length);
  const fullName = `${HNSW_INDEX_PREFIX}${suffix}`;
  if (Buffer.byteLength(fullName, "utf8") <= MAX_IDENTIFIER_BYTES) {
    return fullName;
  }
  const hash = createHash("sha256").update(suffix).digest("hex").slice(0, 8);
  const budget = MAX_IDENTIFIER_BYTES - HNSW_INDEX_PREFIX.length - hash.length - 1;
  return `${HNSW_INDEX_PREFIX}${suffix.slice(0, Math.max(budget, 0))}_${hash}`;
}

/**
 * ゼロベクトル（norm=0）専用の部分索引名（Issue #956）。テーブル名・HNSW 索引名と
 * 同じ導出規則（63バイト超で切り詰め＋ハッシュ）から機械的に決める。
 */
export function embeddingSpaceZeroNormIndexName(space: EmbeddingSpaceId): string {
  const table = embeddingSpaceTableName(space);
  const suffix = table.slice(TABLE_PREFIX.length);
  const fullName = `${ZERO_NORM_INDEX_PREFIX}${suffix}`;
  if (Buffer.byteLength(fullName, "utf8") <= MAX_IDENTIFIER_BYTES) {
    return fullName;
  }
  const hash = createHash("sha256").update(suffix).digest("hex").slice(0, 8);
  const budget = MAX_IDENTIFIER_BYTES - ZERO_NORM_INDEX_PREFIX.length - hash.length - 1;
  return `${ZERO_NORM_INDEX_PREFIX}${suffix.slice(0, Math.max(budget, 0))}_${hash}`;
}

/** 識別子として安全であることの防御的なチェック（SQL 注入対策の最後の砦）。 */
export function assertSafeIdentifier(identifier: string): void {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) {
    throw new Error(`unsafe SQL identifier: ${identifier}`);
  }
}

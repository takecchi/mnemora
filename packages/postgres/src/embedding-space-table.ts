import { createHash } from "node:crypto";
import type { EmbeddingSpaceId } from "@mnemora/core";

/** PostgreSQL の識別子は 63 バイトまで（NAMEDATALEN - 1）。超えるスラグは末尾を切り、衝突を避けるハッシュ片を足す。 */
const MAX_IDENTIFIER_BYTES = 63;
// ⚠ `scripts/readme-postgres-objects-lib.mjs` が次の行を、文字列リテラルを直接代入する形として
// 正規表現で読み、README の接頭辞と突き合わせる。別の定数からの代入などに書き換えないこと。
const TABLE_PREFIX = "memory_embeddings_";
/** 埋め込み空間ごとのテーブル名の接頭辞。 */
export const EMBEDDING_SPACE_TABLE_PREFIX = TABLE_PREFIX;
const HNSW_INDEX_PREFIX = "idx_memory_embeddings_hnsw_";
/**
 * HNSW（cosine 距離）は norm が0のベクトルを索引へ入れない（pgvector の仕様）。この部分索引
 * （`WHERE vector_norm(embedding) = 0`）は、`search()`/`searchMany()` がその取りこぼしを別枝で拾うために使う。
 */
const ZERO_NORM_INDEX_PREFIX = "idx_memory_embeddings_zero_norm_";
/**
 * `(memory_id)` 単一列索引（ADR 0383）。主キーは `(tenant_id, memory_id)` で、`memory_id` だけで行を探す向きには
 * 使えない。`memories` の行を消すたびに外部キーの検査・CASCADE 削除が走るので、この索引が無いと空間テーブルの
 * Seq Scan になる。
 */
const MEMORY_ID_INDEX_PREFIX = "idx_memory_embeddings_memory_id_";

function sanitizeSlugPart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * `EmbeddingSpaceId` からテーブル名スラグを導出する（docs/memory-model.md §10・ADR 0002 D8）。
 *
 * この導出は単射ではない。正規化（小文字化・英数字以外を `_`）の後に同じ綴りになる組は同じテーブル名になる。
 * 導出を変えてはならない（既存のデプロイのテーブル名が変わる）。衝突は `registerEmbeddingSpace` が
 * テーブルのコメントの記録で検出して拒む。
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

/** ゼロベクトル（norm=0）専用の部分索引名。導出規則はテーブル名・HNSW 索引名と同じ。 */
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

/** `(memory_id)` 単一列索引の名前（ADR 0383）。導出規則はテーブル名・他の索引名と同じ。 */
export function embeddingSpaceMemoryIdIndexName(space: EmbeddingSpaceId): string {
  const table = embeddingSpaceTableName(space);
  const suffix = table.slice(TABLE_PREFIX.length);
  const fullName = `${MEMORY_ID_INDEX_PREFIX}${suffix}`;
  if (Buffer.byteLength(fullName, "utf8") <= MAX_IDENTIFIER_BYTES) {
    return fullName;
  }
  const hash = createHash("sha256").update(suffix).digest("hex").slice(0, 8);
  const budget = MAX_IDENTIFIER_BYTES - MEMORY_ID_INDEX_PREFIX.length - hash.length - 1;
  return `${MEMORY_ID_INDEX_PREFIX}${suffix.slice(0, Math.max(budget, 0))}_${hash}`;
}

/** 識別子として安全であることの防御的なチェック（SQL 注入対策の最後の砦）。 */
export function assertSafeIdentifier(identifier: string): void {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) {
    throw new Error(
      `unsafe SQL identifier: ${identifier} ` +
        "(使えるのは英小文字・数字・_ だけで、先頭は英小文字か _ である必要がある: /^[a-z_][a-z0-9_]*$/)",
    );
  }
}

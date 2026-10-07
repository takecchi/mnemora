import {
  DigestSourceSchema,
  EmbeddingStatusSchema,
  MemoryStatusSchema,
  ProvenanceKindSchema,
} from "@mnemora/core";

const COLUMNS = {
  status: MemoryStatusSchema,
  digest_source: DigestSourceSchema,
  embedding_status: EmbeddingStatusSchema,
  provenance_kind: ProvenanceKindSchema,
} as const;

/**
 * `memories` の列挙の列に書ける値かを確かめる。型を外した呼び出しで届く、列挙に無い値を Postgres の CHECK 制約と同じく拒む。
 * 状態を書き換える前に呼ぶ。ただし見つからない id・CAS の食い違いの検査の後に置く（Postgres でも先に決まる）。
 */
export function assertStorableMemoryColumn(column: keyof typeof COLUMNS, value: unknown): void {
  const schema = COLUMNS[column];
  if (!schema.safeParse(value).success) {
    throw new Error(
      `memories.${column} must be one of ${schema.options.join(", ")} (got ${JSON.stringify(value)})`,
    );
  }
}

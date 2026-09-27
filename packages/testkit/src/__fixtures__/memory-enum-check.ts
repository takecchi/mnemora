import {
  DigestSourceSchema,
  EmbeddingStatusSchema,
  MemoryStatusSchema,
  ProvenanceKindSchema,
} from "@mnemora/core";

// testkit の fixture の内部モジュール。`InMemoryMemoryStore` の関数の中身からだけ使う——`.d.ts` の
// import に出ないので、公開の型の面（`exports` から辿れる宣言）には入らない（`memory-event-check.ts` と同じ）。

const COLUMNS = {
  status: MemoryStatusSchema,
  digest_source: DigestSourceSchema,
  embedding_status: EmbeddingStatusSchema,
  provenance_kind: ProvenanceKindSchema,
} as const;

/**
 * `memories` の列挙の列に書ける値かを確かめる（Postgres が拒む入力を、同じ入力で拒む）。
 *
 * Postgres は CHECK 制約（`memories_status_check`・`memories_digest_source_check`・
 * `memories_embedding_status_check`・`memories_provenance_kind_check`）で、型の列挙に無い値を拒む。
 * 型を外した呼び出し・JavaScript からの呼び出しで届く。値の集合は core のスキーマから取る
 * （CHECK 制約の値の並びと同じ）。
 *
 * 呼ぶ口は**状態を書き換える前に**これを呼ぶ——Postgres は1文（または1トランザクション）で
 * 何も書かない。それを写す。見つからない id・CAS の食い違いは Postgres でも先に決まる
 * （更新する行が無ければ CHECK に届かない）ので、それらの検査の後に置く。
 */
export function assertStorableMemoryColumn(column: keyof typeof COLUMNS, value: unknown): void {
  const schema = COLUMNS[column];
  if (!schema.safeParse(value).success) {
    throw new Error(
      `memories.${column} must be one of ${schema.options.join(", ")} (got ${JSON.stringify(value)})`,
    );
  }
}

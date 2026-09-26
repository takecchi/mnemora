-- 0022_embedding_zero_norm_index.sql
--
-- Issue #956 / ADR 0343: pgvector の cosine HNSW 索引は norm が0のベクトル（ゼロベクトル）を
-- そもそも索引へ入れない（pgvector README「Troubleshooting」、実装は pgvector
-- `src/hnswutils.c` の `HnswFormIndexValue`/`HnswCheckNorm`）。`PostgresVectorStore.search()`/
-- `searchMany()` は、`vector_norm(embedding) = 0` の部分索引を使う別枝（`UNION ALL`）で
-- この取りこぼしを拾う（`packages/postgres/src/vector-store.ts`）。
--
-- ## なぜこの migration が要るか（`registerEmbeddingSpace` だけでは足りない理由）
--
-- `memory_embeddings_<space>` テーブルと HNSW 索引自体は、最初から `migrations/*.sql` に
-- 一度も現れたことが無い——`<space>` はテーブル名に埋め込まれる動的な値であり、
-- migration 作成時点では個々の空間名を列挙できないため、`registerEmbeddingSpace`
-- （プロセス起動のたびに呼ばれる、べき等な `CREATE ... IF NOT EXISTS`）だけが作ってきた。
-- この部分索引もその経路（`registerEmbeddingSpace` 自身が `CREATE INDEX IF NOT EXISTS` を
-- 発行する）は保っているが、**アプリケーションが `mnemora-postgres-migrate` を実行した後、
-- 実際にプロセスを再起動する（＝ `registerEmbeddingSpace` を呼び直す）までの間**は、
-- 既存の空間にこの部分索引が無いままになる——その窓の間、ゼロ枝（`UNION ALL` の `= 0` 側）は
-- 索引を使えず Seq Scan になる（動作はするが遅い。取りこぼしはしない）。
-- この migration は、**その窓を無くすため**、migration 適用の時点で存在する埋め込みテーブル
-- すべてに、同じ部分索引をここで作ってしまう。
--
-- ## 索引名は `embeddingSpaceZeroNormIndexName`（TypeScript 側）と1バイトも違わないこと
--
-- `packages/postgres/src/embedding-space-table.ts` の `embeddingSpaceZeroNormIndexName` は、
-- テーブル名から `memory_embeddings_` を除いた残り（`suffix`）に接頭辞
-- `idx_memory_embeddings_zero_norm_` を付け、63バイトを超えるときだけ末尾を切り詰めて
-- `suffix` の SHA-256 先頭8桁（16進）を付与する。**この migration がここで作る名前が、
-- 後から `registerEmbeddingSpace` が計算する名前と1バイトでも違うと、`CREATE INDEX
-- IF NOT EXISTS` が「無い」と判定し、同じ役目の索引がもう1本作られてしまう**
-- （`IF NOT EXISTS` は名前の一致でしか見分けないため）。⟹ 下の `DO` ブロックは、
-- TypeScript 側と同じ計算（`octet_length`/`substring`/`sha256`/`encode(..., 'hex')`）を
-- SQL でそのまま再現する。**歯**（`embedding-zero-norm-migration.postgres.test.ts`）が
-- 短い名前・63バイトを超える名前の両方で、この SQL の計算結果と TypeScript 関数の
-- 計算結果が一致することを実測で固定している——どちらかを直したら、もう片方も
-- 直っているか歯で確認すること。
--
-- ## 対象範囲: `current_schema()` の中だけ
--
-- `--schema` を指定した運用（ADR 0057）では、`migrate.ts` がこのファイルを適用する前に
-- `SET LOCAL search_path TO <schema>` を発行する（`migrate.ts` の該当箇所参照）ため、
-- `current_schema()` はその `<schema>` を指す。⟹ この migration は、指定されたスキーマの
-- 中に在る埋め込みテーブルだけを対象にする——他のスキーマには触れない。
--
-- ## ロックとブロックする時間（ADR 0343「実測」節）
--
-- 素の `CREATE INDEX`（`CONCURRENTLY` 無し）は対象テーブルに `ShareLock` を取る
-- （読み取りは止めない。書き込み——`INSERT`/`UPDATE`/`DELETE`——は索引の構築が
-- 終わるまで止まる。ADR 0343 が `pg_locks` で実測済み）。この migration は
-- `migrate.ts` の1ファイル=1トランザクションの中で全対象テーブルの索引を作るため、
-- 複数の空間があれば、それらすべての `ShareLock` がこの migration 全体が
-- コミットするまで保持される。1空間あたりの構築時間の実測は ADR 0343「実測」節
-- （100,000行で約40ms、1,000,000行で約270ms）。
--
-- ⚠ この migration は、`registerEmbeddingSpace` 側の `CREATE INDEX IF NOT EXISTS` を
-- 置き換えない——新しく作る空間は引き続きそちらが作る。この migration が対象にするのは
-- 「migration 適用の時点で既に存在する」空間だけである。

DO $$
DECLARE
  target_table text;
  suffix text;
  full_name text;
  index_name text;
  name_hash text;
  budget int;
BEGIN
  FOR target_table IN
    SELECT c.table_name
    FROM information_schema.columns c
    WHERE c.table_schema = current_schema()
      AND starts_with(c.table_name, 'memory_embeddings_')
      AND c.column_name = 'embedding'
      AND c.udt_name = 'vector'
  LOOP
    suffix := substring(target_table from length('memory_embeddings_') + 1);
    full_name := 'idx_memory_embeddings_zero_norm_' || suffix;
    IF octet_length(full_name) <= 63 THEN
      index_name := full_name;
    ELSE
      name_hash := substring(encode(sha256(suffix::bytea), 'hex') from 1 for 8);
      budget := 63 - octet_length('idx_memory_embeddings_zero_norm_') - octet_length(name_hash) - 1;
      IF budget < 0 THEN
        budget := 0;
      END IF;
      index_name := 'idx_memory_embeddings_zero_norm_' || substring(suffix from 1 for budget) || '_' || name_hash;
    END IF;

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON %I (tenant_id, memory_id) WHERE vector_norm(embedding) = 0',
      index_name,
      target_table
    );
  END LOOP;
END $$;

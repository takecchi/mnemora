-- 0027_erase_tenant_fk_indexes.sql
--
-- Issue #1207 / ADR 0383: `MemoryStore.eraseTenant?`（`packages/postgres/src/memory-store.ts`）が
-- 削除のたびに踏む参照整合性チェック・自己参照の検査のための索引を足す。
--
-- ## なぜ要るか（ADR 0059・ADR 0062 と同じ形）
--
-- Postgres は、参照される側（親）の行を DELETE するたびに、「この行を参照している
-- 子の行が無いか」を確かめる（`SELECT 1 FROM <child> WHERE <fk column> = $1 FOR KEY
-- SHARE` に相当）。この WHERE には**参照する側の表の `tenant_id` は一切現れない**
-- ——FK 自体がテナントで絞られていないため。`tenant_id` を先頭に置いた複合索引
-- （例: `idx_memory_events_by_memory (tenant_id, memory_id, at)`）は、この問い合わせに
-- 対して先頭列を1点にも絞れず、実質 Seq Scan になる——`idx_memories_contested_with`
-- を足した `0004_contested_with_index.sql` が `memories.contested_with_id` について
-- 実測済みの形を、他の参照列にも広げる。
--
-- `eraseTenant?` はテナントの全行を消す操作であり、`memories`・`observations` の削除が
-- 大量に連続する——索引が無いと、削除する行1件ごとに子表の Seq Scan が走り、
-- 「行数 × 子表の全行数」の費用になる。
--
-- ## 単一列索引（8本）
--
-- | 索引 | 対象の参照整合性チェック |
-- |---|---|
-- | `idx_memory_events_memory_id` | `memory_events.memory_id → memories(id)` |
-- | `idx_recall_usages_memory_id` | `recall_usages.memory_id → memories(id)` |
-- | `idx_recall_usages_recall_id` | `recall_usages.recall_id → recalls(id)` |
-- | `idx_memory_labels_memory_id` | `memory_labels.memory_id → memories(id)` |
-- | `idx_memories_source_observation_id` | `memories.source_observation_id → observations(id)` |
-- | `idx_memories_superseded_by_id` | `memories.superseded_by_id → memories(id)`（自己参照） |
-- | `idx_memory_relations_from_memory_id` | `memory_relations.from_memory_id → memories(id)` |
-- | `idx_memory_relations_to_memory_id` | `memory_relations.to_memory_id → memories(id)` |
--
-- `memory_relations`（migration 0026、Issue #207/#933 PR2）の既存の索引
-- `idx_memory_relations_from`/`_to` は `(tenant_id, from_memory_id, kind)`/
-- `(tenant_id, to_memory_id, kind)` で `tenant_id` が先頭にあり、上と同じ理由で参照整合性
-- チェックに使えない。`eraseTenant?` だけでなく、`memories` の行を消すすべての経路で
-- 1行ごとに `memory_relations` の全行を走査することになるため、ここで足す（クローン miku
-- の判断、ADR 0383）。
--
-- **`memories.contested_with_id`（自己参照 FK）には足さない**——`0004_contested_with_index.sql`
-- が作った `idx_memories_contested_with (contested_with_id) WHERE contested_with_id IS NOT NULL`
-- が既に単一列（部分）索引であり、同じ役目を果たしている（確認済み。`pg_indexes` で
-- 実在を確認し、`erase-tenant-fk-indexes.postgres.test.ts` が縛る）。
--
-- 部分索引にしない（`WHERE ... IS NOT NULL` を付けない）理由: `0004` は
-- `contested_with_id` が非NULL行が全体の一部（実測時点で約2%）という前提で部分索引を
-- 選んだ。本 migration が対象にする列（特に `memory_events.memory_id`・
-- `recall_usages.memory_id`・`recall_usages.recall_id`・`memory_labels.memory_id`）は
-- 通常運用でほぼ全行が非NULL（`memory_events.memory_id` は `kind = 'events_purged'` の
-- 行だけ NULL、`recall_usages`/`memory_labels` の対象列はどちらも NOT NULL 制約付き）
-- ——部分索引にしても母数はほとんど削れないため、単純な無条件索引にする
-- （`idx_memory_events_by_retention`（migration 0010）が `kind <> 'events_purged'` を
-- 部分索引の条件にしなかったのと同じ理由）。`memories.superseded_by_id`・
-- `memories.source_observation_id` はどちらも NULL 行が多数派になりうる運用だが、
-- ここでは `eraseTenant?`（自己参照の事前 NULL 化・FK 検査）と将来の RI チェック
-- 全般のための汎用索引として無条件で作る——部分索引にすると、`eraseTenant?` が
-- 実行する `UPDATE memories SET superseded_by_id = NULL, contested_with_id = NULL
-- WHERE tenant_id = $1 AND (superseded_by_id IS NOT NULL OR contested_with_id IS
-- NOT NULL)` のような書き込み側のクエリにも使えなくなるため（`0004` の
-- `idx_memories_contested_with` は読み取り専用の RI チェックにしか使われないのに対し、
-- ここは書き込み側の絞り込みにも使う）。
--
-- ⚠ この `CREATE INDEX` は素のまま（`CONCURRENTLY` を付けない）。
-- `packages/postgres/src/migrate.ts` が各移行ファイルを1トランザクションで包んでおり、
-- `CREATE INDEX CONCURRENTLY` はトランザクション内で実行できないためである
-- （0002/0003/0004/0007/0010 と同じ理由・同じ形。ADR 0059・ADR 0062 参照）。
--
-- 実測（止まる時間・索引サイズ）は [ADR 0383](../../../docs/decisions/0383-erase-tenant.md)
-- 「実測」節を参照——ここには写さない（`AGENTS.md`「数を、道具と生成物に焼き込まない」）。

CREATE INDEX idx_memory_events_memory_id
  ON memory_events (memory_id);

CREATE INDEX idx_recall_usages_memory_id
  ON recall_usages (memory_id);

CREATE INDEX idx_recall_usages_recall_id
  ON recall_usages (recall_id);

CREATE INDEX idx_memory_labels_memory_id
  ON memory_labels (memory_id);

CREATE INDEX idx_memories_source_observation_id
  ON memories (source_observation_id);

CREATE INDEX idx_memories_superseded_by_id
  ON memories (superseded_by_id);

CREATE INDEX idx_memory_relations_from_memory_id
  ON memory_relations (from_memory_id);

CREATE INDEX idx_memory_relations_to_memory_id
  ON memory_relations (to_memory_id);

-- ## 埋め込み空間テーブルの (memory_id) 索引（既存の空間へ遡って足す）
--
-- `memory_embeddings_<space>` テーブルと `(memory_id)` 索引自体は、`0022_embedding_zero_
-- norm_index.sql` と同じ理由で migrations/*.sql に一度も現れたことが無い——`<space>` が
-- 動的な値であり、`registerEmbeddingSpace`（`packages/postgres/src/vector-space.ts`）
-- だけが作ってきた。`registerEmbeddingSpace` はこの migration と同じ版から
-- `(memory_id)` 索引も作るが（`embeddingSpaceMemoryIdIndexName`）、**アプリケーションが
-- `mnemora-postgres-migrate` を実行した後、実際にプロセスを再起動する（＝
-- `registerEmbeddingSpace` を呼び直す）までの間**は、既存の空間にこの索引が無いまま
-- になる——この DO ブロックは、その窓を無くすため、migration 適用の時点で存在する
-- 埋め込みテーブルすべてにこの索引をここで作ってしまう（`0022` と同じ動機）。
--
-- **列挙は `packages/postgres/src/embedding-space-catalog.ts` の `listEmbeddingSpaceTables`
-- と同じ3条件**（Issue #1425 / ADR 0382 決定2、`PostgresVectorStore.deleteAcrossSpaces`/
-- `eraseTenant?` が使う列挙と共通）——`0022` の `information_schema.columns`
-- ベースの列挙（「`embedding` 列が `vector` 型を持つ表」）から、`pg_constraint`
-- ベースの列挙（「`memory_id` 列が `memories(id)` への外部キーを持つ表」）に変えてある。
-- **⚠ SQL のこの DO ブロックから TypeScript の `listEmbeddingSpaceTables` を呼ぶ経路は
-- 無い**（`migrate.ts` は `.sql` ファイルをそのまま実行するだけ）——同じ3条件を
-- SQL として書き写しており、一致は
-- `packages/postgres/src/__tests__/embedding-space-table-enumeration-consistency.postgres.test.ts`
-- が実測で検査するだけで、機械的に強制されてはいない（ADR 0383「引き受けた負債」）。
--
-- 索引名は `embeddingSpaceMemoryIdIndexName`（TypeScript 側）と1バイトも違わないこと
-- ——`0022` の DO ブロックと同じ規律（同 migration の doc コメント参照）。この DO
-- ブロックは TypeScript 側と同じ計算（`octet_length`/`substring`/`sha256`/
-- `encode(..., 'hex')`）を SQL でそのまま再現する。

DO $$
DECLARE
  target_table text;
  target_schema text;
  suffix text;
  full_name text;
  index_name text;
  name_hash text;
  budget int;
BEGIN
  FOR target_table, target_schema IN
    SELECT c.relname, n.nspname
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_class refc ON refc.oid = con.confrelid
    JOIN pg_namespace refn ON refn.oid = refc.relnamespace
    JOIN pg_attribute fkatt
      ON fkatt.attrelid = con.conrelid AND fkatt.attnum = con.conkey[1]
    JOIN pg_attribute pkatt
      ON pkatt.attrelid = con.confrelid AND pkatt.attnum = con.confkey[1]
    WHERE con.contype = 'f'
      AND n.nspname = current_schema()
      AND starts_with(c.relname, 'memory_embeddings_')
      AND array_length(con.conkey, 1) = 1
      AND fkatt.attname = 'memory_id'
      AND refc.relname = 'memories'
      AND refn.nspname = n.nspname
      AND pkatt.attname = 'id'
  LOOP
    suffix := substring(target_table from length('memory_embeddings_') + 1);
    full_name := 'idx_memory_embeddings_memory_id_' || suffix;
    IF octet_length(full_name) <= 63 THEN
      index_name := full_name;
    ELSE
      name_hash := substring(encode(sha256(suffix::bytea), 'hex') from 1 for 8);
      budget := 63 - octet_length('idx_memory_embeddings_memory_id_') - octet_length(name_hash) - 1;
      IF budget < 0 THEN
        budget := 0;
      END IF;
      index_name := 'idx_memory_embeddings_memory_id_' || substring(suffix from 1 for budget) || '_' || name_hash;
    END IF;

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON %I.%I (memory_id)',
      index_name,
      target_schema,
      target_table
    );
  END LOOP;
END $$;

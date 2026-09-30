-- 0031_memory_labels_label_id_index.sql
--
-- [ADR 0400](../../../docs/decisions/0400-general-fk-index-tooth.md): `memory_labels.label_id`
-- （`REFERENCES labels(id)`、`0020_taxonomy_labels.sql`）の外部キーに、先頭列が `label_id` の
-- 索引を足す。
--
-- ## なぜ要るか（0027 と同じ形）
--
-- 親（`labels`）の行を DELETE するたびに、Postgres は子に対して
-- `SELECT 1 FROM memory_labels WHERE label_id = $1 FOR KEY SHARE` 相当の参照整合性検査を行う。
-- 既存の `idx_memory_labels_by_label` は `(tenant_id, label_id)` で `label_id` が2列目のため、
-- この検査（`tenant_id` を含まない）の先頭列を絞れず、Seq Scan になる。
-- `eraseTenant` は `labels` を大量に消すので、この検査が効かないと費用が「消す行数 × 子表の行数」になる。
-- 調査担当の実測では、`memory_labels` 20万行で labels を消すのに 46ms（索引なし）→ 6.5ms（索引あり）。
--
-- 0027 が足した8本の漏れである（0027 の歯は索引名の固定表だったため、`label_id` を数え損ねた）。
-- 以後は一般形の歯（`foreign-key-indexes-general.postgres.test.ts`）が全外部キーを数え上げる。
--
-- ## CONCURRENTLY を使わない
--
-- `packages/postgres/src/migrate.ts` が各 migration ファイルを1トランザクションで包むため
-- `CREATE INDEX CONCURRENTLY` は使えない。素の `CREATE INDEX` は `memory_labels` に SHARE ロックを取る
-- （構築が終わるまで書き込みが止まり、読み取りは通る）。0027・0028 と同じ扱い。
--
-- ## 冪等性
--
-- `IF NOT EXISTS` を付ける（0027 は付けていないが、再実行されても壊れないほうが安全）。

CREATE INDEX IF NOT EXISTS idx_memory_labels_label_id
  ON memory_labels (label_id);

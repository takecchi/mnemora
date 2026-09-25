-- 0019_observations_memories_attributes.sql
--
-- Issue #152/#153（ADR 0308）: 呼び手が申告する任意属性 `attributes` を持たせる。
--
-- ## なぜ2テーブルとも要るか
--
-- `Observation.attributes`（`@mnemora/core`）は `ObserveXxxInput.attributes` を
-- `occurredAt`/`validFrom`/`validUntil` と同じ経路で運ぶ
-- （`packages/core/src/observation.ts` の `Observation.attributes` の doc コメント参照）。
-- `extract: 'deferred'` を選んだ場合、抽出は outbox 経由で後から `processExtractJob`
-- （`runtime.ts`）が拾い、そこでは `MemoryStore.getObservation` で DB から読み直した
-- `Observation` しか手元に無い（元の `ObserveXxxInput` はとうに捨てられている）。この列が
-- 無いと、deferred 抽出経路では `attributes` が消える——`0014_observations_valid_from_until.sql`
-- が `validFrom`/`validUntil` について確立した先例と同じ形である。
--
-- `memories` 側は Phase 1 の時点（`0001_init.sql`）に `tags`（同じ「呼び手／抽出器が
-- 記憶に属性を持たせる」役割の列）が既に在ったが、`attributes` は今回が初めての追加である
-- ——`validFrom`/`validUntil` が `memories` 側は Phase 1 から持っていたのに対し
-- `observations` 側だけが `0014` を要ったのと、ちょうど逆の非対称になる。
--
-- ## 型を `jsonb` にする理由（`text[]`/追加の列にしない）
--
-- ADR 0006（`docs/decisions/0006-*.md`）は「単一の JSON カラムに全部入れる」設計を
-- 「索引が効くフィルタを要求する recall の二段検索と正面から衝突する」として却下している
-- ——ただしそれは「`Memory` の状態・provenance・時刻を1つの JSON へ潰す」話であり、
-- ここでの `attributes` は値の型を `string` に絞った、キーごとに等値比較で絞り込む専用の
-- 属性袋である。`jsonb` の containment 演算子（`@>`）は GIN 索引が効く述語であり
-- （下記索引参照）、この用途には ADR 0006 の却下理由が当たらない。
--
-- ## GIN 索引を `jsonb_path_ops` にする理由
--
-- `attributes` に対して行うクエリは `m.attributes @> $1::jsonb`（AND 等値の絞り込み、
-- `RecallQuery.attributes` の doc コメント参照）だけであり、キーの存在チェック（`?`）や
-- パス演算子は使わない。`jsonb_path_ops` は `@>` のためだけに特化した GIN 索引であり、
-- 既定の `jsonb_ops` より索引サイズが小さい（PostgreSQL のドキュメントが明記する一般的な
-- 特性）。**この選択は実機の索引サイズ・実行計画を測って選んだものではない**
-- （手元に Postgres を立てていない状態でこのマイグレーションを書いている）——
-- `idx_memories_tags`（`0001_init.sql`）が `btree_gin` の `text[]` 用 GIN を使っている
-- のと同じ形で、`tenant_id`（btree_gin 経由）と `attributes jsonb_path_ops`
-- （コア組み込みの GIN opclass）を1つの複合 GIN 索引に混ぜられる
-- （`btree_gin` は列ごとに opclass が違う複合 GIN 索引をサポートする——`idx_memories_tags`
-- が `tenant_id`（btree_gin の text 用 opclass）と `tags`（コア組み込みの array opclass）を
-- 同じ形で混ぜている先例そのもの）。
--
-- ⚠ **確かめていないこと**: 実際の `EXPLAIN` でこの索引が使われるか、`jsonb_ops` との
-- 索引サイズ・書き込みコストの差は測っていない（手元に Postgres + pgvector を立てられる
-- 環境が無かった。`AGENTS.md` の「手元で Postgres を立てる」手順に従って CI 側で検算する
-- こと）。

ALTER TABLE observations
  ADD COLUMN attributes jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE memories
  ADD COLUMN attributes jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Issue #153: 段1（候補生成）の絞り込み（`m.attributes @> $1::jsonb`）に使う。
-- `idx_memories_tags` と同じ形（`tenant_id` を btree_gin 経由で複合 GIN の1列目に含める）。
CREATE INDEX idx_memories_attributes
  ON memories USING gin (tenant_id, attributes jsonb_path_ops);

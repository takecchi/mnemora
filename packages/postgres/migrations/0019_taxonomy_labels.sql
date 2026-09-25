-- 0019_taxonomy_labels.sql
--
-- Issue #201 / ADR 0304（案(1)）: taxonomy の語彙管理（labels / memory_labels）を
-- Phase 2 の予定から、任意の追加として前倒しで実装する PR-A。
-- docs/memory-model.md §8 の SQL 案をそのまま採用する。
--
-- 決定の詳細は ADR 0304 を見ること。ここでは移行そのものに関係する要点だけ書く。
--
--   - **書き込みは常に自由（open）のまま。** この移行はテーブルを作り、
--     `PostgresMemoryStore` の書き込み経路（`createMemory` / `createMemoryWithOutbox` /
--     `supersedeWithNewMemories`）が新規 Memory の `tags` から `proposed` ラベルを
--     自動で作る・紐付けるようになる。**strict モードが検索のフィルタ・加点に
--     実際に影響する経路は、この移行にもこの PR にも含めない**（PR-B の射程）。
--   - **既存 `memories.tags` からの backfill を含める。**
--     `docs/roadmap.md` §3 の「未登録のラベルは既に `proposed` として記録されている」
--     という記述は、`labels` テーブルそのものが存在しない時点では成り立っていなかった
--     （`docs/roadmap.md` の訂正注記を参照）。この移行で初めて、既存データについても
--     その記述を成り立たせる。
--   - `tenant_settings.taxonomy_mode`（`migrations/0001_init.sql:223`）は既に存在する列
--     であり、この移行では触らない。

-- ---------------------------------------------------------------------------
-- 1. labels — テナントごとの語彙。registered（テナントが承認した語彙）と
--    proposed（tags から自動的に提案された、未承認の語彙）の2状態を持つ
--    （docs/memory-model.md §8「二つのモードを二つの経路にしない。『ラベルの状態』
--    一つで表す」）。
-- ---------------------------------------------------------------------------

CREATE TABLE labels (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      text        NOT NULL,
  name           text        NOT NULL,
  status         text        NOT NULL DEFAULT 'proposed' CHECK (status IN ('registered','proposed')),
  proposed_count integer     NOT NULL DEFAULT 0,
  registered_at  timestamptz NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

-- テナントの語彙一覧（状態で絞る、`MemoryStore.listLabels?`）のための索引。
-- 上の `UNIQUE (tenant_id, name)` は等値検索（`tenant_id, name` が両方分かっている場合）
-- には効くが、「あるテナントの proposed だけを一覧する」のような status での絞り込みには
-- 別の索引が要る。
CREATE INDEX idx_labels_by_status
  ON labels (tenant_id, status);

-- ---------------------------------------------------------------------------
-- 2. memory_labels — Memory と label の多対多の結び付け。
-- ---------------------------------------------------------------------------

CREATE TABLE memory_labels (
  tenant_id text NOT NULL,
  memory_id uuid NOT NULL REFERENCES memories(id),
  label_id  uuid NOT NULL REFERENCES labels(id),
  PRIMARY KEY (tenant_id, memory_id, label_id)
);

-- PR-B（recall 側でラベルによる絞り込みを足す）が「この label_id を持つ memory_id の集合」を
-- 引くための索引。主キー (tenant_id, memory_id, label_id) の列順は「この Memory のラベル
-- 一覧」には効くが、逆方向（label_id → memory_id の集合）には効かない。
-- ⚠ PR-A 自身はこの索引を使う読み出し経路を実装していない——先取りで足しておくだけである
-- （ADR 0304「決めたこと」参照）。
CREATE INDEX idx_memory_labels_by_label
  ON memory_labels (tenant_id, label_id);

-- ---------------------------------------------------------------------------
-- 3. backfill — 既存 memories.tags を proposed ラベルとして持ち込む
-- ---------------------------------------------------------------------------
--
-- 各 (tenant_id, tag) の組について、その tag を持つ memories の行数を
-- proposed_count の初期値とする。この移行より後に作られる Memory は
-- `PostgresMemoryStore` の書き込み経路が同じ数え方で proposed_count を
-- インクリメントする（ADR 0304）——ここで起動時点の値を揃えておく。
--
-- ⚠ 同一 Memory の `tags` 配列内に重複した文字列が入っていた場合、その重複ぶんも
-- 数えてしまう（`unnest` は配列の要素をそのまま展開するため）。`proposed_count` は
-- 「昇格の判断材料になる目安」であり厳密な一意カウントを契約していない
-- （docs/memory-model.md §8 参照）ため、ここでは DISTINCT を取らない——書き込み経路
-- （1 Memory ＝ 1回のインクリメント、`tags` 内の重複は `Set` で潰す。ADR 0304 参照）
-- とこの backfill の数え方が完全には一致しない可能性がある、という限界を残す。

INSERT INTO labels (tenant_id, name, status, proposed_count)
SELECT tenant_id, tag, 'proposed', count(*)
FROM memories, unnest(tags) AS tag
GROUP BY tenant_id, tag;

INSERT INTO memory_labels (tenant_id, memory_id, label_id)
SELECT DISTINCT m.tenant_id, m.id, l.id
FROM memories m
CROSS JOIN LATERAL unnest(m.tags) AS t(tag)
JOIN labels l ON l.tenant_id = m.tenant_id AND l.name = t.tag;

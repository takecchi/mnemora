-- 0026_memory_relations.sql
--
-- Issue #207 / #933 PR2（ADR 0292 決定1、ADR 0327 §2・§5、ADR 0378 決定1〜4、ADR 0381）:
-- 3件以上の claim key 衝突を表現する関係グラフの表。2者間の `contested_with_id`/`status`
-- 列（0001_init.sql）はそのまま残す——ADR 0378 決定1 の (ii) 別口新設。既存の2者データは
-- backfill しない（列のまま）。
--
-- ## なぜこの形か
--
-- ADR 0292 決定1-a・1-b・1-c をそのまま実装する:
--
-- - `kind` は `'contradicts'` の1値に CHECK で絞る（`supersedes`/`consolidates_from`/
--   `derived_from`/`supports` は入れない——既に列・jsonb に保存済み、または出所不明。
--   ADR 0292 §2 決定1-a）。列自体は残す——将来 `kind` を増やす判断は、この CHECK を
--   広げるマイグレーションで済む（列追加より軽い）。
-- - 対称な `contradicts` は双方向2行で書く（`A→B`・`B→A`）——`OR` クエリを作らず、
--   単純な等値索引スキャンで済ませる（ADR 0292 決定1-b）。書き込み経路
--   （`MemoryStore.markContestedGroup?`/`resolveContestedGroup?`、ADR 0381）が両方向を
--   1トランザクションで書く契約を持つことで、`UNIQUE` 制約が片方向だけの重複を防げない
--   欠落を補う。
-- - `tenant_id` を全索引・`UNIQUE` の先頭に置く（[ADR 0007](../../../docs/decisions/0007-tenant-scoping.md)
--   と同じ tenant scoping の形）。
--
-- ## `from_memory_id`/`to_memory_id` に `ON DELETE` を付けない理由
--
-- `memories` 行は物理削除されない——forget/archive/supersede は status 遷移、purge は
-- 内容をトゥームストーン化するだけで行自体は残る（`packages/postgres/src/memory-store.ts`
-- の `purgeMemory` を参照）。この FK が `ON DELETE` の挙動を試される場面が無いため、
-- 既定（`NO ACTION`）のままにする。
--
-- ## 既存の2者データは動かさない
--
-- `contested_with_id`/`status='contested'` の既存行は、このマイグレーションでは一切
-- 触れない——ADR 0378 決定1 の (ii) が「2者間は列のまま」と決めている。3件以上に
-- なった場合だけ、書き込み経路（Runtime 側、ADR 0381）が対の列を空にしてこの表へ移す
-- （穴A、ADR 0381 決定5）。

CREATE TABLE memory_relations (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       text        NOT NULL,
  from_memory_id  uuid        NOT NULL REFERENCES memories(id),
  to_memory_id    uuid        NOT NULL REFERENCES memories(id),
  kind            text        NOT NULL CHECK (kind IN ('contradicts')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, from_memory_id, to_memory_id, kind)
);

CREATE INDEX idx_memory_relations_from ON memory_relations (tenant_id, from_memory_id, kind);
CREATE INDEX idx_memory_relations_to   ON memory_relations (tenant_id, to_memory_id, kind);

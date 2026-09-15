-- 0011_memory_events_kind_restored.sql
--
-- Issue #195 / ADR 0122: `Runtime.restoreArchived` が積む `memory_events.kind = 'restored'`
-- を許可する（`status='archived'` → `status='active'` の明示的な復帰。
-- docs/memory-model.md §11 行14）。
--
-- `packages/core/src/event.ts` の `MemoryEventKind` 型・`MemoryEventKindSchema`（zod）へは
-- 既に `"restored"` を追加してある。この移行はそれに対応する DB 側の CHECK 制約
-- （`0001_init.sql:149-151`）を広げるだけであり、他の列・索引・制約は一切変えない。
--
-- **なぜ制約名をハードコードしないか。**`0001_init.sql` の `kind` 列の CHECK は無名で
-- 宣言されており（`kind text NOT NULL CHECK (kind IN (...))`）、実際に生成される制約名は
-- PostgreSQL のデフォルト命名規則（`<table>_<column>_check`）に依存する。手元にこの移行を
-- 実行して確かめられる Postgres が無いため（この作業環境に DATABASE_URL が無い）、
-- 名前を推測して `DROP CONSTRAINT <推測した名前>` と書くのは危険——名前が外れていれば
-- 移行そのものが失敗するか、最悪の場合べつの制約を誤って落とす。
--
-- 代わりに `pg_constraint`/`pg_get_constraintdef` から**定義の中身**で対象を特定する。
-- `memory_events` には `kind` に関する CHECK 制約が2本ある:
--   1. `kind IN ('created', ..., 'events_purged')`        -- 本移行が広げたいもの
--   2. `kind <> 'events_purged' OR memory_id IS NULL`      -- 触ってはいけないもの
-- PostgreSQL は `IN (...)` を正規化して `= ANY (ARRAY[...])` という定義文字列に変換する
-- （`pg_get_constraintdef` の出力）。2本目の定義にはこの部分文字列が現れないため、
-- `LIKE '%= ANY%'` で1本目だけを一意に特定できる。対象が見つからない・複数見つかった
-- 場合は `RAISE EXCEPTION` で失敗させる——想定が崩れていたら黙って何もしない、
-- ではなく気付けるようにする。

DO $$
DECLARE
  target_constraint text;
  match_count int;
BEGIN
  SELECT con.conname, count(*) OVER ()
  INTO target_constraint, match_count
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  WHERE rel.relname = 'memory_events'
    AND con.contype = 'c'
    AND pg_get_constraintdef(con.oid) LIKE '%= ANY%';

  IF match_count IS NULL OR match_count = 0 THEN
    RAISE EXCEPTION
      'memory_events: kind の CHECK 制約（IN リスト側）が見つからない。想定した形（0001_init.sql）から変わっていないか確認すること';
  END IF;
  IF match_count > 1 THEN
    RAISE EXCEPTION
      'memory_events: kind の CHECK 制約の候補が % 件あり一意に特定できない', match_count;
  END IF;

  EXECUTE format('ALTER TABLE memory_events DROP CONSTRAINT %I', target_constraint);
END $$;

ALTER TABLE memory_events
  ADD CONSTRAINT memory_events_kind_check
  CHECK (kind IN
    ('created', 'updated', 'superseded', 'archived', 'forgotten', 'purged',
     'events_purged', 'restored'));

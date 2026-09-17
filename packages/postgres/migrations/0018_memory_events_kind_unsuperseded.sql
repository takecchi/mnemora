-- 0018_memory_events_kind_unsuperseded.sql
--
-- `Runtime.restoreSuperseded`（superseded → active の復旧口。`superseded → active` は
-- docs/memory-model.md §11 の遷移表に足す行）が積む `memory_events.kind = 'unsuperseded'`
-- を許可する。
--
-- `packages/core/src/event.ts` の `MemoryEventKind` 型・`MemoryEventKindSchema`（zod）へは
-- 既に `"unsuperseded"` を追加してある。この移行はそれに対応する DB 側の CHECK 制約
-- （`0001_init.sql:149-151`、`0011_memory_events_kind_restored.sql` が一度広げたもの）を
-- さらに広げるだけであり、他の列・索引・制約は一切変えない。
--
-- **なぜ `"restored"` を再利用しないか**（`packages/core/src/event.ts` の doc コメントに
-- 詳しい）。`idx_memory_events_by_kind`（`tenant_id, kind, at`）で監査ログを引くとき、
-- 「archive から戻った」（`restoreArchived`）と「supersede を取り消した」
-- （`restoreSuperseded`）が同じ `kind` だと索引で分けて引けない——ADR 0122 が
-- `"updated"` の再利用を却下して `"restored"` を新設したのと同じ理由で、専用の値を足す。
--
-- **なぜ制約名をハードコードしないか。**`0011_memory_events_kind_restored.sql` と
-- まったく同じ理由・まったく同じ形を踏襲する（この移行を実行して確かめられる Postgres が
-- 手元に無い時点で書く可能性があるため、名前を推測しない）。
--
-- 代わりに `pg_constraint`/`pg_get_constraintdef` から**定義の中身**で対象を特定する。
-- `memory_events` には `kind` に関する CHECK 制約が2本ある:
--   1. `kind IN ('created', ..., 'restored')`                -- 本移行が広げたいもの
--   2. `kind <> 'events_purged' OR memory_id IS NULL`          -- 触ってはいけないもの
-- PostgreSQL は `IN (...)` を正規化して `= ANY (ARRAY[...])` という定義文字列に変換する
-- （`pg_get_constraintdef` の出力）。2本目の定義にはこの部分文字列が現れないため、
-- `LIKE '%= ANY%'` で1本目だけを一意に特定できる。対象が見つからない・複数見つかった
-- 場合は `RAISE EXCEPTION` で失敗させる——想定が崩れていたら黙って何もしない、
-- ではなく気付けるようにする。
--
-- 🔴 `rel.relname = 'memory_events'` だけでは足りない（0011 が CI で実際に踏んだ、
-- ADR 0057）。`packages/postgres/src/migrate.ts` は専用スキーマ（ADR 0057）向けに各移行
-- ファイルを、`SET LOCAL search_path TO <schema>[,<extensionSchema>]` の直後に実行する
-- ——この切り替え文そのものの正確な構文は `migrate.ts` を参照。このファイル自身も含め、
-- 移行の中身は常に裸のテーブル名（`memory_events`）で書かれており、どのスキーマに効くかは
-- search_path 任せである（`schema-namespace.ts` の doc: 「DML は search_path に任せ、DDL と
-- 存在検査は明示修飾する」。この移行の `ALTER TABLE memory_events ...` 自体が前者の形
-- そのもの）。1つの DB に複数の専用スキーマを同居させると、`pg_class`/`pg_constraint` には
-- 各スキーマの `memory_events` が別行として存在する。`relname` だけで絞ると**どのスキーマの
-- 行かを区別せずに全部拾う**ため、他のスキーマで本移行が既に適用済みだと候補が2件以上に
-- なり、まさにこの安全弁が発火する。**安全弁は設計どおり働いた——直すのは安全弁ではなく
-- この絞り込み。**`pg_table_is_visible(rel.oid)` で、今まさに `search_path` の下で裸の
-- `ALTER TABLE memory_events` が指すのと同じ1行だけに絞る（他スキーマの同名テーブルは
-- search_path 上で隠れているので visible にならない）。

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
    AND pg_table_is_visible(rel.oid)
    AND con.contype = 'c'
    AND pg_get_constraintdef(con.oid) LIKE '%= ANY%';

  IF match_count IS NULL OR match_count = 0 THEN
    RAISE EXCEPTION
      'memory_events: kind の CHECK 制約（IN リスト側）が見つからない。想定した形（0011_memory_events_kind_restored.sql）から変わっていないか確認すること';
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
     'events_purged', 'restored', 'unsuperseded'));

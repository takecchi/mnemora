-- 0032_purge_indexes.sql
--
-- ADR 0412（ADR 0404 決定7の改訂）: `purgeExpiredRecalls`（`memory-store.ts` の
-- `buildPurgeExpiredRecallsTargetSelect`）と `purgeCompletedJobs`（`outbox-store.ts` の
-- `buildPurgeCompletedJobsTargetSelect`）が対象を選ぶ SELECT のための索引を2本足す。
-- SQL と振る舞いは変えない。
--
-- ## 何のための索引か
--
-- どちらの SELECT も「1テナントの、ある時刻より古い行を、古い順に limit+1 件」である:
--
--   SELECT id, created_at FROM recalls
--   WHERE tenant_id = $1 AND created_at < $2
--   ORDER BY created_at ASC, id ASC LIMIT $3 [FOR UPDATE]
--
--   SELECT id, completed_at FROM outbox
--   WHERE tenant_id = $1 AND completed_at IS NOT NULL AND completed_at < $2
--   ORDER BY completed_at ASC, id ASC LIMIT $3 [FOR UPDATE SKIP LOCKED]
--
-- 索引が無いと、どちらも Seq Scan + Sort になり、1回の呼び出しの
-- 費用が表の行数に比例する（対象が 0 件でも表を全部読む）。outbox の既存の索引はどれも
-- `completed_at IS NULL` の部分索引（未処理の行のための索引）で、この問い合わせには使えない。
--
-- ## 列と述語
--
-- - `idx_recalls_by_created (tenant_id, created_at, id)`: `ORDER BY created_at, id` を索引の並びが
--   そのまま供給する（Sort が消え、LIMIT で早期に打ち切れる）。部分索引ではない。
-- - `idx_outbox_completed (tenant_id, completed_at, id) WHERE completed_at IS NOT NULL`:
--   述語は問い合わせの `completed_at IS NOT NULL` と同じ形なのでプランナが導ける。完了した行だけを
--   索引に入れるので、未処理の行（ワークキューの大半の時間は少数派）には索引の費用が乗らない。
--   ただし `complete` の UPDATE は `completed_at` を書くので HOT 更新にならず、索引エントリが増える
--   （ADR 0412 が受け入れた上乗せ）。
--
-- ⚠ 書き込みへの上乗せ: 全 recall の INSERT と全 outbox の `complete` に、purge を呼ばない利用者も
-- 含めて恒久的な上乗せが乗る。実測は ADR 0412。
--
-- ⚠ 手で `CREATE INDEX CONCURRENTLY` を流せる経路は作らない（Issue #760 の決定。
-- 0027・0029 と同じくトランザクション内の素の `CREATE INDEX`）。`recalls` と `outbox` への書き込みは
-- 索引作成の間（`ShareLock`）止まる。
CREATE INDEX idx_recalls_by_created
  ON recalls (tenant_id, created_at, id);

CREATE INDEX idx_outbox_completed
  ON outbox (tenant_id, completed_at, id)
  WHERE completed_at IS NOT NULL;

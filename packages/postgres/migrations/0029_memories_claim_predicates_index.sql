-- 0029_memories_claim_predicates_index.sql
--
-- ADR 0329 の 2026-09-30 追記: `listActiveClaimPredicates`（`packages/postgres/src/memory-store.ts`）
-- 専用の部分索引を足す。SQL と振る舞いは変えない——`knownPredicatesFromStore`（opt-in）が
-- observe のたびに打つ問い合わせが、この索引だけで（Index Only Scan で）答えられるようになる。
--
-- ## 何のための索引か
--
-- `listActiveClaimPredicates` が打つのは次の形である:
--
--   SELECT claim_key_predicate FROM memories
--   WHERE tenant_id = $1 AND subject_id [IS NOT DISTINCT FROM 相当] $2
--     AND status = 'active'
--     AND claim_key_subject IS NOT NULL AND claim_key_predicate IS NOT NULL
--   GROUP BY claim_key_predicate ORDER BY MAX(created_at) DESC LIMIT $3
--
-- 既存の `idx_memories_claim_key`（0021、`(tenant_id, subject_id, claim_key_subject,
-- claim_key_predicate) WHERE claim_key_subject IS NOT NULL`）でも索引は引けるが、`status` の
-- 絞りが Filter に落ち（ヒープを読む）、`created_at` を索引が持たないので Sort/Aggregate も要る。
--
-- ## 列と述語
--
-- `(tenant_id, subject_id, claim_key_predicate, created_at)` + `WHERE status = 'active' AND
-- claim_key_subject IS NOT NULL AND claim_key_predicate IS NOT NULL`。
--
-- - `status` はキーに入れず、部分索引の述語へ移した。問い合わせの `WHERE` と同じ形の述語なので
--   プランナが述語を導け、キーの列を1つ減らせる（`status` を等号で固定する問い合わせしかない）。
-- - 問い合わせが読む列（`claim_key_predicate`・`created_at`）がすべて索引に入るので、
--   Index Only Scan になりうる（visibility map が all-visible のページに限る）。
-- - `claim_key_subject` はキーに入れない（`IS NOT NULL` の述語でだけ使う）。
--
-- ⚠ 手で `CREATE INDEX CONCURRENTLY` を流せる経路は作らない（Issue #760 の決定。
-- 0027 と同じくトランザクション内の素の `CREATE INDEX`）。`memories` への書き込みは
-- 索引作成の間（`ShareLock`）止まる。
CREATE INDEX idx_memories_claim_predicates
  ON memories (tenant_id, subject_id, claim_key_predicate, created_at)
  WHERE status = 'active'
    AND claim_key_subject IS NOT NULL
    AND claim_key_predicate IS NOT NULL;

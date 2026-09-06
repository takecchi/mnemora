-- 0002_outbox_claim_lease_index.sql
--
-- ADR 0032: `PostgresOutboxStore.claimBatch`（`packages/postgres/src/outbox-store.ts`）の
-- WHERE から `claimed_at` の条件が抜け落ちていた（クエリは `completed_at IS NULL AND
-- failed_at IS NULL AND available_at <= now` だけを見ており、`idx_outbox_pending` の述語
-- `WHERE completed_at IS NULL AND claimed_at IS NULL` を含意していなかった）。本 PR で
-- `claimBatch` にリース条件（`claimed_at IS NULL OR claimed_at <= now - leaseMs`）を足した
-- ため、`idx_outbox_pending` の述語はもう当てはまらない——`claimed_at` に依存する述語は
-- `leaseMs`（クエリ実行時の引数）次第で成否が変わり、部分索引の述語（作成時に固定される
-- 定数式でなければならない）としては使えない。
--
-- **`idx_outbox_pending` は DROP しない**（追加のみのマイグレーションに留める。ADR 0032
-- 「採らなかった案」参照）。以後この索引はプランナから選ばれなくなる見込みだが、
-- 存在すること自体の害はなく、破壊的な変更（DROP）を避ける方を優先した。
--
-- 新しい索引 idx_outbox_claimable の述語 `completed_at IS NULL AND failed_at IS NULL` は、
-- `claimBatch` の新しい WHERE 句が持つ AND 節の部分集合であり、`leaseMs`/`now` の値に関わらず
-- 常に成立する（`claimed_at` を述語に含めていないため、リースの実引数から独立している）。

CREATE INDEX idx_outbox_claimable
  ON outbox (tenant_id, kind, available_at)
  WHERE completed_at IS NULL AND failed_at IS NULL;

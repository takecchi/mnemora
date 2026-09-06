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
--
-- **列順を (tenant_id, available_at) にし、`kind` を索引に入れない**（マネージャー指摘、
-- CI の EXPLAIN 実測で判明）。`idx_outbox_pending` を含め、当初 `(tenant_id, kind,
-- available_at)` にしていたが、`claimBatch` は `kind = ANY(ARRAY['extract','embed'])`
-- のように複数の kind を指定する（`runtime.tick` の既定が `["extract", "embed"]`）。
-- 索引の列順が `(tenant_id, kind, available_at)` だと、`kind` を等号1点に絞らない限り
-- 索引の並びは `available_at` の全体順序を提供できない（`tenant_id` 固定でも、
-- `kind` ごとに `available_at` が別々にソートされた区間になるだけ）——
-- `ORDER BY available_at ASC LIMIT n` を索引だけで満たせず、必ず `Sort` を挟む。
-- `kind` を索引から外し `(tenant_id, available_at)` にすれば、`tenant_id` の等値だけで
-- `available_at` 昇順の並びをそのまま使えて `LIMIT` が早期に打ち切れる。`kind` は
-- 索引で絞り込む代わりに、残った行への `Filter` 条件として効けば十分（claim 可能な行の
-- 母数はそもそも小さいことが前提、下記 EXPLAIN テストの seed 参照）。

CREATE INDEX idx_outbox_claimable
  ON outbox (tenant_id, available_at)
  WHERE completed_at IS NULL AND failed_at IS NULL;

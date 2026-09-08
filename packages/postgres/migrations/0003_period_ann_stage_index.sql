-- 0003_period_ann_stage_index.sql
--
-- ADR 0059: 段1（ANN 検索、`PostgresVectorStore.search`）の WHERE 句に period
-- （`occurredAfter`/`occurredBefore`）の述語を降ろした。比較対象は
-- `COALESCE(occurred_at, recorded_at)`（ADR 0039 が定義した「実効時刻」）。
--
-- この式を実際に索引で支えるため、(tenant_id, status, COALESCE(occurred_at, recorded_at))
-- の3列の式索引を1本、**追加だけで**足す——既存の idx_memories_recall_gate
-- (tenant_id, status, decay_floor_at) は作り直さない（ADR 0059「採らなかった案」参照）。
--
-- 実測（前任者からの引き写し。ADR 0059 参照。**本 PR の作業者は測定用 Postgres を
-- 立てておらず、この実測値を裏取りしていない**）: 100,000行・256次元・1点のみで、
-- 2列 (tenant_id, COALESCE(...)) 索引との比較。返す件数は同じで、この3列索引は
-- 狭い窓（0.1%/1%）で1.3〜2.1倍速い。広い窓（10%/50%）の絞りは効かないまま残る
-- （この移行では塞がない）。段5（`aggregateScope`）はこの索引の恩恵を受けない
-- （集約は `WHERE` 句ではなく `count(*) FILTER (WHERE ...)` の中で評価されるため）。

CREATE INDEX idx_memories_period_ann_stage
  ON memories (tenant_id, status, COALESCE(occurred_at, recorded_at));

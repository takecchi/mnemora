# 0059. 段1の ANN クエリで `period` を絞る（`COALESCE(occurred_at, recorded_at)` の式索引を1本足す）

**状態**: WIP（実装中。この節は着地時に書き直す）

## 決定

段1（ANN 検索）の `WHERE` 句に `period` の述語を降ろす。比較対象は
`COALESCE(occurred_at, recorded_at)`。あわせて
`(tenant_id, status, COALESCE(occurred_at, recorded_at))` の式索引を1本、追加だけで入れる。

`hnsw.iterative_scan` は**入れない**（別の腕として切り出す）。

## まだ書いていないこと

**この ADR は未完である。** 実装が着地した時点で、以下を埋める:

- 採らなかった案とその理由
- 実測値（前任者の報告からの引き写しであることを明記する）
- 測っていないこと（1,000,000行・1536次元・広い窓・段5）
- 覆る条件

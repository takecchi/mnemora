# mgr-06cc1811 変異試験の控え（vector / lexical / trigram）

- 基点: main 33d53442（3つの対象ファイルは bf52db73 から変わっていない）
- 前任 mgr-344011cc の退避 ref は L4 の変異（coverage を百分位に丸める）が当たったままの lexical-store.ts だけ。結果の控えは残っていない。
- Postgres: 自分専用 127.0.0.1:55437, UTF8, pg_trgm 1.6, vector 0.8.0
- 置き換え: mutate.mjs（一致がちょうど1件のときだけ書く）, 定義は mutants.mjs
- 流す試験: t-vector.txt（V）, t-lexical.txt（L）, t-trigram.txt（T）

## 結果

-- 0035_memory_events_seq.sql
--
-- ADR 0702: `memory_events` に、store が記録した順の番号 `seq` を足す。
--
-- ## なぜ要るか
--
-- `at` は呼び出し側（runtime）の時計の値で、DB の時刻でも連番でもない。複数のプロセスで時計がずれると、
-- 同じ記憶のイベントでも `ORDER BY at` の順が実際の遷移の順と逆になる（例: 時計が 10 秒進んだワーカーが
-- archive し、1 秒進んだワーカーがその後で restore すると、`restored` が `archived` より前に並び、
-- 履歴から最終状態を `archived` と誤る）。
--
-- ## 順が保証できる理由
--
-- 状態を変える経路はどれも、同じトランザクションの中で対象の `memories` の行をロック（UPDATE・FOR UPDATE）して
-- から、イベントを INSERT する。行ロックはコミットまで保持されるので、同じ記憶への次の遷移は前のトランザクションの
-- コミットを待ってから INSERT する。⟹ 同じ記憶のイベントでは、`seq` の採番順が遷移の順と一致する。
-- 違う記憶どうしの `seq` の大小は意味を持たない。連番の保証も無い（ロールバックで欠番が出る）。
--
-- ## 既存の行
--
-- 列を足すときに、既存の行にも番号が振られる。その順は物理的な並びで、遷移の順とは限らない。
--
-- 保持期間と削除の方針（`purgeExpiredEvents` は `at` で選ぶ）は変えない。

ALTER TABLE memory_events
  ADD COLUMN IF NOT EXISTS seq bigint GENERATED ALWAYS AS IDENTITY;

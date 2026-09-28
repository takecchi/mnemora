-- 0024_tenant_subject_activity.sql
--
-- Issue #338 / ADR 0348: 活動時計の数え方を、呼び出しごとの引数で選べるようにする。
--
-- **オーナーの回答（ask_human 61355570、逐語）**: 「呼び出す際の引数で指定できるようには
-- できない？ これは使用者次第の内容だと思ったんだけど」。
--
-- ADR 0165 は「1単位 = recall() 1回」をテナント1行の `tenant_activity.activity_seq`
-- （以下 `T`）で数えると決めた。ADR 0311 が実測したとおり、subject を絞った recall
-- （`ctx.subjectId` 指定）でも `T` が進むため、B に絞った recall が A の記憶の忘却を
-- 進める（本 Issue の症状）。
--
-- 本マイグレーションは、`T` に加えて **subject ごとのカウンタ `S_x`** を持つ
-- テーブルを1本足す。ある Memory（subject `x`）の「有効ないま」は常に `T + S_x`
-- （`x` が無い＝主題なしの記憶は `T` のみ）——これは呼び出しの `RecallQuery.
-- activityCounting` の値に関わらず、**読み取り時は常に同じ式**である
-- （`activityCounting` が制御するのは前進（+1）の対象だけ。ADR 0348 参照）。
--
-- `tenant_activity`（マイグレーション 0015）と同じ理由で、`tenant_settings` の行には
-- 相乗りさせない——recall のたびの UPDATE が設定の読み出しをカウンタの行ロックで
-- 待たせないため。

CREATE TABLE tenant_subject_activity (
  tenant_id    text        NOT NULL,
  subject_id   text        NOT NULL,
  activity_seq bigint      NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, subject_id),
  CONSTRAINT tenant_subject_activity_seq_non_negative CHECK (activity_seq >= 0)
);

-- 読み取り側（`hasSubjectActivityCounters?`、`(tenant_id) EXISTS` 相当）は主キーの
-- 先頭列（`tenant_id`）で引けるので、追加の索引は要らない。`getSubjectActivitySeqs?`
-- （`WHERE tenant_id = $1 AND subject_id = ANY($2)`）も同じ主キーで引ける。

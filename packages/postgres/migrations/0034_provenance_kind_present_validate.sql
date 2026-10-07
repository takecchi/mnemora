-- 0034_provenance_kind_present_validate.sql
--
-- Issue #1909: `0033_provenance_kind_present.sql` が `NOT VALID` で足した制約
-- `memories_provenance_kind_present` を、既存行に対して検証する。
--
-- ## なぜ別ファイル（別トランザクション）に分けたか
--
-- `0017` と同じ理由である。`VALIDATE CONSTRAINT` 単独は `SHARE UPDATE EXCLUSIVE`（読み書きを
-- ブロックしない）で走るが、`ADD CONSTRAINT` と同じトランザクションに置くと先に取った
-- `ACCESS EXCLUSIVE` が走査の間ずっと効く。また、失敗したときに `0033` の保護まで巻き戻らない。
--
-- ## 🔴 このファイルが失敗したら
--
-- **既存の行に、`provenance` の jsonb が `kind` を持たない行がある**ということである
-- （`{}`・`{"kind": null}`・オブジェクトでない jsonb）。`0033` は commit 済みなので新しい書き込みは
-- 既に守られているが、既存のその行はこの migration が通るまで残る。
-- **その場でデータを直さない**——その行を作ったもの（生 SQL・別の書き手）を先に特定すること。
-- 見つけるには:
--
--   SELECT id, tenant_id, provenance_kind, provenance FROM memories
--   WHERE provenance->>'kind' IS NULL;
--
-- `provenance_kind`（列）が正しいと確かめられた行だけ、jsonb の `kind` を列に合わせて直し、
-- その後に `runMigrations` を流し直す（0033 は台帳に残っているので、検証だけが走る）。

ALTER TABLE memories
  VALIDATE CONSTRAINT memories_provenance_kind_present;

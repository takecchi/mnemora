-- 0021_memories_claim_key.sql
--
-- Issue #371（(B) 第1段、ADR 0185 決定2・決定3・決定4、ADR 0314）: 「この記憶は何についての
-- 主張か」を表す構造化された鍵を持たせる。**検出（#372）はこの migration の範囲外**——
-- ここで足すのは列と索引だけであり、この列を読んで `contested` を立てる処理は1行も無い。
--
-- ## なぜ2つの text 列か（JSONB 1列にしない）
--
-- `Memory.claimKey`（`@mnemora/core`）は `{ subject, predicate }` というネストしたオブジェクト
-- だが、これは `provenance`（判別共用体、値の形が種類ごとに変わる）とは性質が違う——
-- `claimKey` は常に同じ2つのスカラーの組でしかない。次の段（#372）が要求する索引アクセス
-- （「同じ tenant・同じ subject_id・同じ claim key を持つ他の active な行を探す」）は、
-- 2つの平たい text 列 + 通常の btree 複合索引のほうが、jsonb の式索引より単純で
-- プランナに読みやすい（`idx_memories_lexical` の doc コメントが式索引を選んだ理由と対照的
-- ——あちらは「生成列を避けたい」動機があったが、こちらは列を増やすこと自体が目的である）。
--
-- ## 正規化はアプリ側の責務
--
-- この列に入る文字列は、書き込み側（`packages/core/src/claim-key.ts` の
-- `normalizeClaimKeyPart`: NFKC 正規化・前後空白除去・小文字化・内部空白を `_` に畳む）が
-- 既に正規化済みであることを前提にする。DB 側では追加の正規化（`CHECK` 制約での
-- 小文字強制等）を行わない——アプリ側の正規化規則が変わったときに DB 側の制約と
-- 二重に保守することを避けるため（ADR 0314 決定3「正規化規則は#371の実装判断」）。
--
-- ## NULL の意味
--
-- 両方 NULL は「鍵なし」（opt-in を使っていない、または鍵が取れなかった、既存の記憶）。
-- **片方だけ NULL の行は、書き込み側（`buildNewMemoryFromCandidate`）が作らない契約だが、
-- この migration では CHECK 制約で強制しない**——`claimKey` は `@mnemora/core` の型としては
-- 常に `{subject, predicate}` の組かNULLであり（`ClaimKeySchema`）、部分的な組は型の時点で
-- 表現できない。DB 側に同じ制約を重ねると、将来 `MemoryStore` を独自実装する adapter
-- （`@mnemora/core` は公開パッケージ、任意の adapter を書ける）が、たとえば「主語だけ先に
-- わかっている」段階的な書き込みを行いたくなったときに不必要に硬い。
--
-- ## 索引: `(tenant_id, subject_id, claim_key_subject, claim_key_predicate)`
--
-- Issue #371 本文「索引を張る（次の段の検出が索引アクセスで済む形にしておくこと）」への
-- 対応。#372（未実装）が行う想定のクエリ形（「同じテナント・同じ subject_id・同じ claim key
-- を持つ、他の active な Memory を探す」）に対して、この列順で先頭から絞り込める。
-- `status` を索引に含めない理由: `idx_memories_contested`（0004）と違い、この索引は
-- 「特定の status だけを対象にした部分索引」ではなく「claim key で引く」ための汎用索引
-- ——#372 がどの status 集合を対象にするか（`active` のみか `active`+`contested` か）を
-- この ADR/issue の範囲では決めていない（ADR 0185 決定4 は「contested で止める」を決めて
-- いるが、検出クエリ自体が何を対象にするかは #372 の実装判断）。索引を status で絞ると、
-- その判断をこの migration が先取りしてしまう。
--
-- 部分索引（`WHERE claim_key_subject IS NOT NULL`）にする理由: 鍵が無い行（opt-in を
-- 使っていない既定の大多数の行）をこの索引に含めても #372 のクエリからは一度も引かれない
-- ——`idx_memories_contested`/`idx_memories_superseded_by`（0004 の doc コメント）と同じ
-- 判断。`claim_key_subject IS NOT NULL` だけを条件にし、`claim_key_predicate` も NULL で
-- ないことを別途書かないのは、上の「NULL の意味」の契約（両方 NULL かどちらも非 NULL）を
-- 前提にしているため——DB 側で強制していない契約に索引の述語だけを頼るのは危ういが、
-- 万一 `claim_key_subject` が非 NULL で `claim_key_predicate` が NULL の行ができても、
-- この部分索引に含まれるだけで実害はない（含まれすぎるだけで、含まれなさすぎない）。
--
-- ⚠ `CREATE INDEX CONCURRENTLY` は使わない。`0004_contested_with_index.sql` /
-- `0008_memories_lexical_index.sql` と同じ理由（`migrate.ts` が1ファイル=1トランザクション
-- で包むため、`CONCURRENTLY` はそもそもこの migration の枠組みでは使えない）。

ALTER TABLE memories
  ADD COLUMN claim_key_subject   text NULL,
  ADD COLUMN claim_key_predicate text NULL;

CREATE INDEX idx_memories_claim_key
  ON memories (tenant_id, subject_id, claim_key_subject, claim_key_predicate)
  WHERE claim_key_subject IS NOT NULL;

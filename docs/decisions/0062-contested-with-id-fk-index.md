# ADR 0062: `memories.contested_with_id` の自己参照 FK に索引を足す — 「先頭列に tenant_id」が RI チェックには効かないことと、索引名は中身を保証しないこと

- **状態**: 採用 (2026-09)

- **文脈**:

  `memories.contested_with_id`（`packages/postgres/migrations/0001_init.sql:73`、
  `memories(id)` への自己参照 FK。`NULL` 許容）を先頭列に置いた索引が一本も
  無かった。既存の索引を読むと一見紛らわしい:

  ```sql
  -- 係争中の Memory の一括検出・companion 取得
  CREATE INDEX idx_memories_contested
    ON memories (tenant_id, status)
    WHERE status = 'contested';
  ```

  **`idx_memories_contested` という名前だけを見ると `contested_with_id` の索引だと
  誤読しうるが、これは `(tenant_id, status) WHERE status = 'contested'` という
  `status` の索引であり、`contested_with_id` は列にすら含まれていない。**
  （本 PR の作業者が `packages/postgres/migrations/0001_init.sql:124-126` を読んで確認。）

  親側（`memories`）の行を `DELETE` するたびに、PostgreSQL の参照整合性トリガーは
  次の形のクエリを発行し、「この行を `contested_with_id` として指している行が無いか」
  を確かめる（本 PR の作業者が CI の実測ログ ——
  `packages/postgres/src/__tests__/contested-with-index.test.ts` の `EXPLAIN` 出力 ——
  で確認した、逐語）:

  ```sql
  SELECT 1 FROM ONLY "public"."memories" x
    WHERE $1 OPERATOR(pg_catalog.=) "contested_with_id" FOR KEY SHARE OF x
  ```

  **この `WHERE` に `tenant_id` は一切現れない。** 索引が無い（あるいは先頭列が
  `contested_with_id` でない）と、この問い合わせのたびに `memories` 全体の
  `Seq Scan` が走る——`idx_memories_contested` も `idx_memories_recall_gate`
  （`tenant_id, status, decay_floor_at`）も `idx_memories_by_subject`
  （`tenant_id, subject_id, status`）も、先頭列が `tenant_id` である以上この
  RI チェックの絞り込みには使えない。CI の実測（`contested-with-index.test.ts`）で
  実際に `Seq Scan` になることを確認済み。

- **決定**:

  1. `packages/postgres/migrations/0004_contested_with_index.sql`
     （命名の経緯は「マイグレーション番号について」参照）に、部分索引を1本追加する:

     ```sql
     CREATE INDEX idx_memories_contested_with
       ON memories (contested_with_id)
       WHERE contested_with_id IS NOT NULL;
     ```

  2. **`idx_memories_superseded_by`（`(tenant_id, superseded_by_id) WHERE
     superseded_by_id IS NOT NULL`）と同じ形（`tenant_id` を先頭に置く）には
     しない。** 理由は下記 (a)。
  3. **既存の索引は一切変更しない。** `DROP` も列の並べ替えもせず、追加のみ。
  4. `INCLUDE` 等の追加列は持たせない——RI クエリは `FOR KEY SHARE OF x` で行ロックを
     取るため常にヒープへのアクセスが要り、`Index Only Scan` にはならない。加えて
     `grep` で確認した限り、アプリケーション側（`memory-store.ts`・`mapping.ts`）は
     `contested_with_id` を `INSERT` の列挙・`SELECT` の行マッピングに使うのみで
     `WHERE`/`JOIN` の絞り込みには使っていない。
  5. `CREATE INDEX CONCURRENTLY` は使わない。理由は下記 (c)。

- **(a) 一般則: 先頭列が `tenant_id` の複合索引は、RI（外部キー）チェックを供給できない**

  **これは本 PR 固有の事実ではなく、このリポジトリ全体に対する一般則として記録する:**

  > **RI チェックの `WHERE` 句は、参照整合性トリガーが自動生成するものであり、
  > 常に FK 列（ここでは `contested_with_id`）の等値条件だけを持つ。
  > `tenant_id` は原理的にそこへ現れない**（`memories` は単一テーブルの自己参照
  > FK であり、PostgreSQL の RI トリガーはテナントという概念を知らない）。
  > **ゆえに、先頭列が `tenant_id` の複合索引を見て「この索引があるから対応する
  > 外部キーの検査も速い」と読んではならない。** 索引は FK 列そのものが先頭に
  > 来ていない限り、その FK の RI チェックに対して**索引の絞り込み能力を提供しない**
  > ——B-tree は先頭列で絞れて初めて後続列が効くため、`tenant_id` が先頭にある限り
  > `contested_with_id = $1` という条件だけでは索引スキャンの起点を作れない。

  **今後このリポジトリで `tenant_id` 先頭の複合索引を見たとき、「テナントで絞る
  クエリ」を供給する索引だと読むのは正しいが、「テナント内のある列を指す外部キーの
  DELETE 時 RI チェックも供給する」と拡大解釈しないこと。** 両者は別の性質の
  クエリであり、後者を供給するには FK 列自身を先頭に置いた別の索引が要る。

  `idx_memories_superseded_by`（`(tenant_id, superseded_by_id) WHERE
  superseded_by_id IS NOT NULL`）を本 PR が真似なかったのはこの一般則の適用例
  である。あの索引は「この Memory は何に置き換わったか」という**アプリケーション側**
  の検索（`superseded_by_id` を使う読み取り経路。`grep` では未確認——存在すると
  仮定して設計された索引としてコメントに書かれている、`memory-store.ts` 側の
  実際の呼び出し確認は本 PR の範囲外）を `tenant_id` 前提で引くために作られたもので
  あり、**`superseded_by_id` 自身の RI チェックを供給する索引ではない**
  （もし `superseded_by_id` にも自己参照 FK があれば、`idx_memories_superseded_by`
  はそちらの RI チェックに対しても本 ADR と同じ理由で無力である——確かめていないが、
  もし `superseded_by_id` が FK なら理屈上同じ穴が既にある。**この点は本 PR の
  スコープ外であり、ここでは指摘のみに留め、直さない。**）。

- **(b) 一般則: 索引の名前は、その索引が何を供給するかを保証しない**

  `idx_memories_contested` という名前は、素直に読めば「`contested_with_id` の索引」
  に見える。**実体は `(tenant_id, status) WHERE status = 'contested'` であり、
  `contested_with_id` という列は式にも `WHERE` にも一切現れない。** 名前が指すのは
  「係争中 (`contested`) の Memory を引く」という用途であって、`contested_with_id`
  という列名ではない——**名前の類似は偶然であり、保証ではない。**

  **今後このリポジトリで「名前から中身を類推する」ことをしないこと。** 索引が
  実際に何を供給するかを知りたければ、`\d memories`（または移行ファイルの
  `CREATE INDEX` 文そのもの）を読み、列の並びと `WHERE` 述語を確認する。本 PR は
  この読み違いが実際に起こりうることを、`idx_memories_contested` という実例で
  示した——**「`contested` という名前の索引があるから `contested_with_id` は
  もう塞がれている」と誤読した結果として、この穴が長期間見つからずに残っていた
  可能性がある**（本 PR 以前にこの索引が「足りている」と判断された経緯は
  確かめていない。あくまで、この読み違いが起こりうる実例として記録する）。

- **(c) `CREATE INDEX CONCURRENTLY` が使えないことと、引き受ける負債**

  `packages/postgres/src/migrate.ts` は各マイグレーションファイルを丸ごと1つの
  トランザクションで実行する——本 PR の作業者が現物を読んで確認した
  （`migrate.ts:340` の `await client.query("BEGIN");` から `migrate.ts:349` の
  `await client.query("COMMIT");` まで。失敗時は `migrate.ts:352` で
  `ROLLBACK`）。**`CREATE INDEX CONCURRENTLY` はトランザクションブロックの内側
  では実行できない**（PostgreSQL 自体の制約であり、`migrate.ts` の設計を直しても
  この制約自体は消えない）。⟹ この実行系を使う限り、`CONCURRENTLY` という選択肢は
  そもそも存在しない。既存の `0002_outbox_claim_lease_index.sql`・
  `0003_period_ann_stage_index.sql` も同じ理由で素の `CREATE INDEX` を使っており、
  本マイグレーションはその先例と整合している。

  **引き受ける負債として明記する**:

  - **素の `CREATE INDEX` は `ACCESS EXCLUSIVE` ロックを取る。** その間、
    `memories` テーブルへの書き込み（`observe()` からの挿入・`reinforce`・
    `setEmbeddingStatus`・DELETE を含むすべて）が止まる。
  - **100万件級のテーブル（`docs/roadmap.md` がテナントあたりの想定規模として
    前提に置く数字）では、この停止時間が実運用上無視できない長さになりうる**
    ——具体的にどれだけ止まるかはこの PR では測っていない。
  - **⚠ 非トランザクションの移行経路（`CREATE INDEX CONCURRENTLY` を使える実行系）
    を別途作るかどうかは、本 ADR・本 PR の範囲を超える、もっと大きい判断である。**
    本 PR はこれを「そうすべきだ」とは決めない——決めるとしたら、既存の全
    マイグレーションの実行モデル（advisory lock によるプロセス間排他、ADR 0017）
    との整合を含めて再設計が要り、1本の索引追加のために決めることではない。
    **本 PR は意図的にこの手段へ踏み込まない。**

- **マイグレーション番号について**:

  本 ADR の対象の実装は当初 `packages/postgres/migrations/0003_contested_with_index.sql`
  として書かれた。その後 `main` に `0003_period_ann_stage_index.sql`（ADR 0059、PR #67）
  がマージされ、`0003_*` が2本になる状態を避けるため、本 PR の作業として
  `0004_contested_with_index.sql` へ改名した（`git mv` + ファイル先頭の自己参照コメント
  + テストファイル内の参照を追随。詳細はコミットメッセージ・PR 参照）。索引の定義・
  テストの assert・本 ADR が扱う3点の論旨には変更を加えていない。

- **採らなかった案**:

  - **`(tenant_id, contested_with_id)` の複合索引にする**（`idx_memories_superseded_by`
    と同じ形）。却下。上記 (a) の理由により、RI チェックの `WHERE` に `tenant_id`
    が現れない以上、先頭列を `tenant_id` にすると索引の絞り込み能力を活かせない
    ——実質的に索引全体を舐めるのと変わらない。
  - **無条件の単一列索引（`WHERE` 句なし）にする。** 部分索引（`WHERE
    contested_with_id IS NOT NULL`）と比較し、CI の `EXPLAIN` 実測でどちらが
    実際にプランナから選ばれるかで決めた。`$1 = contested_with_id` という
    strict な等号演算子は、一致する行の `contested_with_id` が `NULL` ではあり
    得ないことを含意し、プランナはこの含意を使って部分索引の述語を証明できる。
    実測でこの部分索引が実際に選ばれることを確認できたため、より小さい部分索引を
    採用した（`idx_memories_superseded_by`・`idx_memories_contested` と同じ
    「NULL が多数派の列は部分索引にする」という、このスキーマの既存の規約にも合う）。
  - **`CREATE INDEX CONCURRENTLY` を使える形に `migrate.ts` を書き換える。**
    マネージャーの指示によりこの PR の権限の外——(c) 参照。

- **⭐ 変異試験について（この PR の作業者が用意したもの、CI 未実測）**:

  `packages/postgres/src/__tests__/contested-with-index.test.ts` が実際にどの変異を
  捕まえるかは、**本物の PostgreSQL に対する `EXPLAIN` の実測でしか判定できない**
  ——この作業環境には Postgres/`DATABASE_URL` が無いため、以下の変異はいずれも
  **パッチとして用意しただけであり、赤/緑の判定はしていない。**

  1. `(contested_with_id)` → `(tenant_id, contested_with_id)`（先頭列を破壊する）
  2. `WHERE contested_with_id IS NOT NULL` の部分索引述語を削除する
  3. 索引の `CREATE INDEX` 文自体を削除する

  用意したパッチは `/tmp/mutations/`（この器のローカルパス、リポジトリの一部ではない）
  に置いた。**次の CI 実行で `packages/postgres` の DB ジョブが走った時点が、
  これらの変異に対する唯一の実測経路である。**

- **これが覆るとしたら**:

  - **`ACCESS EXCLUSIVE` ロックの停止時間が実運用で許容できない長さになると
    判明したら**、非トランザクションの移行経路を別途設計する、より大きな判断の
    引き金になる（(c) 参照）。
  - **`superseded_by_id` に自己参照 FK があり、かつ `idx_memories_superseded_by`
    がその RI チェックを供給できていないことが確認されたら**、本 ADR と同じ理由で
    別途 `superseded_by_id` 先頭の索引を追加する判断が要る——ただし本 PR は
    `superseded_by_id` に索引を追加しない（明示的にスコープ外）。
  - **CI の `EXPLAIN` 実測で `idx_memories_contested_with` が選ばれなかった場合**、
    索引の形（部分/無条件、列の追加）を見直す。

- **確かめていないこと**:

  - **本 PR 以前にこの穴（`contested_with_id` の RI チェックが `Seq Scan` になる）が
    見つからなかった経緯・理由は確かめていない。** 「索引名から中身を誤読した」は
    ありうる説明として (b) に書いたが、実際の経緯（そもそも気づかれていなかったのか、
    気づいた上で後回しにされたのか）は調べていない。
  - **`superseded_by_id` が自己参照 FK かどうか、それに対する RI チェックが同じ穴を
    持つかどうかは確かめていない。** (a) に「もし FK なら理屈上同じ穴がある」と
    書いたが、これは推論であり、`0001_init.sql` の `superseded_by_id` 列定義を
    読んで FK 制約の有無を確認する作業はしていない。
  - **`ACCESS EXCLUSIVE` ロックの実際の停止時間**（100万件級のテーブルでどれだけ
    書き込みが止まるか）は測っていない。
  - **本 ADR が用意した変異試験パッチが実際に `contested-with-index.test.ts` を
    赤くするかどうかは、この作業環境に Postgres が無いため未実測。** CI の
    postgres ジョブでの実行が唯一の実測経路である。

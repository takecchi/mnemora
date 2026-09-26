# ADR 0343: `PostgresVectorStore.search()`/`searchMany()` が、HNSW 索引に入らないゼロベクトルの候補を部分索引 + `UNION ALL` で拾う（Issue #956）

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-27

> **⚠ 本文はクローン miku の委譲先が書いた。オーナー本人の執筆ではない。**
> この担い手・マネージャーの署名は repo 上では `takecchi` になり、オーナー本人と
> 区別が付かない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
> 「approach (a) を採る」という方向自体はクローン miku が決めた
> （[ADR 0156](./0156-delegate-5-grade-judgment-and-breaking-changes.md) の委譲範囲）。

**⚠ 各主張の出所を分ける**（ADR 0284 / ADR 0342 の体裁を踏む）。

- **【現物】** — この repo のコード・文書を、この ADR の書き手が自分の手で読んで確かめた。
- **【実測】** — この書き手が実際に `psql`/`vitest`/`tsc`/`pnpm`/`git` を走らせて確かめた。
- **【受】** — 報告・外部ドキュメントとして受け取り、自分では再導出していない（出所を明記する）。

断りの無い【現物】【実測】は、本作業の分岐点 `origin/main` = `0706eb3` の木で、
2026-09-27 に行った。

---

## 文脈

[Issue #956](https://github.com/takecchi/mnemora/issues/956) は、CI の postgres ジョブで
[ADR 0040](./0040-zero-vector-never-returned.md) の適合テスト（`vector-store-conformance.ts`
「⚠ ゼロベクトルの候補は…」）が1回だけ赤になったと報告した。原因の調査（別ブランチでの
先行調査。本 ADR はその材料を引き継ぎ、本番コードを実際に直す）で、次が実測された。
詳細・再現手順は [ADR 0040](./0040-zero-vector-never-returned.md) の末尾の追記を参照。

## 原因（実測・一次情報）

pgvector の cosine 距離用 HNSW 索引は、**norm が0のベクトル（ゼロベクトル）をそもそも
索引へ追加しない**。

- **【受、pgvector README】**「Troubleshooting」節・「Why are there less results for a
  query after adding an HNSW index?」の直下: *"Also, note that `NULL` vectors are not
  indexed (as well as zero vectors for cosine distance)."*
  （<https://github.com/pgvector/pgvector/blob/master/README.md#hnsw>、2026-09-27 時点の
  `master` を `curl` で取得して確認）。
- **【現物、pgvector 0.8.0 のソース】** `src/hnswutils.c` の `HnswFormIndexValue`
  （404〜426行付近）が `HnswCheckNorm`（173行、「norm が0より大きいか」を返す）で
  非zeroを確認してから正規化する——`HnswCheckNorm` が `false` を返すと
  `HnswFormIndexValue` は `false` を返し、その行は索引に**追加されない**
  （`hnswbuild.c`/`hnswinsert.c` の呼び出し元が `false` を「索引化しない」として扱う）。

⟹ `search()`/`searchMany()` の `ORDER BY embedding <=> query LIMIT n` が HNSW 索引の
Index Scan（ADR 0284 の `ORDER BY` 押し下げ）を経由すると、ゼロベクトルの行は
**索引に無いので、構造的に結果へ出てこない**——[ADR 0040](./0040-zero-vector-never-returned.md)
決定1（「比較不能でも候補として返す」）に違反する。この違反は「統計が古い間だけの
一時的な窓」ではなく、**HNSW Index Scan が選ばれれば行数・統計の新旧に関係なく常に
起きる**（[ADR 0040](./0040-zero-vector-never-returned.md) 追記の実測: `enable_seqscan`/
`enable_bitmapscan` を切って強制した3行のテーブルでも、`ANALYZE` 済みの5,001行の
テーブルで自然に HNSW が選ばれた場合でも、`hnsw.iterative_scan` の3モード
（`off`/`relaxed_order`/`strict_order`）いずれでも、ゼロベクトルの候補は一度も
返らなかった）。

**pgvector の版**: 手元の実測は 0.8.0（Debian パッケージ）。CI が使う
`pgvector/pgvector:pg17` イメージは 0.8.6 を指す（Docker Hub のタグを見た。2026-09-27
時点）——**この ADR の書き手はコンパイラ（`gcc`/`make`）が使える環境を用意できず、
0.8.6 を手元でビルドして確かめることはできなかった**（`apt-get install gcc make
postgresql-server-dev-17` が候補パッケージ無しで失敗し、root 権限も無い、確認済み）。
上に引用した README の記述・`HnswCheckNorm`/`HnswFormIndexValue` の仕組みはこの ADR が
確認した限り 0.8.0 の実装であり、0.8.6 でも同じ関数・同じ仕組みが使われているかは
**確かめていない**（pgvector の changelog に、この節を廃止・変更したという記載は
見当たらないが、実測はしていない）。

## 決定

### 1. `search()`/`searchMany()` に、`vector_norm(embedding) = 0` の候補を拾う2枝目を足す

`packages/postgres/src/vector-store.ts` の `search()` を、次の形の1本の SQL 文
（`UNION ALL`）に変える:

```sql
SELECT combined.memory_id, combined.distance
FROM (
  (  -- 非ゼロ枝: 今日と同じ ORDER BY 押し下げ（HNSW Index Scan）
    SELECT e.memory_id, e.embedding <=> :query AS distance, m.recorded_at
    FROM <table> e JOIN memories m ON ...
    WHERE <buildFilterConditions> AND vector_norm(e.embedding) > 0
    ORDER BY e.embedding <=> :query, m.recorded_at DESC, e.memory_id
    LIMIT :limit
  )
  UNION ALL
  (  -- ゼロ枝: 部分索引を使い、行数に関係なく filter に一致する全件を拾う
    SELECT e.memory_id, e.embedding <=> :query AS distance, m.recorded_at
    FROM <table> e JOIN memories m ON ...
    WHERE <buildFilterConditions> AND vector_norm(e.embedding) = 0
  )
) AS combined
ORDER BY combined.distance, combined.recorded_at DESC, combined.memory_id
LIMIT :limit
```

- **`WHERE` は両枝とも `buildFilterConditions`（既存の共有ヘルパー）をそのまま使う**
  ——tenant/status/subject・includeSubjectless/attributes/labels/period/validAt/
  decayFloor/excludeProvenanceKinds のどれも、`search()`単独と食い違う経路を作らない。
- **非ゼロ枝の `WHERE` に `vector_norm(e.embedding) > 0` を足した。** これが無いと、
  Seq Scan が選ばれた場合（小さいテーブル等）にゼロベクトルの行が非ゼロ枝にも現れ、
  ゼロ枝と重複して返ってしまう——2枝を必ず排他にするための条件。
- **順序**: 外側の `ORDER BY` が [ADR 0170](./0170-association-search-tiebreak-nondeterminism.md)/
  Issue #339 と同じ3段 tie-break（距離→`recorded_at` DESC→`memory_id`）で
  両枝をまとめて並べ直す。ゼロベクトルの距離（`<=>` の結果）は常に `NaN` であり、
  PostgreSQL の `float8` の順序規則で常に最大値扱い——非ゼロ枝の内側 `LIMIT` を
  超えて非ゼロ候補を取り直す必要はない（ゼロ候補が非ゼロ候補を押しのけて上位に
  出ることは無い）。
- **往復は増やしていない。** `UNION ALL`・外側の再ソートは1本の SQL 文の中に収めた
  ——`search()`/`searchMany()` とも、発行する SQL 文の本数は変えていない。

### 2. `searchMany()` にも同じ2枝を、`LATERAL` の中に入れる

`packages/postgres/src/vector-store.ts` の `searchMany()`（Issue #377）の
`CROSS JOIN LATERAL (...)` の中身を、決定1と同じ2枝の `UNION ALL` + 外側の再ソートに
変えた。`LATERAL` はクエリごとに繰り返されるが、`UNION ALL`/再ソートはその
`LATERAL` サブクエリ1個の中に収めてある——**`queries.length`（アンカー数）が増えても、
発行する SQL 文は今日と同じ1本のまま**（`recall-roundtrip-count.postgres.test.ts`
「歯5: 連想枠 on — anchorCount=1/3/10 で往復数が等しい」で確認済み。下記「実測」節）。

### 3. 部分索引 `WHERE vector_norm(embedding) = 0` を足す

`packages/postgres/src/embedding-space-table.ts` に
`embeddingSpaceZeroNormIndexName`（接頭辞 `idx_memory_embeddings_zero_norm_`）を、
`packages/postgres/src/vector-space.ts` の `registerEmbeddingSpace()` に

```sql
CREATE INDEX IF NOT EXISTS <name>
  ON <table> (tenant_id, memory_id)
  WHERE vector_norm(embedding) = 0;
```

を足した。**ゼロ枝がこの部分索引を使うことで、テーブル全体の行数に関係なく
（通常0件の）ゼロベクトル行だけを読む**——「余分な参照はテーブルの大きさに
比例して増えない」という要求を満たす（下記「実測」節、EXPLAIN で確認）。

### 4. 新規の空間は `registerEmbeddingSpace`、既存の空間は migration（0022）——両方作る

**`memory_embeddings_<space>` テーブルと HNSW 索引自体、`migrations/*.sql` には
一度も現れたことが無い**（【実測】`git grep -n memory_embeddings_ packages/postgres/migrations/`
は0件）——`<space>` はテーブル名に埋め込まれる動的な値で、migration 作成時点では
個々の空間名を列挙できないため、この2つは最初から `registerEmbeddingSpace`
（プロセス起動のたびに呼ばれる、べき等な `CREATE ... IF NOT EXISTS`）だけが作ってきた
（`examples/chat/src/runtime-factory.ts` 等、本番の呼び出し元はすべてプロセス起動時に
1回呼ぶ形——【実測】`git grep -n "registerEmbeddingSpace(" --include=*.ts` で確認）。

**この部分索引は`registerEmbeddingSpace`だけに乗せると、「migration を適用した後、
実際にアプリを再起動する（＝`registerEmbeddingSpace`が呼び直される）まで」の間、
既存の空間にこの索引が無いままになる**——マネージャーの指摘（miku の指示は
「migration で足す」）を受け、この窓を無くすために
`packages/postgres/migrations/0022_embedding_zero_norm_index.sql` を足した。この
migration は `DO` ブロックで、適用時点の `current_schema()` に存在する埋め込み
テーブル（`memory_embeddings_%` という名前で `embedding` 列が `vector` 型のテーブル、
`information_schema.columns` で判定）を列挙し、それぞれに同じ部分索引を
`CREATE INDEX IF NOT EXISTS` で作る。

**索引名は`embeddingSpaceZeroNormIndexName`（TypeScript）と1バイトも違わないように、
同じ計算（63バイト以内ならそのまま、超えるなら63−33−8−1=21バイトへ切り詰めて
SHA-256先頭8桁を付与）を `DO` ブロックの中で SQL として再現している**——PostgreSQL
は14以降 `sha256(bytea)` を組み込みで持つ（pgcrypto 不要、【実測】
`encode(sha256('...'::bytea), 'hex')` が Node の
`crypto.createHash("sha256").update(...).digest("hex")` と同じ16進文字列を返すことを
確認済み）。名前が1バイトでも違うと `CREATE INDEX IF NOT EXISTS` が「無い」と
誤判定し、同じ役目の索引が2本作られてしまう——`embedding-zero-norm-migration.postgres.test.ts`
歯1a・1b が、短い名前・63バイトを超える名前の両方で、migration が実際に作った
索引名と TypeScript 関数の計算結果が一致することを実測で固定している。

**⟹ 「新しく作る空間」は`registerEmbeddingSpace`が、「migration 適用時点で既に
存在する空間」は0022が作る——同じ名前に収束するので、`registerEmbeddingSpace`側の
`CREATE INDEX IF NOT EXISTS`は引き続き残す**（新しい空間にはまだ0022が実行されて
いないため、こちらが唯一の作成経路のまま）。`embedding-zero-norm-migration.postgres.test.ts`
歯2が、0022が先に索引を作った後で`registerEmbeddingSpace`を呼んでも2本目が
作られないこと（`pg_indexes`で数えて1本のまま）を実測で固定している。

schema-namespace（[ADR 0057](./0057-dedicated-schema-namespace.md)）対応の空間も同じ経路
——`registerEmbeddingSpace` は `schema`/`extensionSchema` オプションに応じて
`qualify()` で DDL の識別子・型・演算子クラスを修飾しており、`vector_norm` 関数名も
同じ `qualify(extensionSchema, "vector_norm")` で修飾している。DML 側（`vector-store.ts`
の `search()`/`searchMany()`）は他の DML と同じく `search_path` に任せ、`vector_norm` を
裸のまま書いている（`schema-namespace.ts` の doc コメントが定める「DML は
`search_path` に任せ、DDL は明示修飾する」という既存の使い分けをそのまま踏襲）。
0022 は `current_schema()` の中だけを対象にする——`--schema` 指定時、`migrate.ts` が
このファイルを適用する前に `SET LOCAL search_path TO <schema>,<extensionSchema>` を
発行するため（`migrate.ts` 既存の仕組み、`quotedSearchPathFor`）、`current_schema()`
はその `<schema>` を指す。`embedding-zero-norm-migration.postgres.test.ts` 歯3が、
`--schema` 相当の状態で作った索引が指定したスキーマに入り、`public` には誤って
作られないことを実測で固定している。

### 5. `CREATE INDEX CONCURRENTLY` は使わない

[Issue #760](https://github.com/takecchi/mnemora/issues/760) が「`CREATE INDEX
CONCURRENTLY` を流せる経路を作るかどうか」をオーナーへの未決の問いとして残している
——本 ADR はその問いを解かない。既存の HNSW 索引と同じ素の `CREATE INDEX`
（`ShareLock` を取る——下の「実測」節）のままにした。

## 実測

### EXPLAIN: 非ゼロ枝は HNSW、ゼロ枝は部分索引（テーブル全体を Seq Scan しない）

`packages/postgres/src/__tests__/vector-search-zero-norm.postgres.test.ts` 歯1
（対象テナントに3,000行 + ゼロベクトル1件、`ANALYZE` 済み、`limit=10`、強制なし）:

```
Limit
  -> Sort
    -> Append
      -> Subquery Scan  -- 非ゼロ枝
        -> Limit
          -> Sort  -- 3,000行に対する上位10件の並べ替え
            -> Index Scan using idx_memory_embeddings_hnsw_test_fixture_model_3 on ...
                  Order By: (embedding <=> ...)
      -> Nested Loop  -- ゼロ枝
        -> Index Scan using idx_memory_embeddings_zero_norm_test_fixture_model_3 on ...
```

`Seq Scan on memory_embeddings_...` は現れない。

### 強制した Index Scan でも、非ゼロ・ゼロの両候補が正しく返る

`enable_seqscan = off` / `enable_bitmapscan = off` を `SET LOCAL` で切り、`search()`/
`searchMany()` が実際に発行する SQL・パラメータをそのまま再生した（同ファイル歯2・3、
2件の非ゼロ候補 + 1件のゼロ候補）——非ゼロ候補2件・ゼロ候補1件（`distance` が `NaN`）
とも結果に含まれた。

### 往復数（`searchMany`）はアンカー数に依存しない

`recall-roundtrip-count.postgres.test.ts` 歯5（`anchorCount` を1/3/10で振る、
Issue #377 の既存の歯）は、この修正後も**往復数が等しいまま**だった（実測、変更なし
で通過）——`UNION ALL`/再ソートを `LATERAL` サブクエリの内側に収めた設計が、
Issue #377 の契約（往復数がアンカー数に依存しない）を壊していないことの確認。

### ロックモードと部分索引の構築時間

素の `CREATE INDEX`（`CONCURRENTLY` 無し）が対象テーブルに取るロックモードを
**実測した**（`BEGIN; CREATE INDEX ...;` で開いたトランザクションを `pg_sleep()` で
保持し、`pg_locks` を別セッションから読む・並行して `SELECT`/`INSERT` を試す、という形）:

- `pg_locks.mode` は **`ShareLock`**（`AccessExclusiveLock` ではない）。
- 別セッションからの `SELECT count(*) FROM <table>` は**即座に完了する**（読み取りは
  止まらない）。
- 別セッションからの `INSERT INTO <table> ...`（実在の1行）は、`statement_timeout=3000`
  で `canceling statement due to statement timeout` になった（**書き込みは止まる**
  ——`ShareLock` は `RowExclusiveLock`——`INSERT`/`UPDATE`/`DELETE` が取るロック——と
  競合するという PostgreSQL の一般的なロック互換表どおり）。

⟹ **この索引の構築中、対象テーブルへの読み取りは止まらず、書き込みだけが止まる。**
**その停止時間**（＝索引構築にかかる時間）を実測した:

| 行数 | テーブルの状態 | 構築時間 |
|---|---|---|
| 100,000 | 本番と同じ埋め込みテーブル（HNSW 索引が既に存在・維持されている） | **約40ms** |
| 1,000,000 | 最小限のテーブル（`vector(3)` 列のみ、HNSW 索引なし） | **約270ms** |

⟹ 行数にほぼ比例して増える（100,000行あたり約27〜40ms）。**部分索引自体が持つ行数
（通常0件）ではなく、`vector_norm(embedding) = 0` を全行に対して評価する
テーブル全体の読み取りコストが支配的**——このオーダーであれば、既存の HNSW 索引の
構築（Issue #360 が記録した100,000行で388ms、`ANALYZE` 込みの別の操作）と同程度か、
それより軽い。

## 採らなかった案

- **`packages/testkit` の適合テストのフィクスチャ側だけを直す**（例: 検索前に明示的に
  `ANALYZE` を挟む）。却下——[ADR 0040](./0040-zero-vector-never-returned.md) の追記が
  実測した通り、この欠陥は統計の新旧に関係なく HNSW が選ばれれば常に起きる。
  フィクスチャだけ直すと、production の `search()`/`searchMany()` は直らないまま残る。
- **2本目の SQL 文（別の round trip）でゼロベクトルの候補を取りに行く。** 却下
  ——マネージャーの指示どおり、1本の `UNION ALL` に収める案を優先した。素朴な
  実装より複雑だが、往復は増えない。
- **`CREATE INDEX CONCURRENTLY` で部分索引を作る。** 却下（この ADR の範囲では）
  ——Issue #760 がこの経路自体の是非をオーナーへの未決の問いとして残しており、
  本 ADR がその判断を先取りしない。既存の HNSW 索引も同じ素の `CREATE INDEX` の
  ままである。
- **`hnsw.iterative_scan`/`ef_search`/`max_scan_tuples` を調整して、ゼロベクトルを
  HNSW 索引経由で拾えるようにする。** 却下——[ADR 0040](./0040-zero-vector-never-returned.md)
  の追記が実測した通り、ゼロベクトルはそもそも索引に**存在しない**ため、
  索引側のどのパラメータを振っても拾えない（`HnswFormIndexValue` が索引への
  追加自体を拒否している）。

## 引き受けた負債

1. **既存の大きな embedding テーブルに対しては、この部分索引の追加が
   `ShareLock` で書き込みを止める**（読み取りは止めない。上の「実測」節の時間だけ）。
   [ADR 0059](./0059-period-in-ann-stage.md)/[ADR 0062](./0062-contested-with-id-fk-index.md)
   が `memories` の索引について「読み書きを止める」と記録している負債と近い形（ロック
   モードそのものの食い違いは下の追記を見ること）であり、
   [Issue #760](https://github.com/takecchi/mnemora/issues/760) の未決の問い
   （`CONCURRENTLY` 経路を作るか）がそのまま当たる。**migration（0022）は
   `migrate.ts` の1ファイル=1トランザクションという既存の設計のまま**——複数の
   埋め込み空間が既に存在する場合、その全部の `ShareLock` が、0022 全体がコミット
   するまで保持される（1空間ずつ個別にコミットするわけではない）。
2. **0022 が対象にするのは「migration 適用の時点で存在する」空間だけである。**
   0022 適用より後に（旧いバージョンの `registerEmbeddingSpace`——この部分索引を
   まだ知らないコード——で）作られた空間は対象にならない。ただし、そのようなコードは
   このリポジトリの `main` には存在しない（この修正を含むバージョンに上げれば、
   `registerEmbeddingSpace` 自体が新規作成時にこの部分索引を作る）——⟹ **実際に
   起こり得るのは「0022 を含む migration を適用したが、アプリはまだ古いバージョンの
   まま動いている」という、通常のローリングデプロイの過渡的な窓だけであり、
   その窓では新しい部分索引を知らない旧いコードの `search()`/`searchMany()` も
   まだ動いているため、この窓の間に新しく実害が増えるわけではない**（旧いコードは
   そもそもこの部分索引を使わない）。
3. **pgvector 0.8.6（CI が使う版）で同じ実装（`HnswCheckNorm`/`HnswFormIndexValue`）が
   使われているかは確かめていない。** コンパイラの無い環境から動けなかった
   ——次に pgvector を更新する・CI の実際の版を確かめられる担い手が確認すること
   （この ADR 自身は確認していない、という記録に留める）。

## これが覆るとしたら

- **pgvector が cosine HNSW 索引の実装を変え、ゼロベクトルを索引に含めるようになったとき**
  （`HnswCheckNorm`/`HnswFormIndexValue` の変更、あるいは pgvector README の
  「Troubleshooting」節の記述が変わったとき）。その場合、決定1〜3のゼロ枝・部分索引は
  不要になる（ただし複雑さを増やすだけで正しさは壊れない——`vector_norm(embedding) = 0`
  に一致する行が0件なら、ゼロ枝は常に空集合を返すだけである）。
- **[Issue #760](https://github.com/takecchi/mnemora/issues/760) の問いにオーナーが
  答え、`CREATE INDEX CONCURRENTLY` の経路が実際に作られたとき。** そのとき、
  この部分索引の追加も同じ経路に乗せ直すことを検討する。

## `packages/testkit` の InMemoryVectorStore と、ゼロベクトル候補の並び順が食い違う（確認済み、直していない）

`limit` に対して非ゼロ候補が十分少ないとき、ゼロベクトルの候補が結果のどこに来るかを
Postgres と `InMemoryVectorStore`（`packages/testkit/src/__fixtures__/in-memory-vector-store.ts`）
で比較した。

**Postgres**: 距離が `NaN` の行は、PostgreSQL の `float8` の順序規則（`NaN` は他のどんな
値よりも大きい、`ORDER BY ... ASC` で常に最後）により、**常に最後尾**に来る
（`vector-search-zero-norm.postgres.test.ts` 歯4 で実測済み）。

**InMemoryVectorStore**: `search()` の並べ替えは

```ts
hits.sort((a, b) => {
  if (a.distance !== b.distance) return a.distance - b.distance;
  ...
});
```

という形（`in-memory-vector-store.ts`）。`a.distance`/`b.distance` の一方が `NaN` だと
`a.distance !== b.distance` は常に真になり、`a.distance - b.distance` も `NaN` を返す
——`Array.prototype.sort` の比較関数が `NaN` を返したときの挙動は、V8 の実装により
定まるが「常に最後尾に送る」ことを保証しない。**【実測】** 同じ4件の非ゼロ候補
（distance 0/0.293/0.757/1）+ ゼロ候補1件を、挿入順を変えて6通り試したところ、
ゼロ候補の位置は最後尾（5件中4番目、0-indexで4）に来た回もあれば、先頭（0番目）・
2番目・3番目に来た回もあった——**`NaN` の位置は挿入順に依存し、一定しない。**

⟹ **Postgres と InMemoryVectorStore は、ゼロベクトル候補が `limit` の境界付近に
いるとき、`search()` が返す集合・順序が食い違いうる**（`limit` が非ゼロ候補の総数
より小さいとき、Postgres は常に非ゼロ候補を優先して残すが、InMemory は `NaN` の
位置次第で非ゼロ候補がゼロ候補に押し出されて `limit` から漏れることがある）。

**この ADR の書き手はこれを直していない**——マネージャーの指示どおり、この食い違いを
見つけたところで止めて報告する。`packages/testkit` 側の修正（`compareDescendingNaNLast`
のような、`NaN` を必ず最後尾へ送る比較関数への置き換え——[Issue #938](https://github.com/takecchi/mnemora/issues/938)
が `packages/core/src/recall-runtime.ts` の3箇所に対して既に採った形と同じ）が要るかは、
オーナー・マネージャーの判断に委ねる。この ADR の決定1〜4（Postgres 側の修正）は、
この食い違いの有無に関係なく成立する——Postgres 側の契約（ADR 0040）を満たすための
ものであり、InMemory 側の挙動を変える・前提にするものではない。

### 確かめていないこと（この節固有）

- `packages/core/src/__tests__/runtime-fakes.ts` の `FakeVectorStore`（`in-memory-vector-store.ts`
  とは別の実装、ADR 0040 本文「引き受ける負債」が触れている）が同じ食い違いを持つかは
  確認していない。
- 実際の `recall()` パイプライン（段2の `compareScoredCandidates`、Issue #938 で
  `NaN` 最後尾に直した箇所）が、この InMemory の並び順の乱れを別の層で吸収しているか
  どうかは確認していない——`VectorStore.search()` の生の返り値の順序だけを見た。

## 確かめていないこと

- pgvector 0.8.6（CI の実際の版）での動作再確認（上記「引き受けた負債」3番）。
- `halfvec`/`sparsevec`、内積・L2距離での同じ構造的欠落の有無——`vector`型・
  cosine距離（`vector_cosine_ops`）だけを対象にした。
- 100万行を大きく超える規模（1,000万行等）での部分索引の構築時間。
- 同時実行下（複数プロセスが同時に `search()`/`searchMany()` を呼ぶ）でのレイテンシ
  増分——`UNION ALL` の2枝目を足したことによる追加コストは、単一プロセス・
  連続呼び出しでは計測していない。
- schema-namespace（ADR 0057）を実際に指定した状態での、本 ADR の DDL
  （`registerEmbeddingSpace` の新しい `CREATE INDEX`）の動作——`qualify()` の
  既存の使い方をそのまま踏襲したという設計上の確認に留め、実機での確認は
  していない。

---

## 追記（2026-09-27）—— ロックモードの実測は `ShareLock` であり、`ACCESS EXCLUSIVE` ではなかった

⛔ 上の本文は1バイトも書き換えていない。同じ形で追記する。

[ADR 0059](./0059-period-in-ann-stage.md)/[ADR 0062](./0062-contested-with-id-fk-index.md)
は、`memories` テーブルへの素の `CREATE INDEX` が `ACCESS EXCLUSIVE` ロックを取ると
記録している。本 ADR の本文も、その記録を踏まえて同じ主張（「素の `CREATE INDEX` は
`ACCESS EXCLUSIVE` ロックを取る」）をしていた——**これは実測に基づくものではなく、
ADR 0059/0062 からの引用だった。**

本 ADR の対象（埋め込みテーブルへの部分索引 `WHERE vector_norm(embedding) = 0` の
`CREATE INDEX`）について、この追記の書き手が改めて実測した:

- `BEGIN; CREATE INDEX ...;`（`COMMIT` 前）で開いたトランザクションが対象テーブルに
  持つロックを、別セッションから `pg_locks.mode` で読むと **`ShareLock`** だった
  （`AccessExclusiveLock` ではない）。
- 同じ状態で、別セッションからの `SELECT count(*) FROM <table>` は**即座に完了した**
  （読み取りは止まらない）。
- 同じ状態で、別セッションからの `INSERT INTO <table> ...`（実在の1行）は
  `statement_timeout=3000` で `canceling statement due to statement timeout` に
  なった（**書き込みは止まる**）。

⟹ **この ADR が対象にしている `CREATE INDEX`（部分索引、埋め込みテーブル）は、
読み取りを止めず、書き込みだけを止める。** 本文・「実測」節・「引き受けた負債」1番の
`ACCESS EXCLUSIVE` という記述は、この実測とは食い違う——本文は書き換えず、この追記で
訂正する。ADR 0059/0062（`memories` テーブルの別の索引についての記録）も書き換えて
いない——それらが対象にした索引で実際に何が起きたかは、この追記では再確認していない
（`memories` の該当索引に対して同じ手順で実測し直せば、同じ食い違いが見つかる可能性は
あるが、確かめていない）。

### この追記が確かめていないこと

- ADR 0059/0062 が実際に対象にした `memories` の索引（`idx_memories_period_ann_stage`
  等）について、同じ手順（`pg_locks`・並行 `SELECT`/`INSERT`）で測り直してはいない。
- PostgreSQL のバージョンやテーブルの列構成によってロックモードが変わる余地がある
  かどうかは確認していない——この実測は本 ADR と同じ PostgreSQL 17.11 環境1点のみ。

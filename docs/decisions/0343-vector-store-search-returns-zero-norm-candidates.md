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

### 4. 既存の空間・新規の空間は同じ経路（`registerEmbeddingSpace`）——専用の migration は書かない

**`memory_embeddings_<space>` テーブルと HNSW 索引自体、`migrations/*.sql` には
一度も現れたことが無い**（【実測】`git grep -n memory_embeddings_ packages/postgres/migrations/`
は0件）——`<space>` はテーブル名に埋め込まれる動的な値で、migration 作成時点では
個々の空間名を列挙できないため、この2つは最初から `registerEmbeddingSpace`
（プロセス起動のたびに呼ばれる、べき等な `CREATE ... IF NOT EXISTS`）だけが作ってきた
（`examples/chat/src/runtime-factory.ts` 等、本番の呼び出し元はすべてプロセス起動時に
1回呼ぶ形——【実測】`git grep -n "registerEmbeddingSpace(" --include=*.ts` で確認）。
**⟹ 新しい部分索引もこれと同じ経路に乗せた。** 「新しく作る空間」と「この修正より
前から存在する空間」は同じコードパスを通る——違うのは `IF NOT EXISTS` が実行される
タイミング（初回作成時か、この修正を含むバージョンへ上げた後の次回起動時か）だけ。
**⟹ 専用の `packages/postgres/migrations/*.sql` は書いていない**（そもそも
HNSW 索引自体がそのファイル群に無いため、同じ形を保つのが一貫している）。

schema-namespace（[ADR 0057](./0057-dedicated-schema-namespace.md)）対応の空間も同じ経路
——`registerEmbeddingSpace` は `schema`/`extensionSchema` オプションに応じて
`qualify()` で DDL の識別子・型・演算子クラスを修飾しており、`vector_norm` 関数名も
同じ `qualify(extensionSchema, "vector_norm")` で修飾している。DML 側（`vector-store.ts`
の `search()`/`searchMany()`）は他の DML と同じく `search_path` に任せ、`vector_norm` を
裸のまま書いている（`schema-namespace.ts` の doc コメントが定める「DML は
`search_path` に任せ、DDL は明示修飾する」という既存の使い分けをそのまま踏襲）。

### 5. `CREATE INDEX CONCURRENTLY` は使わない

[Issue #760](https://github.com/takecchi/mnemora/issues/760) が「`CREATE INDEX
CONCURRENTLY` を流せる経路を作るかどうか」をオーナーへの未決の問いとして残している
——本 ADR はその問いを解かない。既存の HNSW 索引と同じ素の `CREATE INDEX`
（`ACCESS EXCLUSIVE` ロックを取る）のままにした。

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

### 部分索引の構築時間（`ACCESS EXCLUSIVE` ロックが対象テーブルへの読み書きを止める間）

素の `CREATE INDEX`（`CONCURRENTLY` 無し）は、構築が終わるまで対象テーブルに
`ACCESS EXCLUSIVE` ロックを取り、読み書きを止める——[ADR 0059](./0059-period-in-ann-stage.md)/
[ADR 0062](./0062-contested-with-id-fk-index.md) が `memories` の索引で既に記録した
PostgreSQL の一般的な性質であり、本 ADR で新しく確かめ直してはいない。**その停止時間**
（＝索引構築にかかる時間）を実測した:

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
   `ACCESS EXCLUSIVE` ロックで読み書きを止める**（上の「実測」節の時間だけ）。
   [ADR 0059](./0059-period-in-ann-stage.md)/[ADR 0062](./0062-contested-with-id-fk-index.md)
   が `memories` の索引について既に引き受けている負債と同じ形であり、
   [Issue #760](https://github.com/takecchi/mnemora/issues/760) の未決の問い
   （`CONCURRENTLY` 経路を作るか）がそのまま当たる。
2. **既存の空間にこの部分索引が実際に作られるのは、次回 `registerEmbeddingSpace`
   が呼ばれたとき（通常はプロセスの再起動時）である。** アプリケーションが長期間
   再起動されない場合、その間は決定1〜2の修正があっても、対象の空間では
   ゼロベクトルの候補が（部分索引が無いため）ゼロ枝から見つからないままになる
   ——ゼロ枝自体は「索引が無ければ Seq Scan で拾う」というフォールバックを
   実装していない（`buildFilterConditions` の WHERE に `vector_norm(embedding) = 0`
   を書いているだけなので、索引が無ければ単に Seq Scan になり、動作はするが遅い
   ——「拾えない」わけではない。「速く拾えない」だけである）。
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

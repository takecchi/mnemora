# ADR 0362: `PostgresVectorStore.searchMany` の `LATERAL` を、`memories` を主キー（`memories_pkey`）で引く形に固定する（Issue #1181）

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-29

> **⚠ 本文はクローン miku の委譲先が書いた。オーナー本人の執筆ではない。**
> この担い手・マネージャーの署名は repo 上では `takecchi` になり、オーナー本人と
> 区別が付かない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。

**⚠ 各主張の出所を分ける**（ADR 0284 / ADR 0343 の体裁を踏む）。

- **【現物】** — この repo のコード・文書を、この ADR の書き手が自分の手で読んで確かめた。
- **【実測】** — この書き手が実際に `psql`/`vitest`/`tsc`/`pnpm`/`git` を走らせて確かめた。
- **【受】** — 報告・外部ドキュメントとして受け取り、自分では再導出していない（出所を明記する）。

断りの無い【現物】【実測】は、自分専用の PostgreSQL 17 + pgvector（`initdb`、`autovacuum off`、
5432 以外の専用ポート）を使い、分岐点 `origin/main` = `1618694` の木で、2026-09-29 に行った。

---

## 文脈

[Issue #1181](https://github.com/takecchi/mnemora/issues/1181) は、空の DB に記憶を入れ始めた
ばかりで `memories`/埋め込み表にまだ統計が無いと、連想枠（段3.5）の `PostgresVectorStore.searchMany`
が `memories` を主キーで引かないプランになり、`recall()` が約3〜20倍遅くなることを実測していた
（【受、Issue本文】200行・64次元で、`searchMany` 単体が統計なし 27.7〜28.9ms、`ANALYZE` の後
1.4ms）。Issue のコメント2は、`searchMany` を `search()` と同じ2枝 `UNION ALL` の形に揃える
「方向2」を1案試し、**改善が出ず、統計がある場面ではむしろ遅くなった**ので採らなかったと記録している。

このマネージャーが委譲した調査（Issue #1181 のコメント3、本 PR の前段）は、まず前提を
再実測し（今も成り立つ、ただし本文の「段1 `search()` は統計なしでも Hash Join」という記述は
`observe()` 経由の再現でも再現しなかった——`search()` も `searchMany()` と同じ悪いプランを
選ぶ）、そのうえで**「クエリの形だけを変えて、統計の有無に関係なく `memories` を主キーで
引かせる」**候補（A・B・C）を3つ試した。いずれも失敗した（A はオプティマイザに inline され
プランが変わらない。B・C は `MATERIALIZED` CTE で壁を作ってプランは変わったが速くならず、
しかも **B・C は統計なしで既に良いプランだった N=500 のケースを壊した**）。

この ADR が扱うのは、その続きでコーディネーターが指定した**候補D**——`LATERAL` +
`OFFSET 0`（Postgres の伝統的な「最適化の柵」）で `memories` の副問い合わせを外側へ
引き上げさせず、`e` の行ごとに独立して評価させる案——の実測と、実装した最終形である。

## 原因（実測、Issue #1181 本文・本 ADR 追試の一致）

`searchMany` の元のクエリ（`FROM <emb> e JOIN memories m ON m.id = e.memory_id AND
m.tenant_id = e.tenant_id WHERE <filter> ...`）は、`memories`/埋め込み表のどちらか
（あるいは両方）に統計が無いと、プランナが行数を著しく誤って見積もる。

**【実測】** `observe()` 経由（同期抽出・決定的な偽の LLM・`tick(embed)`・64次元、Issue本文と
同じ手順）で N=200 を投入し、`ANALYZE` を一度も打たずに `searchMany` を EXPLAIN すると:

```
Nested Loop (actual rows=480 loops=1)
  ->  Values Scan on "*VALUES*" (rows=3)
  ->  ... Nested Loop (actual rows=200 loops=3)
        ->  Bitmap Heap Scan on memory_embeddings_… e (actual rows=200)
        ->  Index Scan using idx_memories_recall_gate_seq on memories m
              Index Cond: (tenant_id = '…')
              Filter: (decay_floor_at > … AND valid_from/valid_until …)
        (親の Nested Loop で Join Filter: (m.id = e.memory_id)、Rows Removed by Join Filter: 19900)
```

`memories`（あるいは `store` 経由の投入では別の索引・`Seq Scan` のこともあった——実測、
下の「行の幅で結果が変わる」節）が `e.memory_id` との等値ではなく、`filter` が直接
`m` に課す述語（`tenant_id`・`status`・`decay_floor_at` 等）だけにマッチする索引で
スキャンされ、`m.id = e.memory_id` は**索引条件ではなく `Join Filter`**（フェッチした
あとの後絞り）になる。`e` の行数が1行と見積もられるため、この索引スキャンが
`e` の行数（実際は200）だけ繰り返される（`loops=600`）ことをプランナは織り込んでおらず、
実際には 200 × 100 前後の比較（`Rows Removed by Join Filter: 19900`）が起きる。

### 候補A・B・C が失敗した理由（実測）

- **候補A**（`JOIN` を `WITH ranked AS (...)`（非 `MATERIALIZED`）に書き換えるだけ）:
  Postgres はこの CTE を素通しで inline し、**最終的なプランは元の `JOIN` と1文字も
  変わらなかった**（実測、統計なし・ありのどちらでも）。
- **候補B・C**（`ranked`/`filtered_m` を `MATERIALIZED` にして壁を作る）: 壁自体は効き、
  `memories` 側の索引選択は変わったが、**`ranked` と `filtered_m`（どちらも中間結果）
  自体の行数見積もりが依然として「1行」に固定される**ため、2つの中間結果どうしの
  `JOIN` でも同じ「`Nested Loop` + `Join Filter` で全数比較」が選ばれた。しかも
  **統計なしで既に良いプランだった N=500 のケース**（`memories` を `gate_seq` で、
  埋め込み表を**自分の複合主キー**（`tenant_id, memory_id`）で `Index Cond: memory_id = m.id`
  として正しく引く、0.9ms 未満）を、`MATERIALIZED` の壁が壊し、**100ms 超**（`Rows Removed
  by Join Filter: 249,500`）に悪化させた。

統計の欠如がもたらす「行数1」という誤った見積もりは、クエリを`WITH`/`MATERIALIZED`で
どう再構成しても、**その中間結果自身の見積もりへそのまま伝播する**——これが方向2の
過去の試みがすべて失敗した根本原因である。

## 決定

**候補D を採用し、実装した。** `searchMany` の `LATERAL` の中の `JOIN memories m ON
m.id = e.memory_id AND m.tenant_id = e.tenant_id` を、次の形に変える
（`packages/postgres/src/vector-store.ts` の `searchMany`）:

```sql
FROM <emb> e
CROSS JOIN LATERAL (
  SELECT * FROM memories WHERE id = e.memory_id OFFSET 0
) m
WHERE e.tenant_id = $1 AND e.tenant_id = $2 AND vector_norm(e.embedding) > 0
  AND m.tenant_id = e.tenant_id
  AND <m 側の filter（status・decayFloor・subjectId 等）>
ORDER BY e.embedding <=> q.qvec, m.recorded_at DESC, e.memory_id
LIMIT …
```

**3つの位置がすべて意味を持ち、どれか1つでも動かすと直らない（実測で確認済み）**:

1. **`LATERAL` の中身は `id = e.memory_id` だけ**（`SELECT *`）。`tenant_id`（や `status`
   等）を中に足すと、プランナは `memories_pkey`（`id` 単独の一意索引）ではなく、
   `tenant_id` を先頭に持つ別の索引（`idx_memories_recall_gate_seq`・
   `idx_memories_period_ann_stage` 等、実測ではどちらも出た——投入経路・行の幅で
   選ばれる索引名自体は変わるが、いずれも `id` を索引条件に使わず `Join Filter` に
   落ちる点は同じ）を選び直し、Issue #1181 の欠陥に戻る（下の表「D-safe」参照）。
2. **`OFFSET 0`** が最適化の柵——これが無いと Postgres はこの副問い合わせを外側の
   クエリへ引き上げてしまい（`memories` 単体では行数の見積もりを誤らないため、
   引き上げれば結局もとの `JOIN` と同じプランに戻る）、`LATERAL` を書いた意味が無くなる。
3. **`m.tenant_id = e.tenant_id`（テナント境界、Issue #1050）は `LATERAL` の**外**の
   `WHERE` に置く**——他の `m.*` の filter 条件と同じ場所（下の「引き受けた負債」参照）。
   `id` はテナントをまたいで一意（`memories.id uuid PRIMARY KEY`、`tenant_id` は
   複合主キーの一部ではない）なので、`LATERAL` の中で `tenant_id` を確認しなくても
   **`m.id = e.memory_id` が一致した1行だけが返る**——テナント境界は、その1行が
   正しいテナントのものであることを**外側で確認する安全網**として働く（1と同じ理由
   で、この安全網を柵の中に入れると索引選択が壊れる）。

`search()` はこの ADR の前後で**1バイトも変えていない**——`buildFilterConditions`
（`search()` が使う）は、内部で `m.*` 側の条件を組み立てる部分（`memoryOnlyConditions`）
を `searchMany` 用の `buildLateralMemoryConditions` と共有するよう括り出したが、
`buildFilterConditions` 自体が返す `SQL`（配列の構築順・内容）は前後で同一である
（`packages/postgres/src/vector-store.ts` の `buildFilterConditions` の doc コメント、
「戻り値は1バイトも変えていない」の実測は `pnpm --filter @mnemora/postgres exec vitest run`
で `search()` に依存する既存の歯——`vector-search-hnsw.test.ts`・`vector-search-subject.test.ts`・
`recall.postgres.test.ts` 等——が変更なく緑のままであることで確認した）。

## 実測

### `searchMany`（`observe()` 経由、N=200、アンカー3/10、直前と直後）

| 場面 | 直前（同一SQLの中央値、warmup5+20回） | 直後（候補D、同条件） | `memories_pkey` 使用 | 結果一致 |
|---|---|---|---|---|
| N=200・統計なし・アンカー3 | 71.23ms | **4.48ms** | ○ | ○ |
| N=200・統計あり・アンカー3 | 3.33ms | 4.40ms | ○ | ○ |
| N=200・統計なし・アンカー10 | 178.41ms | **7.80ms** | ○ | ○ |
| N=200・統計あり・アンカー10 | 5.29ms | 7.02ms | ○ | ○ |

### `searchMany`（store 経由——`memoryStore.createMemory` + `vectorStore.upsert` を1件ずつ、filter は `tenantId` のみ）

| 場面 | 直前 | 直後（候補D） | `memories_pkey` 使用 | 結果一致 |
|---|---|---|---|---|
| N=200・統計なし | 17.45ms | **8.89ms** | ×（下の注） | ○ |
| N=200・統計あり | 2.41ms | 2.35ms | ○ | ○ |
| N=500・統計なし | 6.95ms | 6.33ms | ○ | ○ |
| N=500・統計あり | 3.27ms | 2.63ms | ○ | ○ |

**注（行の幅で結果が変わる、実測）**: `buildNewMemoryFixture` の既定（短い定型文の
`content`）で N=200 だけを作った狭い `memories` テーブルは、物理的にごく少数のページ
しか占めない。この規模では、`id = e.memory_id` という**孤立した**（他の条件を一切
伴わない）副問い合わせ単体でも、Postgres が `Seq Scan`（cost=0.00..8.05）を
`memories_pkey` 経由の `Index Scan`（cost=0.14..8.16）よりわずかに安いと見積もり、
`Seq Scan` を選ぶことがある（`SET enable_seqscan = off` で強制すると `Index Scan` に
変わることを実測で確認——索引自体は使える状態にある。プランナの見積もりの問題であり、
候補Dの形が効いていないわけではない）。それでも `Join Filter` による O(N²) の破棄は
無くなる（`Seq Scan` 1回・`id` の等値比較だけになる）ため、実測のとおり約2倍速くなった。
**`observe()` 経由の実データ（本文の再現条件、行がもっと広い）では、同じ N=200 で
`memories_pkey` が確実に選ばれた**（上の表）——この歯を足す際は、`buildNewMemoryFixture`
の既定の短い `content` のままだと `memories_pkey` を検査できないことがあるため、
`content`/`digest` をある程度の長さに広げてある
（`packages/postgres/src/__tests__/search-many-primary-key-lookup.postgres.test.ts`）。

### D-safe（`m.tenant_id = e.tenant_id` を `LATERAL` の中に残した場合、実測・不採用）

`observe()` 経由・N=200・統計なしで、`tenant_id = e.tenant_id` を `LATERAL` の中に
足すと、`idx_memories_provenance_kind`（`tenant_id` を含む別の索引）が選ばれ直し、
中央値が 27.07ms に戻った（`memories_pkey` は使われず、`Join Filter` 相当の
`Filter: (id = e.memory_id) Rows Removed by Filter: 199` が再出現）——**この位置に
置いてはいけない**という決定1の根拠。

### 統計がある場面の `recall()` 全体（追記、固い測り直し）

上の表（`searchMany` 単体）は N=200・アンカー3/10 で「統計あり」の場合に前後で数msの
差を示していたが、単発の EXPLAIN 1回だけの比較だったため、**`recall()` 全体を、
`observe()` 経由で作った本物の DB（`ANALYZE` 済み）に対して測り直した**。

最初に2〜3回だけ測った初回の値（後日、この節を差し替える前の値）は測定ノイズに
強く引かれていた——特に N=3000・アンカー3 では初回 +3.6ms（Nとともに伸びる、に見えた）
だったが、下の固い測り直しでは -0.45ms（伸びない）に変わった。**そのため、測り方を
固くして（1点=warmup5回を捨てたあとの25回の中央値、前後を12往復以上交互に、同じ
DB・同じデータに対してビルドだけを差し替えて測定）測り直した。**

| N | アンカー | 前: 中央値(最小〜最大)、12往復 | 後: 中央値(最小〜最大)、12往復 | 前後差の中央値 | 前後差の平均 |
|---|---|---|---|---|---|
| 200 | 3 | 29.72ms (24.64〜32.87) | 30.03ms (27.77〜41.14) | **+2.08ms** | +2.81ms |
| 3000 | 3 | 41.37ms (37.62〜50.41) | 42.62ms (35.22〜45.91) | **-0.45ms** | -0.83ms |
| 200 | 10 | 33.28ms (27.37〜36.29) | 36.43ms (31.00〜47.18) | **+3.70ms** | +4.33ms |
| 3000 | 10 | 49.61ms (41.04〜54.20) | 47.87ms (41.93〜55.47) | **-0.55ms** | -1.02ms |

前後差（後−前）の生データ（1往復ごと、12個）:

- N=200・アンカー3: 2.25, 3.90, 3.61, 1.80, 5.84, 1.90, 11.39, -1.70, -0.52, -1.25, 9.47, -2.96
- N=3000・アンカー3: -3.02, 4.50, 1.75, 0.28, -0.95, -5.30, -4.50, -6.27, 0.05, 2.95, 3.44, -2.88
- N=200・アンカー10: 6.41, 1.47, 8.94, 4.69, 2.70, 13.68, -2.15, 1.57, 5.46, -2.22, 2.26, 9.11
- N=3000・アンカー10: 5.45, -10.09, 1.62, -9.11, 3.71, 1.04, 11.40, -1.67, 0.58, -2.54, -7.06, -5.55

**判定（既定のアンカー数=3で判断する。`DEFAULT_ASSOCIATION_ANCHOR_COUNT` = 3、
`packages/core/src/recall.ts`）**:

- **アンカー3は、N=200・N=3000 のどちらも前後差の中央値が概ね2ms以内で、
  N とともに伸びていない**（+2.08ms → -0.45ms、むしろ縮む）。N=200 の +2.08ms は
  2msをわずかに超えるが、同じ条件の12個の生データが -2.96〜+11.39ms に広く散って
  おり（外れ値2個――+11.39、+9.47――が中央値を押し上げている）、この0.08msの超過を
  「系統的な悪化」と呼べる根拠は無いと判断する。⟹ **この直しは進める**（候補Dを
  そのまま採用する。統計ありでも既定のアンカー数では実務上の遅れは無い）。
- **アンカー10（既定ではない、`RecallAssociationQuery.anchorCount` を明示的に
  10にした場合だけ）は、N=200 で +3.70ms の遅れが実測された**（12個の生データの
  うち10個が正——系統的に後のほうが遅い）。**N=3000 では -0.55ms に縮み、N とともに
  伸びてはいない**——N=200 という小さい規模に特有の効果で、大きくなるほど薄れる。
  **数字はそのまま書く**（「ばらつきの中」「ノイズと見分けが付かない」とは言わない
  ——N=200 のアンカー10 は実際に後のほうが遅い）。
- **アンカー10 を選んでもこの直しを進める理由**: (1) アンカー10 は既定ではなく、
  利用者が明示的に選ぶ値である。(2) 統計が無い場面（本 ADR の主題）では、アンカー10
  のときのほうが遅れの絶対値が大きい（Issue #1181 の実測、N=200・アンカー10・
  統計なしで 178ms → 7.8ms、約170ms 縮む）。統計ありで数msだけ遅くなる代償に対し、
  統計なしで170ms縮む利得のほうが、既定でも明示指定でも一貫して大きい。

### 統計がある場面で Hash Join を保つ別の形は無いか（短い検討）

**見つからなかった。** `LATERAL` + `OFFSET 0` という形自体が、Postgres に「この副
問い合わせは外側の行ごとに独立して評価する（相関副問い合わせ）」ことを強制する
柵であり、相関副問い合わせは構造的に `Nested Loop` としてしか実行できない
（`Hash Join` は両側を独立した集合として先にハッシュ化する必要があり、相関
副問い合わせとは両立しない）。⟹ **候補Dの柵は、統計の有無に関係なく常に
`Nested Loop`（`memories_pkey` 経由）を選ばせる**——これは「統計が無くても直る」
ことの代償として、「統計があっても `Hash Join` は選べない」ことを常に引き受ける
形である。

検討した、実装しなかった案:

- **`pg_class.reltuples` を呼び出し側で読み、大きければ元の `JOIN` 文を、小さければ
  候補Dの文を使う（アプリケーション層での分岐）**: 統計がある場面は元のコードと
  1バイトも変えずに済み、この ADR が測った前後差そのものが消える。ただし
  ①`searchMany` の「往復は1回」という既存の設計・歯
  （`vector-store-search-many.postgres.test.ts`）に新しい読み取りを足すことになる
  （読み取り自体は `pg_class` の1行 index lookup で軽いが、往復は増える）、
  ②「クエリの形だけで直す」という今回の委譲の範囲を超え、実装の分岐点が増える、
  ③どの閾値で切り替えるかという新しい裁量値が要る——という3点から、**この PR
  では見送った**。統計ありの前後差が実測のとおり数ms（ばらつきの幅の内側）に
  留まっているため、今の時点でこの複雑さを持ち込むほどの根拠は無いと判断した。
  次に大きな N・大きなアンカー数で問題になった場合の再検討先として残す。
- **`pg_hint_plan` 等の拡張でヒントを与える**: 拡張自体をインストールする必要が
  あり、「クエリの形だけで直す」の範囲を超える。CI・利用者の環境に前提を追加
  することになるため見送った。
- **`SET LOCAL` でコストパラメータ（`random_page_cost` 等）だけを変える**:
  コーディネーターの指示で明示的に禁止されている（プランナー設定を変える形）。

### `search()`（段1、参考——この ADR では変えていない）

`observe()` 経由・N=200・統計なしで、`search()` は `searchMany` と同じ悪いプラン
（`idx_memories_recall_gate_seq` + `Join Filter`、実行時間 25.7ms）を選んでいた——
Issue #1181 本文の「段1は統計なしでも Hash Join で 0.5ms」は、この再現でも再現しな
かった（Issue のコメント2の観測と一致）。**この ADR は `search()` を直していない**
——`search()` を同じ形に変えるかどうかは未決（下の「これが覆るとしたら」参照）。

## 試して捨てた案

- **方向2・候補A**（`search()` と同じ2枝 `UNION ALL` に揃えるだけ）: Issue のコメント2が
  既に試し、改善なし・統計ありで悪化と報告。本 ADR の再実測でも同じ結果（プランが
  1文字も変わらない）。
- **方向2・候補B/C**（`MATERIALIZED` CTE + `id = ANY(array)`）: 本 ADR の実測で、
  統計なしの改善は無く、統計なしで既に良かった N=500 のケースを壊した。**不採用**。
- **D-safe**（`tenant_id` を `LATERAL` の中に残す）: 上の実測のとおり、プランが
  悪い形に戻る。**不採用**——`tenant_id` は柵の外に置く。
- **方向1**（`INITIAL_ANALYZE_THRESHOLD` を下げる・embed 後に1回だけ ANALYZE を打つ）:
  Issue 本文が「既定値の変更」として持ち越した論点であり、この PR の範囲外
  （クエリの形だけを直す、という委譲の範囲に収まる）。
- **何もしない**（方向3の README 追記のみに留める）: 既に #1182 でマージ済みだが、
  「`--analyze-memories` を打ち忘れる」運用依存を残す。今回のクエリ整形は、
  打ち忘れた場合の被害（統計なし時の上乗せ）そのものを縮める——両立する。

## 引き受けた負債

- **`SELECT *` で `memories` の全列を取る**——実際に外側で参照するのは `recorded_at`
  と `memoryOnlyConditions` が触れる列（`status`・`decay_floor_at`・`subject_id`・
  `attributes`・`tags`・`occurred_at`・`valid_from`・`valid_until`・`provenance_kind`・
  `tenant_id`）だけだが、`filter` の内容によって必要な列の集合が変わるため、
  列を明示的に絞る形にすると `buildLateralMemoryConditions`/呼び出し側の同期が
  さらに1箇所増える。行が800バイト級まで太っても pkey 経由の1行取得のコストへの
  影響は実測上ごく小さい（上の表）——**列を絞る最適化は見送った**（引き受けた負債）。
- **N=200・狭い行・統計なしでは `memories_pkey` が確実に選ばれる保証はない**（上の
  「行の幅で結果が変わる」実測）。この ADR が直すのは「`m.id = e.memory_id` を
  `Join Filter` で全数比較する O(N²) の経路を無くす」ことであり、「`memories_pkey`
  を常に選ばせる」ことそのものではない——狭い行・小さいテーブルでは `Seq Scan`
  1回（O(N)、`Join Filter` 無し）に落ち着くことがあり、それ自体は正しい選択である。
- **`search()` は直していない**——同じ欠陥が理論上・実測上どちらも存在する
  （上の「参考」節）。同じ直しを当てるべきかは、このマネージャーへの報告で
  判断を仰いだ（下の「これが覆るとしたら」）。

## これが覆るとしたら

- **`search()` にも同じ欠陥が実測されている**（本 ADR の「参考」節）。`search()` は
  `searchMany` と違って `LATERAL`/`VALUES` を使わないため、候補Dの形をそのまま適用
  できるかは未検証——次の一手として検討する価値がある（このマネージャーの判断待ち）。
- pgvector・PostgreSQL の版が変わり、`OFFSET 0` が最適化の柵として効かなくなった
  場合（Postgres の将来のバージョンが `OFFSET 0` の柵をオプティマイザで見透かす
  ように変わる可能性はゼロではない——现状 17 系での実測に留まる）。
- `memories` の列が増減し、`SELECT *` が返す幅が大きく変わった場合（上の「行の幅」
  依存の性質そのもの）。

## 確かめていないこと

- 大きな規模（N=3000 までは、アンカー3・10 とも12往復×25回の中央値で測った。
  数万行以上、統計あり）で候補Dが Hash Join に対してどの程度不利になるか
  ——測った範囲（N=200〜3000）では、既定のアンカー数（3）で前後差の中央値が
  概ね2ms以内かつ N とともに伸びず、アンカー10（既定ではない）でも N=3000 では
  伸びが消えた。統計的な検定（t検定等）はしていない——中央値・散らばりの実測
  までで判断している。N=3000 より大きい規模は測っていない。
- `search()` に同じ直しを当てた場合の実測（上の「これが覆るとしたら」）。
- PostgreSQL 18 系・pgvector の異なる版での再現性。

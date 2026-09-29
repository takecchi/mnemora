# ADR 0362: `PostgresVectorStore.searchMany` は、統計が無いときだけ `memories` を主キー（`memories_pkey`）で引く形に切り替える（Issue #1181）

**⚠ 題は最終決定を指す。**当初は「常に固定する」（候補Dだけを常に使う）案を採用したが、
統計がある場面での実測（後述）を受けて依頼主がこれを退け、「統計の有無で切り替える」
（案2、`pg_class.reltuples` + One-Time Filter）に変わった。旧い決定の記録は下の「決定」
節にそのまま残し、上書きした経緯は「統計がある場面で Hash Join を保つ別の形は無いか」
節に書く。

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

**⚠ この節は当初の決定（候補Dだけを常に使う）の記録である。固い測り直しの結果、
依頼主はこれを退けた——最終的な決定は下の「統計がある場面で Hash Join を保つ
別の形は無いか（追記・見つかった。決定を上書きする）」を見ること。候補Dの
クエリの形自体（`LATERAL` + `OFFSET 0` + `id = e.memory_id` だけ + テナント境界を
外に置く）は、統計が無い場面の枝としてそのまま採用されている——変わったのは
「常に使うか、統計の有無で切り替えるか」だけである。**

`searchMany` の `LATERAL` の中の `JOIN memories m ON
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

### 統計がある場面で Hash Join を保つ別の形は無いか（追記・見つかった。決定を上書きする）

**⚠ 上の「決定」（候補Dだけを常に使う）は、この追記で覆った。** `LATERAL` +
`OFFSET 0` は相関副問い合わせを強制する柵であり、構造的に `Nested Loop` としてしか
実行できない（`Hash Join` は両側を先にハッシュ化する必要があり、相関副問い合わせと
両立しない）。⟹ 候補Dだけを常に使う形は、統計の有無に関係なく常に `Nested Loop`
（`memories_pkey` 経由）を選ばせる——「統計が無くても直る」ことの代償として、
「統計があっても `Hash Join` は選べない」ことを常に引き受ける形だった。

**固い測り直し**（`recall()` 全体、`observe()` 経由・`ANALYZE` 済み、前後を12往復
以上交互に、各点は warmup5回を捨てた後の25回の中央値）で、この代償を数字にした:

| N | アンカー | 前: 中央値(最小〜最大) | 後（候補Dのみ）: 中央値(最小〜最大) | 前後差の中央値 |
|---|---|---|---|---|
| 200 | 3（既定） | 29.72ms (24.64〜32.87) | 30.03ms (27.77〜41.14) | **+2.08ms** |
| 3000 | 3（既定） | 41.37ms (37.62〜50.41) | 42.62ms (35.22〜45.91) | -0.45ms |
| 200 | 10 | 33.28ms (27.37〜36.29) | 36.43ms (31.00〜47.18) | **+3.70ms** |
| 3000 | 10 | 49.61ms (41.04〜54.20) | 47.87ms (41.93〜55.47) | -0.55ms |

**依頼主の判定（当初の線: 既定のアンカー数で前後差が概ね2ms以内かつNとともに
伸びない場合だけ進める）はこれを退けた**——N=200・アンカー3（既定）の +2.08ms が
2msを超えており、「外れ値が中央値を押し上げているだけ」という読みで線を緩めることは
認めない、という判断だった。⟹ **候補Dだけを常に使う案（(A)）は採らない。**

### 案（B）: 統計の有無で分岐する（「クエリの形だけで直す」から外れる）

依頼主は、ここで「クエリの形だけで直す」という当初の依頼の範囲を外れることを
明示的に受け入れた——**統計がある場面では今の main の SQL（`search()` と同じ素の
`JOIN`）が1バイトも変わらずに走り、統計が無い場面だけ候補Dの形になる**、という
分岐を実装する。**新しい閾値・裁量値は作らない**——「統計が無い」ことそのものを
`pg_class.reltuples` で見る。

#### 1. `reltuples < 0` は「統計が無い」場面を見分けられるか（実測、まず確かめた）

見た場面は3つ: 入れ始めの N=200 で自動 ANALYZE 前、N=500・900 で同じく自動
ANALYZE（[ADR 0194](./0194-embedding-space-analyze-threshold.md) の
`INITIAL_ANALYZE_THRESHOLD = 1000`）前、`ANALYZE` 実行後。対象は `memories` と
埋め込み表 `memory_embeddings_<space>` の両方（`observe()` 経由・実データに近い
`content`、`packages/postgres/src/bench/rigorous-measure.ts` の `reltuples-check`
コマンドで実測）。

| 場面 | `memories`.`reltuples` | 埋め込み表.`reltuples` |
|---|---|---|
| テーブル作成直後（N=0） | **0** | **-1** |
| N=200（自動 ANALYZE 前） | **0** | **-1** |
| N=500（自動 ANALYZE 前） | **0** | **-1** |
| N=900（自動 ANALYZE 前） | **0** | **-1** |
| N=900（`ANALYZE` 実行後） | 900 | 900 |

**`memories` は単独では「統計が無い」を検出できない**——`memories` の
`reltuples` は N=0〜900 のどこでも `0`（負ではない）である。原因は
`migrations/0005_analyze_memories.sql`（[ADR 0062](./0062-contested-with-id-fk-index.md)
が既に文書化している既知の限界）: 新規インストールでは `0001`〜`0005` が**空の**
`memories` に順に適用され、`0005` の `ANALYZE memories;` が空テーブルに対して
実行される。`ANALYZE` は空テーブルに対しても成功するが、サンプルする行が無いので
`reltuples` は `0` になり、**それ以降その後 `ANALYZE` を打つまで `0` のまま残る**
（Postgres は `INSERT` だけでは `reltuples` を更新しない）。「一度も `ANALYZE`
されていない」ことを示す `-1`（PostgreSQL 14 以降の意味）には、二度と戻らない。

**埋め込み表は単独で正しく検出できる**——`registerEmbeddingSpace`
（`vector-space.ts`）は `CREATE TABLE`/`CREATE INDEX` だけを行い、`ANALYZE` を
一度も打たないため、新規登録された埋め込み表の `reltuples` は本物の「一度も
`ANALYZE` されていない」を表す `-1` のままであり、実際に自動 ANALYZE の閾値
（1000）に達するか、明示的に `ANALYZE` されるまでそのまま残る。

**⟹ `memories` 単独では見分けられないが、`(memories.reltuples < 0) OR
(埋め込み表.reltuples < 0)` という OR 判定であれば、この Issue が扱う窓（N=200〜900
の自動 ANALYZE 前）を正しく見分けられる**——埋め込み表側が常に正しく `-1` を
示すため、OR の片方が常に機能する。**この Issue の範囲では「止めて表を返す」条件
（reltuples で場面を見分けられない）には当たらない**——ただし `memories` 単独の
限界は、この判定の脆さとして「引き受けた負債」に記録する。

**PostgreSQL の対応する最低版での意味**: このリポジトリの migrations は
`NULLS NOT DISTINCT`（`migrations/0001_init.sql` の `uq_memories_extraction`、
PostgreSQL 15 以降の構文）を無条件に使っており、**このリポジトリが実際に対応する
最低版は PostgreSQL 15 である**（CI は 17 だけを検査している。`.github/workflows/ci.yml`）。
`reltuples = -1` の意味（「一度も `ANALYZE`/`VACUUM` されていない」）は PostgreSQL 14
以降で導入されたものなので（[ADR 0062](./0062-contested-with-id-fk-index.md) 実測・
引用）、このリポジトリが対応する版の全域でこの意味は変わらない。

#### 2. 往復の抑え方の比較（案1・案2、実測）

- **案1（store ごとのキャッシュ）**: 一度 `reltuples >= 0` を見たら、その表について
  以後見ない。**設計しただけで実装・実測はしていない**——案2が「往復を増やさない」
  という目標をより直接に満たし、かつ実測で目標値（統計ありで2ms以内）を満たした
  ため、追加の複雑さ（プロセスローカルなキャッシュの生存期間・複数プロセス間の
  不整合をどう扱うか）を持ち込む前に不要と判断した。
- **案2（1本の SQL の中に両方の形を置き、One-Time Filter で切り替える）**: **採用。**
  `WHERE (SELECT reltuples FROM pg_class WHERE oid = to_regclass(<table>)) >= 0`
  という、クエリベクトル・アンカーの添字を参照しない定数の副問い合わせを、`search()`
  と同じ素の `JOIN` の枝（統計あり）と候補Dの枝（統計なし、否定条件）それぞれの
  `WHERE` に足す。`EXPLAIN` で確認済み——Postgres はこの副問い合わせを
  `InitPlan` として1回だけ評価し（`LATERAL` の繰り返し回数に関係なく）、条件が
  偽の枝は `One-Time Filter: (...)` として `(never executed)` になる
  （下の「実測」参照）。**往復は増えない**（1本の SQL 文のまま）。

  実測（`observe()` 経由・`ANALYZE` 済み、`EXPLAIN (ANALYZE, BUFFERS)`）:
  - 統計ありの枝（`reltuples >= 0`）: `search()` と同じ `Hash Join`（`Seq Scan`
    両側）が選ばれ、候補Dの枝は `One-Time Filter` により `(never executed)`。
  - 統計なしの枝（`reltuples < 0`）: `memories_pkey` を `Index Cond: (id =
    e.memory_id)` で引く候補Dの形が選ばれ、統計ありの枝は `(never executed)`。
  - 計画時間: 統計あり 2.9〜4.5ms（元の main は実測で 0.6〜2ms 程度だったので、
    `InitPlan` 4つ（枝2つ×2条件）と枝が2倍（4枝）になった分の増加はあるが、
    小さい）。

  **統計ありの `recall()` 全体（案2、固い測り直し。前は元の main、後はこの案2）**:

  | N | アンカー | 前: 中央値(最小〜最大) | 後（案2）: 中央値(最小〜最大) | 前後差の中央値 | 前後差の平均 |
  |---|---|---|---|---|---|
  | 200 | 3 | 29.52ms (27.23〜34.10) | 30.50ms (27.10〜36.47) | -0.64ms | +0.13ms |
  | 200 | 10 | 29.48ms (26.17〜35.63) | 32.07ms (27.05〜39.50) | +1.17ms | +1.81ms |
  | 3000 | 3 | 39.25ms (35.33〜42.64) | 39.71ms (33.66〜53.08) | +1.19ms | +2.40ms |
  | 3000 | 10 | 44.39ms (41.48〜56.18) | 45.64ms (42.20〜52.42) | -0.18ms | +0.37ms |

  **⟹ 全4条件で前後差の中央値が2ms以内、かつ N とともに伸びていない**
  （アンカー3: -0.64ms→+1.19ms、アンカー10: +1.17ms→-0.18ms）。「止めて表を返す」
  条件（統計ありで2msを超える）には当たらない。**案2を採用する。**

**検討して見送った他の案**:

- **`pg_hint_plan` 等の拡張でヒントを与える**: 拡張自体をインストールする必要が
  あり、CI・利用者の環境に前提を追加することになるため見送った。
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
- **`memories.reltuples` 単独では「統計が無い」を検出できない**（上の「1.
  `reltuples < 0` は統計が無い場面を見分けられるか」実測）——`migrations/0005_analyze_memories.sql`
  が新規インストールの空テーブルに対して `ANALYZE` を打つため、`reltuples` は
  `0`（`-1` ではない）に固定され、それ以降 `ANALYZE` を打つまで動かない。この
  判定は埋め込み表側の `reltuples < 0` が正しく機能することに実質的に依存している
  ——両方の表が同時に「統計はあるが実データに対して古い」という状態（例えば
  埋め込み表だけが閾値到達で自動 `ANALYZE` された後、`memories` 側は未 `ANALYZE`
  のまま行数が伸びた場合）は、この OR 判定では拾えない。この class の staleness
  （統計が古いこと一般）は ADR 0194 が既に引き受けている負債であり、この ADR が
  新たに広げるものではない——Issue #1181 が扱う「新規インストールの入れ始め」の
  窓に限っては、埋め込み表側の `-1` が正しく機能するため実害は無い（実測）。
- **統計ありの枝は、常に `Hash Join` になるとは限らない**——`search()` と同じ
  素の `JOIN` を使うので、統計に基づく普通のプランナの判断（`Hash Join`・
  `Nested Loop` 経由の `memories_pkey` 等）がそのまま適用される。この ADR が
  縛るのは「候補Dの枝（`LATERAL`/`OFFSET 0`）が実行されないこと」であり、
  統計ありの枝がどの物理プランを選ぶかまでは縛らない（`search()` 自身も
  縛っていない）。
- **`UNION ALL` が2枝から4枝に増えた**——計画時間が実測で 0.6〜2ms 程度から
  2.9〜4.5ms程度に増える（上の「実測」参照）。統計ありの `recall()` 全体では
  この増分を含めても前後差が2ms以内に留まったため（上の表）、この計画時間の
  増加そのものは引き受けた。

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

- 案2（統計あり枝・統計なし枝を1本の SQL に置く形）の、大きな規模（N=3000 まで、
  アンカー3・10とも12往復×25回の中央値で測った）を超えたときの計画時間・実行時間
  ——測った範囲では前後差の中央値が全条件で2ms以内かつ N とともに伸びなかったが、
  統計的な検定（t検定等）はしていない。N=3000 より大きい規模・アンカー数は測って
  いない。
- `reltuples` の2つの InitPlan（埋め込み表・`memories`）が、`LATERAL` の繰り返し
  回数（アンカー数）が非常に多い場合（数百・数千アンカー等、通常の使い方からは
  外れる規模）でも1回だけ評価されたままかは、アンカー10までしか確かめていない。
- `autovacuum` が有効な環境（本 ADR の実測は自分専用インスタンスで
  `autovacuum = off`）で、`reltuples` が本 ADR の想定と違うタイミングで更新される
  ケース（例えば `memories` が別の経路で先に `VACUUM`/`ANALYZE` される場合）の
  挙動は確かめていない——`autovacuum` が先に統計を作ってくれるなら、この Issue
  の欠陥自体がそもそも起きない側に転ぶだけであり、悪化する方向のケースは想定して
  いない。
- `search()` に同じ直しを当てた場合の実測（上の「これが覆るとしたら」）。
- PostgreSQL 18 系・pgvector の異なる版での再現性。`reltuples = -1` の意味が
  PostgreSQL 14 以降で安定していることは [ADR 0062](./0062-contested-with-id-fk-index.md)
  の実測を引用したが、本 ADR 自身では PostgreSQL 17 でしか実測していない。

# ADR 0023: 段1の ANN クエリで `subject` を等値で絞る（`period` は降ろさない）

- **状態**: 採用 (2026-09)

- **文脈**:

  `docs/recall.md` の段1（索引が効くフィルタ + ANN 検索）は、`tenant_id` と `status`
  だけで絞っていた。`subject` は**候補を取得した後の後段フィルタ**で落としていた
  （`packages/core/src/recall-runtime.ts`）。

  **⟹ 大規模テナントで小さい subject を引くと、over-fetch の窓
  （`k' = limit × overFetchFactor`、既定 40）がテナント全体の近傍で埋まり、
  その subject の記憶が1件も窓に入らないまま黙って落ちうる。**

  `Ctx.subjectId` は最初から在り（`packages/core/src/ctx.ts`。「`tenantId` は隔離境界、
  `subjectId` はテナント内の整理の単位」）、段5の目次帯も subject 単位で集計している。
  **段1だけが、この次元を見ていなかった。**

  なお `VectorFilter` の doc は「filter は索引で表現できる形（等値・単調な範囲比較）に限る」
  と定めており、**subject の等値一致はこれにそのまま当たる**——新しい種類の要求ではない。

- **決定**:

  1. `VectorFilter` に `subjectId?: string` を足し、段1の呼び出しで
     `scope.subjectId` を渡す。`packages/postgres` の `search` は
     `m.subject_id = $x` を `WHERE` に足す。
     **段1のクエリは既に `JOIN memories m` している**（`m.status` を絞るため）ので、
     **スキーマの変更も新しい索引も要らない。**
  2. **後段フィルタは残す。** 二重に見えるが意図的である——`VectorStore` は
     「絞ってもよいが絞らなくてもよい」派生索引であり、**正しさの責任は常に後段にある。**
     段1の絞りは正しさのためではなく、**over-fetch の窓を無駄にしないための最適化**である。
     （`InMemoryVectorStore` は `filter.status` すら見ないプレースホルダであり、
     後段を消すと core の契約が壊れる。）
  3. **`period`（`occurredAfter` / `occurredBefore`）は段1に降ろさない。**下記参照。

- **`period` を降ろさなかった理由**:

  `docs/recall.md` は「partial index は離散値・低カーディナリティのフィルタに向くが、
  連続値の範囲比較には向かない。連続値で索引を効かせたいなら離散化したバケット
  （例:『直近30日』）を別列に持つ迂回はあり得るが、**Phase 1 の scope には含めない**」
  と書いている。`period` はまさにこの連続値の範囲比較である。

  ⟹ **subject（等値）と period（範囲）は索引設計上の性質が違う。**
  period を降ろすには「バケット列を足すか」というスキーマに踏み込む判断が要り、
  それは本 ADR の範囲を超える。

  **引き受ける負債**: period については引き続き、段1がテナント幅で over-fetch してから
  後段で捨てる。**狭い時間窓 × 大規模テナントでは、subject と同種の取りこぼしが残る。**
  この穴は塞いでいない。

- **検討した代替案**:

  - **`period` も一緒に段1へ降ろす**: 却下（上記。スキーマに踏み込む設計判断が要る）。
  - **後段フィルタを消して段1に一本化する**: 却下。`VectorStore` の契約は
    「絞る義務」を課していない。消すと `InMemoryVectorStore` のような
    絞らない adapter で静かに壊れる。**正しさを最適化に依存させない。**
  - **`memory_embeddings_<space>` に `subject_id` 列を複製して JOIN を無くす**:
    却下（今回は）。段1は既に `memories` を JOIN しており、列の複製は
    同期のずれという新しい失敗様式を持ち込む。**測ってから必要なら考える。**

- **`testkit` の適合テストに `subjectId` の契約を足すかどうか（今回は足さない）**:

  足さなかった。理由は `vector-store-conformance.ts` に既にある先例と同じ
  ——`EXPLAIN` で索引が使われることの検査は pgvector 固有の関心事であり、
  `packages/postgres` 側に置く、という切り分けである。**`filter` を実際に適用するか
  どうかは adapter の裁量**であり（`InMemoryVectorStore` は `status` すら見ない）、
  「必ず絞る」を適合テストで要求するとそのプレースホルダが落ちる。

  **⚠ ただしこれは、より一般的な未解決の問いを先送りしている**:
  **`VectorFilter` は「絞る義務」を持つのか、持たないのか。**
  いまは持たない（後段が正しさを担保する）という前提で全体が組まれているが、
  それは `status` / `decayFloorAtAfter` / `subjectId` のすべてに同じく効く話であり、
  **どこにも明文化されていない。** 明文化するなら、
  `VectorStoreConformanceOptions` に `supportsFilter` のような能力フラグを足して
  「絞ると宣言した adapter は本当に絞る」ことを検査する形が考えられる。
  **本 ADR ではこれを決めない。**

- **結果（この決定が招くもの）**:

  良い面: 小さい subject が over-fetch の窓から押し出されなくなる。
  スキーマ変更も新しい索引も無い。

  **⚠ プランナの選択は測るまで分からなかった——測った結果は上の「実測でわかったこと」に書いた
  （HNSW は使われない）。** 以下は本 PR より前に書いた予測であり、実測はこれを裏付けた。
  選択性の高い等値条件
  （`subject_id = $x`）を足すと、[ADR 0011](./0011-no-window-count-in-ann-stage.md)
  が実測した通り、**プランナが HNSW を捨てて別の経路（主キー/別索引 + Sort）を
  選ぶことがありうる。** それ自体は正しさを損なわない（結果は同じ）が、
  「段1では常に HNSW が効く」という前提は成り立たなくなる。
  本 PR は `EXPLAIN` の歯でこれを実測する。

- **⭐ 実測でわかったこと（当初の期待が反証された。GitHub Actions run 34007687930、PostgreSQL 17 + pgvector、3,000行・100 subject）**:

  本 ADR の「結果」節は当初「プランナの選択は測るまで分からない」と書いていた。**測った。**
  **`m.subject_id = $x` を足すと、プランナは HNSW を使わない。**

  ```
  Limit
    -> Sort  (Sort Key: (e.embedding <=> '...'::vector))
         -> Hash Join  (Hash Cond: (e.memory_id = m.id))
              -> Seq Scan on memory_embeddings_...  (Filter: tenant_id = ...)
              -> Hash
                   -> Index Scan using idx_memories_by_subject on memories m
                        Index Cond: ((tenant_id = ...) AND (subject_id = ...) AND (status = ANY (...)))
  ```

  ⟹ **「memories を `idx_memories_by_subject`（既存の索引。新設していない）で絞ってから、
  距離で並べ替える」という*厳密な*経路が選ばれた。** これは
  [ADR 0011](./0011-no-window-count-in-ann-stage.md) が `count(*) OVER ()` について
  実測したのと同じ現象である——**プランナは、正しい答えを安く出せる代替経路があるなら、
  近似索引を使わない。**

  **良い面**: 結果は近似ではなく**厳密**になる。小さい subject を引くとき、
  HNSW の近似では窓に入らなかった記憶が、確実に返る（歯Aが実測で押さえた:
  絞らないと窓40件が全部 `crowd` で `small` は **0件**、絞ると `small` の **3件**が返る）。

  **🔴 代償（塞いでいない）**: 上のプランは埋め込みテーブル側を `Seq Scan` している。
  3,000行では最安（cost 148）だが、**この経路の費用はテナントの行数に比例して伸びる。**
  `docs/roadmap.md` §5.6 は100万件級を前提に設計すると書いており、
  **その規模でこの経路がどうなるかは測っていない。**
  ⟹ **subject で絞る recall は、いまや「取りこぼさないが、テナント規模に比例しうる」経路である。**
  取りこぼす近似と、比例して重い厳密のどちらを既定にするかは、
  **実測を伴う次の判断**であり、本 ADR では決めない。考えられる手は
  `hnsw.iterative_scan` の有効化、`memory_embeddings_<space>` への `subject_id` 複製、
  subject の大きさに応じた経路の切り替えなど。

- **⚠ この変更の効果を、擬似 provider の `compare` の ✅/❌ で読まないこと**:

  `examples/chat` は `ctx.subjectId` を**一度も設定していない**（`grep` で確認済み）。
  ⟹ `scope.subjectId` は `undefined` のままで、**この変更は `compare` に対して
  何もしない。`compare` の数値は本 PR の前後で変わらないはずである。**

  そして仮に将来 `compare` が subject を使うようになって ❌ が ✅ に変わったとしても、
  **それは想起の質が良くなった証拠ではない**——[ADR 0022](./0022-fake-provider-compare-does-not-claim-recall-quality.md)
  の通り擬似 embedding には意味的な類似度が無く、**単に競争相手が減っただけ**である。
  **「候補件数がどう変わったか」（この変更の効果）と「✅/❌ がどう変わったか」
  （擬似 embedding の産物）を、混ぜて読まないこと。**

- **これが覆るとしたら**:

  - `EXPLAIN` の実測で「subject を足すと HNSW が使われず、かつ実運用規模で遅い」
    と分かったら、`memory_embeddings_<space>` への `subject_id` 列複製や
    部分索引を検討し直す。
  - `period` を段1で絞りたいという要求が実測で裏付けられたら（狭い時間窓 ×
    大規模テナントでの取りこぼしが観測されたら）、離散化バケット列の設計を
    別 ADR で起こす。

- **確かめていないこと**:

  - **歯A・歯Bは手元で一度も実行していない**（作業環境に PostgreSQL が無い）。
    **CI が唯一の実行環境であり、上の「実測でわかったこと」はすべて CI の実測である。**
  - **🔴 subject で絞る経路の、大規模（100万件級）での費用を測っていない。**
    実測したのは 3,000行・100 subject の1点だけである。上記の `Seq Scan` が
    テナント規模でどう効くかは未知のままである。
  - **実運用規模（100万件級）での性能は測っていない。**歯Aは 503行、歯Bは 3,000行である。
  - `subjectId` に空文字列などの特殊値を渡した場合の挙動は検討していない
    （`status` / `decayFloorAtAfter` も同様に無検証であり、既存方針に倣った）。

---

## 追記（2026-09-06）: 規模と **subject の大きさ**を振った実測。「`Seq Scan` になる」はどの大きさでも起きなかった——**ただし大きい subject では別の問題が出る（プランナが HNSW へ戻り、窓が埋まらない）**

**上の「実測でわかったこと」「代償（塞いでいない）」節は書き換えていない。**
当時（3,000行・100 subject）の記録として残す。以下は別の計測（GitHub Actions run
34009301567、PostgreSQL 17 + pgvector、`packages/postgres/src/bench/scale-bench.ts`、
擬似の合成ベクトル・実 API 不使用）で、10,000行と100,000行のスケールを追加で測った結果である。

### 実測表（`PostgresVectorStore.search`、subject フィルタ）

| 規模（行数） | 次元数 | 変種 | 所要時間（中央値） | HNSW 使用 | Seq Scan |
|---:|---:|---|---:|---:|---:|
| 10,000 | 256 | subjectId 無し | 1.1ms | yes | no |
| 10,000 | 256 | subjectId 有り（小さい subject） | 0.9ms | no | no |
| 100,000 | 256 | subjectId 無し | 1.2ms | yes | no |
| 100,000 | 256 | subjectId 有り（小さい subject） | 0.9ms | no | no |

100,000行・subject 指定のプラン（逐語）:

```
Limit  (cost=226.05..226.10 rows=21 width=32) (actual time=0.048..0.050 rows=10 loops=1)
->  Sort
->  Nested Loop
->  Index Scan using idx_memories_by_subject on memories m  (actual rows=10)
->  Index Scan using <埋め込み表>_pkey on <埋め込み表> e  (loops=10)
```

### この実測が言っていること、そして見立ての訂正

**上の「代償（塞いでいない）」節は「上のプランは埋め込みテーブル側を `Seq Scan` している……
この経路の費用はテナントの行数に比例して伸びる」と書いていた。**
**今回の実測では、そうならなかった。** 10,000行・100,000行のどちらでも
`Seq Scan` は出ず、`idx_memories_by_subject` → 埋め込み表の主キーという **Nested Loop** が
選ばれ、**0.9ms でほぼ横ばい**だった（1.1ms→0.9ms、1.2ms→0.9ms）。

⟹ **当時観測した 3,000行での `Seq Scan` は、表が小さいときの産物だった可能性が高い**
（表が小さいと Seq Scan が最安になるためプランナがそれを選ぶ。今回の10,000行・100,000行
では既に Nested Loop の方が安く、プランが切り替わっている）。

**⚠ ただし「だから問題ない」とは言えない。次の点を測っていない:**

- ~~大きい subject を測っていない~~ → **測った。下の「追測」節を見ること**（この行は
  当時の未測定の記録として残す）。
- **1,000,000行でのベクトル検索を測っていない**（このベンチは Part 2 を 100,000行までに
  留めている。HNSW の逐次維持コストが重くなりうるため）。
- **256次元でしか測っていない。** 次元数は埋め込みテーブルの行幅を決めるため、
  `Seq Scan` になった場合の費用に直結する。より高次元（例えば `text-embedding-3-small`
  相当の1536次元）で測り直した結果ではない。
- **同時実行下では測っていない**（単発クエリの中央値のみ）。
- **「何 ms なら割に合わないか」の閾値を、この repo は定義していない。** ⟹ この数値だけから
  「近似索引が要る／要らない」を結論しないこと。生の数値とスケーリングの傾向を示すに留め、
  閾値の判断は読む人に委ねる。

この計測は同時に `docs/recall.md` §5 の `aggregateScope`（群カウント）についても
10,000/100,000/1,000,000行で測っている。そちらの実測と読み方は `docs/recall.md` §5 に書いた
（本 ADR の対象である段1の ANN クエリとは別の場所である）。

ベンチの回し方: `pnpm --filter @mnemora/postgres run bench:scale`
（環境変数 `BENCH_SCOPE_SCALES` / `BENCH_VECTOR_SCALES` / `BENCH_VECTOR_DIMENSIONS` で調整可能。
詳細はスクリプト冒頭のコメント `packages/postgres/src/bench/scale-bench.ts` を参照）。
**このベンチは CI に常時つないでいない。手で回す口である。**

---

## 追測（2026-09-06）: subject の**大きさ**を振った。**3つの領域がある**

上の追記は「小さい subject（10〜21行）」でしか測っていなかった。**そこが唯一残っていた穴**
だったので、**subject の大きさだけを振って**測り直した（次元は 256 に固定。振る軸を2つにすると
どちらが効いたか分からなくなるため）。全体行数は 100,000 に固定。**狙いの subject の行数は
`SELECT count(*)` で実測して突き合わせている**（「10,000行のつもり」と「10,000行だった」は違う）。

出所: GitHub Actions run 34010394105、PostgreSQL 17 + pgvector、
`packages/postgres/src/bench/scale-bench.ts` Part 3、擬似の合成ベクトル・実 API 不使用。

| subject の大きさ（実測） | 全体行数 | 操作 | 所要時間（中央値） | HNSW 使用 | Seq Scan |
|---:|---:|---|---:|---:|---:|
| 10 | 100,000 | `search` | 0.8ms | no | **no** |
| 1,000 | 100,000 | `search` | 2.5ms | no | **no** |
| 10,000 | 100,000 | `search` | 1.7ms | **yes** | **no** |
| 10 | 100,000 | `aggregateScope` | 0.8ms | – | no |
| 1,000 | 100,000 | `aggregateScope` | 1.2ms | – | no |
| 10,000 | 100,000 | `aggregateScope` | 5.2ms | – | no |

### 1. `Seq Scan` は、どの大きさでも起きなかった

**当時の見立て（「埋め込み側が `Seq Scan` になり、費用がテナント規模に比例する」）は、
小さい subject でも大きい subject でも再現しなかった。** ⟹ 3,000行で観測した `Seq Scan` は
**表が小さいときの産物**だった、という上の解釈は、subject の大きさを振っても覆らなかった。

### 2. 🔴 **しかし大きい subject では、別の問題が出る**

`subject` が全体の 10%（10,000 / 100,000行）になると、**プランナは厳密な経路をやめて
HNSW へ戻る**。そしてそのとき、**窓が埋まらない**:

```
Limit  (cost=102.94..945.88 rows=40 width=32) (actual time=0.587..0.816 rows=6 loops=1)
->  Nested Loop  (actual rows=6 loops=1)
->  Index Scan using idx_memory_embeddings_hnsw_... e   (actual rows=384 loops=1)
->  Index Scan using memories_pkey on memories m        (actual rows=0 loops=384)
```

**HNSW が返した 384 件のうち、狙いの subject に属していたのは 6 件だけで、
`LIMIT 40` に対して 6 件しか返っていない。**
subject が全体の 10% を占めるので、ANN が近傍から拾う 384 件のうち約 10% しか
フィルタを通らない——**近似索引の下では、subject の絞り込みは「後段のフィルタ」に戻る。**

⟹ **段1へ subject を降ろす効果は、subject の大きさによって3つの領域に分かれる:**

| 領域 | プラン | 窓 | 評価 |
|---|---|---|---|
| **小さい subject** | `idx_memories_by_subject` → 主キーの Nested Loop（**厳密**） | 全部入る | **この PR が直したかった当のもの。効いている** |
| **中くらい** | 同上（厳密） | 埋まる | 費用は上がる（1,000行で 2.5ms がこの実測の最悪点） |
| **大きい subject** | **HNSW へ戻る（近似）** | **埋まらない**（40 要求に対し 6） | **絞り込みが効かない領域が残っている** |

**⚠ ただし、これは本 PR による退行ではない。** 段1へ subject を降ろす前は、
ANN がテナント全体から 40 件を取り、後段のフィルタで subject 外を捨てていた
——同じ 10% の subject なら手元に残るのは約 4 件であり、**6 件はそれより悪くない。**
**「直しきれていない領域が在る」のであって、「壊した」のではない。**

### 3. `aggregateScope` は subject が大きいほど伸びる（が、全体集計よりはるかに安い）

0.8ms（10行）→ 1.2ms（1,000行）→ 5.2ms（10,000行）。
`docs/recall.md` §5 に載せたテナント全体の集計（100,000行で 45.8ms、1,000,000行で 408ms）
と比べると、**subject で絞れている限り桁が違う。**

### ⚠ この追測でも測っていないこと

- **`omitted` に何が出るかを確かめていない。** 上の「窓が埋まらない」場合、`annHits.length`
  は `k'` に達しないので `ann_truncated` は付かないはずである（`recall-runtime.ts` の条件は
  `annHits.length >= kPrime`）。**「近似索引の下で subject の絞り込みが取りこぼした」ことを
  呼び出し側が知る手段が在るのかどうかは、確かめていない。**
  段5の目次帯が subject の総数を返すので**気づく手段はある**はずだが、実測していない。
- **全体行数を振っていない**（100,000 固定）。同じ subject の大きさでも、全体行数が変われば
  プランナの選択は変わりうる。
- **subject が全体に占める割合の境目を特定していない。** 10%（10,000/100,000）で HNSW へ
  戻ったことは分かったが、**何%で切り替わるかは測っていない。**
- 次元は 256 固定、同時実行下では測っていない（上の追記と同じ）。

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

  **⚠ プランナの選択は測るまで分からない。** 選択性の高い等値条件
  （`subject_id = $x`）を足すと、[ADR 0011](./0011-no-window-count-in-ann-stage.md)
  が実測した通り、**プランナが HNSW を捨てて別の経路（主キー/別索引 + Sort）を
  選ぶことがありうる。** それ自体は正しさを損なわない（結果は同じ）が、
  「段1では常に HNSW が効く」という前提は成り立たなくなる。
  本 PR は `EXPLAIN` の歯でこれを実測する。

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

  - **`packages/postgres` の歯（歯A: subject で絞ると窓が変わること、歯B: EXPLAIN）は
    作業環境に PostgreSQL が無く、手元で一度も実行していない。** CI が唯一の実行環境である。
  - **実運用規模（100万件級）での性能は測っていない。**歯Aは 503行、歯Bは 3,000行である。
  - `subjectId` に空文字列などの特殊値を渡した場合の挙動は検討していない
    （`status` / `decayFloorAtAfter` も同様に無検証であり、既存方針に倣った）。

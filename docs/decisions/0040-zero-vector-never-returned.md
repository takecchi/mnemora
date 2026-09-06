# ADR 0040: ゼロベクトルが絡む候補は `recall()` の結果に出ない — 契約は振る舞いで揃える

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-07

**⚠ 各主張の出所を分ける。**「私が実行して確かめた」と「受け取った前提」を混ぜない。

---

## 🔴 まず、これまで3箇所に書かれていた前提が誤りだった（**私が実行して確かめた**）

「**pgvector の `<=>` はゼロベクトルに対してエラーを返す**」——これは
`packages/postgres/src/bench/scale-bench.ts:667` を出どころとして、
[ADR 0038](./0038-vector-hit-distance-is-cosine.md) の決定2と
`packages/testkit/src/__fixtures__/in-memory-vector-store.ts` の doc コメントへ写っていた。

**実測（pgvector 0.8.2、この器の PostgreSQL 17.9）:**

| クエリ | 結果 |
|---|---|
| `'[0,0,0]'::vector <=> '[1,0,0]'` | **`NaN`** |
| `'[1,0,0]'::vector <=> '[0,0,0]'` | **`NaN`** |
| `'[0,0,0]'::vector <=> '[0,0,0]'` | **`NaN`** |
| ゼロベクトルを含む表に `ORDER BY e <=> …` | **通る。NaN 行が最後に来る** |

**⟹ エラーにならない。`NaN` を返す。**
**⚠ 過去の pgvector でどうだったかは確かめていない。**この器の 0.8.2 での実測である。

---

## 文脈: 何が食い違っていたか

- `InMemoryVectorStore.cosineDistance` はノルム0のとき **`1`**（「無関係」）を返していた。
- Postgres は **`NaN`** を返す。

`recall-runtime.ts` は `similarity = 1 - distance` として使い、段2で `total >= scoreThreshold` で絞る。

|  | in-memory | Postgres |
|---|---|---|
| `distance` | 1 | `NaN` |
| `similarity` | 0 | `NaN` |
| `total` | 0 | `NaN` |
| 既定の `scoreThreshold`（0.1）で | 落ちる | 落ちる |
| **`scoreThreshold <= 0` で** | **返る** | **落ちる**（`NaN >= x` は常に false） |

**⟹ 観測できる差は `scoreThreshold <= 0` のときだけである**（実測で特定した）。
**そして到達経路は公開 API にある**——`recall(ctx, { vector: [0,0,0], scoreThreshold: 0 })`。
`RecallQuery.vector` は `z.array(z.number())` で値の制約が無い。

**⚠ 保存側のゼロベクトルは `runtime` 経由では作れない**
（`ExtractedMemoryCandidateSchema.content` が `z.string().min(1)`、本物の埋め込みは 0 にならない）。
`VectorStore.upsert` を直接呼べば作れる。

---

## 決定

1. **契約は振る舞いで揃える: 「ゼロベクトルが絡む候補は `recall()` の結果に出ない」。**
   **⚠ 実装の詳細（`NaN` を返すか、別の値を返すか）までは揃えない。**
2. **`InMemoryVectorStore` のゼロベクトル時の戻り値を `1` から `NaN` に変える。**
   **`0` でも `Infinity` でもなく `NaN` を選んだ理由**: 契約は「**どんな `scoreThreshold` でも通らない**」
   ことである。`Infinity` は `similarity = -Infinity` になり、`scoreThreshold = -Infinity` では
   `-Infinity >= -Infinity` が真になって**通ってしまう**。
   **`NaN` はどんな数との比較も false になる唯一の値である。**
3. **適合テストで、両 adapter に対して振る舞いを固定する**（`vector-store-conformance.ts`）。
   **`Number.isNaN` で等値を見ない**——「`distance >= 0` も `distance <= 0` も false であること」を見る。
   ⟹ 決定1のとおり、実装が別の値を返す自由を残す。
4. **`recall()` の高さでも測る**（`packages/postgres/src/__tests__/recall.postgres.test.ts`）。
   **`scoreThreshold: 0` で測る**——差が観測できるのはそこだけだから。
5. **誤った記述を3箇所とも直す。**ただし
   **[ADR 0038](./0038-vector-hit-distance-is-cosine.md) は本文を書き換えず、訂正の追記にする**
   ——あれは「そのときそう信じていた」記録であり、`scale-bench.ts` の既存コメントを根拠にした
   経緯ごと残す価値がある。

---

## 検討して採らなかった案

- **入口（`RecallQuery.vector`）でゼロベクトルを弾く。** **却下（この ADR では）。**
  根に近いのはこちらだが、`vector` / `scoreThreshold` の値制約は
  **入力検証全体の設計**に属する問い（`similarity` が負になりうること、`tagMatch` に上限が無いことと同じ族）であり、
  別に決める。**本 ADR はスコアにも入力検証にも触れない。**
- **in-memory を「エラーを投げる」側に揃える。** 却下。
  **Postgres がエラーを投げないことが実測で分かった以上、揃える先が存在しない。**
- **`Number.isNaN(distance)` を適合テストで直接見る。** 却下（決定3）。
  それは実装の詳細を契約にしてしまう。

## 引き受ける負債・覆えていない範囲

- **`packages/core/src/__tests__/runtime-fakes.ts` の `FakeVectorStore.cosineDistance` は
  `1` を返したままである。**本 ADR では変更していない
  （**そのファイルは触ってはいけないものとして指定されており、解除されていない**）。
  **⟹ `packages/core` の recall の歯は、いまも「ゼロベクトルなら similarity 0」の世界を測っている。**
  適合テストは `packages/core` に届かない（core は testkit を import できない。
  `dependency-boundary.test.ts` が実行時依存を zod だけに固定している）。**塞いでいない。**
- **`RecallQuery.vector` / `scoreThreshold` に値の制約が無い**（上記の却下案）。塞いでいない。
- **`VectorStore.upsert` にゼロベクトルを渡せる**ことは変えていない。契約は検索側の振る舞いだけを縛る。
- **NaN が他の候補の並びを壊すかは測った——壊さなかった**（V8 の `sort` で、非 NaN の相対順は変わらなかった）。
  **ただしこれは1つの標本での観測であり、`sort` の比較器が不整合なときの順序は実装定義である。**

## これが覆るとしたら

- **pgvector が `<=>` の挙動を変えたとき**（エラーにする、0 を返す等）。本 ADR の実測はバージョン固有である。
- **入力検証の設計が決まり、ゼロベクトルを入口で弾くことになったとき。**そのとき決定2は要らなくなる。

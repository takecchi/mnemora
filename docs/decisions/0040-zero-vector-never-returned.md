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

---

## その後（2026-09-13）—— **「候補そのものを返さない」は自由の範囲外だった**（実測）

⛔ **上の本文は1バイトも書き換えていない。**当時そう書いた経緯ごと残す
（決定5が [ADR 0038](./0038-vector-hit-distance-is-cosine.md) に対して採ったのと同じ形）。

### 何が曖昧だったか

決定1は「**実装の詳細（`NaN` を返すか、別の値を返すか）までは揃えない**」と書いた。
決定3の適合テスト（`packages/testkit/src/vector-store-conformance.ts`）は、その自由を

```ts
const zero = hits.find((h) => h.memoryId === zeroId);
if (zero !== undefined) {
  expect(zero.distance >= 0).toBe(false);
  expect(zero.distance <= 0).toBe(false);
}
```

という `if` で表現していた。⟹ 🔴 **この `if` は「候補を `search` の結果から落とす」実装まで
許してしまっていた。**決定1が与えたのは**値の自由**であって、**候補を返すか否かの自由ではない。**

### 🔴 実測: 落とすと [ADR 0044](./0044-score-not-comparable-omission.md) が壊れる

`packages/core/src/__tests__/runtime-fakes.ts` の `FakeVectorStore.search` に
「比較の通らない候補（`NaN`）を結果から除外する」変異を当てた（`tsc --noEmit` は `EXIT=0`。
つまり構文は有効）。

```
× ⭐ ゼロベクトルの記憶が混ざると score_not_comparable が出る（ADR 0040 と繋がる端）
Tests  1 failed | 527 passed (528)
— 変異を戻すと —
Tests  528 passed (528)
```

⟹ 🔑 **候補が段2の採点に届かないと、`omitted: score_not_comparable` を出せない。**
⟹ `recall()` が「**取りこぼしは無い**」と誤答する。**それは ADR 0044 が名指しで直した欠陥そのもの**である。

### さらに、`if` は別の欠陥も通していた

`packages/testkit/src/__fixtures__/in-memory-vector-store.ts` の `upsert` に
「ゼロベクトルを黙って捨てる」変異を当てても、`packages/testkit` の適合テストは
**`217 passed`（全緑）**のままだった。⟹ **「除外した」と「そもそも保存しなかった」が同じ顔で緑になる。**

### ⟹ 決定1・決定3への追記

1. **決定1の自由は「値」についてである。**⛔ **`search` の結果から候補を落とすことは契約違反**
   （`omitted` の報告義務を果たせなくなるため）。
2. **決定3の歯から `if` を外し、`expect(zero).toBeDefined()` を要求する。**
   ⛔ **この表明を緩めて緑にしないこと**——緩めると上の誤答が黙って通る。

|                               | 直す前                          | 直したあと                  |
| ----------------------------- | ------------------------------- | --------------------------- |
| 素の実装                      | ✅ `217 passed`                 | ✅ `217 passed`             |
| `search` がゼロ候補を除外     | 🔴 **`217 passed`（生き残り）** | ✅ `1 failed \| 216 passed` |
| `upsert` がゼロを黙って捨てる | 🔴 **`217 passed`（生き残り）** | ✅ `1 failed \| 216 passed` |
| 変異を戻す                    | —                               | ✅ `217 passed`             |

### ⚠ 上の「引き受ける負債」の1項目も古い

本文にこう書いてある:

> **`packages/core/src/__tests__/runtime-fakes.ts` の `FakeVectorStore.cosineDistance` は
> `1` を返したままである。**…**⟹ `packages/core` の recall の歯は、いまも
> 「ゼロベクトルなら similarity 0」の世界を測っている。塞いでいない。**

⟹ ❌ **これは既に塞がっている。**現物の `runtime-fakes.ts` の
`cosineDistance` は **`NaN` を返す**（`normA === 0 || normB === 0` の番人つき）。
塞いだのは **PR #45**（`f9b5c31`「runtime-fakes.ts の Fake 2つが契約に従っていなかった
（ADR 0042 の EventStore.list / ADR 0040 のゼロベクトル）」。`git log -S` で特定した）。
上の実測はまさにその経路で NaN を作っている。
⛔ **本文は直さない**——「そのとき塞いでいなかった」という記録だからである。

### ⚠ この追記が確かめていないこと

- 🔴 **本物の Postgres では1度も走らせていない。**この追記を書いた器には docker / `initdb` / `psql` が無く、
  `DATABASE_URL` も未設定だった。⟹ **pgvector が `[0,0,0]` の `upsert` を受け付け、`<=>` が `NaN` を返す**ことは、
  **上の本文の実測記録に依拠している**（この追記で再確認してはいない）。
  ⟹ 決定3の歯を強くしたことで、**CI の postgres ジョブで初めて実測される。**
- **「候補が除外された」と「`limit` の切り捨てで落ちた」を区別していない。**
  当該の歯は `limit: 10` に対し候補3件なので今回は無関係だが、一般には別の理由で `undefined` になりうる。
- **`NaN` が混ざったときの並び順**は、本文が「1つの標本での観測」と断ったままである。この追記でも測っていない。
- **`@mnemora/testkit` の適合テストを使う外部 adapter が実在するか**は調べていない。
  ⟹ 歯を強くしたことの外部への実害の大きさは**未測**である。

---

## その後（2026-09-26）—— クエリベクトルの長さが `space.dimensions` と違う場合も、同じ契約に含める（Issue #867）

⛔ **上の本文・前の追記は1バイトも書き換えていない。**同じ形で追記する。

### 何が新しく見つかったか

[Issue #867](https://github.com/takecchi/mnemora/issues/867) が、ゼロベクトルではないが
**長さが対象の空間の `dimensions` と違う**クエリベクトル（例: 3次元の空間に `[1,2]` や
`[1,2,3,4]`）を実測した。この本 ADR が対象にしていた「ゼロベクトル」とは別の入力である。

【実測 Issue #867、pgvector 0.8.2 / PostgreSQL 17.9】保存 `[1,0,0]` に対し:

| クエリ | Postgres | Fake（直す前） |
|---|---|---|
| `[1,2]`（短い） | 未捕捉の `DrizzleQueryError`（"different vector dimensions"） | 正常完走。**意味の無い実数の距離を普通のヒットとして返す**（`omitted` にも何も残らない） |
| `[1,2,3,4]`（長い） | 同上 | 同上（保存側を `0` で埋めて計算） |

`RecallQuery.vector`・`VectorStore.search` の doc、`docs/recall.md`、本 ADR、ADR 0044 の
どれにも、この場合の扱いは書かれていなかった。

### 決定: 案B（比較不能として扱う）を採る。境界で拒む案（新しい throw）は採らない

クローン miku が 2026-09-26 に、空間の次元と長さが違うクエリベクトルを**比較不能**として
扱い、`score_not_comparable` に数えると決めた。

理由:

- **本 ADR（決定1）が既に確立した契約の形をそのまま延長できる。** 「比較できない候補は
  `recall()` の結果から落とさず、距離を比較の通らない値（`NaN`）にする」という形は、
  原因がゼロベクトルであることに依存していない——長さの不一致も同じ形の「比較できない」
  である。
- **新しい throw を増やさない。** `docs/autonomy.md` の「ついでに直さない」の裏返しとして、
  この Issue の対応で例外の種類を増やすと、それ自体が別の破壊的変更の検討（型を公開するか、
  どの adapter がいつ投げるかを揃えるか）を呼び込む。比較不能扱いならその検討が要らない。
- **3実装（Postgres・testkit・core の Fake）を揃えられる。** Postgres は次元不一致の
  クエリをゼロベクトルへ差し替える（`packages/postgres/src/vector-store.ts`、Issue #862 が
  空配列に対して足した経路の自然な拡張）。testkit・core の Fake の `cosineDistance` は、
  比較する2本の長さが違う時点で `NaN` を返す。どちらも「候補は残し、距離だけを
  比較不能にする」という同じ形の実装になる。

採らなかった案（Issue #867 の「選択肢と帰結」参照）:

- **境界で型付き例外で拒む。** 却下。新しい throw になる——`vector.length !==
  space.dimensions` を検査する入口の入力検証は、本 ADR が決定1の「検討して採らなかった案」
  で既に「入力検証全体の設計に属する別の判断」として自らのスコープ外に置いている。
  ゼロベクトルを入口で弾かないと決めた ADR が、長さの不一致だけ入口で拒むのは一貫しない。
- **Postgres を Fake の「足りない側を0埋めして計算を続ける」旧挙動に揃える。** 却下。
  意味の無い点数を本物のヒットとして返すことになり、pgvector が構造上の不整合として
  検出している事実を握りつぶす（Issue #867 本文の「なぜ #862 と同じ形で直さないか」）。
- **未定義のまま doc に書く（PR #903 が一時的にそう書いた）。** 却下。Postgres の未捕捉の
  生の DB エラーと、Postgres/Fake 間の挙動の食い違いが残ったままになる。この Issue が
  再度上がってくる理由がそのまま残る。

### 覆えていない範囲

- **`VectorStore.upsert` に長さの違うベクトルを渡したときの扱いは、この決定の対象外
  のままである**（Issue #867「範囲外で見つけたもの」）。Postgres は例外（`expected N
  dimensions, not M`）、Fake はそのまま保存する食い違いが残る。
- `runtime.observe()` を通した経路（実際の埋め込み provider は常に固定次元を返すため、
  到達性は測っていない）。
- 候補が複数あるときの順位・`limit`・目次帯への影響（今回も候補1件でしか確かめていない）。
- 他のバージョンの pgvector でのエラーメッセージ。

---

## その後（2026-09-26）—— 「NaN が他の候補の並びを壊すかは…壊さなかった」という観測に反例が出た（Issue #938）

⛔ 上の本文・前の2つの追記は1バイトも書き換えていない。同じ形で追記する。

### 何が新しく見つかったか

上の「引き受ける負債」節にはこう書いてある（本文、直していない）:

> **NaN が他の候補の並びを壊すかは測った——壊さなかった**（V8 の `sort` で、非 NaN の
> 相対順は変わらなかった）。ただしこれは1つの標本での観測であり、`sort` の比較器が
> 不整合なときの順序は実装定義である。

クローンの委譲先が、この「1つの標本」に対する反例を Issue #938 として見つけた。
`compareScoredCandidates`（`packages/core/src/recall-runtime.ts`、段2の並べ替え）に

```
[A(total=0.9), C(total=0.7), NAN1(total=NaN), B(total=0.8)]
```

の順で4件を渡して `sort` すると、`NaN` とは無関係な `B` と `C` の相対順が入れ替わる
（期待 `["A","B","C"]`、実際 `["A","C","B"]`）。`b.score.total - a.score.total` は
どちらかが `NaN` だと比較値も `NaN` になり、比較関数の一貫性（推移律）を満たさなく
なる——`Array.prototype.sort` はその周辺にある、`NaN` を含まない有限値どうしの
順序まで崩す。

同じ形の生の引き算比較（`b.field - a.field`）は、段3.5（連想）の
`associationHits.sort`（アンカー類似度降順）・`rankedCandidates.sort`
（rankKey 降順、いずれも `recall-runtime.ts`）にもあり、`similarity`/`rankKey` は
どちらも本 ADR が扱うゼロベクトルの cosine 距離に由来して `NaN` になりうる。

### 直したこと（Issue #938）

段2（`compareScoredCandidates` の第1段）と、段3.5の上の2箇所の `sort` に、`NaN`
（比較できない値）を必ず最後尾へ送る、共有の比較 helper（`compareDescendingNaNLast`）を
当てた。**有限値どうしの大小関係・同点時の安定ソートの性質は1バイトも変えていない。**
`NaN` どうしは `0` を返し、`compareScoredCandidates` では次段のタイブレーク
（実効時刻→id）へそのまま進む。歯: `packages/core/src/__tests__/score-sort-nan.test.ts`。

⚠ この helper は export していない——`pnpm api:check` の差分を0のまま保つため
（`packages/core/src/index.ts` は `recall-runtime.ts` を `export *` しているので、
export すれば公開 API 表面に出る）。段3.5の2箇所は private な関数の直接呼び出しでは
検査できないため、歯はその形（数値2つを受け、降順・`NaN` 最後尾を返す）を複製して
単体で確かめている——`recall-runtime.ts` 側を変えたら複製側も合わせて直す必要があり、
歯自身のコメントにその旨を書いてある。

### この追記が確かめていないこと

- 本物の Postgres + pgvector に対する end-to-end の再現はしていない。`packages/core` の
  純関数レベル（`compareScoredCandidates` への直接入力、および段3.5の2箇所と同じ形の
  複製）での確認に留めている。
- 段3.5の `rankKey`（`hit.similarity × score.total`）について、`similarity`/`total` の
  どちらも有限なのに掛け算そのものがオーバーフロー/アンダーフローして `NaN`/`Infinity`
  になる経路は見ていない——今回直したのは「どこかで既に `NaN` になった値」を `sort` が
  受け取ったときの並び順だけである。
- V8 以外の JS エンジンでの `Array.prototype.sort` の挙動（比較関数が不整合なときの
  実装定義の振る舞い）は確かめていない。

---

## その後（2026-09-27）—— pgvector の HNSW（cosine）索引はゼロベクトルを索引化しない。決定1は `search()`/`searchMany()` 側で部分索引 + `UNION ALL` を足して満たす（Issue #956、ADR 0343）

⛔ 上の本文・前の3つの追記は1バイトも書き換えていない。同じ形で追記する。

### 原因

pgvector の cosine 距離用 HNSW 索引は、norm が0のベクトル（ゼロベクトル）をそもそも
索引へ追加しない。**【受、pgvector README】**「Troubleshooting」節・「Why are there
less results for a query after adding an HNSW index?」の直下: *"Also, note that
`NULL` vectors are not indexed (as well as zero vectors for cosine distance)."*
（<https://github.com/pgvector/pgvector/blob/master/README.md#hnsw>）。**【現物、
pgvector 0.8.0 のソース】** `src/hnswutils.c` の `HnswFormIndexValue` が
`HnswCheckNorm`（norm が0より大きいかを返す）で確認し、`false` ならその行を索引に
追加しない。⟹ `PostgresVectorStore.search()`/`searchMany()` の `ORDER BY <=> LIMIT`
が HNSW の Index Scan を経由すると、ゼロベクトルの候補は索引に存在しないため
構造的に結果へ出てこない——本 ADR 決定1（「比較不能でも候補として返す」）への違反に
なる。この違反は統計の新旧・テーブルの大小に関係なく、HNSW Index Scan が選ばれれば
常に起きる（`enable_seqscan`/`enable_bitmapscan` を切って強制した場合・自然に
HNSW が選ばれた場合のどちらでも、`hnsw.iterative_scan` の3モード
（`off`/`relaxed_order`/`strict_order`）いずれでも同じ）。

CI が使う `pgvector/pgvector:pg17` イメージは pgvector 0.8.6 を指す（【受、Docker Hub
のタグ】2026-09-27時点）。上の実測は手元の 0.8.0（Debian パッケージ）に基づく——
コンパイラ（`gcc`/`make`）を用意できない環境だったため、0.8.6 を手元でビルドしての
再確認はしていない。

### 直したこと

`packages/postgres/src/vector-store.ts` の `search()`/`searchMany()` を、
「`vector_norm(embedding) > 0` の候補（今日と同じ HNSW 経由）」と
「`vector_norm(embedding) = 0` の候補（新設した部分索引経由）」の2枝を
`UNION ALL` で合わせ、外側で3段 tie-break（距離→`recorded_at` DESC→`memory_id`）を
掛け直して `LIMIT` を再適用する1本の SQL 文に変えた。ゼロ枝は
`packages/postgres/src/vector-space.ts` の `registerEmbeddingSpace()` が
`CREATE INDEX IF NOT EXISTS ... WHERE vector_norm(embedding) = 0` で作る部分索引を
使う——テーブル全体の行数に関係なく（通常0件の）ゼロベクトル行だけを読む。往復数は
増えていない（`UNION ALL`・再ソートは1本の SQL 文の中に収めた。`searchMany()` の
往復数がアンカー数に依存しないという Issue #377 の契約も実測で確認済み）。詳細・
EXPLAIN・往復数・索引構築時間の実測は [ADR 0343](./0343-vector-store-search-returns-zero-norm-candidates.md)。

### 引き受けた負債・migration の扱い

既存の埋め込みテーブルへの部分索引の追加は、素の `CREATE INDEX`（`CONCURRENTLY` 無し）
のため `ACCESS EXCLUSIVE` ロックで対象テーブルの読み書きを止める——実測した構築時間は
100,000行で約40ms、1,000,000行で約270ms（[ADR 0343](./0343-vector-store-search-returns-zero-norm-candidates.md)
「実測」節）。`memory_embeddings_<space>` テーブルと HNSW 索引自体が最初から
`packages/postgres/migrations/*.sql` に一度も現れたことが無く（`<space>` は動的な値で
migration 作成時点では列挙できないため）、`registerEmbeddingSpace`（プロセス起動の
たびに呼ばれる、べき等な `CREATE ... IF NOT EXISTS`）だけが作ってきた——新しい部分
索引もこの既存の経路に乗せてあり、専用の `migrations/*.sql` は書いていない。既存の
空間にこの部分索引が実際に作られるのは、次回 `registerEmbeddingSpace` が呼ばれたとき
（通常はプロセスの再起動時）である。

### 確かめていないこと

- pgvector 0.8.6（CI が実際に使う版）での動作再確認。
- `halfvec`/`sparsevec`、内積・L2距離での同じ構造的欠落の有無。
- 100万行を大きく超える規模での部分索引の構築時間、同時実行下でのレイテンシ増分。
- schema-namespace（ADR 0057）を実際に指定した状態での、`registerEmbeddingSpace` の
  新しい `CREATE INDEX` の実機での動作。

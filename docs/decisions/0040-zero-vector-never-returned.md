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

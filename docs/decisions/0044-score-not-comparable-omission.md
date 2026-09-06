# ADR 0044: 段2の閾値比較を網羅的な三分割にし、`score_not_comparable` を `omitted` に出す

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-07

**⚠ 各主張の出所を分ける。**「私が実行して確かめた」と「受け取った前提」を混ぜない。

---

## 文脈

段2（再スコア）は、閾値の判定を**独立した2本の `filter`** で書いていた:

```ts
const passed = scored.filter((c) => c.score.total >= scoreThreshold);
const belowThreshold = scored.filter((c) => c.score.total < scoreThreshold);
```

**この2つは補集合ではない。**どちらかの値が `NaN` だと `>=` も `<` も false になり、
**候補は残らないのに、落ちた記録も残らなかった。**

### 実測（**私が実行した**。本物の PostgreSQL 17.9 + pgvector 0.8.2）

ゼロベクトルの候補1件＋正常な候補2件で `recall()` を呼び、`omitted` を全部出した:

| `scoreThreshold` | 返った | `omitted` | `explain.rescore` |
|---|---|---|---|
| 既定（0.1） | 近い | `below_threshold: 1` | `{scored:3, passedThreshold:1}` |
| **0** | 近い, 遠い | **`[]`（空）** | `{scored:3, passedThreshold:2}` |

**⟹ どちらでも `scored − passed − below = 1` が行方不明。**
**そして `scoreThreshold: 0` では `omitted` が空配列になる。**

### 🔴 なぜ「不変条件を書くだけ」では足りないと判断したか

**空配列は不在ではなく、主張である。**呼び出し側が `omitted` を読んで空を見たら、
それは「**取りこぼしはありません**」という答えである。
**⟹ 欄が黙っているのではなく、積極的に誤った答えを返していた。**

**「`explain.stages.rescore` の `scored` と `passedThreshold` から算術で復元できる」は
救いにならない**——`scored = passed + below` が不変条件だという記述がどこにも無いので、
**誰も知らない算術は、在っても読まれない。**
（この判断はマネージャーが下した。私が出した「不変条件を書くだけ」という軽い案は却下された。）

### 漏れる集合を数えた（**私が実行した**）

`scoreThreshold = 0.1` に対して `total` を振ると:

| `total` | `>= t` | `< t` |  |
|---|---|---|---|
| **`NaN`** | false | false | **両方漏れる** |
| `-0` / `0` / `-Infinity` | false | true | 漏れない |
| `+Infinity` / 閾値ちょうど | true | false | 漏れない |

**閾値側が `NaN` なら全候補が漏れる**が、**zod が `scoreThreshold: NaN` を弾く**（実測）。
`vector` に `NaN` を混ぜる経路も zod が弾く（実測）。
**⟹ 漏れる集合は `{total が NaN}` だけである。**

### `total` が `NaN` になる経路（**私が実行して確かめた**）

| 経路 | 到達性 |
|---|---|
| `similarity = NaN`（**ゼロベクトル**。[ADR 0040](./0040-zero-vector-never-returned.md)） | **到達する。実用的な経路はこれだけ** |
| `strength = NaN` | `PostgresMemoryStore.createMemory` の INSERT が失敗する ⟹ store 経由では到達しない |
| `halfLifeHours = NaN` | `MemorySchema` の `z.number().positive()` が弾く（実測）。DB に CHECK は無いが store 経由の到達性は**測っていない** |
| `halfLifeHours = 0` | **NaN になるのは経過時間がちょうど 0 のときだけ**（実測: `+1ms` なら 0、`-1ms` なら `+Infinity`）⟹ 実時計では発火しない。**固定時計のテスト環境では作れる**ので、`packages/core` の歯はこの経路を使う |

---

## 決定

1. **段2の閾値判定を、網羅的な三分割にする**（`partitionByThreshold`、`recall-runtime.ts`）。
   1件につき1回だけ分岐し、`passed` / `belowThreshold` / `notComparable` のどれか1つに入れる。
   **⟹ `passed + belowThreshold + notComparable === scored` が構造的に成り立つ。**
2. **`Omission` に `score_not_comparable` を足す。件数を持つ。**
   [ADR 0026](./0026-ann-unreached-omission.md) の `ann_unreached` が件数を持たないのは
   「原理的に数えられない」からだが、**こちらは段2が触った候補の数え上げなので本当に数えられる。**
3. **🔴 `countKind` をリテラルで書かない。**この repo が一度破れたのはそこである
   ——`count(*) OVER ()` が `hnsw.ef_search` 依存の値を返すようになっても、名乗りは
   `'exact'` のままだった（[ADR 0011](./0011-no-window-count-in-ann-stage.md)）。
   **名乗りは、正確さを知っている場所から引き継ぐ:**

   ```ts
   const partitionIsExhaustive =
     passed.length + belowThreshold.length + notComparable.length === scored.length;
   const rescoreCountKind: CountKind = partitionIsExhaustive ? "exact" : "unknown";
   ```

   **⟹ 三分割が壊れたら、名乗りは `'exact'` から `'unknown'` へ落ちる。嘘にはならない。**
   この `rescoreCountKind` は `below_threshold` / `over_limit` / `score_not_comparable` の
   **3つとも**に使う（どれも同じ三分割の数え上げだから）。以前は3つとも `'exact'` のリテラルだった。
4. **`explain.stages.rescore.detail` に `notComparable` を出す。**trace の側でも辻褄が合うようにする。
5. **不変条件を `docs/recall.md` §2 段2 に書く。⚠ 直した*後*に書く。**
   直す前は `scored = passed + below` が偽だったので、書けば守れない約束を1つ作ることになる。
6. **⚠ `recall()` のスコアと閾値の値には触らない。**この ADR は分類を足すだけである。

---

## 「足した欄を書き込む経路」を1つずつ数えた（ADR 0024 の義務）

**書き込む経路（`omitted.push`）は `recall-runtime.ts` に 13箇所**あり、
**そのうち `score_not_comparable` を書くのは1箇所だけ**である（段2の三分割）。
**⚠ 他の12箇所がこの欄を書かないのは正しい**——別の段・別の理由の omission であり、
この欄は段2の閾値比較に固有である。

**読む側（`kind` を列挙している箇所）は1つだけだった**——
`examples/chat/src/compare.ts` の網羅 switch。
**⭐ そこは型検査が見つけた**（`Type 'ScoreNotComparableOmission' is not assignable to type 'never'`）。
残りの消費側（`format.ts` / `backfill.ts` / `retrieval-quality.ts` / `cli.ts`）は
`kind` を列挙せず総称的に扱っているので、変更が要らないことも確かめた。

**⚠ 併せて、名乗りが実測より強い箇所を1つ直した**——
`packages/core/src/__tests__/recall.test.ts` の `describe("OmissionSchema — 7つの kind すべて")`。
`ann_unreached`（ADR 0026）が入った時点で 8 になっていたのに直っておらず、本 ADR で 9 になる。

---

## 検討して採らなかった案

- **不変条件を書くだけで済ませる**（`omitted` に種類を足さない）。**却下。**
  空配列は「取りこぼしは無い」という主張であり、**誰も知らない算術で救えない。**
- **`NaN` を段2の手前で弾く**（`similarity` が `NaN` の候補を候補生成の時点で落とす）。**却下。**
  落とすこと自体は同じで、**落ちた理由が `omitted` に出ない問題は変わらない。**
  そして [ADR 0040](./0040-zero-vector-never-returned.md) は「入口でゼロベクトルを弾く」を
  **入力検証全体の設計に属する**として意図的に却下している。そちらへ倒さない。
- **`below_threshold` に相乗りさせる。** 却下。**次の一手が違う**——
  `below_threshold` は「閾値を緩めて聞き直す」、こちらは「その記憶の埋め込みを作り直す」である。
  閾値を緩めても直らない。ADR 0008 の判定基準（区別があると次の一手が変わるか）に照らして分ける。
- **`countKind: 'exact'` をリテラルで書く**（既存の3箇所と揃える）。却下（決定3）。

## 引き受ける負債・覆えていない範囲

- **`budget_dropped` の `countKind` は依然リテラルの `'exact'` である。**段4は三分割の外なので
  本 ADR の `rescoreCountKind` を使えない。**同じ形の見直しをしていない。**
- **`halfLifeHours = NaN` が store 経由で書けるかを測っていない**（`strength = NaN` は
  INSERT が失敗したので同様と推測しているが、**確かめていない**）。
- **`halfLifeHours = 0` かつ減衰の起点が未来だと `decay = +Infinity` になり、
  `total = +Infinity` で閾値を通って1位に来る。**本 ADR の対象外
  （`decay` を丸めないのは [ADR 0036](./0036-clamp-freshness-at-one.md) の意図的な決定であり、
  起点が未来にならないという前提の上に立っている）。**塞いでいない。**
- **`packages/core` の歯は `NaN` を2通りの経路で作っている。**
  `halfLifeHours = 0`（経過時間ちょうど0）と、**ゼロベクトル**である。
  後者は当初 `FakeVectorStore` が `1` を返していたため core では作れなかったが、
  PR #45 が [ADR 0040](./0040-zero-vector-never-returned.md) の契約を `FakeVectorStore` にも
  適用したので、**本 PR を #45 の上に rebase した時点で作れるようになった。**
  **⟹ 「Fake が NaN を作り、三分割がそれを `omitted` に出す」という端から端までの経路を、
  core で一度だけ通しで測っている。**
  **⚠ 両方を残す**——NaN の作られ方が2通りあることを、歯の側でも示しておく。

## これが覆るとしたら

- **ゼロベクトルを入口で弾くと決めたとき**（ADR 0040 が却下した案）。そのとき
  `score_not_comparable` が発火する経路は無くなるが、**欄そのものは残す価値がある**
  ——三分割の網羅性は閾値や入力に依らない性質だからである。
- **スコアリング戦略を差し替えて `total` が `NaN` になりうる別の経路が入ったとき。**

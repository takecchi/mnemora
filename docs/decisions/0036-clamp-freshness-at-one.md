# ADR 0036: `freshness` を 1 で頭打ちにする — 「まだ起きていない出来事は、最も古びていない」

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-06

**⚠ 各主張の出所を分ける。**「私が実行して確かめた」と「読んだだけ」を混ぜない
（[AGENTS.md](../../AGENTS.md)）。

---

## 文脈

**これはスコアの調整ではない。式が、これまで一度も来なかった入力に出会ったときの
振る舞いが誰にも決められていなかった、という穴を塞ぐものである。**

[docs/recall.md](../recall.md) §7 のスコアは
`similarity × decay × tagMatch × freshness × strength`。
`freshness` は [ADR 0010](./0010-decay-parameters.md) の減衰式を
`occurredAt ?? recordedAt` を起点に呼んで求める:

```
freshness = 0.5 ** ((now - (occurredAt ?? recordedAt)) / halfLifeHours)
```

**`occurredAt` は [docs/memory-model.md](../memory-model.md) §3 の定義上、ふつうに未来になる**
——「その出来事・事実がいつのものか」であり、「来月、京都へ出張する」の `occurredAt` は来月である。

**⟹ 経過時間が負のとき、この式は 1 を超える。上限は無い。**

### 実測（**私が実行した**。`defaultScoringStrategy` を直接呼んだ。半減期は既定の720時間）

| `occurredAt` | `freshness` | `total`（`similarity` 0.4 のとき） |
|---|---|---|
| `null`（いまのリポジトリの全件） | 1.00 | 0.400 |
| 先月（−30日） | 0.500 | 0.200 |
| 去年（−365日） | 0.000218 | 0.0000870 |
| **来月（+30日）** | **2.00** | **0.800** |
| **来年（+365日）** | **4,597** | **1,839** |
| **10年後（+3650日）** | **4.2×10³⁶** | **1.7×10³⁶** |

**⟹ 上限が無いと、未来の日付を1つ持つ記憶が、そのテナントの想起を永久に支配する。**
`scoreThreshold`（既定 0.1）も `over_limit` も、この桁の前では意味を失う。

### なぜこれが「誰も決めていない」と言えるか（**私が実行して確かめた**）

- [ADR 0010](./0010-decay-parameters.md) は式と `floorAt` の導出を固定しているが、
  **起点が未来になる場合に一言も触れていない。**同 ADR の `strengthAt` の説明は
  `lastReinforcedAt ?? recordedAt`（＝未来になりえない側）だけを対象にしている。
- [docs/recall.md](../recall.md) §7 にも [docs/memory-model.md](../memory-model.md) §3 にも、
  `freshness` の値域についての記述が無い。
- `packages/core/src/strategies/{decay,scoring}.ts` にも、上限・clamp の類は無い。

**⟹ 「未来の出来事の鮮度をどう扱うか」は、意図的な設計ではなく、
一度も入力が来なかったために決まらずに残っていた。**

### なぜいま塞ぐか

**`occurredAt` を埋める作業（台帳の1番）の準備ではない。埋める前に要るものである。**
`ObserveInput.occurredAt` という口は既に全入力に在り、`observe()` は素通しする
（`runtime.ts`）。**呼び出し側は今日でも未来の時刻を渡せる。**
「取り込み時刻だから過去のはず」は呼び出し側の作法であって、機構の保証ではない。

---

## 決定

1. **`freshness` の上限を 1 とする**（`MAX_FRESHNESS`、`packages/core/src/strategies/scoring.ts`）。
2. **🔴 これは「まだ起きていない出来事は、最も古びていない」と決めたものである。**
   式の副作用として 1 になるのではなく、**選んだ結果として 1 になる。**
   `freshness` は**古び**を測る項なので、まだ起きていない出来事は古びようがない。
   **⚠ 「未来の出来事を優遇する」決定ではない**——**「たったいま起きたこと」と同じ扱いにするだけ**である。
3. **上限を掛けるのは `freshness` だけ。`decay` には掛けない。**
   `decay` の起点は `lastReinforcedAt ?? recordedAt` で、どちらも「mnemora が知った時刻」系である。
4. **`defaultDecayStrategy` そのものは変えない。戦略（`defaultScoringStrategy`）の側で頭打ちにする。**
   減衰関数に clamp を入れると、[ADR 0010](./0010-decay-parameters.md) が明示的に価値を置いている
   「`floorAt` が `strengthAt(now) = threshold` の解析解として導かれ、両者が同じ式から機械的に
   一貫する」という性質が壊れる（clamp した関数の逆関数は解析解にならない）。
5. **`MAX_FRESHNESS` を export する。**呼び出し側が `ScoringStrategy` を差し替えるとき、
   上限の存在と値を読める形にしておく（`ScoringStrategy` は差し替え可能である、と
   `scoring.ts` の doc が明記している）。

---

## この変更は、いまの挙動を1ミリも変えない（**実測**）

**リポジトリ内で `observe()` に `occurredAt` を渡している箇所は0件であり、
`Memory.occurredAt` は全件 `null` である**（[ADR 0033](./0033-what-decided-the-rank-in-the-retrieval-bench.md)
§4・§4.1 で数えた。arm C の75件すべてで `occurred_at IS NULL`）。
**⟹ 上限に当たる行が1つも存在しない。**

**実測（私が実行した。本物の PostgreSQL 17.9 + pgvector 0.8.2）:**

- `compare`（擬似 provider）を本 PR の前後で1回ずつ走らせ、出力表を `diff` した:

  ```
  $ diff /tmp/cmp-before.txt /tmp/cmp-after.txt
  （差分なし）
  ```

  **12行すべて（会話2〜642ターン）で `mnemora chars` も `mnemora tokens` も同一。**

- `retrieval` を本 PR の後に1回走らせ、[ADR 0033](./0033-what-decided-the-rank-in-the-retrieval-bench.md) §5.1 の実測と並べた:

  | arm | LLM | 埋め込み | ADR 0033 §5.1 | 本 PR 後 |
  |---|---|---|---|---|
  | A | 擬似 | 擬似 | 0.018 / 0.000 / 0.021 | **0.018 / 0.000 / 0.021** |
  | B | 擬似 | 本物 | 0.714 / 1.000 / 0.667 | **0.714 / 1.000 / 0.667** |
  | C | 本物 | 本物 | 0.750 / 1.000 / 0.708 | 0.743 / 1.000 / 0.700 |

  **arm A・B は擬似 LLM ＝ 決定的なので、MRR は完全に一致した。**
  **⚠ arm C は本物の LLM を使うため実行ごとに揺れる**（同 ADR §2.3。diet の goldRank は
  4 / 5 / 7 / 9 と動く。今回は 5 だった）ので、**一致も不一致も主張しない。**
  **hit@1 は 4/7、外す3件は exercise / diet / travel で、これまでと同じだった。**

**🔴 そして、この変更は `hit@1` を改善しない。**
上限は「未来を優遇しない」ための防波堤であって、想起を良くするものではない。
[ADR 0033](./0033-what-decided-the-rank-in-the-retrieval-bench.md) が測ったとおり、
`travel` probe の失敗は「質問が指す時間の向きを表す場所が無い」ことであり、
**`recall()` は質問文を解釈しない**（`occurredAfter` は呼び出し側から受け取るだけ）。
**「時刻まわりを触ったのに効かない」と読まないこと。**

---

## 検討して採らなかった案

- **`defaultDecayStrategy.strengthAt` の側で clamp する。** 却下（決定4）。
  `floorAt` との解析的な一貫性が壊れる。
- **未来の `occurredAt` を書き込ませない**（抽出・`observe()` の入口で弾く）。 却下。
  **`occurredAt` の定義（「その出来事・事実がいつのものか」）は未来を含む。**
  定義に合う値を入口で捨てるのは、欄の意味を黙って狭めることになる。
  **上限はスコアの問題であって、データの問題ではない。**
- **`freshness` を「`now` からの距離」の対称関数にする**（未来も過去も等しく古びる）。 却下。
  「来月の出張」と「先月の出張」を同じ鮮度にすることになり、**予定と記録が区別できなくなる。**
  時間的妥当性（`valid_from` / `valid_until`）は Phase 2 の別概念であり、そちらに属する問いである。
- **上限を 1 以外にする**（例: 未来は 1.2 まで許して少し優遇する）。 却下。
  **それは「調整」であり、根拠が無い。**1 は「古びていない」という意味を持つ唯一の値である。

---

## 引き受ける負債・覆えていない範囲

- **`decay` の起点（`lastReinforcedAt ?? recordedAt`）が未来にならないことは、型で保証していない。**
  `NewMemory.lastReinforcedAt` は呼び出し側・adapter が渡せる。いまは
  `buildNewMemoryFromCandidate` が `null` を書き、強化は `clock.now()` で行うため未来にならないが、
  **その保証は規律であって機構ではない。塞いでいない。**
- **`similarity` にも上限が無い。** `1 - distance` であり、コサイン距離は最大 2 まで出るので
  `similarity` は **−1 まで負になりうる**（[ADR 0033](./0033-what-decided-the-rank-in-the-retrieval-bench.md)
  の `formatScoreValue` の doc に同じ観察がある）。**負のスコアが何を意味するかは決まっていない。
  本 ADR の対象外であり、塞いでいない。**
- **`tagMatch` は `1 + 0.1 × 一致数` で上限が無い。** クエリタグの本数に比例して伸びる。
  本 ADR の対象外。

## これが覆るとしたら

- **「未来の出来事は、いま起きたことより*強く*引かれるべきだ」とオーナーが決めたとき。**
  そのときは上限ではなく、**質問側の時間の向きを表す項**の議論になる
  （[ADR 0033](./0033-what-decided-the-rank-in-the-retrieval-bench.md) §4）。
- **Phase 2 で `valid_from` / `valid_until` が入ったとき。**「いつからいつまで真か」が別の列で
  表せるようになると、`occurredAt` の未来値の意味そのものが変わりうる。

---

## その後（2026-09-26）—— 下限側（古すぎる `occurredAt`）も、厳密に0になる（Issue #939）

⛔ 上の本文は1バイトも書き換えていない。本 ADR の決定1〜5が扱ったのは上限側（未来の
`occurredAt`）だけであり、下限側については一言も無い——その前提ごと残す。

### 何が見つかったか

[Issue #939](https://github.com/takecchi/mnemora/issues/939) が、`freshness` の式
（`Math.min(MAX_FRESHNESS, 0.5 ** (elapsed / halfLifeHours))`）の下限側を実測した。
`elapsed / halfLifeHours` が十分大きいと、`Math.pow(0.5, x)` は IEEE 754 倍精度が表現できる
最小の非正規化数（`2^-1074`）を割り込み、丸めではなく**厳密に `0`** になる。境界は
この作業を行った器（Node.js v22.23.3）で `x = 1075`（`Math.pow(0.5, 1074) ===
Number.MIN_VALUE`、`Math.pow(0.5, 1075) === 0`）と実測した——`Math.pow` の丸めは
V8 依存であり、他のエンジン・バージョンでは1前後ずれうる。既定の半減期
（`DEFAULT_HALF_LIFE_HOURS` = 720時間）では、これは約88.3年前の `occurredAt` に相当する。

`freshness` が0まで潰れると `total`（`affinity × decay × tagMatch × freshness × strength`）
も0になり、`similarity` の差が順位から消える——同点になった候補の順位は、段2
（`compareScoredCandidates`。`total` 降順→実効時刻降順→`memory.id` 昇順）または連想枠
（`rankKey = 類似度 × total` の安定ソート、同点は過取得した順序を保つ）のタイブレークだけで決まる。

さらに実測したところ、**`decay`/`strength` が1未満だと、積のアンダーフローで
`total` が `freshness` 自身より手前で0になりうる**——`strength: 0.1` のとき、
`freshness` がまだ非正規化数（`5e-324`、非0）の時点で `total` は既に `0` だった。
⟹ 上の境界（約1075倍・約88.3年）は「そこに達すれば必ず0になる」という
**十分条件**であり、「そこまでは0にならない」ことの保証ではない。

これは本 ADR の決定1〜5とは独立に、`0.5 ** x` という式そのものが最初から持っていた
性質である——本 ADR が塞いだのは「経過が負（未来）のときに上限が無い」ことだけであり、
「経過が非常に大きい（過去）ときに下限がIEEE754の表現域で切れる」ことには触れていない。

### 決めたこと: 案(d)「そこまで古い記憶は区別しない」を契約として書く

式も既定の振る舞いも変えていない——`packages/core/src/strategies/{decay,scoring}.ts` の
diff はコメントのみである。上で実測した境界・タイブレークの規則・どの呼び出しで
表に出るか（`scoreThreshold <= 0`・連想枠・`mandatory_companion`）を、
`docs/recall.md` §7.2 と `computeFreshness`/`decayFactor` の doc コメントに契約として
明記した。

### 検討して採らなかった案

- **(a) 時間項に下限を置く。** 却下。`freshness`/`decay` の**値そのもの**を変えることになり、
  既存の呼び出しの `total` が変わる。どこに下限を置くかにも、決定4が上限1について
  持っていたような根拠（「1 は古びていないという意味を持つ唯一の値」）が無い——
  下限側には対応する意味の値が無く、選んだ数がただの調整になる。
- **(b) 段2のタイブレークに `affinity`（`similarity`/`lexicalMatch`）を入れる。** 却下。
  連想枠（段3.5）では `score.total` に `similarity` が入っていない——アンカーとの
  類似度は `rankKey`（ローカル変数）にだけ載り、`score.similarity` はクエリとの類似度を
  渡さないため中立の1に退化する（`affinity` の定義、`scoring.ts` 冒頭の doc）。
  ⟹ 段2の `compareScoredCandidates` だけを直しても連想枠の `rankKey` 比較には
  そもそも `affinity` を足す先が無く、2つの並び方針が揃わない。段2だけに限っても、
  「`total` が同点なら関連度も同じ」という `ScoreBreakdown` の暗黙の前提を崩すことになる。
- **(c) 比較を対数で行う。** 却下。0への丸め込み自体は避けられるが、`ScoreBreakdown.total`
  という公開値の意味・計算式（`affinity × decay × tagMatch × freshness × strength` の積）を
  変えることになる——対数和を返すか、比較専用の別の値を新設するかのどちらでも、
  現行の `total` の契約（「段2で使った最終スコア」、`docs/recall.md` §7）を壊す。

### 採った理由

表に出る経路が実測で限られていた——既定の `scoreThreshold`（0.1）では
`below_threshold` に落ちて返らず、観測できるのは `scoreThreshold <= 0` を渡した呼び出し・
連想枠（段3.5、閾値ゲートが無い）・`mandatory_companion`（段3、スコアに関係なく
候補集合へ追加される）の3経路だけである。式・公開される `ScoreBreakdown` の値を
一切変えずに契約として書けるという小ささが、(a)〜(c) のどれかを選ぶより優る。

### この追記が確かめていないこと

- **境界の整数値（`x = 1075`）は、この追記を書いた器の Node.js v22.23.3・V8 の
  `Math.pow` の丸めに依存する。** 他の JS エンジン・他のバージョンでは確かめていない。
- [ADR 0040](./0040-zero-vector-never-returned.md) の最後の追記が「`rankKey`
  （`similarity × total`）について、掛け算そのものがオーバーフロー/アンダーフローして
  `NaN`/`Infinity` になる経路は見ていない」と書いている——本追記が確かめたのは
  「`freshness` 自身が式の性質として0になる」経路であり、`hit.similarity × score.total`
  という掛け算が `score.total` が非正規化数域まで縮んだ状態でさらにどう丸まるか
  （0になるか、別の非正規化数になるか）の全域は網羅していない。
- 本物の Postgres + pgvector に対する end-to-end の再現はしていない。`defaultScoringStrategy`
  / `compareScoredCandidates` を直接呼ぶ形（`packages/core` の純関数レベル）での
  確認に留めている。
- `strength`/`decay` が1未満のときに `total` が `freshness` より手前で0になる境界を、
  `strength`/`decay` の値ごとに一般化した式では出していない——実測した数点（`strength:
  0.1` のときの1点）からの帰納であり、`decay` 側を1未満にした場合の実測はしていない。

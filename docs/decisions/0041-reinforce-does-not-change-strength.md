# ADR 0041: `reinforce` は `strength` を動かさない — 「強化」の意味を確定させる

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-06

**⚠ 各主張の出所を分ける。**「私が実行して確かめた」と「受け取った前提」を混ぜない。

---

## 文脈

**doc が、実装より強く名乗っていた。**

2箇所が **`reinforce` は `strength` を更新する**と書いていた（逐語）:

- [docs/memory-model.md](../memory-model.md) §6:
  「**挿入が実際に起きたときだけ** `memories.last_reinforced_at` / `memories.strength` **を更新する。**」
- `packages/core/src/interfaces/memory-store.ts` の `MemoryStore` 契約コメント:
  「`reinforce` は挿入が実際に起きたときだけ `last_reinforced_at` / `strength` を更新し、
  `decay_floor_at` を再計算する。」

### 数えたこと（**私が実行した**。3つの実装をすべて読んだ）

|  | `last_reinforced_at` | `decay_floor_at` | **`strength`** |
|---|---|---|---|
| `PostgresMemoryStore.reinforce` | 更新する | 再計算する | **更新しない** |
| `InMemoryMemoryStore.reinforce`（testkit） | 更新する | 再計算する | **更新しない** |
| `FakeMemoryStore.reinforce`（core のテスト用） | 更新する | 再計算する | **更新しない** |

**そして適合テストの題が、既に実装の側に立っていた**——
「reinforce は last_reinforced_at と decay_floor_at を更新する」。

**⟹ 実装3つ + 適合テスト1本 対 doc 2箇所。**

### 🔴 そして「いくつ増やすか」は、どこにも書かれていない（**私が実行して確かめた**）

- [ADR 0010](./0010-decay-parameters.md) は減衰式と `floorAt` の導出を固定するが、
  **強化時の増分にも `strength` の上限にも触れていない。**
  むしろ「`strength` を低く初期化した `imported` な Memory」を**正常系として挙げている**
  ——つまり `strength` は**初期値として設定される欄**として扱われている。
- `Memory.strength` の zod は `z.number()`（制約なし）、DB は `real NOT NULL DEFAULT 1.0`（CHECK なし）。
- **この repo は、値を選んだときには選んだと書く**——`MAX_FRESHNESS`（[ADR 0036](./0036-clamp-freshness-at-one.md)）/
  `DEFAULT_SCORE_THRESHOLD = 0.1`（「強い根拠がある値ではなく」と自認つき）/
  `DEFAULT_DECAY_THRESHOLD = 0.05`（ADR 0010）/ `DEFAULT_HALF_LIFE_HOURS = 720` /
  `DEFAULT_RECALL_LIMIT = 10` / `DEFAULT_OVER_FETCH_FACTOR = 4` の6箇所で確認した。
  **⟹ `strength` の増分にだけ何も無いのは、探し方の問題ではない。空白である。**

---

## 決定

1. **「強化」の意味を、`last_reinforced_at` の更新と `decay_floor_at` の再計算に確定させる。**
2. **🔴 `reinforce` は `strength` を動かさない。**`strength` は**初期値として設定できる欄**であり、
   強化では変化しない。ADR 0010 の「`strength` を低く初期化した `imported` な Memory」は生きる。
3. **doc 2箇所を実装に合わせて直す**（`memory-model.md` §6 とライフサイクル表、`MemoryStore` の契約コメント）。
4. **適合テストで固定する。**`strength` を **0.42**（既定の 1 でも 0 でもない値）で初期化し、
   `reinforce` 後も変わらないことを、返り値と読み直しの両方で見る。

**⚠ 実装は1行も変えていない。**変えたのは doc と、doc が言うようになったことを測る歯である。

---

## 検討して採らなかった案

- **🔴 実装を doc に合わせる（`reinforce` で `strength` を上げる）。**
  **却下。**上げるなら**増分の式を新たに決める**ことになり、それは
  **誰も決めていない値を決めること**であり、しかも**スコアに直接効く**
  （`total = similarity × decay × tagMatch × freshness × strength`）。
  **⟹ 北極星の「使われない記憶が、静かに遠ざかる」は、この案を採らなくても成立する**
  ——`last_reinforced_at` が動けば減衰の起点が動き、使われた記憶は遠ざかりにくくなる。
  **目的が満たせるなら、決めなくてよいものを決めない側を採った。**

  **⚠ この却下が覆る条件を書いておく: 増分の式を決める根拠ができたとき。**
  そのとき次の人が見る必要があるのは、
  (a) 増分（加算か乗算か、係数はいくつか）、(b) **上限**（無いと `freshness` と同じ穴が開く。
  ADR 0036 が塞いだのと同じ形）、(c) `decay_floor_at` の再計算がその値を使うこと、の3つである。

- **`strength` に値域の制約（zod / DB の CHECK）を足す。** 却下（今回は）。
  **本 ADR は「強化が `strength` を動かすか」だけを決める。**値域は
  `similarity`（−1 まで負になりうる）・`tagMatch`（上限なし）と同じ族の問いであり、
  **スコア式全体の値域という別の判断に属する。**

## 引き受ける負債・覆えていない範囲

- **`strength` の値域は依然として制約が無い**（`z.number()` / CHECK なし）。塞いでいない。
- **`strength` を初期値以外で書き換える経路は、いま存在しない。**
  `buildNewMemoryFromCandidate` は常に `1` を書き、`reinforce` は動かさない。
  **⟹ `strength` が 1 以外になるのは、`MemoryStore.createMemory` を直接呼んだときだけである。**
  `Runtime`（`observe` / `tick` / `recall` / `reextract`）からは 1 以外にならない。
- **北極星の「使われない記憶が、静かに遠ざかる」が実際に効いているかは、測っていない。**
  `last_reinforced_at` が動けば `decay` の起点が動く、というのは式からの帰結であり、
  **ベンチで観測したものではない。**

## これが覆るとしたら

- **オーナーが「使った記憶は強くなるべきだ」と決めたとき。**上の「却下が覆る条件」の3点が要る。
- **Phase 2 で忘却の実処理（`decay_floor_at` を読み取りに使う）が入ったとき。**
  `strength` が動かないことは `decay_floor_at` の単調性の前提でもある
  （[docs/memory-model.md](../memory-model.md) §7）。

# ADR 0043: 一対一の対向関係が破れて候補が単位から漏れたら、`omitted` に出す（黙らない）

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-07

**⚠ 各主張の出所を分ける。**「私が実行して確かめた」と「受け取った前提」を混ぜない。

---

## 🔴 まず、この ADR が直すものは「いま壊れているもの」ではない

**Phase 1 では、この経路は一度も通らない。**

`Runtime`（`observe` / `tick` / `recall` / `reextract`）は
**`status = 'contested'` も `contestedWithId` も書かない。**
⟹ 一対一の対向関係が破れた状態を、**この系は自分では作れない。**

**⟹ これは `contested` を作る主体が入る Phase 2 のための契約である。**

### 数えたこと（**私が実行して確かめた**）

`contestedWithId` を書ける経路を、アプリのコード・マイグレーション SQL・**DB 側**まで数えた:

| 経路 | `status='contested'` | **`contestedWithId`** |
|---|---|---|
| `runtime.observe` → `buildNewMemoryFromCandidate` | ✗（書かない＝既定 `active`） | **✗**（`extraction.ts` に出現0件） |
| `runtime.reextract` → 同じ関数 ＋ `updateStatusWithEvent('superseded')` | ✗ | **✗** |
| `runtime.tick`（embed）→ `setEmbeddingStatus` | ✗ | **✗** |
| `runtime.observe({kind:'memory_usage'})` → `reinforce` | ✗ | **✗** |
| `MemoryStore.updateStatus` / `updateStatusWithEvent` | ⭕ | **✗**（`SET` 句が `status` と `superseded_by_id` しか書かない） |
| **`MemoryStore.createMemory` / `createMemoryWithOutbox`** | ⭕ | **⭕（唯一）** |
| **DB の trigger / rule / 列 default** | — | **✗**（`memories` の非内部 trigger は **0件**、`contested_with_id` の default は**無し**） |

**⚠ 最後の行はアプリのコードをいくら読んでも出てこない。DB に直接聞いて確かめた。**

**実測でも裏を取った**——`Runtime` だけで矛盾しそうな発話を `observe` → `tick` → `reextract` まで
通し、DB を数えたところ **`contested` は0件、`contested_with_id` が入った行も0件**だった。

**⟹ 本番コードで `status: 'contested'` を*書いて*いる箇所は0件であり、
段3（mandatory companion retrieval）は `Runtime` 経由では一度も発火しない。**
機構と歯は在るが、その歯はすべて `memoryStore.createMemory` を直接呼んで `contested` を作っている。

---

## 何が問題か

段3は候補を「単位（Unit）」にまとめる。**その繰り返しは `contestedWithId` が一対一であることを
前提にしている**（`docs/memory-model.md` §5 逐語:
「一対一の対向関係に限って Phase 1 で成立させるための補助列」）。

**一対一が破れていると、候補がどの単位にも入らないまま落ちる。**
実測（鎖 A→B→C を `createMemory` で直接作った）:

```
[budget 無し] 返った: A,B   omitted=[not_indexed:pending:1]
```

**⟹ B の対向である C は、返り値にも `omitted` にも現れず、黙って消える。**
（`budget` を渡した場合だけは [ADR 0045](./0045-budget-dropped-count-kind.md) の
`budget_dropped.countKind` が `'unknown'` へ落ちて痕跡が残るが、**`budget` 無しでは何も残らない。**）

---

## 決定

1. **`Omission` に `unit_assembly_dropped` を足す。**
   単位が候補を覆えていないとき、その差を `omitted` に出す。
2. **🔴 この欄は「黙らせない」ためだけに在る。**
   **候補が消えたこと自体が良いか悪いかは、ここでは決めない。**
   決めるのは、`contested` を作る主体が入るときの判断である。
3. **`countKind` は `'lower_bound'`。**覆えていない数は数えられるが、
   **別の候補が二重に単位へ入っていると、その分だけ消失が隠れる。**
   ⟹「少なくともこの件数は消えた」までしか言えない。
   `docs/recall.md` §4 が `'lower_bound'` に与えている意味（下限だけは分かる）にそのまま当たる。
4. **覆った数が候補数を*超える*場合（二重計上）には出さない。**
   候補は*消えて*いないので「落ちた」と名乗るのは嘘になる。
   その場合は `unitsCountKind` が `'unknown'` へ落ちる（ADR 0045）。
5. **`count` は `z.number().int().positive()`。**他の件数つき omission は `nonnegative` だが、
   **0件の消失を報告することはこの欄の意味と矛盾する。**

### ⚠ ADR 0045 で一度却下した案を、ここで採っている

[ADR 0045](./0045-budget-dropped-count-kind.md) は「単位から漏れた候補を `omitted` に出す」を
**「漏れること自体の振る舞いが決まっていないので、決まる前に分類だけ足さない」**として却下した。

**本 ADR はそれを覆す。**理由は**マネージャーの判断**である——
**「黙らない」ことと「どう振る舞うべきか」は別の問いであり、前者は後者を待たずに決められる。**
分類は「候補が段の内部で消えた」という**機構の事実**を述べるだけで、
`contested` の扱いについて何も決めていない。

---

## なぜ「`Runtime` からは `contested` が生まれない」ことを歯にしないのか

**それを歯にすると「`contested` を作ってはいけない」を意味してしまう。**
`docs/memory-model.md` は関係グラフ本体を **Phase 2** と書いており、これは
「やらない」と決めた記述ではなく**「やる」と書いてある未実装の宣言**である。

**⟹ その歯は Phase 2 が着地した瞬間に赤くなる。**
次の人は「何かが壊れた」と読み、**正しい実装を戻しにいく。⟹ 改善を禁じる歯になる。**

**見分け（マネージャーの判断）: その前提が変わるのは、事故か、予定か。**
**事故なら歯で固定する。予定なら固定しない。**
本件の到達不能は**予定されたもの**なので固定しない。

---

## 検討して採らなかった案

- **例外を投げる。** 却下。壊れたデータでは想起そのものを止める、という**振る舞いの決め打ち**になる。
  決定2のとおり、ここでは振る舞いを決めない。
- **`explain.stages` にだけ出す。** 却下。
  [ADR 0044](./0044-score-not-comparable-omission.md) が測ったとおり、
  **誰も知らない算術は、在っても読まれない。**`omitted` は「なぜ落ちたか」を読む場所である。
- **`score_not_comparable` に相乗りさせる。** 却下。**次の一手が違う**——
  あちらは「その記憶の埋め込みを作り直す」、こちらは「対向関係を直す」である。
- **`contested_with_id` に相互参照の制約（DB の CHECK / 一意制約）を足す。** 却下（本 ADR では）。
  **入口を塞ぐ話であり、`MemoryStore` が `Runtime` の不変条件を素通しで壊せるという
  より大きな族に属する**（`strength` / `halfLifeHours` の値域と同じ）。別に決める。

## 引き受ける負債・覆えていない範囲

- **一対一を強制する仕組みは、どの層にも無い。**zod は
  `contestedWithId: z.string().min(1).nullable().optional()`、DB は
  `uuid NULL REFERENCES memories(id)` の**外部キーだけ**。相互参照も一意性も見ていない。**塞いでいない。**
- **二重計上と消失が同時に起きて数が相殺すると、この欄は出ない。**
  `countKind: 'lower_bound'` はその可能性を名乗りで認めているが、
  **「出ない」ケースは名乗りようがない。**候補の id 集合を突き合わせれば分かるが、そこまではしていない。
- **段3の繰り返しが候補を漏らすこと自体は直していない。**本 ADR は黙らせないだけである。

## これが覆るとしたら

- **Phase 2 で `contested` を作る主体が入ったとき。**そこで初めてこの欄が本番で発火する。
  **そのときに「漏れたらどうするか」を決めることになる**（本 ADR は決めていない）。
- **一対一が機構で強制されるようになったとき。**この欄は到達不能になり、
  そのときは「到達不能が事故か予定か」を改めて問うことになる。

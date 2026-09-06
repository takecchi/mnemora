# ADR 0045: `budget_dropped` の `countKind` を、単位の網羅性から引き継ぐ

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-07

**⚠ 各主張の出所を分ける。**「私が実行して確かめた」と「受け取った前提」を混ぜない。

---

## まず数えた: `countKind` のリテラルは1箇所ではなかった

**出所: 私が実行した**（`packages/*/src` と `examples/*/src` を検索。テストを除く）。

| 区分 | 箇所数 | 判定 |
|---|---|---|
| **型・schema の `"unknown"`**（`AnnTruncatedOmission` / `AnnUnreachedOmission`、および対応する `z.literal`） | **4** | **決めてある。触らない**（[ADR 0026](./0026-ann-unreached-omission.md) が「件数を持たせない。`countKind` は常に `'unknown'`」と書いている） |
| **`recall-runtime.ts` の実行時 `"unknown"`**（`ann_truncated` / `ann_unreached`） | **2** | 同上。**触らない** |
| **`recall-runtime.ts` の実行時 `"exact"`**（`budget_dropped`） | **1** | **本 ADR の対象** |
| **`PostgresMemoryStore.aggregateScope` の `"exact"`** | **9** | **触らない**（下記） |
| **`InMemoryMemoryStore.aggregateScope` の `"exact"`** | **8** | **触らない**（下記） |

**⟹ 「リテラルで書いている `'exact'`」は 18箇所あり、そのうち本 ADR が直すのは1箇所である。**

### `aggregateScope` の 17箇所を直さない理由

**「その件数を作っている経路は、正確さを知っている場所を持つか」**という問いに対して、
**持っている——ただしそれは*書かれた決定*であって、実行時に確かめられる事実ではない。**

`MemoryStore` の契約コメントが逐語でこう書いている:
「`aggregateScope` の返り値は近似を許すが、`countKind` を必ず伴う（**Phase 1 は常に厳密**）」。
そして [ADR 0024](./0024-remove-exact-counts-option.md) が、近似を選べる唯一の口だった
`RecallQuery.exactCounts` を**実装が無いという理由で削除している。**
**⟹ Phase 1 に近似の経路は存在せず、`'exact'` は嘘になりようがない。**

**⚠ ただし塞いでいない穴として記録する: 将来 `aggregateScope` に近似を入れると、
17箇所のリテラルが一斉に嘘になる。**そのときは「近似したかどうかを知っている場所」が
SQL 側にできるはずなので、そこから引き継ぐ形になる。**いま先回りして形だけ作らない**
——引き継ぐ先が無いのに引き継ぐ形を作ると、名乗れる以上の精度を主張することになる。

（**⚠ `PostgresMemoryStore` は別の委譲が触っているため、本 PR では読むだけにした。**）

---

## 決定: `budget_dropped` は「単位が候補を網羅したか」から名乗りを引き継ぐ

[ADR 0044](./0044-score-not-comparable-omission.md) で段2に入れた規律を、段4へ広げる。

```ts
export function countKindForUnits(units: readonly Unit[], candidateCount: number): CountKind {
  const covered = units.reduce((sum, unit) => sum + unit.members.length, 0);
  return covered === candidateCount ? "exact" : "unknown";
}
```

### 🔴 ここで「正確さを知っている場所」は `slice` ではない

`keptUnits = units.slice(0, cut)` / `droppedUnits = units.slice(cut)` が網羅であることは
**言語の保証**であり、確かめても同語反復にしかならない。

**正確さを決めているのは、その手前の「単位を組む繰り返し」である**——
段3までに集まった候補（`withinLimit` ＋ 同伴取得分）が、**それぞれちょうど1つの単位に入ったか。**
あの繰り返しは `consumed` の集合で重複を避けながら同伴をペアにしており、
**どの候補もどの単位にも入らないまま落ちる余地が構造として在る。**

**⟹ そうなると、その候補は返り値にも `budget_dropped` にも現れずに消える**——
**ADR 0044 が段2で塞いだのと同じ形の穴が、段4で開く。**

### 実測: 到達する（**私が実行した**）

`contested` の鎖 A→B→C を作ると（`contestedWithId` は `docs/memory-model.md` §5 が
**一対一の対向関係**と定めているので、これは**壊れたデータ**である）:

```
[budget 無し] 返った: A,B   omitted=[not_indexed:pending:1]
[budget 有り] 返った: (0件) omitted=[budget_dropped count=2 countKind="unknown", not_indexed:pending:1]
```

**⟹ 候補3件に対して単位が覆うのは2件。名乗りは `'exact'` から `'unknown'` へ落ちた。**
**⟹ この分岐は到達可能である。**（段2の `countKindForPartition` は到達不能で、
前提を歯にすることで測った。段4は**実際に到達する**ので、`recall()` の高さで直接測れる。）

---

## 🔴 ついでに見つけた別の欠陥（**本 ADR では直していない。報告済み**）

上の実測の1行目——**`budget` 無しで A と B が返り、B の対向である C が返っていない。**

`docs/recall.md` §8 は「`contested` の Memory は候補になった時点で**単独では返さない**。
対向する Memory をスコアに関係なく候補集合へ追加する」と定めている。
**⟹ 鎖の形の（＝一対一でない）データでは、この不変条件が黙って破れる。**

**⚠ これは「壊れたデータが来たときに機構がどう振る舞うべきか」という設計の問いであり、
本 ADR の範囲ではない。**マネージャーへ報告し、判断を仰いだ。

**本 ADR がやるのは、その状況で `omitted` が嘘をつかないようにすることだけである。**

---

## 検討して採らなかった案

- **`slice` の網羅性を確かめて引き継ぐ。** 却下。同語反復であり、`'unknown'` へ落ちる入力が
  **原理的に存在しない。**確かめても何も測れない。
- **`aggregateScope` の17箇所も同じ形にする。** 却下（上記）。
  **引き継ぐ先が無い。**近似の経路が無いので「近似したかどうかを知っている場所」が存在しない。
- **`budget_dropped` から `countKind` を外す**（`StageSkippedOmission` に倣って持たない）。 却下。
  **件数は数えられているのに名乗りだけ落とすのは、情報を捨てることになる。**
  `ann_unreached` が持たないのは件数そのものが原理的に不明だからで、ここは事情が違う。
- **単位から漏れた候補を `omitted` に出す**（新しい kind）。 **却下（本 ADR では）。**
  漏れること自体が上記の別の欠陥であり、**どう振る舞うべきかが決まっていない。**
  決まる前に分類だけ足すと、`omitted` の語彙が「まだ決めていないこと」を先に固定してしまう。

## 引き受ける負債・覆えていない範囲

- **`aggregateScope` の17箇所のリテラル**（上記）。**塞いでいない。**
- **単位から候補が漏れる欠陥そのもの**（上記）。**塞いでいない。報告済み。**
- **`countKindForUnits` は「覆った数が一致するか」しか見ない。**
  同じ候補が二重に入り、かつ別の候補が漏れて**数が偶然一致する**場合は `'exact'` と名乗る。
  同一性まで見るには候補の id 集合を突き合わせる必要があり、**そこまではしていない。**

## これが覆るとしたら

- **`aggregateScope` に近似が入ったとき**（17箇所の扱いを決め直す必要が出る）。
- **単位から候補が漏れる欠陥の扱いが決まったとき。**漏れを機構が拒むようになれば、
  `countKindForUnits` の `'unknown'` 側は到達不能になり、段2と同じ形（前提を歯にする）へ移る。

# ADR 0025: 段1の ANN が窓を埋められなかったことが、`omitted` に出ていない（実測。**決定は保留**）

- **状態**: **未決（2026-09）。実測の記録のみ。直し方はオーナーと決める。**

  **⚠ この ADR は決定を含まない。**[ADR 0008](./0008-absence-taxonomy.md) の芯が
  特定の経路で破れていることを**実測した記録**である。直すには「欄を足す」判断が要り、
  **足した欄の経路を1つずつ実測する義務**が生じる（[ADR 0011](./0011-no-window-count-in-ann-stage.md)
  と [ADR 0024](./0024-remove-exact-counts-option.md) が同じ罠を記録している）。
  **だから測るところで止めた。**

- **文脈**:

  [ADR 0023](./0023-subject-filter-in-ann-stage.md) の追測で、**大きい subject（テナントの10%）
  では、プランナが HNSW へ戻り `LIMIT 40` に対して数件しか返らない**ことが分かった。
  **⟹ 「なぜ足りないのか」が呼び出し側に出ているのか?** を確かめた。

- **実測（GitHub Actions run 34011906560、PostgreSQL 17 + pgvector、
  `packages/postgres/src/bench/scale-bench.ts` Part 4、擬似の合成ベクトル・実 API 不使用）**:

  条件: 1テナント 100,000行、狙いの subject に 10,000行、次元256、`ctx.subjectId` 指定、
  `scoreThreshold: 0`（**減衰でスコアが落ちて `below_threshold` に化ける影響を外すため**。
  下の「測るまでに2回間違えた」を参照）。

  ```
  result.memories.length      : 0
  result.index.totalInScope   : 6288   （countKind=exact）
  result.index.groups         : [{ axis:"subject", key:"subject-size-10000", count:6288 }]

  result.omitted:
    { kind:"filtered",    condition:"archived", count:1170 }
    { kind:"filtered",    condition:"status",   count:2542 }
    { kind:"not_indexed", reason:"pending",     count:904  }
    { kind:"not_indexed", reason:"failed",      count:913  }
    { kind:"not_indexed", reason:"skipped",     count:930  }

  result.explain.stages[candidate_generation].detail:
    { channel:"ann", kPrime:40, hits:0 }
  ```

  **数を合わせる:**

  | | 件数 |
  |---|---:|
  | subject の全 Memory | 10,000 |
  | − `filtered`（scope 外の status） | −3,712 |
  | **= `totalInScope`** | **6,288** |
  | − `not_indexed`（埋め込みが無い＝ANN の候補になれない） | −2,747 |
  | **= ANN の候補になり得た Memory** | **3,541** |
  | **実際に返った Memory** | **0** |
  | **`omitted` がこの 3,541 について説明している件数** | **0** |

- **⟹ 実測でわかったこと**:

  1. **呼び出し側は「10件くれ」と言い、6,288件在る subject から 0件を受け取った。**
  2. **`omitted` にはその理由が1つも無い。** `ann_truncated` も `over_limit` も
     `below_threshold` も付いていない（`ann_truncated` の条件は
     `annHits.length >= kPrime` であり、`hits=0 < kPrime=40` では成立しない）。
  3. ⟹ **「ANN が近傍40件を他の subject で埋めてしまい、この subject に届かなかった」**と
     **「この subject には返せる Memory が無かった」**が、`omitted` の上では**同じ顔**である。
     **これは [ADR 0008](./0008-absence-taxonomy.md) が禁じている潰し方そのものである。**
  4. **ただし完全に不可視ではない。2つの手掛かりが在る:**
     - **`explain.stages[candidate_generation].detail` に `{ kPrime: 40, hits: 0 }` が出ている。**
       段1が何件返したかは**説明の側には在る。**
     - **目次帯が `totalInScope: 6288` を返している。**「0件返ったが 6,288件在る」という
       食い違いは、呼び出し側が**引き算すれば**気づける。
     ⟹ **情報は在るが、`omitted`（＝「無い」の分類）には無い。**
     **ADR 0008 の判定基準（「その区別があると次の一手が変わるか」）に照らすと、
     次の一手は明確に変わる**——取りこぼしなら `limit` や over-fetch 係数を上げる、
     あるいは subject を指定し直す、という手が在る。**無かったのなら何もできない。**

- **⚠ 比較のため（同じ実測、同じ run）**:

  `ctx.subjectId` を**指定しない**場合は `memories.length: 10`（既定 `limit`）で正常に返る。
  ⟹ **この現象は subject を絞ったときに固有である。**

- **⭐ 測るまでに2回間違えた（同じ罠を次に踏まないための記録）**:

  1. **1回目**（run 34011508214）: `recall()` が `hits: 0` を返したが、
     **subject を指定しない比較用の呼び出しでも `hits: 0` だった。**
     62,734件が scope に在るのに 0 は有り得ない ⟹ **計測の配線を疑うべき合図。**
     診断（同じ pool・同じ space・同じクエリベクトルで `vectorStore.search` を直接叩く）を
     足したところ、**直接叩けば 40件返った。** ⟹ 計測側の問題だった。
  2. **2回目**（run 34011723766）: 候補は3件返っていたが、
     **score が 2e-4 / 7e-7 / 6e-9 で全部 `below_threshold` に落ちていた。**
     seeding が `recorded_at` を「`now()` − 乱数×365日」で散らすため、既定の
     halfLife（720h＝30日）だと**減衰でスコアがほぼ0になる。**
     ⟹ そのままでは「窓が埋まらない」ではなく**「減衰で落ちた」を測ることになる。**
     `scoreThreshold: 0` の変種を足して分離した。

  **⟹ どちらも「0件だった」という同じ見た目をしていたが、原因は3つとも違った**
  （配線ミス / 減衰 / 本当の窓の埋まらなさ）。**0 を見たら、まず 0 の理由を疑うこと。**

- **⚠ 確かめていないこと**:

  - **直し方を何も試していない**（本 ADR は測定の記録であり、決定を含まない）。
  - **HNSW の近似は index の構築ごとに揺れる。**同じ seeding でも、subject 指定の
    直接検索は run によって **3件**（run 34011723766）と **0件**（run 34011906560）に
    振れた。**「何件返るか」は再現しない。「窓が埋まらない」ことは再現する。**
  - `status` の分布・`embedding_status` の分布は seeding の都合で散らしてあり、
    実運用の分布ではない（`filtered` と `not_indexed` の件数はその産物である）。
  - **全体行数 100,000・次元 256・subject 10% の1点でしか測っていない。**
    何%から起きるか、他の規模でどうなるかは測っていない。
  - `budget` を渡した場合・`limit` を上げた場合にどうなるかは測っていない。

- **決めるべきこと（オーナーと）**:

  **「取りこぼしたかもしれない」を `omitted` に出すか。出すなら何という顔で出すか。**
  ADR 0008 は `Omission` を閉じた集合として設計していないので、値を足すこと自体は
  禁じられていない。**ただし [ADR 0024](./0024-remove-exact-counts-option.md) の教訓が効く**
  ——**欄を足したら、その値を作る経路を1つずつ実測して、名乗りどおりのものが入るか
  確かめなければならない。**「あとで実装する欄」を型に置かない。

  **⟹ 2026-09、オーナーが決定。[ADR 0026](./0026-ann-unreached-omission.md) を見よ**
  （`Omission { kind: 'ann_unreached', countKind: 'unknown' }` として出す。本 ADR のこの節から下は当時の記録のまま書き換えていない）。

---

## 追記（2026-09-27）: Issue #1005（scale-bench の seedVectors が全行に同じベクトルを入れていた不具合）を踏まえた当て直し

本 ADR が実測に使った `packages/postgres/src/bench/scale-bench.ts` の `seedVectors` は、
`ARRAY(SELECT random() ...)` の副問い合わせが外側の行を参照しておらず、PostgreSQL がこれを
InitPlan として1回だけ評価して**全行に同じベクトルを入れていた**（Issue #1005、PR #1008 で
修正、main `76db71c`）。⟹ 本 ADR の実測（`result.memories.length: 0`、`hits: 0`）は、
全行同一ベクトルの表に対するものだった。

**この不具合が実測結果そのものを作っていたのかを、クリーンな対照実験で切り分けた。** 実測に
使われたコミット（`gh run view 34011906560 --json headSha` で特定した `f8d4d79`、2026-09-06。
`seedVectors` はバグ入りのまま）を `git worktree` でチェックアウトし、(a) 無改造のまま実行、
(b) `WHERE m.id IS NOT NULL` の1行相関を足すだけ（PR #1008 と同じ修正）を当てて実行、の2通り
を同じ規模（100,000行、狙い subject 10,000行、次元256）で比較した。

| 条件 | `hits`（subjectId指定・`kPrime=40`） | `result.memories.length` | `result.omitted` |
|---|---:|---:|---|
| `f8d4d79`（無改造＝当時のまま） | **0** | **0** | 5件（`filtered:archived=1170`・`filtered:status=2542`・`not_indexed:pending=904`・`failed=913`・`skipped=930`——いずれも本文の実測値と完全一致） |
| `f8d4d79` + `seedVectors` の修正のみ | **1** | 0（`scoreThreshold=0`の変種では1） | 6件（内訳の性質は変わらず） |

無改造の行が本文の実測値と件数まで一致し、**再現を確認した。** その上で、**バグを直しただけでは
`hits` は 0→1 とわずかに増えるに留まり、`kPrime`（40）には遠く及ばない。** ⟹ **本 ADR の
核心的な実測結果（「大きい subject で `recall()` を呼ぶと ANN がほぼ何も返さない」）は、
`seedVectors` のバグが作っていたものではない——バグを直しても再現する。**

今日の main（`76db71c`）で同じ条件を測ると `hits: 40`（満window）になる。この差の出どころを、
`e12b49b`「段1の `search()` に `hnsw.iterative_scan = relaxed_order` を採用し、他テナントの
near-duplicate による全滅を塞ぐ（ADR 0284）」（2026-09-24）の親コミットと `e12b49b` 自身の
双方に `seedVectors` の修正のみを当てて実測し、特定した：

| コミット | ADR 0284 | `hits`（subjectId指定・`kPrime=40`） |
|---|---|---:|
| `e12b49b` の親（ADR 0284 適用前） | 適用前 | **2** |
| `e12b49b`（ADR 0284 適用） | 適用後 | **40** |

**同じ `seedVectors` 修正の下で、`e12b49b` を境に `hits` が切り替わることを実測で確認した。**
本 ADR が実測した事象（over-filter で ANN が窓を埋められない）は、まさに ADR 0284 が
主題として直したものであり、**#1005 とは無関係な、正しい改善**として今日の状況を変えている。

⟹ 本 ADR の読みは変わらない（本 ADR の実測は同一ベクトルの不具合の産物ではなく、有効な
観測だった）。ただし今日の main の挙動は本 ADR 執筆時から大きく変わっている——その理由は
ADR 0284 であり、#1005 ではない。

環境: 手元 PostgreSQL 17.11 / pgvector 0.8.0。元の測定は GitHub Actions CI
「PostgreSQL 17 + pgvector」（正確な pgvector の patch バージョンは当時の ADR 本文に記載が無い）。

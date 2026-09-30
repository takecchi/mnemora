# ADR 0402: `RelationStore.listRelatedMany?` を足し、幅優先探索の1段（frontier）を1往復で読む

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-30
- **PR**: Draft（[Issue #1449](https://github.com/takecchi/mnemora/issues/1449) 1-A の遅さのうち案A。`Refs`、閉じない）

> **⚠ 本文はクローン miku の委譲先が書いた。オーナー本人の執筆ではない。**
> 案A を入れると決めたのはマネージャー（クローンの委譲元）であり、オーナー本人の確認は取っていない。

---

## 問い

`Runtime` には、関係の行（`memory_relations`、`kind = 'contradicts'`）を幅優先で辿る場所が3つある。

- recall 段3（`contradiction_resolution`）の群の同伴取得（`recall-runtime.ts`）
- `resolveContestedGroup` の部分解消の確認（`runtime.ts`。渡されたメンバー以外に群がつながっていないか）
- claim key の群の検出（`detectClaimKeyContested`、`runtime.ts`。穴Aの吸収・合併の判定）

3つとも `RelationStore.listRelated` を**起点ごとに1回、直列に**呼んでいた。群の幅が N なら、1つの群を辿るだけで関係の SELECT が
N 本（実測は下）。[ADR 0401](./0401-mark-resolve-contested-group-constant-statements.md)（Issue #1449 の案D・案E、PR #1490）は
書き込み側（`markContestedGroup` / `resolveContestedGroup` の store 内）を定数個の文にしたが、**読み側の runtime が撃つ
`listRelated` × N は ADR 0401 の【実測】が「この PR の外に残り、全体の下限になる」と名指していた**。本 ADR がその続き（PR2）である。

## 決めたこと

### 決定1. `RelationStore` に任意メソッド `listRelatedMany?(ctx, memoryIds, kind?)` を足す

```ts
listRelatedMany?(ctx: Ctx, memoryIds: readonly MemoryId[], kind?: RelationKind): Promise<Relation[][]>;
```

- `result[i]` は `listRelated(ctx, memoryIds[i], kind)` と**同じ集合**。位置で対応させる（uuid の綴りの揺れに依らない）。
- 重複した id は同じ内容を別々の配列で返す。実在しない id・関係の行を持たない id は、その位置に空配列。空の入力は空配列。
- 各要素の中の順序は規定しない（`listRelated` と同じ。`Runtime` が必要な順に並べる）。
- **任意メソッド**。実装しない adapter では `Runtime` は今までどおり `listRelated` を起点ごとに直列に呼ぶ。型の追加のみで非破壊。
- Postgres 版は `WHERE tenant_id = $1 AND from_memory_id = ANY($2::uuid[]) [AND kind = $3]` の1文。uuid の形でない id は
  DB へ投げず（型変換エラーでバッチ全体が落ちる）、その位置は空配列にする。`InMemoryRelationStore`（testkit）も実装した。

### 決定2. 幅優先を「1段ずつ」進め、1段を1往復にする。ただし、今までの結果は変えない

- **recall 段3**: frontier（1段ぶんの起点）を id 昇順にそろえて `listRelatedMany` に渡す。返りを起点ごとに、今までと同じ順
  （id 昇順・1件ごとの安全弁・打ち切った後は先へ進まない）で処理する。**安全弁で止まった位置より後ろの起点の結果は捨て、辺も記録しない**
  ——先読みで多く取っても、`companionOf`（同じ段で複数の親から届く相手は id の小さい親）・`over_limit` の `countKind` は変わらない。
- **resolve の部分解消の確認・claim key の群の検出**: 途中で止めない探索なので、1段（キューの現在の全員）を1往復で取り、次の段へ。
  処理する順は先入れ先出しの queue と同じ。
- 取り出しは `packages/core/src/relation-level.ts` の2関数（`listRelatedManyIfSupported`＝無ければ `undefined`／`listRelatedLevel`＝無ければ直列の `listRelated`）。
  `listRelatedMany` が返す長さが入力と違えば、位置をずらさず例外にする（adapter の契約違反）。

### 決定3. 適合テストは実装した adapter にだけかける

`describeRelationStoreConformance` に任意のフラグ `implementsListRelatedMany?: boolean`。実装が有れば宣言に依らず節がかかる。
実装が無ければ節は skip。**`true` を宣言して実装が無ければ赤**（「実装したつもりで skip され続ける」を防ぐ）。

## 歯（先に書いた。赤→緑）

歯だけの commit `4cb3cb0`（実装より前。型と doc だけ足してある）と、実装の commit `88109c7` を分けた。
下の赤は、別 worktree で `4cb3cb0` をチェックアウトし、同じ Postgres に対して走らせた**実測**（2026-09-30）。

| 歯 | 何を縛るか | `4cb3cb0`（実装前） | 実装後 |
|---|---|---|---|
| `packages/core/src/__tests__/list-related-many-round-trips.test.ts` | 星・完全・鎖・安全弁つき・2群の合併で、あるとき／無いときの往復数（`listRelatedMany` の回数と `listRelated` の回数）と、**結果の完全一致**（提示順・`companionOf`・省略・段の説明） | **赤**（21件中17件。「星（owner + 6 葉）: listRelatedMany 2回…」は `listRelatedMany` の呼び出しが空で `expected [...] to deeply equal []`、frontier の昇順の歯は `level1 is not iterable` など） | 緑（23件） |
| `packages/testkit/src/__tests__/in-memory-fixtures.conformance.test.ts` | in-memory の適合。`implementsListRelatedMany: true` の宣言に対する実装の有無 | **赤**（536件中1件。「listRelatedMany を実装していると宣言した adapter は、実際に実装している」が `expected 'undefined' to be 'function'`） | 緑（535 passed・1 skipped） |
| `packages/postgres/src/__tests__/conformance.postgres.test.ts` | Postgres の適合。同上 | **赤**（539件中1件。同じ it が同じメッセージ） | 緑 |
| `packages/postgres/src/__tests__/list-related-many.postgres.test.ts`（実装と同じ commit） | 起点の数に依らず関係の SELECT が1文／位置ごとに `listRelated` と同じ集合（大文字の綴り・重複・存在しない id・uuid の形でない id を含む）／`kind` あり・別テナント／recall 段3 が段数（2文）で、無い store では起点ごと（クリーク8件で8文）・結果は同じ | （実装後の commit で足した） | 緑（実装後の枝先で、上の Postgres 適合と合わせて 542件緑） |

`list-related-many-round-trips.test.ts` の「菱形」の歯（`listRelatedMany` の返す順に依らず `companionOf` が id の小さい親に決まる）は、
実装の commit で足したので、`4cb3cb0` の 21件には入っていない（実装後の 23件との差）。

## 【実測】前後（2026-09-30、PostgreSQL 17、自分専用のインスタンス）

**条件**: 器は48コア・メモリ322GB の共有機で、測定中の load average は約20（他の担当の負荷と重なる）。Postgres は `initdb` した専用インスタンス
（既定の設定。`max_connections=200` だけ足した）、クライアントと同じ機の loopback（127.0.0.1）で往復の遅延はほぼ0。
テナント1つに関係の行を **112,080 行**（`memories` 1,376 行）入れた。内訳は、

- 完全グラフ（クリーク）1本: 幅316（316 × 315 = 99,540 行。ベクトルは持たせず、recall の入口にならない。resolve の対象）
- 完全グラフ1本: 幅60（3,540 行。メンバー1件だけにベクトル。recall の入口）
- 完全グラフ100本: 幅10（100 × 90 = 9,000 行。背景）

`markContestedGroup`（ADR 0401 後の実装）で作った。作成後に `ANALYZE memory_relations`。

**やり方**: 同じプロセス・同じ DB で、`listRelatedMany` を持つ `PostgresRelationStore` を配線した runtime（あり）と、
同じ store の `listRelatedMany` を外したラッパ（`link`/`unlink`/`listRelated` だけ通す）を配線した runtime（なし）を、
**なし → あり を交互に**、2ラウンド。各測定は捨てる1回の助走の後に15回、中央値（かっこは最小〜最大）。
文の数は `pg` の `Client.prototype.query` を数えた（1回の呼び出しあたり。関係の SELECT は `from memory_relations ... from_memory_id` を含む文）。
測定用の道具は `bench-1449.ts`（`packages/postgres/` の直下に置いて `tsx` で走らせた。**ADR 0401 の `bench-1449` の道具と同じく commit していない**）。
同じ手順は、テスト（`list-related-many.postgres.test.ts`）が文の数だけを恒常的に縛っている。

| 対象 | 群 | | 文（全体） | 関係の SELECT | 中央値 ms（最小〜最大） |
|---|---|---|---|---|---|
| recall 段3 | 幅60（round 1） | なし | 75 | 60 | 43.2（26.8〜63.0） |
| recall 段3 | 幅60（round 1） | あり | 17 | 2 | **18.5**（13.7〜29.1） |
| recall 段3 | 幅60（round 2） | なし | 75 | 60 | 30.9（28.2〜51.1） |
| recall 段3 | 幅60（round 2） | あり | 17 | 2 | **18.8**（16.6〜22.7） |
| resolveContestedGroup（先頭100件を渡す。部分解消の確認） | 幅316（round 1） | なし | 318 | 316 | 235.0（209.8〜267.3） |
| 同上 | 幅316（round 1） | あり | 4 | 2 | **162.6**（140.3〜187.6） |
| 同上 | 幅316（round 2） | なし | 318 | 316 | 240.5（211.7〜275.9） |
| 同上 | 幅316（round 2） | あり | 4 | 2 | **154.5**（141.9〜194.1） |

### 読み取れること

- **文の数は、群の幅から段数に変わった。** recall 段3 は関係の SELECT が 60 → 2（段数。owner の段と、同伴の段）、resolve の確認は 316 → 2
  （渡した100件の段と、見つけた216件の段）。全体の文は recall で 75 → 17、resolve で 318 → 4。
- **時間は、この構成（loopback、往復の遅延がほぼ0）では recall 段3 が約 1.6〜2.3 倍（31〜43 → 19 ms）、resolve の確認が約 1.5 倍（235〜241 → 155〜163 ms）。**
  **往復の遅延が大きい構成（別の機・別のゾーンの DB）では、削れた文の数（−58本・−314本）に往復の遅延を掛けた分がそのまま上乗せで効くはずだが、
  そのような構成では測っていない【確かめていない】。** loopback での差は、往復の固定費（文の解析・計画・結果の受け取り）だけである。
- **resolve の「あり」が 155〜163 ms に残るのは、幅316の群の関係の行が 10 万行近く、1文でそれを全部返しているためと見ている**【推論。
  文の内訳は取っていない】。1段目（100件）で約31,500行、2段目（216件）で約68,000行を受け取って `Relation` に組み立てる。行の数は減らしていない。
  **完全グラフでは、行の数がボトルネックになり、文の数を減らしても下がらない**（ADR 0401 の完全1000 の mark と同じ形）。
- **鎖のように、1段が1件の形は、段の数が起点の数と同じなので、往復は減らない**（`list-related-many-round-trips.test.ts` の「鎖（5件）…5回」が縛っている）。
  この形の測定は取っていない【確かめていない】。
- 3つの探索のうち、**claim key の群の検出（`detectClaimKeyContested`）は実測していない**【確かめていない】。resolve の確認と同じ
  `listRelatedLevel` を通り、歯（`list-related-many-round-trips.test.ts`）で往復数と結果の一致は縛っているが、`observe` 経由の時間は測っていない。

## 非破壊である根拠

- 任意メソッドの追加のみ。実装しない adapter（`RuntimeDeps.relationStore` が `listRelatedMany` を持たない）は、呼び出し順・回数とも今までと同じ。
- 実装する adapter でも、`Runtime` の結果（recall の提示順・`companionOf`・`omitted`・`over_limit` の `countKind`・resolve の outcome・claim key の群の面子）は、
  「あるとき」と「無いとき」で完全に一致することを歯が縛っている（星・完全・鎖・安全弁つき・菱形・2群の合併）。
- 公開面の snapshot（`scripts/__snapshots__/public-api/{core,postgres,testkit}.d.ts`）を更新した。

## 採らなかった案

- **`listRelated` の第2引数を配列にする（既存メソッドの署名変更）**: 破壊的。任意メソッドの追加のほうが、実装しない adapter を1つも壊さない。
- **`WITH RECURSIVE` で群全体を1文で辿る（`resolveContestedGroup?` の CAS と同じ形）**: 往復が1になるが、recall 段3 は安全弁で
  「途中で止める」位置と `companionOf` の規則が今の直列の順に依っており、SQL の再帰では同じ位置で止められないと見た（結果が変わりうる）【推論。試していない】。
  1段ずつなら、既存の規則をそのまま保てる。**段の数ぶんの往復は残る**（鎖のような深い群では効かない）。
- **`listRelated` を起点ごとに並列（`Promise.all`）に撃つ**: 接続を N 本占め、安全弁で止まった後ろの起点の分まで撃ってしまう。順序の規則も崩れる。
- **recall 段3 で、安全弁で止まる位置より後ろの起点を先読みしない**: 採用した（frontier を1度に取るため、止まった後ろの起点の分は無駄に読む）。
  frontier の幅が安全弁より大きいときに余分に読む行が増える負債は下。

## 引き受けた負債

- **recall 段3 は、frontier をまるごと取ってから安全弁で切る**ので、切った後ろの起点の関係の行も読んで捨てる。
  幅が安全弁（既定で上限の10倍）を大きく超える群では、読んで捨てる行が増える。上限そのものは `relationMaxCount`（ADR 0396）が持つ。
  捨てる行の量は測っていない【確かめていない】。
- 深さ（段数）が大きい群では往復が減らない。Postgres 側で1文にする再帰は、上の理由で採っていない。
- 実装する adapter が、`kind` あり・なし、綴りの揺れ、重複・存在しない id を契約どおり扱うかは、適合テストの節（`implementsListRelatedMany`）が縛る。
  **自前の `RelationStore` に実装していない adapter は、この節では何も検査されない**（skip される）。

## これが覆るとしたら何が起きたときか

- 往復の遅延が大きい構成で測って、文の数を減らしても時間が下がらない（完全グラフの行の転送が支配的）と分かったとき。
  その場合は、行の数を減らす側（群の関係の行を全部返さない）へ話が移る。
- `Runtime` の探索が `WITH RECURSIVE` 相当を、安全弁の位置と `companionOf` の規則ごと1文で書ける形に変わったとき。

## 関連

- [Issue #1449](https://github.com/takecchi/mnemora/issues/1449)（1-A の遅さ。案A が本 ADR、案D・案E が PR1）
- [ADR 0401](./0401-mark-resolve-contested-group-constant-statements.md)（PR1、PR #1490。書き込み側を定数個の文にした。読み側の `listRelated` × N を「この PR の外」と名指した）
- [ADR 0381](./0381-contested-group-write-path-implementation.md)（群の書き込み・読みの実装）、[ADR 0396](./0396-recall-relation-max-count.md)（段3の安全弁 `relationMaxCount`）

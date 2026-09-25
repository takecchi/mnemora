# ADR 0308: `RecallAssociationQuery.anchorPool` を任意欄として足す — アンカーの母集合を、既定を変えずに `limit` の外へ広げる（Issue #377）

- **状態**: 提案 (2026-09) ——🔴 **実測の結果、測った範囲（7規模・2 ef_search・2 anchorCount）
  では gold 到達を1件も増やせなかった（§7）。「採用」へは進めていない。オーナー判断待ち。**
- **日付**: 2026-09-25

**出自**: オーナーの依頼を受けたマネージャーのセッションから切り出され、それを受けたエージェントの
セッションが Issue #377 に対して書いた。**この ADR はオーナー本人の決定ではない**——
[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md) と同じ理由で、
署名からは区別が付かない。**連想枠の既定 off・`DEFAULT_ASSOCIATION_ANCHOR_COUNT` の値は
オーナー決定として動かさない**（下の「0. 依頼の要旨」）。

**⚠ 各主張の出所を分ける。**

- **【実測】** — この書き手が自分の手で `vitest`/`tsc`/`eslint`/`prettier`/実際の Postgres +
  pgvector を走らせて確かめた。
- **【現物】** — この repo のコード・文書を読んで確かめた。
- **【受】** — Issue 本文・過去の ADR・過去の Issue コメントからの引用で、この書き手が
  再導出していない。

---

## 0. 依頼の要旨

[Issue #377](https://github.com/takecchi/mnemora/issues/377)（実測の報告、逐語の要旨）:

> 連想枠（段3.5）のアンカーは「クエリに実際に当たった候補の上位 `anchorCount`（既定3）件」から
> 取られる。この3は固定で、テナントの規模に追随しない。記憶が増えるほど、連想の起点になれる
> 候補の割合が下がる。1万件規模の実測では、probe 自身の anchor が上位3件に入ったのは
> `ef_search=40` で 5/12、`ef_search=120` で 7/12。gold 到達は 0/12 と 1/12。62文の haystack
> では 12/12 だった。

[PR #430](https://github.com/takecchi/mnemora/pull/430)（着地済み、doc のみ）が実測して残した
事実:

> `anchorCount` だけを上げても `limit`（既定10）が天井になる。実際のアンカー数は
> `min(anchorCount, limit, 段2を通った候補数)`。回避には `limit` と `anchorCount` の
> 両方を上げる必要があるが、`limit` を上げると段1の取り込み幅 `kPrime`（= `limit ×
> overFetchFactor`）も一緒に広がる——費用は連想枠だけの話では済まない。

マネージャーからの追加方針（本セッションへの指示、逐語の要旨）:

> 既定を変えずに直す。任意欄の純追加で規模に追随させる（ADR 0289 の型）。推奨案:
> アンカーの母集合を `withinLimit` ではなく段2の通過集合（`passed`、最大 `kPrime`）から
> 取れる任意指定。`limit` の天井を外す。ADR 0151 の「クエリに当たった候補から取る」
> （companions は起点にしない）を守る。

⚠ **[Issue #337](https://github.com/takecchi/mnemora/issues/337)（連想枠を既定 on にするかを
10万行級で測ってから判断する、オーナー決定 2026-09-16）は、本 ADR の射程外である。**
本 ADR は「`anchorCount` の天井をどこまで動かせるか」という**任意欄の設計**であり、
「連想枠の既定を on にするか」という**既定の判断**には一切触れない。#337 の10万行級の
判断は、引き続きオーナー判断待ちのまま残る。

## 1. 現物で確認した — 天井の出所

【現物】`packages/core/src/recall-runtime.ts`（本 PR の変更前）:

```ts
const withinLimit = passed.slice(0, limit);          // :876 付近
...
const anchorCount = associationQuery.anchorCount ?? DEFAULT_ASSOCIATION_ANCHOR_COUNT;
const anchors = withinLimit.slice(0, anchorCount);    // :1124 付近
```

`passed` は段2の閾値分割（`partitionByThreshold`）を通った**全**候補——`limit` で
切り詰める**前**の集合であり、大きさの上限は段1の over-fetch 窓 `kPrime`
（= `limit × overFetchFactor`、既定 `10 × 4 = 40`）である。`withinLimit` はその先頭
`limit` 件（既定10件）だけを取ったものである。

⟹ **アンカーの母集合が `withinLimit` に固定されている限り、`limit`（既定10）が
`anchorCount` の実効的な天井になる。** これが Issue #377 の実測が踏んだ構造である
——テナントの規模が伸びるほど「クエリに当たった候補（`passed`）」の総数は増えうるが、
アンカーに使えるのはそのうち先頭10件だけであり、割合は下がる一方になる。

## 2. なぜ `passed` へ広げれば直るか

`passed` は `withinLimit` の**上位集合**であり、両方とも「段2の閾値
（`scoreThreshold`、既定0.1）を通った」候補の部分集合である。ADR 0151 が課した制約
——「アンカーはクエリに実際に当たった候補から取る。`companions`（段3の必須同伴取得、
スコアに関係なく足された候補）を起点にしない」——は、母集合を `withinLimit` から
`passed` に広げても**破れない**。`companions` は `passed`/`withinLimit` のどちらにも
含まれていない（`companions` は段2の再スコア対象そのものではなく、段3で別途足された
候補である。`recall-runtime.ts` の該当ブロック）。

⟹ **母集合を `passed` に広げることは、ADR 0151 の制約の中で天井だけを動かす、最小の変更である。**

## 3. 決定

### 3.1 `RecallAssociationQuery.anchorPool?: "withinLimit" | "passed"` を任意欄として足す

```ts
export const ASSOCIATION_ANCHOR_POOLS = ["withinLimit", "passed"] as const;
export type AssociationAnchorPool = (typeof ASSOCIATION_ANCHOR_POOLS)[number];

export interface RecallAssociationQuery {
  maxCount: number;
  anchorCount?: number;
  minSimilarity?: number;
  anchorPool?: AssociationAnchorPool;      // 新設
}

export const DEFAULT_ASSOCIATION_ANCHOR_POOL: AssociationAnchorPool = "withinLimit";
```

**既存の欄の型・名前・必須性は1バイトも変えていない**（`git diff` で確認——追加のみ、
`packages/core/src/recall.ts`）。[ADR 0289](./0289-recalled-memory-speaker-subject.md)
（`RecalledMemory.speaker?`/`subjectId?`）・[ADR 0282](./0282-score-breakdown-affinity-measured.md)
（`ScoreBreakdown.affinityMeasured?`）と同じ「任意欄の純追加」の型を踏襲する。

### 3.2 既定 `"withinLimit"` — この欄を足す前の挙動と1バイトも変わらない

`recall-runtime.ts` は次のように変わる:

```ts
const anchorPool = associationQuery.anchorPool ?? DEFAULT_ASSOCIATION_ANCHOR_POOL;
const anchorSource = anchorPool === "passed" ? passed : withinLimit;
const anchors = anchorSource.slice(0, anchorCount);
```

`anchorPool` を省略した呼び出し（`association` を全く渡さない既存の呼び出しはもちろん、
`association: { maxCount }` だけを渡す ADR 0168 の `examples/chat` の既存呼び出しも含む）は
`anchorSource === withinLimit` のままであり、**挙動は1バイトも変わらない。**

### 3.3 `"passed"` — `limit` を上げずに天井を外す

`anchorPool: "passed"` を渡すと、母集合が `passed`（`limit` で切り詰める前、最大でも
`kPrime` 規模）になる。`limit`・返す `memories` の件数・段1の費用（`kPrime` そのもの）は
1つも変わらない——変わるのはアンカーの母集合だけである。実際のアンカー数は常に
`min(anchorCount, 選んだ母集合の件数)`。

### 3.4 除外集合（`excludeIds`）は変えない

連想枠が実際に返す候補の除外条件（`withinLimit` + `companions` + アンカー自身）は
`anchorPool` の値に関わらず `withinLimit` のままである——ここを `anchorSource` に
連動させると、`anchorPool: "passed"` のときに `withinLimit` の外の候補（まだ `memories`
に含まれていない、`over_limit` として一旦捨てられている候補）が誤って除外され、
連想枠がそれらを拾えなくなってしまう。`anchorPool` は**アンカーの母集合**だけを
変える欄であり、**連想が返しうる候補の集合**は変えない。

## 4. 採らなかった案

| 案 | 却下理由 |
|---|---|
| `RecallAssociationQuery.anchorCount` の意味を直接変え、`limit` を無視して常に `passed` から取るようにする | **既定の挙動が変わる**——`limit` が小さいテナントでは、既存の呼び出しでもアンカーの母集合が広がり、連想の結果（`retrievedVia: "association"` の内訳・件数・費用）が変わりうる。マネージャーの指示「既定を変えない」に反する |
| `limit` を上げる（既存の回避策そのものを既定にする） | `limit` を上げると段1の取り込み幅 `kPrime` も一緒に広がり、返す `memories` の件数自体も増える——アンカーを増やしたいだけなのに、無関係な費用（段1全体・返す件数）まで動く。PR #430 の doc が既に指摘している負債 |
| 母集合をテナントの規模に対する割合で指定する欄（例: `anchorPoolFraction: number`） | 検討したが採らなかった。呼び手は `over_limit(stage:'rescore').count` を `omitted` から読めるため、`limit + count` で `passed.length` を自分で概算し、`anchorCount` を動的に決めることは既に可能——新しい欄を増やさなくても組める。「念のため」で選択肢を増やすことは避けた（`docs/autonomy.md`「やりすぎない」規律）。要る場面が具体化したら追加する |
| `anchorPool` を `boolean`（`useFullPassedSet?: boolean`）にする | 検討したが、母集合が将来3つ目の選択肢（例: 段1の生の ANN ヒット全体）を持つ可能性を潰したくなかった。文字列 enum のほうが `RECALL_CHANNELS`/`TIME_WEIGHTING_POLICIES` と同じ形で拡張しやすい |
| `passed` に加えて `companions` もアンカー候補に含める | ADR 0151 の制約（クエリに当たった候補から取る。`companions` を起点にしない）に正面から反する。Issue #377 の本文自身も「この設計判断そのものに異論を挟むものではない」と明記している |

## 5. 引き受けた負債 / 開いている穴

1. **`anchorPool: "passed"` は「anchor がそもそも `passed` に入っていない probe」を救わない。**
   `passed` は段2の閾値（`scoreThreshold`）を通った候補までであり、`below_threshold` に
   落ちた候補は含まれない。Issue #377 の実測で「生の ANN `kPrime`（既定40）件にすら
   入っていない」probe があったと報告されている場合、その probe はこの修正の範囲外である
   （下の「測ったこと」で実際に何件がこの帯の外だったかを記録する）。
2. **`anchorPool` はアンカーの母集合を広げるだけで、連想枠自体の質（ランキング・
   多様性）には触れていない。** ADR 0151 が「引き受けた負債」3番で書いた
   「アンカーの選び方が素朴（上位 `anchorCount` 件を取るだけ）」という性質は、
   母集合が `withinLimit` でも `passed` でも変わらず残る。
3. **`anchorCount` を大きくして `anchorPool: "passed"` を使うと、`getVectors` の
   呼び出し件数と `VectorStore.search` の呼び出し回数がアンカー数に比例して増える。**
   これは `anchorPool` が新しく作った費用ではなく、既存の `anchorCount` がそもそも
   持っていた費用だが、`anchorPool: "passed"` によって `anchorCount` を大きくする
   動機が増える分、この費用に当たる呼び手も増える。段3.5 のレイテンシへの影響は
   下の「測ったこと」に実測を残す。
4. **[Issue #337](https://github.com/takecchi/mnemora/issues/337) の10万行級の判断は、
   本 ADR とは独立に残る。** 本 ADR は「天井を外せる任意欄」を足しただけであり、
   「既定でその天井を外すべきか」は測っていない・決めていない。

## 6. これが覆るとしたら

1. **`anchorPool` を3つ目の値へ拡張する提案が出たとき**（例: 段1の生の ANN ヒット全体、
   `below_threshold` まで含めた全候補）——このときは ADR 0151 の制約（クエリに当たった
   候補から取る）を当て直す必要がある。`below_threshold` を含める案は、その時点で
   「クエリに当たった」の定義そのものを緩めることになるため、慎重な検討が要る。
2. **[Issue #337](https://github.com/takecchi/mnemora/issues/337) の10万行級の測定を
   経て、連想枠の既定を on にする、または `DEFAULT_ASSOCIATION_ANCHOR_POOL` の既定を
   `"passed"` に変える提案が出たとき**——どちらも北極星の問い1（毎回渡す量を減らす
   方向に働くか）を当て直す新しい ADR が要る。本 ADR はその判断をしていない。
3. **`anchorPool: "passed"` の費用（段3.5のレイテンシ）が、規模が伸びるにつれて
   許容できない水準になると実測されたとき**——このとき、`passed` の実効サイズに
   上限を設ける（`kPrime` とは独立の天井を `anchorPool` 用に持つ）案を検討する
   必要がある。本 ADR の時点ではその上限を設けていない（`passed` 自体が `kPrime`
   規模で既に有界であるため）。

## 7. 測ったこと

🔴 **結論を先に書く: この節の実測は、`anchorPool: "passed"` が gold 到達を
1件でも増やした規模・`ef_search` の組を1つも見つけていない。** 測った7規模
（62/1000/1500/2000/2500/3000/10000）・2つの `ef_search`（40/120）・2つの
`anchorCount`（10/40）の**全ての組み合わせで**、`anchorPool: "passed"` の
gold 到達数は既定（`anchorPool` 省略）と**同数か、それより少なかった**——
1件でも上回った組は無い。小〜中規模（62・1000・1500・2500）では既定より
明確に**悪化**しており（アンカー母集合が広がった分だけ、無関係な候補が
連想の枠（`maxCount`）を奪い合う——下の「なぜ悪化するか」参照）、
中〜大規模（2000・3000・10000）では既定と**同着**（どちらも取り戻せない）
だった。**⟹ 実装を出す意味があるかは、本 ADR だけでは判断できない
——オーナー判断を仰ぐ（下の「この ADR の状態について」参照）。**

### 7.0 器（すべての実測に共通）

| 項目 | 値 |
|---|---|
| PostgreSQL | 17.11、pgvector 0.8.0（`\dx` で確認） |
| embedding | `local` / `ruri-v3-30m/sym` / 256次元（`@mnemora/local-embedding`、ADR 0085） |
| LLM | `deterministic` |
| probe | `examples/chat/src/association-probe-set.ts` の `ASSOCIATION_PROBES`（12件、ADR 0151/Issue #291 が設計した「query ≈ anchor / anchor ≈ gold / query ≉ gold」の三角形） |
| 62件点の haystack | `ASSOCIATION_HAYSTACK`（手書き60文 + Issue #317 で足した2文）——CI の `association-probes` ジョブと**同じ**関数（`buildAssociationProbeSetConversation()`）で組む。**陽性対照そのもの** |
| 62件超の filler | `examples/chat/src/bench/association-anchor-pool-scale-bench.ts` の `buildDistinctFiller`（構成上ゼロ重複、プローブ語彙と非交差のログ風合成テキスト） |
| `RecallQuery.limit` の既定 | 10（`kPrime = 10 × 4 = 40`） |
| 計測道具 | `pnpm --filter @mnemora/example-chat run association-anchor-pool-scale-bench`（本 PR が追加。§7.5「この道具について」参照） |

**測定道具は `packages/core`/`packages/postgres` を1行も変更せずに段ごとの内訳を取る**
——`VectorStore.search`/`VectorStore.getVectors` を薄い spy で包み、`anchorPool`/
`anchorCount`/`limit` の組み合わせを変えて `recall()` を複数回呼ぶことで、
(a) 生ANN・(b) `passed`・(c) `withinLimit`・(d) 実際のアンカー、を外側から観測する
（`ADR 0188` が前提にしている「`getVectors` の呼び出し箇所は1つ」という事実を使う）。
詳細はベンチファイル冒頭の docstring。

### 7.1 陽性対照 — 測定器は生きている

62件点（`ASSOCIATION_HAYSTACK`、ADR 0168 と同じ規模）で:

| arm | goldReturned |
|---|---|
| off（連想枠なし） | **0/12**（設計どおり——query だけでは gold に届かない） |
| on-default（`maxCount=10`、`anchorCount`/`anchorPool` は既定） | **12/12** |

**`off` が 0/12 になること自体が、三角形の設計（query ≉ gold）が壊れていないことの
確認であり、`on-default` が 12/12 に届くことが Issue #377 本文の「62文の haystack
では12/12だった」と一致する陽性対照である。** ⟹ 以下の「規模が伸びると崩れる」
という否定的な結果は、測定器が反応していないからではない。

### 7.2 規模ごとの内訳（4 arm、ef_search 40/120）

`(a)=(b)=(c)` は「probe自身のanchorが、生のANN kPrime件・`passed`・`withinLimit`の
それぞれに入っていたprobe数/12」。**この3つの値は測った7規模・全ての ef_search で
一度も食い違わなかった**——つまり、この corpus では「`withinLimit` の外・`passed`
の中」という `anchorPool: "passed"` が本来救うはずの帯（順位11〜40位）に、
probe自身のanchorが入ったことが**1件も無い**。以下は代表4規模(off/on-default/
on-旧回避策/on-新修正の4 arm、`d` はそのarmで実際にアンカーとして選ばれたprobe数):

| scale | ef | (a)=(b)=(c) | off gold | on-default gold(d) | on-旧回避策(limit=40,anchorCount=40) gold(d) | on-新修正(pool=passed,anchorCount=40) gold(d) |
|---|---|---|---|---|---|---|
| 62 | 40 | 12/12 | 0/12 | **12/12** (12/12) | 9/12 (12/12) | 5/12 (12/12) |
| 62 | 120 | 12/12 | 0/12 | **12/12** (12/12) | 9/12 (12/12) | 5/12 (12/12) |
| 1000 | 40 | 12/12 | 0/12 | **12/12** (12/12) | 10/12 (12/12) | 4/12 (12/12) |
| 1000 | 120 | 12/12 | 0/12 | **12/12** (12/12) | 10/12 (12/12) | 4/12 (12/12) |
| 3000 | 40 | 1/12 | 0/12 | 0/12 (1/12) | 1/12 (3/12) | 0/12 (1/12) |
| 3000 | 120 | 1/12 | 0/12 | 0/12 (1/12) | **10/12** (12/12) | 0/12 (1/12) |
| 10000 | 40 | 0/12 | 0/12 | 0/12 (0/12) | 0/12 (0/12) | 0/12 (0/12) |
| 10000 | 120 | 0/12 | 0/12 | 0/12 (0/12) | 0/12 (0/12) | 0/12 (0/12) |

平均レイテンシ（scale=10000、ef=40、`recall()` 1回あたり）: off 64.3ms /
on-default 39.1ms / on-旧回避策 191.0ms / on-新修正 130.2ms。**アンカー数が
増えるほど `getVectors`/アンカーごとの `search()` 呼び出しが増え、素直に遅くなる**
（ADR 0308「引き受けた負債」3番が予期していたとおり）。

**読み方**:

1. **62・1000（小〜中規模）**: `(a)=(b)=(c)=12/12`——アンカーは常に`withinLimit`
   （上位10件）の中に居る。この状態で `anchorPool: "passed"` を使うと、母集合が
   `withinLimit`（最大10件）から `passed`（最大40件）へ無条件に広がり、
   **本来救う必要のない代わりに、無関係な30件が新たにアンカー候補へ混じる**。
   その結果、連想枠の再結合（`maxCount=10`枠の奪い合い）で本来の gold が
   押し出され、**goldReturnedが12/12から4〜5/12へ悪化する**（`on-旧回避策`も
   同じ理由で9〜10/12へ悪化するが、`anchorPool:"passed"`ほどではない——
   `limit`を上げる方は返す`memories`自体が40件に増えるため、gold自身が
   `withinLimit`に残りやすい面がある一方、`anchorPool:"passed"`は`limit`を
   変えないため`memories`は10件のままで競合が起きやすい）。
2. **3000・10000（大規模）**: `(a)=(b)=(c)`が1/12・0/12へ急落する——**probe自身の
   anchorが、段2の閾値どころか段1の生ANN kPrime(既定40)件にすら入らなくなる**。
   これは `anchorPool` が触る段（`passed`→`withinLimit`の絞り込み）より**手前**の
   崩れであり、`anchorPool: "passed"`は原理的に届かない（ADR「引き受けた負債」1番
   がまさにこれを予期していた）。**この帯を広げるには`limit`（≒`kPrime`）自体を
   上げるしかない**——実際、`on-旧回避策`（`limit=40`→`kPrime=160`）だけが
   scale=3000/ef=120で10/12まで回復している。**ただし`ef_search`を上げるだけ
   （`limit`はそのまま、既定`kPrime=40`）では一度も回復しなかった**——
   scale=3000のon-default/on-新修正はef=40でもef=120でも0/12のまま
   （`hnsw.ef_search`はHNSWグラフ探索の**精度**を上げるだけで、`kPrime`という
   **窓の大きさ**そのものは広げないため。窓の外にあるものは、探索精度をいくら
   上げても見えない）。

### 7.3 `anchorCount` を控えめ（10）にしても結論は変わらない

7.2 の `anchorCount=40`（`kPrime`の上限いっぱい）は極端な設定であり、
「悪化」が単にその極端さのせいではないかを確かめるため、`anchorCount=10`
（`maxCount`と同数、より現実的な値）でも同じ4点+3点（scale=1500/2000/2500、
ef=40のみ）を測り直した:

| scale | ef | (a)=(b)=(c) | on-default gold | on-新修正(anchorCount=40) gold | on-新修正-控えめ(anchorCount=10) gold |
|---|---|---|---|---|---|
| 1000 | 40 | 12/12 | 12/12 | 4/12 | 9/12 |
| 1000 | 120 | 12/12 | 12/12 | 4/12 | 9/12 |
| 1500 | 40 | 8/12 | 7/12 | 2/12 | 6/12 |
| 2000 | 40 | 1/12 | 1/12 | 0/12 | 1/12 |
| 2500 | 40 | 9/12 | 6/12 | 2/12 | 5/12 |
| 3000 | 40 | 1/12 | 1/12 | 0/12 | 1/12 |
| 3000 | 120 | 1/12 | 1/12 | 0/12 | 1/12 |

**`anchorCount`を10へ下げると悪化の幅は縮む（控えめのほうが40より常に良い）が、
それでも既定を上回った点は1つも無い**——最良でも同着（scale=2000/3000）、
それ以外は全て既定より少ない。⟹ 「アンカー数が極端すぎた」だけでは説明が
付かない、`anchorPool: "passed"`自体の性質である。

### 7.4 なぜ「passedの中・withinLimitの外」という帯が空だったのか（推測、確かめていない）

`ASSOCIATION_PROBES`の三角形設計（query ≈ anchorを強く作る）そのものが、
「anchorの順位が10位と40位の間」という中間状態を作りにくくしている可能性がある
——**anchorはqueryに強く似せて設計されているため、生き残るときは大抵上位に
生き残り、死ぬときはfillerに押し出されて一気にkPrimeの外まで落ちる**、という
二値的な振る舞いを、この12 probe × 7規模の観測範囲では一貫して示した
（`(a)=(b)=(c)`が食い違った組が1つも無い、という上の事実そのもの）。

**⟹ 確かめていないこと**: 本物のテナントの記憶集合（多様な話題・多様な強さの
類似度分布を持つ）で、この中間帯（11〜40位）が実際に埋まる状況があるかは
測っていない——`ASSOCIATION_PROBES`はこの中間帯を意図的に作る設計にはなって
いない（三角形は「query≈anchor」を強くするよう作られており、「anchorの順位が
ちょうど`limit`と`kPrime`の間になる」ことは設計目標に入っていなかった）。
**もし本番データでこの中間帯が実際に埋まるなら、`anchorPool: "passed"`は
そこでは効くはずである**——本 ADR の実測はそれを否定していない。**否定して
いるのは「この12 probeのこの合成 filler では、その中間帯が一度も観測されな
かった」という1点である。**

### 7.5 この道具について

`examples/chat/src/bench/association-anchor-pool-scale-bench.ts`として
コミットした（`pnpm --filter @mnemora/example-chat run association-anchor-pool-scale-bench`）。
`lexical-tie-density-bench.ts`（Issue #394）・`packages/postgres/src/bench/scale-bench.ts`
と同じ規律——CIには載せない・exit codeは常に0・スケール/ef_searchは環境変数で
振れる。旧`tmp-scale-bench-377.ts`（前任者の使い捨てスクリプト、`digest`文字列
比較でgoldを判定していた）は本コミットで削除した——本ベンチは`ObserveResult.
memoryIds`から直接memoryIdを取るため、この脆さを持たない。

### 7.6 この ADR の状態について

**上の実測により、3節が提案する`anchorPool: "passed"`は、測った範囲では
Issue #377が報告した問題を解決していない**——大規模（3000・10000）では
届かず（そもそも段1のANN窓の外）、小〜中規模（62・1000・1500・2500）では
既定より悪化する。**唯一プラスに働いたのは`ef_search=120`と`limit=40`
（`旧回避策`、PR #430が既に指摘していた案）を**併用**したときだけ**
——しかしそれは本 ADR が「費用が目的外にまで及ぶ」として退けた案そのものである。

**⟹ 本 ADR は「提案」のまま、状態を「採用」へ進めない。** 実装（`anchorPool`
欄の追加）そのものは既定の挙動を1バイトも変えない**安全な**任意欄の追加であり、
歯（`recall-association.test.ts`）は変異試験で赤/緑を確認済みである
（PR本文参照）——**壊れているわけではない**。だが、Issue #377の目的
（規模が伸びても連想の起点を保つ）を、実測した範囲では達成していない。
**この実装を出す意味があるか（① 中間帯が実在するテナントのために先回りで
用意する任意機能として出す／② Issue #377を「未解決」のまま閉じずに再検討する
／③ この PR自体を見送る）は、書き手には決められない——オーナー判断を仰ぐ**
（`docs/autonomy.md`が定める「オーナー判断を待つ点」の実例）。

## 参照

- [Issue #377](https://github.com/takecchi/mnemora/issues/377) — 本 ADR が直す実測の報告
- [PR #430](https://github.com/takecchi/mnemora/pull/430) — `limit` が天井であることを doc に書いた先行 PR（実装は変えていない）
- [ADR 0151](./0151-recall-association-unprompted.md) — 連想枠そのものの設計。「アンカーはクエリに実際に当たった候補から取る」という制約の出所
- [ADR 0168](./0168-examples-chat-uses-association.md) — `examples/chat` が連想枠を既定で使う（`maxCount=10`）。本 ADR が触れていない呼び出し
- [Issue #337](https://github.com/takecchi/mnemora/issues/337) — 連想枠を既定 on にするかを10万行級で測ってから判断する（オーナー決定）。本 ADR の射程外
- [ADR 0289](./0289-recalled-memory-speaker-subject.md) / [ADR 0282](./0282-score-breakdown-affinity-measured.md) — 「任意欄の純追加」で非破壊に足す型の先例
- [ADR 0178](./0178-public-api-surface-gate.md) — 「新しい任意プロパティの追加」を semver 的に安全と明記した根拠
- `docs/recall.md` §9.2 / §9.2.1 — 実装の記述と、本 ADR が足した escape hatch の doc

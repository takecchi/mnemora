# ADR 0306: `RecallAssociationQuery.anchorPool` を任意欄として足す — アンカーの母集合を、既定を変えずに `limit` の外へ広げる（Issue #377）

- **状態**: 提案 (2026-09)
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

<!-- MEASUREMENT_SECTION_PLACEHOLDER -->

## 参照

- [Issue #377](https://github.com/takecchi/mnemora/issues/377) — 本 ADR が直す実測の報告
- [PR #430](https://github.com/takecchi/mnemora/pull/430) — `limit` が天井であることを doc に書いた先行 PR（実装は変えていない）
- [ADR 0151](./0151-recall-association-unprompted.md) — 連想枠そのものの設計。「アンカーはクエリに実際に当たった候補から取る」という制約の出所
- [ADR 0168](./0168-examples-chat-uses-association.md) — `examples/chat` が連想枠を既定で使う（`maxCount=10`）。本 ADR が触れていない呼び出し
- [Issue #337](https://github.com/takecchi/mnemora/issues/337) — 連想枠を既定 on にするかを10万行級で測ってから判断する（オーナー決定）。本 ADR の射程外
- [ADR 0289](./0289-recalled-memory-speaker-subject.md) / [ADR 0282](./0282-score-breakdown-affinity-measured.md) — 「任意欄の純追加」で非破壊に足す型の先例
- [ADR 0178](./0178-public-api-surface-gate.md) — 「新しい任意プロパティの追加」を semver 的に安全と明記した根拠
- `docs/recall.md` §9.2 / §9.2.1 — 実装の記述と、本 ADR が足した escape hatch の doc

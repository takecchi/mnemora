# ADR 0337: 連想枠（`RecallQuery.association`）の既定を on にする（Issue #337）

- **状態**: 採用 (2026-09-26)
- **日付**: 2026-09-26

**出所: オーナーの決定（ask_human ac5953d1、2026-09-25T21:11Z、選択肢「あ」）。**

> 本文はクローン miku の委譲先が書いた。オーナー本人の執筆ではない。決定そのもの
> （下の「決定」節）は上記 ask_human の回答に基づくが、実装方法・ADR の構成・言葉選びは
> 委譲先の担い手が行った。投稿者名 `takecchi` はオーナー本人を意味しない
> （[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。

**出所の凡例**（ADR 0246・0308・0327・0335 の体裁を踏む）。

- **【現物】** — この repo のコード・文書をこの ADR の書き手が読んで確かめたもの。
- **【実測】** — この書き手が `git`/`vitest`/`tsc`/`pnpm` を実際に走らせて確かめたもの。
- **【受】** — Issue のコメント・先行 ADR からの引用で、この書き手が再導出していない箇所。

断りの無い【現物】は、`origin/main` = `925f974`（PR #833 のマージ）の木を、2026-09-26 に
読んだ記録である。

---

## 背景

### Issue #337 の経緯

[Issue #337](https://github.com/takecchi/mnemora/issues/337) は、連想枠
（`RecallQuery.association`、[ADR 0151](./0151-recall-association-unprompted.md)）の
既定を off から on へ変えるかどうかを扱っている。オーナーは 2026-09-16 の Issue 本文で
「10万行級で測ってから既定 on をやるか判断してほしい」と述べていた【受】。62件規模の
先行実測（同 Issue 本文が引く数字）は、連想枠を on にすると `maxCount=10` で
gold 到達 12/12（`memoryChars` +4.32%）、off では 0/12 だった。

### ADR 0332 の10万行級実測と、その追記が見つけたもの

[ADR 0332](./0332-association-default-100k-measurement.md)（状態: 提案）が、Issue #337 の
依頼に沿って 62件・1万行・10万行での到達・費用・latency・EXPLAIN・ビット同一性を測定した。
ADR 0332 は判定を持たない記録として書かれており、本文の測定（配置 (A)/(B)/(R)、いずれも
base（正解文を含む62文）を先頭にまとめて挿入する構造）では、規模が上がるにつれ到達が
下がって見えた（例: 10万行 配置(A) の on-10 が 0/12）。

ADR 0332 の「追記 2026-09-26 (2)」が、base の挿入位置（先頭・末尾・散らす）を振って
再測定した結果、この到達の低下が連想枠そのものの性質ではなく、ベンチの構築（正解文を
まとめて先頭に置く）に起因することを示した:

| 挿入の型 | 1万行 aRaw | 到達 on-3 | 到達 on-5 | 到達 on-10 |
|---|---|---|---|---|
| base-first（既存ベンチと同じ） | 0/12 | 0/12 | 0/12 | 0/12 |
| base-last | 12/12 | 8/12 | 10/12 | 10/12 |
| base-interleaved | 11/12 | 8/12 | 9/12 | 9/12 |

base を末尾や散らして挿入すると、on はいずれの `maxCount` でも 7〜10/12 まで到達する一方、
off は全ての配置・全ての挿入位置で 0/12 のままだった。ADR 0332 自身は「この結果を
連想枠の既定 on/off の判定には使わない」と明記しており、10万行級の実測は
Issue #337 が求めていた「確定的な材料」には至っていない。

### オーナーの決定

**ask_human ac5953d1（2026-09-25T21:11Z）で、オーナーは選択肢「あ」（連想枠の既定を on に
する）を選んだ。** 上記の経緯（10万行級の実測が確定していない段階での決定）を踏まえた
判断であり、この ADR はその決定を実装した記録である。

---

## 決定

### 決定1: `RecallQuery.association` の既定を on にする

`packages/core/src/recall.ts` に新しい export を追加した:

```ts
export const DEFAULT_RECALL_ASSOCIATION: RecallAssociationQuery = {
  maxCount: 10,
};
```

`RecallQuery.association` を省略（`undefined`）した呼び出しでは、`recall-runtime.ts` の
段3.5がこの値を適用する。`association: null` を明示した呼び出しでは、段3.5全体がスキップ
され、[ADR 0151](./0151-recall-association-unprompted.md) 以前の挙動（連想を一切走らせ
ない）に戻る。`undefined`（省略）と `null`（明示 off）を区別する必要があるため、
`RecallQuerySchema` の `association` 欄は `RecallAssociationQuerySchema.nullable().optional()`
とした。

### 決定2: `maxCount: 10` は仮値として引き継ぐ

`DEFAULT_RECALL_ASSOCIATION.maxCount` の値 `10` は、62件規模のベンチで gold 到達
12/12（`memoryChars` +4.32%）を得た値をそのまま使った。10万行級の実測（ADR 0332）は
この値を積極的に支持する新しい実測ではなく、また値を変えるべきだと示す実測でもない
——上記のとおり確定していない。この ADR は `maxCount` の値そのものを実測から導出しては
おらず、既存の62件規模の実測を根拠として引き継いだだけである。値を見直す場合の経路は
下の「これが覆るとしたら」に書く。

### 決定3: `examples/chat` の独自既定は維持する

`examples/chat/src/mnemora-path.ts` の `DEFAULT_MNEMORA_PATH_ASSOCIATION`
（[ADR 0168](./0168-examples-chat-uses-association.md) が導入した、`packages/core` の
既定が off だった当時から独立に on を選んでいた値、内容は同じ `{ maxCount: 10 }`）は
この ADR では変更していない。`packages/core` 側の既定が on になったことで、この関数だけが
持っていた独自のオプトインという位置づけは意味を失っていないため（`packages/core` の
既定と `examples/chat` の既定は、たまたま同じ値を独立に持っている2つの設定として扱う）。

`queryRecall`（`mnemora-path.ts`）の `opts.association: null` は、`packages/core` の
既定が off だった間は「`association` キー自体を省略して転送する」ことで off を実現して
いた（省略＝off が一致していたため）。`packages/core` の既定が on になると、この転送方法
では `opts.association: null` の呼び出しが黙って連想 on になってしまう。これを避けるため、
`queryRecall` は `null` を省略せず `packages/core` へそのまま転送するよう変更した——
`memory-usage-reinforce.postgres.test.ts` が「`packages/core` 既定の off のまま呼ぶ脱出口」
という契約でこの経路に依存していたための修正である。

### 決定4: `examples/chat` の測定の腕は `association: null` で基準線を固定する

`consolidation-cost.ts`・`archive-sweep-cost.ts`・`identifier-arm.ts`・
`correction-candidate-arm.ts`・`time-term-arm.ts`・`time-weighting-bench.ts`・
`validity-arm.ts`・`local-noise-arm.ts`・`intrusion-margin-candidates.ts`・
`retrieval-quality.ts` など、`examples/chat` の各種ベンチ・比較用の arm は、連想枠を
測定の対象にしていない箇所で `recall()`/`queryRecall()` に `association: null` を明示する
形へ揃えた。連想枠の既定が on になったことで、これらの arm が測ろうとしている値
（例: claim key の効果、time weighting の効果）に連想枠由来の変動が紛れ込むことを避けた
——各ベンチの基準線は、連想枠の既定 on/off という今回の変更の影響を受けない。

### 決定5: `RecallFootprintShape.associationCount` の既定は `0` のまま据え置く

`packages/core/src/recall-footprint.ts` の `estimateRecallFootprint` が受け取る
`associationCount`（連想枠が実際に本体へ昇格させると見込む件数、呼び手が明示的に渡す値）
の既定は `0` のまま変えていない。`recall()` 自身の連想枠の既定が on になったことで、
「`associationCount` を省略した見積もりが、連想を使わない呼び出しと1バイトも変わらない」
という以前の前提は成立しなくなったが、`maxCount`（連想枠が試みる上限）と
「実際に何件が本体へ昇格するか」は別の値であり、`packages/core` が後者を前者から
代わりに推測することはしていない。見積もりを正確にしたい呼び手は、
`footprintSampleFromRecall` による較正か、過去の実測から求めた値を明示的に渡す形になる。

---

## 型・公開 API への影響

- `RecallQuery.association?: RecallAssociationQuery | null`（入力側が `| null` に広がった。
  `RecallAssociationQuery` 型自体は無変更）。
- 新しい export: `DEFAULT_RECALL_ASSOCIATION: RecallAssociationQuery`。
- `RecallUsage.byTier.association` の存在条件が「`association` を渡したかどうか」から
  「連想枠を実際に走らせたかどうか」に変わった——既定 on になったので、`association` を
  省略した通常の呼び出しでもこの欄が現れる。欄が無いのは `association: null` を明示した
  呼び出しだけである。
- `RecalledMemory.retrievedVia` の `"association"` 値そのものは [ADR 0151](./0151-recall-association-unprompted.md)
  から存在しており、この ADR で新設したものではない。既定で現れるようになったのは値の
  出現条件であって、union に新しい値を追加したのではない。

**破壊的変更ではない**——公開 API の実 diff（`scripts/__snapshots__/public-api/core.d.ts`）
は、既存の入力型が `| null` に広がったことと、定数 `DEFAULT_RECALL_ASSOCIATION` が1つ
増えたこと以外の差分を持たない。既存の呼び出し（`association` を渡していた呼び出し・
渡していなかった呼び出しのどちらも）は型検査上そのまま通る。PR 本文に判定の詳細を書く。

**既定の挙動としては変わる**——`association` を渡していなかった呼び出しは、
`recall()` の結果に連想枠経由の記憶（`retrievedVia: "association"`）が新たに混ざる
可能性がある。既定で返る記憶の顔ぶれ・件数はこの変更の前後で変わりうる。従来どおりの
挙動に戻したい呼び出しは `association: null` を渡す。

---

## examples/chat の独自既定を維持した理由

決定3で述べたとおり、`DEFAULT_MNEMORA_PATH_ASSOCIATION`（ADR 0168、`{ maxCount: 10 }`）は
`packages/core` の既定が off だった当時から `examples/chat` が独立に持っていた値である。
この ADR は `packages/core` 側の既定だけを変えており、`examples/chat` 側の既定を
`DEFAULT_RECALL_ASSOCIATION` に連動させる変更は行っていない。値が同じ（`{ maxCount: 10 }`）
であるため挙動は変わらないが、由来は別であり、どちらか一方を見直すときにもう一方が
自動的に追随するわけではない。

---

## これが覆るとしたら

- **`DEFAULT_RECALL_ASSOCIATION.maxCount` の根拠が見直されたとき**——この値はいまの時点で
  最も根拠のある仮値であって確定値ではない（決定2）。実運用の分布での再測定、または
  ADR 0332 の「揺れの機構」（独立 ingest 間で到達が大きく揺れる原因、pgvector の
  HNSW 構築における挿入順の影響）がさらに切り分けられて確度の高い実測が得られたとき、
  値を変える根拠になりうる。変えるべき箇所は `packages/core/src/recall.ts` の
  `DEFAULT_RECALL_ASSOCIATION` の1箇所である（`anchorCount`/`minSimilarity` は個別の
  既定に委ねており、ここでは上書きしていない）。
- **既定 on による誤検出・想定外の記憶の混入が実 API で測定され、悪影響が確認されたとき**
  ——この ADR は `deterministic`/`local` 層での構造的な測定・回帰テストの範囲で判断されて
  おり、`recorded`/`openai` 層での既定 on の影響（回答の質、誤って関連づけられた記憶が
  回答へ混ざる頻度）は測定していない。
- **10万行級の実測が、揺れの機構を排除した形で確定した結果、既定を再検討する材料が
  揃ったとき**——ADR 0332 の追記(2)はベンチの構築由来の交絡を1つ見つけたが、他の交絡が
  無いとは確認していない。

---

## 確かめていないこと

- **実運用の分布・実 API（`recorded`/`openai` 層）での既定 on の効果**——この ADR の実装は
  `deterministic`（配線・契約・適合テスト）と `local`（`packages/postgres` の DB テスト）の
  層でしか確認していない。`examples/chat` の `answer`/`compare` 系のベンチを実 API で
  再測定する作業はこの ADR・PR の範囲外である。
- **ADR 0332 が測っていないこと全般**（同 ADR §9・追記(2) A.6 参照。特に、HNSW の
  到達性が独立 ingest ごとに揺れる根本機構は、base の挿入位置が一因であることまでは
  分かったが、機構そのもの——pgvector のグラフ構造——は確かめていない）。
- **`DEFAULT_RECALL_ASSOCIATION.maxCount=10` が実運用の記憶量・分布に対して最適か**
  ——62件規模のベンチでの到達最大化という基準でしか選ばれていない。

---

## 関連

- [Issue #337](https://github.com/takecchi/mnemora/issues/337) — この ADR が実装する決定の依頼元
- [ADR 0151](./0151-recall-association-unprompted.md) — 連想枠そのものの設計・既定 off の根拠（決定3。この ADR が反転させた決定）
- [ADR 0166](./0166-recall-footprint-association-term.md) — `estimateRecallFootprint` の `associationCount` の既定 `0`（この ADR の決定5が、`recall()` 自身の既定が on になった後も据え置いた値）
- [ADR 0168](./0168-examples-chat-uses-association.md) — `examples/chat` が独自に連想枠を既定で使う（この ADR では変更していない）
- [ADR 0332](./0332-association-default-100k-measurement.md) — Issue #337 の依頼に沿った10万行級の測定記録（状態: 提案。判定を持たない。オーナーはこの実測が確定する前に決定した）

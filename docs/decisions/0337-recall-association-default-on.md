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

---

## 追記（2026-09-26）

> 本文はクローン miku の委譲先が書いた。オーナー本人の執筆ではない。依頼元は
> クローン miku（オーナーではない）——リリース 1.1.0 の前に、既存の記録済みベンチの
> 上で連想枠の既定 on が何を動かすかを測って残してほしい、という委譲である。
>
> **⛔ これは既定を戻すかどうかを決めるための測定ではない。記録である。** 上の
> 「決定」節・「これが覆るとしたら」節の判断そのものは変えていない。

### 目的

決定2・「確かめていないこと」が明記するとおり、`DEFAULT_RECALL_ASSOCIATION.maxCount=10`
の根拠は合成12問（ADR 0332/0168）だけであり、`examples/chat` の既存の記録済みベンチ
（`retrieval`/`compare`/`time-term`/`validity`/`answer-time-weighting`/`answer`、
および `identifier-probes`/`numeral-token-probes`/`consolidation-cost`）に対する
既定 on の影響はこの ADR 自身が測っていなかった。この追記は、その影響の**大きさ**
（品質指標・載る量・`omitted` の内訳・連想枠経由の件数）を実測して残す。

### 条件

- **sha**: `origin/main` = `d500ad4`（この ADR 自身のマージ commit、PR #838）の木。
- **枝**: `measure/association-default-on-2026-09-26`。
- **道具**: `examples/chat/src/bench/association-default-on-measure.ts`
  （新設。`association-default-on-measure-lib.ts` に純関数を分離）。各ベンチの
  arm/オプションへ **省略可能な `association` オプションを足しただけ**——既存の
  呼び出し（この欄を渡さない呼び出し）は1バイトも挙動が変わらない
  （`RunRetrievalQualityArmOptions.association` 等、各ファイルの docstring参照）。
- **層**（⚠ ベンチごとに違う。一括ではない——詳細・理由は
  [examples/chat/bench-results/association-default-on-2026-09-26/README.md](../../examples/chat/bench-results/association-default-on-2026-09-26/README.md)）:
  - `retrieval-quality`/`compare`: `recorded` カセット（`retrieval.json`/`compare.json`）。
    連想枠は `VectorStore.getVectors`/`search` しか呼ばない（`embeddingProvider`/
    `llmProvider` に触れない）ため、on にしてもカセットに無い入力は出なかった
    （実測。例外0件）。
  - `time-term`/`validity`/`identifier-probes`/`numeral-token-probes`/
    `consolidation-cost`/`answer-time-weighting`/`answer`: `MNEMORA_EMBEDDING=local`
    （プロセス内 ONNX 推論。CLI の既定が `deterministic`+`deterministic` のベンチ
    （`time-term`/`validity`）も、この測定だけ embedding を `local` へ上書きした
    ——`deterministic` 埋め込みでは連想枠が拾う近傍が意味を持たないため）。
    `answer-time-weighting`/`answer` は **recall 側の量だけ**を読み、回答の正誤
    （verdict）は読んでいない（`llmMode=deterministic` の出力に正誤の意味を
    持たせられないため）。
- **コマンド**:
  ```
  MNEMORA_ASSOCIATION_DEFAULT_ON_MEASURE_JSON=examples/chat/bench-results/association-default-on-2026-09-26/measure-run.json \
    pnpm --filter @mnemora/example-chat run association-default-on-measure
  ```
- **決定性**: 同じ条件で2回走らせ、`headline`（下の表の数字の出所）が全ベンチ・
  全4段で一致することを確認した
  （`examples/chat/bench-results/association-default-on-2026-09-26/determinism-check.json`、
  `allMatched: true`）。生の `score.decay`/`score.freshness`（壁時計依存、
  ADR 0033/0109 が既に記録している 1e-7 桁の揺れ）は2回の実行で一致しない
  ——これはこの追記が測る対象（連想枠の on/off）とは無関係な、この repo が
  既に記録済みの性質である。
- **実 API**: 呼び出し回数 **0**。理由は上の「層」節と
  [README](../../examples/chat/bench-results/association-default-on-2026-09-26/README.md)
  「実 API」節に書く——この測定が読む差は `recorded`/`local` 層で構造的に決まり、
  「回答の正誤が on/off で変わるか」のような実 API が要る問いをそもそも対象にしていない。

### off と on10（既定）の差

| ベンチ | 指標 | off | on10 | 差 |
|---|---|---|---|---|
| retrieval-quality(7probe, arm B相当) | mrrOverall / hit@1 / hit@10 | 0.714 / 4/7 / 6/7 | 0.714 / 4/7 / 6/7 | **変化なし** |
| retrieval-quality | recalledRows(候補行の総数) | 70 | 105 | +35(+50.0%) |
| retrieval-quality | associationRows(連想枠経由の件数) | 0 | 35 | +35 |
| retrieval-quality | omitted `over_limit` | 7 | 10 | +3(+42.9%) |
| compare(全12会話長) | totalMnemoraChars(全12行の合計) | 15885 | 15655 | -230(-1.4%、**減少**) |
| compare | totalReturnedCount | 78 | 108 | +30(+38.5%) |
| compare | associationRows | 0 | 30 | +30 |
| compare | factStatementSurvivedCount(出典到達、12件中) | 12 | 12 | **変化なし** |
| time-term(8probe) | outcome tally | newer-ranked-higher=4, older-not-returned=1, tied=3 | newer-ranked-higher=5, older-not-returned=0, tied=3 | older-not-returned の1件が newer-ranked-higher へ移った |
| validity(2probe) | current@now / other@now / historical.otherReturned / optOut.otherReturned | 2/2, 0/2, 1/1, 2/2 | 同じ | **変化なし**(ゲートは連想枠と無関係に機能している) |
| identifier-probes(30probe, sparse) | hit@1 / hit@10 | 30/30 | 30/30 | **変化なし** |
| identifier-probes | associationRows | 0 | 300 | +300 |
| numeral-token-probes(18probe, sparse) | hit@1 / hit@10 | 15/18 / 18/18 | 15/18 / 18/18 | **変化なし** |
| numeral-token-probes | associationRows | 0 | 180 | +180 |
| consolidation-cost(budgetLadder=[32,128]、この測定専用に縮小) | round0.unbudgeted.mean.usageChars | 4418.6 | 4649.6 | +231(+5.2%) |
| consolidation-cost | round0.gold到達(7probe中) | 7 | 7 | **変化なし** |
| answer-time-weighting(recall側、dev6件) | meanRecallMemoryCount / meanInputChars | 1.17 / 177.7 | 1.67 / 220.5 | +0.5(+42.9%) / +42.8(+24.1%) |
| answer(recall側、dev+eval14件) | meanInputChars / meanReturnedCount | 418.1 / 3.71 | 418.1 / 3.71 | **変化なし** |

### maxCount 5/10/20 の比較

| ベンチ | 指標 | on5 | on10 | on20 |
|---|---|---|---|---|
| retrieval-quality | associationRows | 20 | 35(+75.0%) | 60(+200.0%) |
| retrieval-quality | recalledRows | 90 | 105(+16.7%) | 130(+44.4%) |
| compare | totalMnemoraChars | 15473 | 15655(+1.2%) | 16024(+3.6%) |
| compare | totalAssociationRows | 19 | 30(+57.9%) | 47(+147.4%) |
| time-term | outcome tally | on10 と同じ | (基準) | on10 と同じ |
| validity | 全指標 | on10と同じ | (基準) | on10と同じ |
| identifier-probes | associationRows | 150 | 300(+100.0%) | 600(+300.0%) |
| numeral-token-probes | associationRows | 90 | 180(+100.0%) | 360(+300.0%) |
| consolidation-cost | round0.unbudgeted.mean.usageChars | 4534.4 | 4649.6(+2.5%) | 4873.1(+7.5%) |
| answer-time-weighting | meanRecallMemoryCount / meanInputChars | 1.67 / 220.5 | on5と同じ | on5と同じ |
| answer | 全指標 | on10と同じ | (基準) | on10と同じ |

生の数字・ベンチごとの `raw` report は
[measure-run.json](../../examples/chat/bench-results/association-default-on-2026-09-26/measure-run.json)
にある。

### 読み取れること

- **品質指標（hit@1/hit@10/mrr/gold到達）は、測った全ベンチで off/on10/on5/on20 の
  間で変化しなかった。** 連想枠が既存の gold/distractor の順位を動かした実例は
  今回の測定には無い——連想枠経由の候補（`associationRows`）は既存の ANN 候補と
  別枠で末尾に追加されており、既存の上位候補を押し下げていないと読める（実測の
  範囲内。理論的な保証ではない）。
- **一方、「載る量」は on にすると明確に増える。** `associationRows`/
  `recalledRows`/`totalReturnedCount` は on10 で off の数倍〜数十件増え、
  `maxCount` を5→10→20と上げるとほぼ線形に増える(retrieval-quality: 20→35→60、
  identifier-probes: 150→300→600、numeral-token-probes: 90→180→360)。
  `compare` の `totalMnemoraChars`（全12会話長の合計）は on10 でわずかに**減った**
  （-1.4%）——`totalReturnedCount`（+38.5%）と方向が逆になっている。これは
  `mnemoraChars` が `recall().usage.chars`（budget無しの生の量）であり、連想枠の
  候補は既存の候補より digest が短い場合がある・件数が増えても短い会話長側の
  絶対値が支配的、といった構成上の理由が考えられるが、**この測定はその原因を
  切り分けていない**（下の「確かめていないこと」）。
- **`answer`（recall側、dev+eval14件）だけは off/on5/on10/on20 で完全に無変化
  だった。** `meanTotalInScope=3.71`（各ケースのスコープ内 Memory 数の平均）が
  既定の `limit`（10件）を下回っており、ANN 段だけで全件が既に返っている
  ——連想枠が追加できる残りの候補がそもそも存在しない構成だったと読める。
  `answer-time-weighting`（同じ recall 側の量を測る枠組みだが、記憶を直接書く
  ぶん `answer` より1ケースあたりの記憶数が多い）では実際に量が動いている
  （+42.9%/+24.1%）ことと整合する。
- **`time-term` は1probeで `older-not-returned` → `newer-ranked-higher` へ
  outcome が移った。** ペア（newer/older）の一方が off では返らず、on では
  連想枠経由で拾われた結果、ペア判定自体が変わった実例である。この arm は
  「時制の新旧判定」を測る目的で `association: null` を基準線に固定している
  （決定4）ため、この1件の移動は基準線には現れない——この追記でだけ見える。
- **`consolidation-cost`/`answer-time-weighting`/compare の `over_limit` の
  微増**（+2〜+3件）は、連想枠が追加した候補の一部が `limit` の外へ落ちている
  ことを示す——連想枠は予算内側に候補を積むが、`limit` そのものは連想枠のために
  拡げられていない（`recall-runtime.ts` の既存の設計、この追記が新しく確かめた
  ものではない）。
- **`recorded`/`local` 層のどちらでも、連想枠を on にして「カセットに無い入力」の
  例外は0件だった。** ADR 0337 決定4・本文が述べる「連想枠は `VectorStore.
  getVectors`/`search` しか呼ばない」という設計上の理由と一致する——on にしても
  `embeddingProvider`/`llmProvider` への新しい呼び出しは増えない。

### 確かめていないこと

- **実運用の記憶量・分布での効果**（この ADR 自身の「確かめていないこと」と同じ
  範囲）。今回測ったのは既存ベンチの合成データ（数件〜数十件規模）であり、
  ADR 0332 が扱った10万行級の規模はここでは測っていない。
- **`compare` の `totalMnemoraChars` が on で減った理由**。方向が直感と逆
  （件数は増えたのに合計文字数はわずかに減った）だが、この追記はその原因
  （digest の長さの分布・会話長ごとの内訳）を切り分けていない。
  `measure-run.json` の `compare[].raw`（会話長ごとの行）を読めば追跡できるが、
  この追記では行っていない。
- **`identifier-probes`/`numeral-token-probes` は sparse haystack の群だけを
  測った。** dense haystack・日本語固有名詞群（既存 CI ジョブが測る他の3群）は
  時間の都合で対象外にした。
- **`archive-sweep-cost` は実行していない。** `association` オプション自体は
  `archive-sweep-cost.ts` に足した（加算）が、`decayClock`/`MutableClock` による
  backdate・`sweepArchive()` の呼び出しを正しく組むコストが他のベンチより高く、
  この回の時間予算では見送った。
- **回答の正誤（verdict）が on/off で変わるか。** `answer`/`answer-time-weighting`
  は recall 側の量だけを読んだ——`llmMode=deterministic` の出力に正誤の意味を
  持たせられないため、この問いには実 API（`recorded`/`openai`）での再測定が要る
  （この ADR 自身の「確かめていないこと」と同じ、まだ埋まっていない項目）。
  今回はこの問いのために実 API を使う判断はしなかった——測った9ベンチのいずれも
  `recorded`/`local` 層で決定的に差を観測できたため、実 API を要する問いに
  当たらなかった。
- **`DEFAULT_RECALL_ASSOCIATION.maxCount=10` を他の値に変えるべきかという
  判断そのもの。** 上の実測は「on にするとどれだけ動くか」の記録であり、
  「10 が適切な値か」「既定を戻すべきか」への判定材料として使うことをこの追記は
  意図していない（冒頭の「⛔」の通り）。

---

## 追記（2026-09-26、回答の正誤）

> 本文はクローン miku の委譲先が書いた。オーナー本人の執筆ではない。依頼元は
> クローン miku（オーナーではない）——上の追記（2026-09-26）が「確かめていないこと」
> に残した「回答の正誤（verdict）が on/off で変わるか」を、実 API（gpt-4o-mini）で
> 最小限だけ埋めてほしい、という委譲である。
>
> **⛔ これは既定を戻すかどうかを決めるための測定ではない。記録である。** 上の
> 「決定」節・「これが覆るとしたら」節の判断そのものは変えていない。

### 条件

- **sha**: `origin/main` = `747acaf`（上の追記（2026-09-26）自身のマージ commit、
  PR #843）の木。
- **枝**: `measure/association-answer-correctness-2026-09-26`。
- **道具**: `examples/chat/src/bench/association-answer-correctness-measure.ts`
  （新設。純関数は `association-answer-correctness-measure-lib.ts` に分離、
  vitest 1ファイル付き）。
- **対象**: `answer-time-weighting` ベンチのみ。理由は「対象外にした理由」節。
- **層**（段によって違う）:
  - **段1（off/on10 でプロンプトが変わる組を数える。実 API ゼロ）**:
    `llmMode=deterministic` / `embeddingMode=recorded`（既存カセット
    `examples/chat/cassettes/answer-time-weighting.order-legend.json` を再生。
    1バイトも書き換えていない）。参考として `embeddingMode=local`（実推論、
    カセット非依存）でも同じ32組（dev6+eval6+eval-undated4=16ケース×2方針）を
    測った。
  - **段2（対にした正誤測定。実 API）**: `llmMode=openai`（`gpt-4o-mini`、
    `examples/chat/src/providers.ts` の `OPENAI_LLM_MODEL` を実測確認済み）/
    `embeddingMode=recorded`（同じ既存カセットを流用。連想枠は
    `VectorStore.getVectors`/`search` しか呼ばないため、embed() の入力集合は
    off/on で変わらず、実測でも embed() の実 API 呼び出しは0回だった）。
    temperature は明示的に渡していない（bench の既存の設定のまま。
    `OpenAILLMProvider` の provider 既定に委ねる——`answer-trials.ts` の
    `TEMPERATURE_UNSPECIFIED_LABEL` と同じ立場）。
- **コマンド**:
  ```
  DATABASE_URL=... OPENAI_API_KEY=... \
    pnpm --filter @mnemora/example-chat exec tsx \
    src/bench/association-answer-correctness-measure.ts
  ```
- **実 API 呼び出し回数**: **60回**（すべて回答生成。このベンチは judge
  （`answer-judge.ts`）を持たないため採点呼び出しは無い）。呼び出し前に
  ハードリミット（200）へ達するかを確認してから呼ぶ実装にしており、実測でも
  上限に達していない（60/200）。生データ・組ごとの回答文・verdict・プロンプト
  文字数/記憶行数は
  [examples/chat/bench-results/association-answer-correctness-2026-09-26/](../../examples/chat/bench-results/association-answer-correctness-2026-09-26/)
  に置いた。

### 段1: off/on10 でプロンプトが変わる組（実測）

32組（16ケース×2方針）のうち:

| 埋め込み層 | 変化した組数 |
|---|---|
| `recorded`（本番の層。既存カセットの実 OpenAI 埋め込み） | **6/32** |
| `local`（参考。ONNX 実推論、カセット非依存） | **14/32** |

`local` のほうが多く変化した——実推論の近傍が、カセット記録時点の実 OpenAI
埋め込みの近傍と異なるためと考えられるが、**原因の切り分けはしていない**（推測）。
実 API での正誤測定は、**`recorded`（本番の層）で変化が確認できた6組だけ**を
対象にした（マネージャー指示。`local` で変化した残り8組は対象外——「確かめて
いないこと」参照）。

変化した6組: `dev-a2-remote-work-day/legacy`,
`dev-b2-current-project/legacy`, `dev-b2-current-project/eventAwareFreshness`,
`eval-b2-relocation/legacy`, `eval-b2-relocation/eventAwareFreshness`,
`eval-undated-c1-seat-floor-reinforced/legacy`。

### 段2: 実 API（gpt-4o-mini）で対にした結果

n=5（呼び出し予算190回 ÷ (2×6組) ≈ 15.8 を、上限5でcapした値）。最初の1組×1回
（`dev-a2-remote-work-day/legacy` trial=1）で `MNEMORA_LLM=openai` +
`MNEMORA_EMBEDDING=recorded` という混在指定が動くことを確認してから残りを
回した（この1回も捨てずに本番の集計に含めている）。off→on の順で、同じ組の
同じ trial 番号を続けて呼んだ（時間による偏りを避けるため、全部の off を
先に済ませてから on をまとめて呼ぶ順序は採らなかった）。

| 組 | off 正答/n | on 正答/n |
|---|---|---|
| dev-a2-remote-work-day/legacy | 0/5 | 5/5 |
| dev-b2-current-project/legacy | 5/5 | 5/5 |
| dev-b2-current-project/eventAwareFreshness | 5/5 | 5/5 |
| eval-b2-relocation/legacy | 5/5 | 5/5 |
| eval-b2-relocation/eventAwareFreshness | 5/5 | 5/5 |
| eval-undated-c1-seat-floor-reinforced/legacy | 5/5 | 5/5 |

全体正答率: off **25/30（83.3%）** / on **30/30（100.0%）**。

対にした差（`AnswerVerdict` を `pass` のみ正解、`fail`/`indeterminate` を
不正解側として二値化。この畳み方自体が選択であり、他の畳み方もありうる）:
**on正・off誤 = 5件 / off正・on誤 = 0件 / 一致 = 25件**。

符号検定（McNemar の exact 二項検定、p=0.5、`min(5,0)=0` を使う両側検定）の
p 値 = **0.0625**。**慣習的な有意水準 0.05 を下回っていない——「統計的に有意」
とは言えない。** `n=5` では、片側に完全に振れた最も極端な結果（5勝0敗）でも
理論上の最小 p 値が 0.0625 に留まる（`2 × (1/2)^5 = 0.0625`）ため、この
サンプルサイズでは構造的に有意水準0.05に届かない。

### 揺れの範囲の見立て

- 6組中5組は off/on とも 5/5 で完全一致しており、これらについては今回の
  n=5では「正誤への影響が見えなかった」以上のことは言えない（真に無効果か、
  効果が小さくn=5では検出できなかったかを、この測定は区別できない）。
- `dev-a2-remote-work-day/legacy` の1組だけが、5/5 という試行内で完全に
  一貫した off=fail / on=pass の差を示した——単発の揺れではなく、この組・
  この温度設定では再現性のある差に見える（推測。真の成功率は測っていない。
  二項比率の信頼区間はこのサンプルサイズでは広く、例えば真の成功率が
  70%程度でも5/5が偶然出る確率は無視できない）。
- 「プロンプトが変わった」ことと「正誤が変わる」ことは別物である——段1で
  変化が確認された6組のうち、実際に正誤へ影響したのは1組だけだった。

### `answer`（18件）を対象外にした理由

`answer` ベンチ（dev6+eval8+`answer-case-set.separate-turn.ts`の4件=18件）は、
前段の前提調査（実 API ゼロ、`llmMode=deterministic`/`embeddingMode=local`）で
**off/on10 のプロンプトが全18件で1バイトも変わらないことを実測済み**——
各ケースの `totalInScope`（スコープ内の記憶総数）が recall の `limit`（既定10）
以下であり、ANN 段だけで全件が既に返っているため、連想枠が追加できる残りの
候補がそもそも存在しない（上の追記（2026-09-26）本文の「読み取れること」の
`answer` の項と同じ構造）。プロンプトが変わらなければ、同じ入力に対する
gpt-4o-mini の出力分布も（モデル自体の非決定性を除けば）区別する理由が無い
——実 API を使って比べても、答えようとしている問い（連想枠の on/off が
回答の正誤を変えるか）に対する情報が増えないため、対象から外した。

### `answer-trials` を対象外にした理由

`answer-trials`（Issue #705、`examples/chat/src/answer-trials.ts`）は
**`recall()` を一切呼ばない**——`answer-trials-material.ts` が
`examples/chat/cassettes/answer.json`（凍結済みカセット）から dev6件の
mnemora 側プロンプト文字列を直接パースして材料にする設計であり（DB・埋め込み・
抽出・recall を import すらしない、ADR 0301 の対照の基準を壊さないための
構造）、association という引数が構造的に存在しない。off 条件を試すには
`association: null` を明示して新しいカセットを記録し直す別スクリプトが要る
——今回はその作業を行っていない（下の「確かめていないこと」）。

### 確かめていないこと

- **`local` 埋め込みで変化が見えた14組のうち、`recorded` では変化しなかった
  残り8組**——実 API では測っていない（`recorded` が本番の層であるとして、
  そちらだけを対象にした）。
- **n=5より多い試行による検出力の向上**——200回という呼び出し上限の中で、
  6組×2(off/on)×5=60回に留めた。`dev-a2-remote-work-day/legacy`の効果の
  真の大きさ（成功率の差）は、この測定からは点推定（0%→100%）以上のことは
  言えない。
- **`answer-trials`/`answer-trials-compare` を association:null 条件で
  測り直すこと**——新しいカセットの記録が要る、今回は着手していない。
- **temperature を明示的に固定した場合にどう変わるか**——今回は bench の
  既存の設定（provider 既定、未指定）をそのまま使った。`answer-time-weighting`
  ベンチは `--temperature` フラグを持つが、この道具はそれを使っていない。
- **`answer-time-weighting` 以外のベンチ（`retrieval-quality`/`compare`/
  `time-term`/`validity`/`identifier-probes`/`numeral-token-probes`/
  `consolidation-cost`）の回答の正誤**——これらは元より「回答の正誤」という
  出力を持たない構造（`retrieval-quality`等は候補の順位・到達を測るもので、
  最終回答という段が無い）ため、この追記の対象にしていない。

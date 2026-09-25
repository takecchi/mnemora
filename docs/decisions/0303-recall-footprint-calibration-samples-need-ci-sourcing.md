# ADR 0303: recall-footprint 較正の補助標本は作れる(実 API 不要)が、compare-baseline.json への昇格には CI artifact が要る — 別ファイルに留めた

- **状態**: 未決 (2026-09-25)
- **日付**: 2026-09-25

---

## 背景

Issue #340 の comment 5822837148 §4 は、`recall-footprint-baseline.test.ts`（ADR 0201 / Issue #410）の
「字数で見た誤差の余白」の歯を実推定器の側で直せない理由として、較正標本の不足を挙げている:

1. hold-in（`compare-baseline.json` の `totalInScope <= DEFAULT_RECALL_LIMIT`(=10) の7行）は
   目次帯が空のまま返る最大件数が8件しかなく、82ターン行（`totalInScope=25`）まで内挿で届かない。
2. `RecallResult.index` の生の記録が無く、切片のずれが構造の問題か digest 長の問題かを
   切り分けられない。

本 ADR は、この2つを埋める補助標本を「目次帯が空のまま件数10〜20件」の範囲で作れるか
（実 API を叩かずに）を検証し、作れた場合にそれを `compare-baseline.json` へどう反映するかの
線を引く。

## 決定

### 1. 実 API を叩かずに作れる（実測で確認済み）

`buildConversation(fillerPairs)`（`scenario.ts`）は `FACT_STATEMENT` と12行の filler を
繰り返すだけの固定文面で、`fillerPairs` の値には依存しない。`buildExtractionPrompt`
（`packages/core/src/extraction.ts`）は観測1件のテキストだけで決まり、カセットの鍵
（`llmCassetteKey`、`packages/testkit`）は `PromptSpec` の SHA-256 ハッシュ——**入力内容で
決まり、呼び出し順序には依存しない**。`recall()` が呼ぶ provider は埋め込みだけで、クエリ文
（`QUERY_TEXT`、`fillerPairs` に依らず固定）の1回だけ。連想枠（`association`）は
`VectorStore.getVectors`/`search` しか呼ばず、embeddingProvider.embed は呼ばない
（`recall-runtime.ts`）。

⟹ **`fillerPairs` を `compare.ts` の `DEFAULT_COMPARE_SEQUENCE` に無い値にしても、
`RecallQuery.limit`（`packages/core` の既存の公開フィールド、`queryRecall` は使っていないが
`runtime.recall` へ直接渡せる）を上げても、新しい embedding/LLM リクエストは1つも増えない。**

【実測、2026-09-25、ローカル Postgres 17 + pgvector、`examples/chat/cassettes/compare.json`
の再生、実 API は一度も叩いていない】`fillerPairs` を6〜642まで掃引し、`limit=20` で
`RecordedEmbeddingProvider`/`RecordedLLMProvider`（カセットに無い入力では例外を投げる、
`packages/testkit`）に対して実行したところ、一度も「記録に無い」例外が出なかった。
`totalInScope`(=目次帯が空のときの返る件数)は9〜19の範囲で複数の整数値に達し、
`examples/chat/src/recall-footprint-calibration-samples.ts` の
`CALIBRATION_SAMPLE_DESIGN`(8点)として固定した。同じ設計を2回、独立に ingest して実行し、
`measuredAt` を除いて `rows`(生の `index` を含む)がバイト単位で一致した
（`examples/chat/recall-footprint-calibration-samples.dev.json` の `provenance` に記録)。

**標本の設計(どの `fillerPairs`/`limit` を使うか)は、hold-out(`compare-baseline.json` の
5行)の推定誤差を一度も見ずに、カセットの被覆(実 API を叩かずに作れる値かどうか)だけを
基準に決めた**——`recall-footprint-calibration-samples.ts` のコメント、
`.dev.json` の `provenance.designDecidedBeforeSeeingHoldOutErrors` に記録している。

### 2. だが `compare-baseline.json` へは昇格させない — 別ファイル(`.dev.json`)に留めた

`examples/chat/README.md`「`compare`」節・ADR 0119 決定6・ADR 0121 決定1は、
`compare-baseline.json`(⭐門)の値は**CI(`example-chat` job)の artifact からだけ作り、
手元では書かない**ことを求める。理由は非決定性(ADR 0170 が実例)を検出するため——
**同一commitでCIを2回以上実行し、バイト単位で一致することを確かめてから採る**手順である。

**本 ADR の標本は、この手順を経ていない。**上の「2回一致」はローカルの同一マシン・
同一プロセスでの2回の再実行であり、CI環境間の非決定性(ADR 0170 が実際に見つけたような
`ORDER BY` 起因の非決定)を検出する力を持たない。さらに、この作業を行った担い手は
PR を作る権限を持たず(委譲元の規律)、`.github/workflows/ci.yml` の `on: push:
branches: [main]` / `pull_request` という発火条件のもとでは、PR を作らない限り
このブランチに対する CI run そのものが存在しない——**CI artifact を取得する経路が
構造的に無い。**

⟹ 標本を `compare-baseline.json` の `rows` に直接足すことも、`rows` の分け方
（`holdInRows = rows.filter(r => r.totalInScope <= DEFAULT_RECALL_LIMIT)`）の条件を
変えることもしなかった。**後者にはもう1つ理由がある**: `totalInScope <= DEFAULT_RECALL_LIMIT`
という条件は「目次帯が空である」ことの代理指標であり、これまで `queryRecall` が `limit` を
一度も明示的に渡さなかった(既定値のまま呼んでいた)ために両者は常に一致していた。
**`limit` を明示的に上げる本 ADR の標本では、この一致が構造的に崩れる**
（`totalInScope=14` でも `limit=20` なら帯は空になる）。この条件をどう直すか
（`bandEntryCount` を明示フィールドとして持たせる等)は、`compare-baseline.json` の
スキーマそのものに関わる判断であり、CI-sourcing の可否とは別に、オーナー/委譲元の
判断を仰ぐべき点として切り分けた。

代わりに、`examples/chat/recall-footprint-calibration-samples.dev.json` という
**別ファイル**に、8点の標本(生の `RecallResult.index` を含む)を、上の実測プロヴェナンスと
共に置いた。**`correction-case-set.dev.ts`(held-outではない、調整用)と同じ位置づけ**——
較正への追加投入の「候補」であり、`compare-baseline.json` のような CI-sourcing の門を
経ていないことを、ファイル自身の `_readme`/`provenance` が名乗る。

### 3. 参考計算: 標本を足すと ADR 0201 の余白の歯が(いまの係数のままでは)赤くなる

`examples/chat/src/__tests__/recall-footprint-calibration-samples.test.ts` の
「較正への影響(参考計算)」節が、`calibrateRecallFootprint`/`estimateRecallFootprint`
（`@mnemora/core`、いずれも公開関数、変更していない）を使って検算している:

| | 現行(hold-in 7点) | 拡張(7+8=15点) |
|---|---|---|
| `charsPerDigest` | 15.458 | 16.336 |
| `fixedIndexChars` | 170.881 | 168.001 |
| hold-in 残差 SD / 最大絶対値 | 1.530 / 3.202字 | 2.319 / 4.328字 |
| hold-out 12行全体の最大相対誤差 | 1.562% | 2.111%(2.5%許容の内側) |
| ADR 0201 の余白(半digest, 最も狭い行) | 12.18字(42ターン行, 上側, 緑) | **7.68字(42ターン行, 下側, FLOOR=8.17字を下回り赤)** |

⟹ **2.5%の歯(`ACCURACY_TOLERANCE`)は拡張後も緑のままだが、ADR 0201 の余白の歯は
拡張すると赤くなる。** `recall-footprint-baseline.test.ts` 自体（`ACCURACY_TOLERANCE`・
`FLOOR_CHARS` の式・12行の値）は本 ADR で一切変更していない——上の表は、
`recall-footprint-calibration-samples.test.ts` 側の参考計算としてのみ存在する。

## 検討して採らなかった案

1. **`compare-baseline.json` の `rows` に直接追記する。** ⛔ 却下——CI-sourcing の規律
   （ADR 119/121/133）に反する。この担い手は PR を作れず、CI artifact を取得する経路が無い。
2. **hold-in/hold-out の分け方(`totalInScope <= DEFAULT_RECALL_LIMIT`)を
   `bandEntryCount === 0` に直す。** ⛔ 保留——委譲元の規律で「分け方の条件を変える必要が
   出たら、変えずに止まって報告する」と定められている。本 ADR はその報告を兼ねる。
3. **deterministic provider で標本を作る。** ⛔ 却下——`recorded` と `deterministic` は
   digest 長の分布が別物であり、較正の意味が変わる(委譲元の規律で明示的に止められている)。
4. **ADR 0201 の余白の歯を緩めて拡張標本を通す。** ⛔ 検討していない——歯を通すために
   閾値を緩めることは #340/#410/ADR 0166 がいずれも却下している形であり、本 ADR の範囲外
   （余白が足りないこと自体の是非は、Issue #340 の残りの論点「ADR 0201 の FLOOR がデータの
   ばらつきに対して適切か」に属する）。

## 引き受けた負債

1. **本 ADR は `compare-baseline.json` を実際には1バイトも変えていない。** Issue #340
   案3の目的（推定器の較正精度を上げる）そのものは、まだ達成していない——達成には
   CI artifact の取得（＝ PR を作れる担い手による続きの作業）が要る。
2. **`.dev.json` の8標本は、ローカルの2回一致でしか裏取りされていない。** CI環境間の
   非決定性を検出する力を持たない。この8標本をそのまま `compare-baseline.json` へ
   昇格させる場合、`examples/chat/README.md` の更新手順（同一commitのCI2回以上一致）を
   別途踏むこと。
3. **hold-in/hold-out の分け方の見直し（決定2の「代わりに」の直後）は本 ADR で決めていない。**
   `bandEntryCount` を明示フィールドにする案を含め、`compare-baseline.json` のスキーマ変更は
   別途オーナー/委譲元の判断を仰ぐ。
4. **10〜20件の範囲のうち14/16/18/20は掃引で到達しなかった(9,10,11,12,13,15,17,19の8点)。**
   無理に丸い数へ到達させると、その選択自体が「範囲を埋めたい」という結果からの逆算になり、
   決定1の「hold-outを見ずに決めた」設計の精神に反するため、到達した値だけを採った。

## これが覆るとしたら

- CI artifact を取得できる担い手が、`.dev.json` と同じ `CALIBRATION_SAMPLE_DESIGN` を
  PR の `example-chat` job 上で実行し（または同等の CI 経路を新設し）、2回以上の一致を
  確認できたとき——`compare-baseline.json` へ正式に昇格させる根拠になる。
- オーナーが hold-in/hold-out の分け方（`totalInScope <= DEFAULT_RECALL_LIMIT`）を
  `bandEntryCount` ベースへ変える判断をしたとき——その変更自体は本 ADR の範囲外である。
- ADR 0201 の余白の歯が赤くなる件について、オーナーが FLOOR の設計そのものを見直す
  判断をしたとき（Issue #340 の残りの論点1本目）。

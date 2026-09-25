# ADR 0310: recall-footprint 較正の補助標本は作れる(実 API 不要)が、compare-baseline.json への昇格には CI artifact が要る — 別ファイルに留めた

- **状態**: 採用 (2026-09-25)。⚠ 当初「未決」としていたのは PR を作れず CI artifact を
  取得できなかったためだが、本 ADR §4（本追記）が CI-sourcing を完了させた——決定2「昇格
  させない」は覆り、標本は `examples/chat/recall-footprint-calibration-samples-baseline.json`
  として正式に基準値へ昇格した。
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

### ⚠ 訂正（2026-09-25、CI 配線を進めた段の担い手）: 上の表は #722（ADR 0306）を反映していない。実際は緑になる

**上の表（決定3の直後、2026-09-25 当初版）は誤りではないが、古い。**この ADR は
`52113a8`（main、`RecallFootprintSample.totalInScope` が存在しない時点）の上で書かれた
——**#722（[ADR 0306](./0306-recall-footprint-calibration-subtracts-structural-terms.md)、
`calibrateRecallFootprint` が構造項を差し引くようになった変更）はまだ main に無かった。**
本ブランチを `cd2c728`（#722 マージ後の main）へ載せ替えた後、ローカル Postgres 17 +
pgvector で `compare`/`recall-footprint-calibration-samples` を実際に実行し直し
（`MNEMORA_PROVIDER_SOURCE=recorded` を明示、実 API は叩いていない）、8点が
`recall-footprint-calibration-samples.dev.json` と完全一致することを確認したうえで、
**#722 の較正**（`totalInScope` を渡し、構造項を差し引いてから最小二乗する）で
拡張標本を較正し直した。上の表の計算は `totalInScope` を渡していなかった
（`recall-footprint-calibration-samples.test.ts` の参考計算節も同様——本 ADR が書かれた
時点で `RecallFootprintSample.totalInScope` 自体が存在しなかったため、渡しようがなかった）。
**加えて、`estimateRecallFootprint` の `shape.limit` を省略していた**——8点の標本は
`limit=20` で測ったが、`limit` を省略すると既定の `DEFAULT_RECALL_LIMIT`(10)が使われ、
`totalInScope`(11〜19)が limit(10)を超えたと誤解して、実際には空のはずの目次帯を
「非空」と見積もってしまう(桁上がりとは別の、もう1つの取り違い)。**この2点を両方
直すと、拡張標本の残差は正常な小ささ(最大絶対値5字未満)に戻り、ADR 0201 の余白の歯は
拡張後も緑のままである。**

| | 現行(hold-in 7点、main) | 拡張(7+8=15点、**#722較正・limit修正後**) |
|---|---|---|
| `charsPerDigest` | 15.458 | 16.175 |
| `fixedIndexChars` | 170.881 | 168.503 |
| hold-in 残差 SD(自由度 n−2) / 最大絶対値 | 1.810 / 3.202字 | 2.180 / 4.922字 |
| hold-out 5行の最大相対誤差 | 1.430% | 1.122% |
| 12行全体の最大相対誤差 | 1.562% | 2.023%(2.5%許容の内側) |
| ADR 0201 の余白(半digest, 最も狭い行) | 12.18字(42ターン行, 上側, 緑) | **9.39字(42ターン行, 下側, FLOOR=8.088字を上回り緑)** |

⟹ **上の「2026-09-25 当初版」表の「7.68字・赤」という結論は、この訂正で覆る。**
#722 の較正（構造項の差し引き）と、`estimateRecallFootprint` へ正しい `limit` を渡すことの
両方が揃って初めて、拡張標本は「正しく」評価される——片方だけでは（このブランチで
実際に踏んだとおり）巨大な見かけ上の残差が出る。**この訂正は、基準値
（`compare-baseline.json`）を1バイトも変えていない**——`recall-footprint-calibration-samples.
dev.json`（8点、CI未経由）を使った参考計算の再計算である。基準値への正式な反映は、
この ADR §2 が定める CI-sourcing の手順を経てから行う。

**確かめていないこと**: CI（`example-chat` job）上での実測——この訂正もローカル
Postgres + `recorded` カセットの実行に基づく（下の「測ったこと」に相当する手順を
このコミットでは ADR 本文へ書き足していない。詳細はマネージャーへの報告に譲る）。

### 4. 2026-09-25 追記: CI-sourcing を完了し、`compare-baseline.json` と並ぶ基準値へ正式に昇格した

> **⚠ この追記は、自動化された担い手（マネージャーのセッションから切り出された worker
> セッション）が書いた。⛔ オーナー本人の判定ではない**（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。

上の「確かめていないこと」（CI 上での実測）を埋めた。PR #728 の CI run 36090652846
（`example-chat` ジョブ）で `compare` / `recall-footprint-calibration-samples` の両
artifact を attempt 1・2 の2回取得し、`measuredAt` を除いてバイト単位で一致すること
（node で `JSON.stringify` した各フィールドを row 単位で比較）を確認した。

| | attempt 1 | attempt 2 |
|---|---|---|
| compare artifact ID | 10845303067 | 10845791720 |
| recall-footprint-calibration-samples artifact ID | 10845602321 | 10846036078 |
| measuredAt (compare) | 2026-09-25T03:34:09.435Z | 2026-09-25T03:40:56.745Z |
| measuredAt (calibration-samples) | 2026-09-25T03:34:13.049Z | 2026-09-25T03:41:00.853Z |

いずれも `gh api repos/takecchi/mnemora/actions/artifacts/<id>` で `workflow_run.id`
（36090652846）・`created_at`・`workflow_run.head_sha`（1b94f8a、PR head）を個別に確認済み。
CI が実際に checkout したのは pull_request のマージプレビュー commit
`deecbd5f20ffeeb2454522a66b20e34c690795c7`（`refs/pull/728/merge`）であり、PR head
（`1b94f8a642bea9b87dc3730b4d7481fb56667d2d`）そのものではない——`gh api
repos/takecchi/mnemora/actions/runs/36090652846` の `pull_requests[0].head.sha` は
PR head を返す一方、ジョブ内で実際にチェックアウトされた sha は前者だった（CI ログでの
実測、`compare-baseline.json`/`recall-footprint-calibration-samples-baseline.json`
双方の `provenance.commit` に記録）。

`recall-footprint-calibration-samples` artifact の8点は、`recall-footprint-
calibration-samples.dev.json`（ローカル2回一致のみ、CI未経由）と rows が1バイトも
違わなかった——ローカル実行とCI実行が同じ設計・同じカセットで同じ結果を返すことも、
この一致で確認できた。`.dev.json` は削除し、CI-sourced な
`examples/chat/recall-footprint-calibration-samples-baseline.json` へ役割を一本化した。

`compare-baseline.json` にも `bandEntryCount`/`rawIndexJsonLength` の2欄を実測反映した
（⭐門が見る2欄は12行すべて不変）。これにより、決定2が保留していた
「hold-in/hold-out の分け方を `bandEntryCount === 0` へ切り替える」も実行できた——
12行の分け方（7行/5行、同じ行）は旧条件（`totalInScope <= DEFAULT_RECALL_LIMIT`）と
1行も変わらなかった（`recall-footprint-baseline.test.ts` の「分け方の移行」歯）。

`recall-footprint-baseline.test.ts` の hold-in を、上の8点を加えた15点（7+8）へ拡張し、
`totalInScope` を渡して較正した。以下は main（本追記時点の `compare-baseline.json`
更新後）と、拡張前（hold-in 7点のみ）を並べた表——上の§3訂正の表と数値は同じだが、
実際に CI artifact から作った `compare-baseline.json`/新設 baseline ファイルに対して
再計算し直し、95%予測区間の半幅（決定4「これが覆るとしたら」・ADR 0201「固定の半 digest
は外挿の距離を見ていない」節と同じ式）を追加した。

| | hold-in 7点(main、拡張前) | hold-in 15点(7+8、本追記) |
|---|---|---|
| `charsPerDigest` | 15.458 | 16.175 |
| `fixedIndexChars` | 170.881 | 168.503 |
| hold-in 残差 RSE(自由度 n−2) / 最大絶対値 | 1.810 / 3.202字 | 2.180 / 4.922字 |
| hold-out 5行の最大相対誤差 | 1.430% | 1.122% |
| 12行全体の最大相対誤差 | 1.562% | 2.023%(2.5%許容=`ACCURACY_TOLERANCE`の内側) |
| ADR 0201 の余白(半digest, 最も狭い行) | 12.177字(42ターン行, 上側) | **9.387字(42ターン行, 下側)** |
| FLOOR(`charsPerDigest / 2`) | 7.729字 | 8.088字 |
| この歯 | 緑(+4.448字) | **緑(+1.299字)** |
| 95%予測区間の半幅(外挿なし, x0=x̄) | 4.975字 | 4.865字 |
| 95%予測区間の半幅(hold-outの返る件数の平均=16まで外挿) | 12.437字 | **5.123字** |
| 95%予測区間の半幅(hold-outの返る件数の最大=20まで外挿) | 15.992字 | **5.477字** |

⟹ **15点への拡張は、ADR 0201「固定の半 digest は外挿の距離を見ていない」節が指摘した
問題を実際に縮めた。**hold-in の標本点が `memoryCount`(=`returnedCount`)の5点
（main、2〜8の範囲）から13点（拡張後、2〜19の範囲）へ増え、hold-out の外挿距離
（`x̄` からの乖離）が相対的に縮んだため、予測区間の半幅は外挿先（returnedCount=16や20）
でもほとんど膨らまない（main は 4.98字→16.0字まで3.2倍に膨らむのに対し、拡張後は
4.87字→5.48字と1.13倍にしか膨らまない）。FLOOR(半digest)は8.088字に上がったが、
実際の最小余白（9.387字）はそれを上回っており、歯は緑のままである。

⚠ **予測区間の半幅（5.12字/5.48字）は、いまの最小余白（9.387字）より小さい——
95%予測区間そのものは依然として FLOOR を上回っているが、両者の差は main ほど大きくは
ない。**外挿の不確かさが実際に縮んだことは確認できたが、消えたわけではない
（引き受けた負債は下の節で更新する）。

**確かめていないこと**: 予測区間は残差が独立で同一分布に従うと仮定している。
`compare-baseline.json` の5点しかない hold-out 側で、この仮定自体を検証してはいない
（ADR 0201 と同じ留保）。

## 検討して採らなかった案

1. **`compare-baseline.json` の `rows` に直接追記する。** ⛔ 却下——CI-sourcing の規律
   （ADR 119/121/133）に反する。この担い手は PR を作れず、CI artifact を取得する経路が無い。
2. **hold-in/hold-out の分け方(`totalInScope <= DEFAULT_RECALL_LIMIT`)を
   `bandEntryCount === 0` に直す。** ⛔ 保留——委譲元の規律で「分け方の条件を変える必要が
   出たら、変えずに止まって報告する」と定められている。本 ADR はその報告を兼ねる。
   ⚠ **2026-09-25 追記（§4）: この保留は解けた。**`compare-baseline.json` が
   `bandEntryCount` を実測で持つようになったため、分け方を `bandEntryCount === 0`
   へ切り替えた——切り替えても12行の分け方（7行/5行、同じ行）は1行も変わらないことを
   検算済み（`recall-footprint-baseline.test.ts`「分け方の移行」歯）。
3. **deterministic provider で標本を作る。** ⛔ 却下——`recorded` と `deterministic` は
   digest 長の分布が別物であり、較正の意味が変わる(委譲元の規律で明示的に止められている)。
4. **ADR 0201 の余白の歯を緩めて拡張標本を通す。** ⛔ 検討していない——歯を通すために
   閾値を緩めることは #340/#410/ADR 0166 がいずれも却下している形であり、本 ADR の範囲外
   （余白が足りないこと自体の是非は、Issue #340 の残りの論点「ADR 0201 の FLOOR がデータの
   ばらつきに対して適切か」に属する）。

## 引き受けた負債

1. ~~**本 ADR は `compare-baseline.json` を実際には1バイトも変えていない。**~~
   ⚠ **2026-09-25 追記（§4）: 解消した。**`compare-baseline.json` は CI artifact から
   `bandEntryCount`/`rawIndexJsonLength` を実測反映し、`recall-footprint-calibration-
   samples-baseline.json` を新設して較正標本を15点へ拡張した。Issue #340 案3の目的
   （推定器の較正精度を上げる）は達成した——`BUILTIN_RECALL_FOOTPRINT_PROFILE` を更新済み。
2. ~~**`.dev.json` の8標本は、ローカルの2回一致でしか裏取りされていない。**~~
   ⚠ **2026-09-25 追記（§4）: 解消した。**同一 commit（マージプレビュー deecbd5f）で
   `example-chat` ジョブを2回実行し、artifact がバイト単位で一致することを確認した
   うえで基準値へ採った。`.dev.json` は削除した。
3. ~~**hold-in/hold-out の分け方の見直しは本 ADR で決めていない。**~~
   ⚠ **2026-09-25 追記（§4）: 決めた。**`bandEntryCount` を `compare-baseline.json` の
   フィールドとして持たせ（スキーマの非破壊追加）、分け方を `bandEntryCount === 0` へ
   切り替えた（上の「検討して採らなかった案」2番の追記参照）。
4. **10〜20件の範囲のうち14/16/18/20は掃引で到達しなかった(9,10,11,12,13,15,17,19の8点)。**
   無理に丸い数へ到達させると、その選択自体が「範囲を埋めたい」という結果からの逆算になり、
   決定1の「hold-outを見ずに決めた」設計の精神に反するため、到達した値だけを採った。
   ⚠ **この負債は解消していない**——§4もこの8点のまま採用しており、14/16/18/20は
   依然として較正標本に無い。
5. **（新規、§4）予測区間の半幅は縮んだが、まだ最小余白より小さくない水準にある。**
   拡張後も95%予測区間の半幅（5.12字〜5.48字、外挿先による）は現行の最小余白
   （9.387字）を下回っており歯は緑だが、外挿の不確かさそのものが消えたわけではない
   （§4「確かめていないこと」参照）。標本をさらに増やす、または予測区間そのものを
   歯にする案は、まだ検討していない。

## これが覆るとしたら

- ~~CI artifact を取得できる担い手が、`.dev.json` と同じ `CALIBRATION_SAMPLE_DESIGN` を
  PR の `example-chat` job 上で実行し（または同等の CI 経路を新設し）、2回以上の一致を
  確認できたとき——`compare-baseline.json` へ正式に昇格させる根拠になる。~~
  ⚠ **2026-09-25 追記（§4）: 起きた。**`example-chat` job に独立ステップとして配線され、
  PR #728 の CI run 36090652846 で2回一致を確認し、
  `recall-footprint-calibration-samples-baseline.json` へ昇格させた。
- ~~オーナーが hold-in/hold-out の分け方（`totalInScope <= DEFAULT_RECALL_LIMIT`）を
  `bandEntryCount` ベースへ変える判断をしたとき——その変更自体は本 ADR の範囲外である。~~
  ⚠ **2026-09-25 追記（§4）: 起きた。**マネージャー委譲のもとで切り替えた
  （検討して採らなかった案2の追記参照）。
- ADR 0201 の余白の歯が赤くなる件について、オーナーが FLOOR の設計そのものを見直す
  判断をしたとき（Issue #340 の残りの論点1本目）。**§4時点ではまだ赤くなっていない**
  （最小余白9.387字 > FLOOR 8.088字）——この論点自体はまだ現れていない。

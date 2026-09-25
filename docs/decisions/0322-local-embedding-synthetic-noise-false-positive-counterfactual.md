# ADR 0322: `local` 埋め込み5+2群に合成ノイズを注入し、ADR 0316 判定の偽陽性率を反実仮想として測る — Issue #109（ADR 0316「引き受けた負債」1番）

- **状態**: 採用 (2026-09-25)
- **日付**: 2026-09-25

> **⚠ この ADR を書いているのは、マネージャー（クローンのセッション）から切り出された
> 作業者である。⛔ 投稿者欄の `takecchi` は「オーナー本人が書いた」ことを意味しない**
> （[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
> **ここに書いてある判断は、すべて「クローン miku の判断」であり、オーナー本人の決定ではない。**
> 後から読む者は、この ADR の決定を「オーナーの決定」として引かないこと
> （[ADR 0276](./0276-retrieval-quality-shadow-verdict-stage1.md) の名乗りの体裁を踏む）。

🔴🔴 **この ADR が測っているのは「実際の偽陽性率」ではない。**`local` 埋め込み
（`@mnemora/local-embedding`）の想起スコアが揺れることは、**一度も観測されていない**
——[ADR 0094](./0094-identifier-probes-local-embedding.md) は2 run のビット単位一致を
確認しただけである。ここにあるのは**反実仮想**——「もし想起スコアに σ の合成ノイズが
入ったとしたら、ADR 0316 の判定（変えていない・再利用している）は何回に1回 red に
なるか」という、仮に揺れがあった場合の上限の見積もりである。**この限定は本 ADR の
どの数値にも掛かる**（結論節でも繰り返す）。

**⚠ 各主張の出所を分ける**（ADR 0094 / ADR 0276 / ADR 0316 の体裁を踏む）。

- **【実測】** — この作業者が自分の手で、`@mnemora/local-embedding`（本物の ONNX 推論、
  HF から取得したモデル重み）と本物の Postgres 17 + pgvector 0.8.0（`docs/autonomy.md`
  §2 の `initdb` 手順で立てた自分専用インスタンス。**本番ではない**）に対して実際に
  走らせた。
- **【現物】** — この repo のコード・文書・[Issue #572](https://github.com/takecchi/mnemora/issues/572)
  のコメントを読んで確かめた。
- **【受】** — Issue #572 の測定（σ 格子・seed 数・対称ノイズの式）を、この ADR の作業者は
  再導出していない。そのまま前提として受け取った。

---

## 文脈

[ADR 0316](./0316-openai-embedding-false-positive-ceiling.md)「引き受けた負債」1番:

> `local` embedding の既存5+2群（ADR 0094/0135/0313）の偽陽性率は、この ADR では
> 測っていない。（…）次に測るなら、ADR 0276 と同じ「合成ノイズを注入する」手法
> （`local` embedding は決定的なので、実 API の呼び出し揺れという手法は使えない）が
> 必要になる。

**`local` の5+2群とは**、`identifier-probes` サブコマンド（5群: `japanese`＝既存の日本語
意味 probe 7件・`identifiersSparse`/`identifiersDense`＝ASCII 識別子 probe 30件・
`japaneseNamesSparse`/`japaneseNamesDense`＝日本語固有名詞 probe 12件）と
`numeral-token-probes` サブコマンド（2群: `numeralSparse`/`numeralDense`＝数詞・記号
索引 probe 18件）が `MNEMORA_EMBEDDING=local` で回す7群（`examples/chat/src/cli.ts` の
`runIdentifierProbes`/`runNumeralTokenProbes`）である。**これらは決定的**（ADR 0094 が
2 run のビット一致で確認済み）であり、[ADR 0316](./0316-openai-embedding-false-positive-ceiling.md)
が OpenAI 実埋め込みに対して使った「同じ設定で独立に録り直す」という手法は、測る対象
（呼び出しをまたいだ揺れ）そのものが存在しないため使えない。

**[ADR 0276](./0276-retrieval-quality-shadow-verdict-stage1.md)（Issue #572 段1）** が
先例——`affinity` へ対称な合成ノイズ `× (1 + σ·ε)` を注入し、σ を段階的に振って、
既存の判定が「品質は変わっていないのに red になる」割合を測った。Issue #572 の
2件目のコメント（【受】、本 ADR の作業者は再導出していない）が実際に走らせたのは:

- **σ 格子（11段）**: `0.0025, 0.005, 0.01, 0.02, 0.04, 0.08, 0.12, 0.16, 0.24, 0.32, 0.48`
- **seed 数**: 15通り（合計 165 run）
- **ノイズの式**: `affinity × (1 + σ·ε)`、ε は決定的な一様分布 `[-1, +1)`
- **偽陽性の帯の定義**: 「MRR の中央値が基準のまま」の帯で赤になった run 数 / 15

**⚠ Issue #572 自身の計装コード（PRNG の実装を含む）は `main` に入っていない**——この
リポジトリのどのコミットにも存在しない。**⟹ 流用できるコードは無く、この ADR の
`noiseEpsilon`（乱数生成）は独自に書いたものである**（下の「確かめていないこと」参照）。
σ 格子・seed 数・帯の定義だけを #572 に揃え、測定前に固定した。

---

## 決めたこと（測定前に固定する。後出しにしない）

1. **注入点はスコアであって埋め込みベクトルではない。** `runtime.recall()` が返した
   `RecalledMemory.score.total`（候補の並び順を決める唯一の値）に `× (1 + σ·ε)` を
   掛けて並べ替え直す。**`packages/core`/`packages/postgres` のスコア計算・
   `runtime.recall()` の公開 API・既定の振る舞いには1文字も触れていない**——
   `recall()` を呼んだ後、返ってきた候補配列を新しいファイルの純関数で並べ替えるだけ。
   **`total` へ掛けることは `affinity` へ掛けることと数学的に同義**である（`total =
   affinity × decay × tagMatch × freshness × strength` であり、`affinity` 以外の4項は
   候補ごとに固定の正の乗数として掛かるだけなので、`affinity` に `(1+σε)` を掛けた
   ものと `total` に同じ係数を掛けたものは、`decay`/`tagMatch`/`freshness`/`strength`
   の値に関わらず常に一致する。`examples/chat/src/synthetic-score-noise.ts` の doc
   コメントに証明を書いた）。
2. **判定は ADR 0316 の `decideEmbeddingDriftVerdict`/`clopperPearsonUpperBound`
   （`examples/chat/src/openai-arm-verdict.ts`）をそのまま使う。1行も変えていない。**
   呼び出しは `examples/chat/src/synthetic-score-noise.ts` の `decideNoiseRoundRed()`
   1か所に絞り、`mrrDropThreshold` を上書きしない（ADR 0316 の既定
   `DEFAULT_MRR_DROP_THRESHOLD = 0.01` をそのまま使う）。
3. **σ 格子（11段）・seed 数（15）・偽陽性の帯の定義**は上の「文脈」節の通り、Issue #572
   に揃えて固定した（`SIGMA_GRID`/`SEED_COUNT`、`examples/chat/src/synthetic-score-noise.ts`）。
   **ただし乱数生成の実装（`noiseEpsilon`）は #572 のものではなく、この ADR が独自に
   書いたもの**——#572 の計装が `main` に無いため、ビット単位では再現していない
   （「確かめていないこと」参照）。
4. **群ごとに「赤の数/n」と Clopper–Pearson 片側95%上限を出す**（ADR 0316 と同じ
   `clopperPearsonUpperBound`）。**σ ごとの表も別途残す**（`summarizeSigmaLevels`）。
5. **CI ジョブは足さない。`.github/workflows/ci.yml` は1バイトも変更していない。**
   成果物は手で回すスクリプト（`examples/chat/src/scripts/local-embedding-synthetic-noise-fp.ts`、
   ADR 0316 の `openai-embedding-fp-ceiling.ts` と同じ構え）と、DB 非依存の純関数の歯
   （`examples/chat/src/__tests__/synthetic-score-noise.test.ts`）、および DB 配線の
   歯（`examples/chat/src/__tests__/local-noise-arm.postgres.test.ts`。**擬似 provider
   で配線だけを見る**——`identifier-arm.postgres.test.ts` と同じ区別）。
6. **既存の probe 集合・既存の arm 関数には1文字も触れていない。** `identifier-arm.ts`/
   `retrieval-quality.ts`/`probe-set.ts`/`identifier-probe-set.ts`/
   `japanese-name-probe-set.ts`/`numeral-token-probe-set.ts`/`openai-arm-verdict.ts`/
   `cli.ts`/`ci.yml` は git diff が空である（下の「触ったファイル」節）。新しいファイル
   3本（`synthetic-score-noise.ts`/`local-noise-arm.ts`/
   `scripts/local-embedding-synthetic-noise-fp.ts`）が、既存の `ArmProbeSetSpec`
   （`identifier-arm.ts` が定義・`IDENTIFIER_PROBE_SET_SPEC`/`JAPANESE_NAME_PROBE_SET_SPEC`/
   `NUMERAL_TOKEN_PROBE_SET_SPEC` が実装）を import して使うだけである。
7. **ADR 番号は、作業中は仮に 0319 とし、マージ前に 0322 へ振り直した**（main で 0319〜0321 が
   先に着地したため。`node scripts/adr-renumber.mjs` による——[ADR 0179](./0179-adr-number-assigned-at-merge.md) の手順）。

---

## 測ったこと（【実測】）

### 環境

手元の `initdb` 自製インスタンス（PostgreSQL 17、pgvector 0.8.0、`docs/autonomy.md` §2
の手順で立てた自分専用ポート）。本番ではない。埋め込みは `@mnemora/local-embedding`
（`ruri-v3-30m/sym`、256次元、HF から重みを取得——ADR 0085 決定7 が言う4ファイル計
42MB。実 API は一切叩いていない）。LLM は常に `DeterministicLLMProvider`
（`identifier-probes`/`numeral-token-probes` の既定と同じ、この ADR は変えていない）。

### 手順 — recall() は1回だけ、並べ替えは何度でも安く

ADR 0316 の OpenAI arm は「round ごとに実 API へ再度 embed する」必要があった（呼び出し
自体が揺れの原因だったため）。**`local` は決定的なので、この必要が無い。** 1群につき
probe ごとに本物の `runtime.recall()` を**1回だけ**呼び、返ってきた候補全体
（`externalId`・`score.total`）を捕まえる（`captureGroupCandidates`、
`examples/chat/src/local-noise-arm.ts`）。σ 11段 × seed 15通り = 165通りの並べ替えは、
この捕まえた候補集合に対して**DB を一切呼ばずに**純関数（`computeNoisyGroupMetrics`、
`synthetic-score-noise.ts`）で行う——1群あたり実測で数秒〜十数秒で165通りすべてが終わる
（2回目の実行は19秒、7群合計）。

### 基準線(σ=0) — 既存の local 測定の値と1件残らず一致した

| 群 | probe数 | σ=0 の MRR | σ=0 の hit@1 | 既存基準値ファイル(`identifier-probe-baseline.json`/`numeral-token-probe-baseline.json`) |
|---|---|---|---|---|
| `japanese` | 7 | 0.8095238095238095 | 5/7 | 0.8095238095238095, 5/7 — 一致 |
| `identifiersSparse` | 30 | 1.0 | 30/30 | 1.0, 30/30 — 一致 |
| `identifiersDense` | 30 | 1.0 | 30/30 | 1.0, 30/30 — 一致 |
| `japaneseNamesSparse` | 12 | 0.9583333333333334 | 11/12 | 0.9583333333333334, 11/12 — 一致 |
| `japaneseNamesDense` | 12 | 0.9583333333333334 | 11/12 | 0.9583333333333334, 11/12 — 一致 |
| `numeralSparse` | 18 | 0.9166666666666666 | 15/18 | 0.9166666666666666, 15/18 — 一致 |
| `numeralDense` | 18 | 0.9166666666666666 | 15/18 | 0.9166666666666666, 15/18 — 一致 |

**7群すべて、σ=0 の実測値が既存のコミット済み基準値ファイルと1バイトも違わず一致した。**
これは「新しく書いた捕捉経路（`captureGroupCandidates`）が、既存の
`runIdentifierProbeArm`/`runRetrievalQualityArm` と同じ `recall()` パイプラインを
同じ条件で通している」ことの実測による確認である。

**再現性（決定性の確認）**: 同じスクリプトを独立に2回実行し（間にリファクタも1回挟んだ
計3回）、`provenance.measuredAt` を除いて出力 JSON が **1バイトも違わず一致した**
（`JSON.stringify` の比較で確認）。埋め込みも `noiseEpsilon` も純粋に決定的であるため、
当然の結果ではあるが、実測で確認した。

### σ ごとの表と「偽陽性の帯」

**帯の定義**（Issue #572 に揃えた）: そのσでの15 seed にわたる MRR の中央値が、σ=0の
基準値と厳密に一致する σ だけを「帯」とし、帯に入る σ の red 数を合算する。

| 群 | 帯(σ) | 帯: red/trials | 帯の上限95% | 全11段合算: red/165 | 全11段の上限95% |
|---|---|---|---|---|---|
| `japanese` | {0.0025} | 0/15 | 18.10% | 118/165 | 77.27% |
| `identifiersSparse` | {0.0025} | 1/15 | 27.94% | 140/165 | 89.24% |
| `identifiersDense` | {0.0025} | 1/15 | 27.94% | 140/165 | 89.24% |
| `japaneseNamesSparse` | {0.02} | 5/15 | 57.74% | 107/165 | 71.03% |
| `japaneseNamesDense` | {0.02} | 5/15 | 57.74% | 107/165 | 71.03% |
| `numeralSparse` | **(空)** | — | **置けない** | 153/165 | 95.75% |
| `numeralDense` | **(空)** | — | **置けない** | 153/165 | 95.75% |

**σ ごとの詳細**（`japanese` の例。他6群は
`examples/chat/local-embedding-synthetic-noise-fp-measurement.json` に全件記録）:

| σ | red/15 | MRR min/中央値/max | 帯 |
|---|---|---|---|
| 0.0025 | 0/15 | 0.8061 / 0.8095 / 0.8095 | 内 |
| 0.005 | 0/15 | 0.8036 / 0.8061 / 0.8143 | 外(中央値が動いた) |
| 0.01 | 5/15 | 0.7109 / 0.8036 / 0.8143 | 外 |
| 0.02 | 10/15 | 0.6131 / 0.7321 / 0.8810 | 外 |
| 0.04 | 13/15 | 0.5206 / 0.6587 / 0.8333 | 外 |
| 0.08〜0.48 | 15/15(全段) | (下がる一方) | 外 |

### 🔴 最も重い実測結果 — 帯がほぼ σ=0.0025 の1点しかなく、`numeral` 群では帯が空になった

**ADR 0316 の判定は、OpenAI 実埋め込みの呼び出し揺れ（コサイン類似度 0.998 台）に対して
較正されている。`local` の7群は軒並み MRR が天井付近（1.0 や 0.917 や 0.958）にあり、
margin が薄い候補が多いため、σ=0.0025（相対 0.25%)というごく僅かなスコアの揺れでも
`hit1Count` が1件動くだけで red になる。** 結果:

- **7群中5群は、帯が σ=0.0025 の1点だけ**（1段上の σ=0.005 で早くも中央値が動く）。
- **`numeralSparse`/`numeralDense` は、格子最小の σ=0.0025 で既に中央値が動いており、
  帯が空になった**——この帯方式では**上限を置けない**（`clopperPearsonUpperBound` は
  分母0では定義できない。道具の欠陥ではなく実測結果である）。
- **参考として出した「全11段合算・帯を無視した」上限は、全群で71%〜96%**——これは
  実用上「上限を置けた」とは到底言えない値である。

**⟹ この反実仮想が示しているのは:** もし `local` の想起スコアに、Issue #572 が OpenAI
実埋め込みの呼び出し揺れに対して使ったのと同じ**形**の対称ノイズがほんの僅か
（0.25%程度）でも乗ったとしたら、ADR 0316 の判定は7群中5群で「品質が変わっていないのに
red になる」ことが15回に1回未満〜数回に1回の頻度で起き、2群（`numeral`）では
そもそも「変わっていない」と呼べる σ の水準が格子の中に見つからない。

### 陽性対照（σ=5.0、格子には含めない別の確認）

探り棒（ノイズ注入 → 並べ替え → 判定）が生きていることを確認するため、格子の外側の
極端な σ=5.0 で全7群を再測定した。**7群すべて、15/15 で red。** 「格子内で赤が出ない」
ことを「揺れが無いことの証明」にしない（`AGENTS.md`）ための、意図的に壊した確認である。

---

## 変異試験（`examples/chat/src/synthetic-score-noise.ts` に対して）

`AGENTS.md`「⛔ 変異を戻すのに `git checkout` を使わない」節どおり、`cp` で退避 →
変異を入れる → 対象の歯を実行 → `cp` で戻す → 元のファイルとバイト一致・
`git status --porcelain` が空であることを確認、の手順を4回行った。

**M1: σ=0 でもノイズが入る実装**
`noisyScore: c.score * (1 + sigma * noiseEpsilon(...))` を
`c.score * (1 + (sigma + 0.01) * noiseEpsilon(...))` に変更（常に最低1%相当のノイズが
漏れる）。

```
✗ sigma=0 は、スコアの差が極小(1e-6)な接戦でも並びを変えない(僅かでもノイズが漏れる実装を検出する)
  AssertionError: expected [ 'b', 'd', 'a', 'c' ] to deeply equal [ 'a', 'b', 'c', 'd' ]
Tests  1 failed | 23 passed (24)
```
戻した後 `24 passed (24)`、`diff`/`git status --porcelain` で元ファイルとバイト一致を確認。

**M2: 非対称（gold だけ下げる）ノイズ**
候補配列の index 0（`identifier-arm` の実データで gold が上位に来やすい位置の代理）だけ
`(1 - sigma * |ε|)`（常に非正の方向）にし、他は対称のまま。

```
✗ 同点の候補にノイズを掛けたとき、index0 だけが特別扱い(非対称)されない
  AssertionError: expected 7 to be greater than 20
```
（200 seed 中、index0 が rank1 を取ったのはわずか7回——対称なら期待値50回。）
戻した後 `25 passed (25)`、バイト一致を確認。

**M3: seed を無視する実装**
`noiseEpsilon` 内部で `seed` 引数を無視し、常に固定値でハッシュする。

```
✗ seed が違えば(同じ streamId/index でも)値が変わる — 実測で衝突していないことを確認
✗ 対称性: 15 seed にわたる平均は 0 付近(⚠ 統計的検定ではない。実測での目安)
✗ 十分大きな sigma では、複数の seed にわたって順位が両方向に動く(陽性対照)
✗ 同点の候補にノイズを掛けたとき、index0 だけが特別扱い(非対称)されない
Tests  4 failed | 21 passed (25)
```
戻した後 `25 passed (25)`、バイト一致を確認。

**M4: 判定を ADR 0316 より緩くした実装**
`decideNoiseRoundRed` 内の `decideEmbeddingDriftVerdict` 呼び出しに
`{ mrrDropThreshold: 0.05 }`（ADR 0316 の既定 0.01 の5倍、緩い方向）を追加。

```
✗ MRR の落ち幅がちょうど閾値(0.01)なら red(境界)
  AssertionError: expected false to be true
Tests  1 failed | 24 passed (25)
```
戻した後 `25 passed (25)`、`diff`/`git status --porcelain` で元ファイルとバイト一致を確認。

**⟹ 4種の変異すべてで、狙った歯だけが赤くなり、復元後に全テストが緑へ戻ることを
確認した。**「σ=0 での混入」「非対称バイアス」「seed 非依存」「判定の緩み/厳しさ」の
4方向とも、既存の歯が噛むことを実測で確認している。

---

## 検討して採らなかった案

**手を動かす前に、この案が過去の PR 本文・ADR の「採らなかった案」・docs の ⛔ で
却下されていないかを確認した**（`AGENTS.md`「⚠『無かった』と書く前に、探した場所を
列挙する」）。当たった場所:

- `grep -rn "合成ノイズ" docs/decisions/*.md` — ADR 0276/0316 以外に無し。
- `grep -rln "local.*ノイズ\|ノイズ.*local\|local.*偽陽性\|偽陽性.*local" docs/decisions/*.md`
  — ADR 0254/0316/0223 等がヒットしたが、いずれも「まだ測っていない」という現状の
  記述であり、この手法自体を却下している箇所は無かった。
- `gh pr list --search "合成ノイズ local"` / `gh issue list --search "合成ノイズ local 偽陽性"`
  — 本 PR の元になった ADR 0316/0276 の PR がヒットしただけで、この手法への却下は
  見つからなかった。
- `gh issue view 109` 本文 — 合成ノイズ・スコア注入への言及自体が無い。

**⟹ 当たった範囲では、この手法（スコアへの合成ノイズ注入）が過去に却下された記録は
見つからなかった。**列挙した探し先が網羅であることは、列挙しただけでは示せない
（`AGENTS.md` の同節「例外」）——見落としの可能性は残る。

この ADR の作業中に検討して採らなかった案:

- ⛔ **埋め込みベクトル自体にノイズを注入する。** マネージャー指示で「注入点はスコア」と
  決まっている。ベクトルへ注入すると、pgvector の ANN 索引・cosine 距離計算・
  `ScoreBreakdown` の生成経路まで実際に通すことになり、「どこで漏れているか」の
  切り分けが難しくなる。スコアへの注入なら、`recall()` の出力を後から並べ替えるだけで
  済み、`packages/core`/`packages/postgres` を一切通らない。
- ⛔ **`runIdentifierProbeArm`/`runRetrievalQualityArm` を round ごとに呼び直す
  （ADR 0316 の OpenAI arm と同じ構え）。** `local` は決定的なので、`recall()` を
  何度呼んでも同じ値が返る——165回呼び直すのは無駄な実行時間である。1回だけ呼んで
  候補を捕まえ、並べ替えは純関数で行う設計にした。
- ⛔ **6群だけを測る（OpenAI arm と同じ `japanese` 除外の判断を踏襲する）。**
  ADR 0316 が `japanese` 群を除いたのは「OpenAI 空間で `retrieval` の arm B/C が既に
  測っている」ためであり、**`local` 空間ではその重複が無い**——`japanese` を除く理由が
  無い。⟹ 7群（5+2）すべてを測った。
- ⛔ **帯が空になった `numeralSparse`/`numeralDense` について、格子を細かくして
  帯を無理に作る。** σ をさらに細かく刻めば帯が見つかるかもしれないが、それは
  測定前に固定した格子を後出しで変えることであり、この ADR 自身が課した規律
  （「決めたこと」3番）に反する。**「この格子では帯が置けなかった」という結果を
  そのまま報告する**（ADR 0316 が `identifiersSparse`/`identifiersDense` について
  「測って、置けないと分かった」としたのと同じ扱い）。
- ⛔ **判定を独自に緩めて「上限を置けた」ことにする。** ADR 0316 が明示的に退けている
  のと同じ理由（測定前に固定した判定を後出しで変えない）。

---

## 引き受けた負債

1. **乱数生成の実装（`noiseEpsilon`）は Issue #572 のものと異なり、ビット単位で
   再現しない。** #572 の計装コードが `main` に無いため。σ 格子・seed 数・帯の定義は
   揃えたが、個々の run の乱数列は #572 と一致しない——本 ADR の数値を #572 の数値と
   1対1で比較しないこと。
2. **`numeralSparse`/`numeralDense` は帯が空になり、上限を置けなかった。** より細かい
   σ 格子・別の帯の定義（例: 中央値の一致ではなく許容誤差を持たせる）を使えば置ける
   可能性があるが、この ADR の範囲では行っていない。
3. **`ruri-v3-30m/sym`（256次元）以外のモデル・次元での挙動は測っていない。**
   `@mnemora/local-embedding` が将来別モデルへ切り替わったときは、測り直しが要る。
4. **CI ランナー上では走らせていない。** 手元の `initdb` インスタンスのみ。
5. **`decideNoiseRoundRed` の1か所に配線を絞ったが、その事実自体を検査する歯は無い**
   （「`decideEmbeddingDriftVerdict` を呼ぶのはここだけ」という規約は doc コメントで
   述べているだけで、grep 等で機械的に検査していない）。
6. **σ=5.0 の陽性対照は全群 15/15 で red だったが、σ をどこまで下げれば red が
   出始めるかの境界は探索していない**（格子の11段の間の値は測っていない）。

---

## これが覆るとしたら

- **`local` 埋め込みの実際の想起スコアに、揺れが実際に観測されたとき。** そのとき
  初めて「反実仮想」ではなく「実測」になる——ADR 0094 の2 run ビット一致がまだ破られて
  いない限り、それは起きていない。
- **`numeralSparse`/`numeralDense` について、より細かい σ 格子または別の帯の定義で
  上限が置けたとき。**
- **Issue #572 の計装コードが `main` に入り、この ADR の `noiseEpsilon` と比較・
  置き換えができるようになったとき。**
- **`@mnemora/local-embedding` のモデル・次元が変わったとき。** 測り直しが要る
  （`examples/chat/src/scripts/local-embedding-synthetic-noise-fp.ts` を再実行する）。

## 確かめていないこと

- ⛔ **これは実際の偽陽性率ではない。** `local` の揺れは一度も観測されていない
  （ADR 0094 は2 run のビット一致）。この ADR 全体が反実仮想の測定である
  （冒頭の繰り返し）。
- ⛔ **CI ランナー上では走らせていない。** 手元の `initdb` インスタンスのみ。
- ⛔ **乱数生成の実装は Issue #572 のものと一致しない**（上の「引き受けた負債」1番）。
- ⛔ **`numeralSparse`/`numeralDense` の帯が空になった理由（margin の分布か、probe
  自体の性質か）を1件ずつ切り分けていない。**
- ⛔ **σ 格子の間の値・σ=5.0 未満で最初に red が出る境界は探索していない。**
- ⛔ **`ruri-v3-30m/sym` 以外のモデル・次元は測っていない。**
- ⛔ **`decideNoiseRoundRed` への配線が1か所に絞られていることを機械的に検査していない。**

Refs #109, ADR 0094, ADR 0254, ADR 0276, ADR 0316, Issue #572

---

## 追記（2026-09-25）— sparse/dense 群の一致理由を突き合わせで確かめた（Issue #109）

> **⚠ この追記もマネージャー（クローンのセッション）から切り出された作業者が書いた。
> オーナー本人の決定ではない**（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
> **この ADR は「採用」のまま変えない——本文は書き換えず、ここに追記するだけである。**

Issue #109（06:58Z のコメント、4番「残っているもの」）が「仮説のみで未確認」として
残していた1件を、実際の突き合わせで確かめた:

> ノイズは (seed, probe 番号, 候補の並び位置) だけで決まるので、dense で足した
> distractor が `recall()` の返す候補に入らなければ、結果は完全に一致する。
> 群どうしで候補を突き合わせてはいない。

### 【実測】環境

本文と同じ手元の `initdb` 自製インスタンス（PostgreSQL 17、pgvector 0.8.0、別ポート）、
`@mnemora/local-embedding`（`ruri-v3-30m/sym`、256次元、本物の ONNX 推論）、LLM は
`DeterministicLLMProvider`。実 API は一切叩いていない。対象は「sparse/dense の結果が
σ・seed の全組で完全に一致した」3組——`identifiersSparse`/`identifiersDense`（30 probe）、
`japaneseNamesSparse`/`japaneseNamesDense`（12 probe）、`numeralSparse`/`numeralDense`
（18 probe）。`japanese`（sparse/dense の区別が無い群）は対象外。

### 追加した歯・スクリプト

- `examples/chat/src/local-noise-candidate-diff.ts`（純関数）——sparse/dense それぞれの
  `captureGroupCandidates`（`local-noise-arm.ts`、**変更していない**）が捕まえた候補配列
  （`externalId`・`score.total`）を probe ごとに突き合わせ、件数・順序・値が丸ごと
  一致するか（`identical`）、dense にしか無い候補（`denseOnlyIds`）が gold/distractor
  より上位に来ているか（`denseOnlyRankedAboveGoldOrDistractor`）を出す。
  歯: `examples/chat/src/__tests__/local-noise-candidate-diff.test.ts`（11件、DB 非依存）。
- `examples/chat/src/local-noise-grid-comparison.ts`（純関数）——`synthetic-score-noise.ts`
  の既存関数（`computeNoisyGroupMetrics`/`decideNoiseRoundRed`、**1文字も変更していない**）
  をそのまま呼び、σ 格子 × seed 全通り（11×15=165 round）で sparse/dense の
  MRR 実値・red/green 判定を突き合わせる。
  歯: `examples/chat/src/__tests__/local-noise-grid-comparison.test.ts`（4件、DB 非依存）。
- `examples/chat/src/scripts/local-noise-arm-candidate-diff.ts`——上の2つを実際の
  `recall()` に対して走らせる、手で回すスクリプト（本文の
  `local-embedding-synthetic-noise-fp.ts` と同じ構え。**CI ジョブは足していない**——
  本文「決めたこと」5番と同じ判断）。出力は
  `examples/chat/local-noise-arm-candidate-diff.json`（コミット済み、機械可読）。
- ⛔ **新しい DB 配線の歯は足していない。** `diffGroupCandidates`/
  `compareGroupNoiseOutcomes` は純関数で、入力を作る `captureGroupCandidates` は
  既存の `local-noise-arm.postgres.test.ts`（本文、変更していない）が既に検査している。

### 【実測】① 候補配列そのもの（入力）の突き合わせ — 仮説は字義通りには誤りだった

| 組 | probe数 | `identical`(丸ごと一致) | `denseOnlyRankedAboveGoldOrDistractor`=true の probe数 |
|---|---|---|---|
| identifiers | 30 | **0/30** | **0/30** |
| japaneseNames | 12 | **0/12** | **0/12** |
| numeral | 18 | **0/18** | **0/18** |

**「dense で足した distractor が `recall()` の返す候補に入らなければ」という仮説の前段は
成り立っていない。** dense 固有の候補（`denseOnlyIds`）は、ほぼ全ての probe で実際に
`recall()` の返す10件（`DEFAULT_RECALL_LIMIT=10`、`packages/core`）の中に入っている
（`identifiers` の30 probe中、`denseOnlyIds` が空だったのは2 probe だけ）。⟹ 仮説の
前段（「入らない」）は**誤り**——dense の filler は実際に候補集合へ入り込んでいる。

**ただし、60 probe すべてで、dense 固有の候補は gold・distractor のどちらよりも
上位に来たことが1件も無かった**（`denseOnlyRankedAboveGoldOrDistractor` が全 probe で
`false`）。これが、σ=0 の基準値（本文の表、identifiers 1.0/30・japaneseNames
0.958/11・numeral 0.917/15）が sparse/dense で一致した**構造的な理由**である——
dense が足した候補は、この embedding 空間・この probe 設計では、常に gold/distractor
より低い順位にしか来ない。

**`identical` が60 probe中1件も無かった理由の内訳は2つある**（`local-noise-arm-candidate-diff.json`
で1件ずつ確認した）:

1. **候補集合そのものが違う**（`denseOnlyIds`/`sparseOnlyIds` が非空）——上で述べた通り、
   dense/sparse の filler が別の文言のため、`recall()` の下位（3位以降）に入る filler の
   顔ぶれが sparse/dense で違う。
2. **候補集合が完全に同じ probe でも、score.total が10⁻⁷ 相対のごく僅かな差で食い違う**
   （例: `project-code-d`——`denseOnlyIds`/`sparseOnlyIds` ともに空、10件の externalId・
   順序が sparse/dense で完全一致するのに、`score.total` が
   `0.9674024463343104`(sparse) vs `0.9674025663714538`(dense) のように末尾で違う）。
   **この差は2回の独立実行（実時刻が違う）で `identical` の判定結果（後述の
   MRR完全一致数を含む）が1バイトも変わらなかった**——もし `packages/core` の
   decay（経過時間依存、既定 `systemClock`、`examples/chat/src/runtime-factory.ts`）が
   原因なら、実時刻に依存して結果が run ごとに揺れるはずだが、実際には揺れなかった。
   ⟹ **decay ではなく、sparse/dense で haystack の構成（バッチに含まれる文の集合）が
   違うことによる ONNX 推論のバッチ依存の浮動小数点非結合性が原因である可能性が高いが、
   埋め込みベクトル自体までは追っていない**——これは【確かめていないこと】に残す。
   **いずれにせよこの差は10⁻⁷相対であり、格子最小の σ=0.0025（2500倍大きい）より
   4桁小さい**——ノイズによる並べ替えには実質影響しない大きさである。

### 【実測】② σ×seed 全165通り（出力）の突き合わせ — 「完全に一致」は red/green 判定に限って正しい

`local-noise-grid-comparison.ts` の `compareGroupNoiseOutcomes` で、実際に捕まえた
候補集合に SIGMA_GRID×SEEDS（165通り、本文と同じ格子）のノイズを掛け、sparse/dense を
round ごとに突き合わせた（2回の独立実行で下の数値は1件も変わらなかった）:

| 組 | red/green 判定が一致した round | MRR 実値が厳密一致した round | 最初に MRR が食い違い始める σ |
|---|---|---|---|
| identifiers | **165/165** | 55/165 | 0.02 |
| japaneseNames | **165/165** | 97/165 | 0.08 |
| numeral | **165/165** | 91/165 | 0.04 |

**red/green の判定（`decideNoiseRoundRed`、ADR 0316 の判定そのもの）は3組とも
165/165 で完全一致した**——本文の表（帯・上限95%が sparse/dense で同じ値になっていた
こと）を、集約統計ではなく round 単位で裏付ける。

**一方、MRR の実値は165通り中55〜97通りでしか厳密一致していない。** 食い違いは
σ が小さいうち（identifiers は σ≤0.01、japaneseNames は σ≤0.04、numeral は σ≤0.02）は
**1件も起きず**、それより大きい σ から起き始め、σ が大きくなるほど増える。

**⟹ Issue #109 の「完全に一致した」という記述は、「ADR 0316 の判定（red/green）」に
ついては165/165で正確だが、「MRR の実値」については正確ではない。** ADR 0322 本文が
報告した σ ごとの表（`japanese` 群の例）でも、`redCount` は sparse/dense で終始一致する
一方、`mrrMedian` は red が飽和した高い σ で僅かに食い違っていた
（本追記のための再検査で確認——例: `identifiersSparse` σ=0.04 の `mrrMedian`
0.8388888888888888 に対し `identifiersDense` は 0.8027777777777777）。本文の
「帯」（medianPreservesBaseline）の定義や「全11段合算」の red 数はこの食い違いの
影響を受けない——**帯に入る低い σ では実際に厳密一致しており、高い σ では
`decideEmbeddingDriftVerdict` が閾値を大きく超えて両方とも red と判定するため、
実値が僅かに違っても判定は割れない。**

### 機構の説明（仮説の差し替え）

元の仮説（「dense固有候補が候補に入らない」）は誤りだったが、観測結果は以下で
無矛盾に説明できる:

1. **σ=0（基準線）で、dense 固有候補は常に gold/distractor より下位にしか来ない**
   （①で確認、60 probe 全数）。⟹ 基準線の goldRank・hit@1・MRR は sparse/dense で
   一致する（本文の表が示す通り）。
2. **ノイズは (seed, streamId=probe番号, index=候補配列内の位置) だけで決まり、
   候補の識別子には依存しない**（`synthetic-score-noise.ts` の `noiseEpsilon` の
   doc コメント、本文で確認済み）。σ が小さいうちは、この位置基準のノイズが
   gold・distractor と、その下に居る sparse/dense 固有の候補との間のスコア差
   （embedding のマージン）を越えられない——⟹ 順位の並べ替えが「gold/distractor の
   2件の中でだけ」起きる限り、その2件は sparse/dense で共通のため、結果は一致する。
3. **σ が大きくなると、この位置基準のノイズが、sparse/dense で別の候補が座っている
   下位の位置まで動かせるようになる。** その候補は sparse/dense で別物なので、
   一方の腕でだけ gold の上に来ることがあり、そこで MRR の実値が分岐する。
4. **それでも red/green の判定が割れないのは、その頃には両腕とも
   `decideEmbeddingDriftVerdict` の閾値（MRR drop ≥ 0.01）を大きく超えて red に
   飽和しているから**——実値が違っても、どちらも「同じ結論（red）」に落ちる。

### これは「dense群が独立な情報を足していない」ことを意味するか

**しない、が言い過ぎでもない——両方が効いている、というのがここでの答えである。**

- **「dense が sparse と全く同じ情報しか持っていない」わけではない。** dense の filler は
  実際に sparse とは違う候補として `recall()` の結果に混入している（①）。σ を上げると
  MRR の実値が分岐する（②）のは、dense が sparse には無い「もう少しで gold に迫る
  近傍」を実際に持ち込んでいることの現れである。**dense はゼロ情報ではない——sparse
  より競合の多い、より厳しい条件を作れている**（`identifier-probe-set.ts` の設計意図
  通り）。
- **一方で、σ が低い側（判定に使う「帯」がある側）で sparse/dense が一致するのは、
  この embedding・この probe 設計のもとで dense の追加競合が「僅差で紛れ込む」ほどには
  強くない（gold/distractor とのマージンを崩すほどではない）ことの表れであり、これは
  実質的な発見である**——ただし、それが**判定（`decideEmbeddingDriftVerdict`）の
  「一致」として表面化するかどうかは、σ 格子の刻み方・閾値という**ノイズ注入設計の側**
  にも依存する。σ 格子がもっと細かければ、①で見た「dense固有候補が意外と近い」
  という違いが、もっと低い σ から MRR 実値の分岐として見えていたかもしれない
  （本 ADR・この追記のどちらもその探索はしていない）。

**⟹ 一言でまとめると**: 基準線（σ=0）が一致するのは probe/embedding 側の構造的事実
（dense固有候補が常に gold/distractor より下位）であり、**「完全に一致した」という
高いσまで含めた強い主張はノイズ注入設計（位置基準のノイズ・粗い閾値判定）の産物**
である。前者は「dense は独立情報を持たない」の根拠にならない——後者と合わせて
初めて「なぜ ADR 0316 の判定テーブルが sparse/dense で完全に一致したか」の説明になる。

### 確かめていないこと（この追記の範囲でも残るもの）

- ⛔ **`identical=false` の主因とした「ONNX バッチ依存の浮動小数点非結合性」は、
  埋め込みベクトル自体を比較して確認していない。** 2回の独立実行で結果が1バイトも
  揺れなかったことから decay（実時刻依存）を消去法で除外しただけであり、埋め込み側の
  挙動を直接見た確認ではない。
- ⛔ **σ 格子の間の値**（例: 0.005〜0.02 の間で `identifiers` の MRR 実値がどこから
  分岐し始めるか、格子の11点だけでは分からない）は探索していない。
- ⛔ **`japanese` 群**（sparse/dense の区別が無い）はこの追記の対象外。
- ⛔ **CI ランナー上では走らせていない。** 手元の `initdb` インスタンスのみ（本文と同じ限定）。
- ⛔ **`ruri-v3-30m/sym` 以外のモデル・次元は測っていない**（本文と同じ限定）。

### 成果物

- `examples/chat/src/local-noise-candidate-diff.ts` / `local-noise-grid-comparison.ts`
- `examples/chat/src/scripts/local-noise-arm-candidate-diff.ts`
- `examples/chat/src/__tests__/local-noise-candidate-diff.test.ts` /
  `local-noise-grid-comparison.test.ts`
- `examples/chat/local-noise-arm-candidate-diff.json`（実測結果、コミット済み）

Refs #109

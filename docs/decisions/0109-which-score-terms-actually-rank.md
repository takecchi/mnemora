# ADR 0109: 残りの4項も丸めずに測った — `total` の順位は `similarity` ただ1項で決まり、`total` は210行すべてで `similarity × decay²` にビット単位で一致する

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-13

**⚠ 各主張の出所を分ける**（[ADR 0081](./0081-similarity-is-the-only-term-that-ranks.md) /
[ADR 0108](./0108-retrieval-bench-does-not-exercise-lexical-channel.md) の体裁を踏む）。

- **【実測】** — この ADR の作業体が実際に走らせて測った。
  **⚠ ベンチを起こしたのは委譲先の作業者であり、書き手は生の出力ファイル
  （`run1-rows.log` / `run2-rows.log`、210行 × 2 run の JSON）と打たれたコマンドを受け取っている。
  ただし §5 の判定（similarity だけで並べ替える／隣接対の余裕／`similarity × decay²` の厳密一致）は、
  書き手自身がその生ファイルに対して計算し直した。**
- **【現物】** — この repo のコード・文書を読んで確かめた。
- **【受】** — 報告として受け取り、再導出していない。

---

## 文脈

[ADR 0081](./0081-similarity-is-the-only-term-that-ranks.md)（2026-09-09、HEAD `01d352d`）は
**「順位を決めているのは `similarity` ただ1項である」**を、項ごとの**通り数**を数えて測った。
本 ADR はその**再測**であり、同時に **ADR 0081 が明示的に残した2つの負債を塞ぐ**ものである。

**なぜ再測が要ったか。**

1. **【現物】ADR 0081 の測定以降、`main` は 46 commit 進んでおり、その中に
   `packages/core/src/strategies/scoring.ts` を実際に書き換えた変更が入っている**
   ——#115（[ADR 0084](./0084-lexical-recall-channel.md)。`total` の第1因子を
   `similarity` から `affinity = max(similarity, lexicalMatch)` へ構造変更）と
   #124（[ADR 0092](./0092-lexical-or-coverage.md)）。
   **⟹ ADR 0081 の表は「第6の項が生える前」のものである。**
2. **【現物】ADR 0081 §6.1 は「この計装は捨てた。再現するには足し直す必要が在る」と書いている。**
   ⟹ 通り数を数える器は repo にも CI にも残っていない。
3. **【現物】ADR 0081 §6.2 / §8 は「ベンチの印字が `decay`/`freshness` の差を丸めで隠す」を
   未解決の欠陥として残している。**⟹ **測定そのものが自分の信号を消す**構図が残っていた。

**⚠ 本 ADR は [ADR 0108](./0108-retrieval-bench-does-not-exercise-lexical-channel.md)（#178）の続きである。**
ADR 0108 は `lexicalMatch` ただ1項について「210行すべてで欄が存在しない」を測った。
**本 ADR は同じ測り方を残りの5項へ広げた。**

---

## 決めたこと

1. **§1〜§5 の測定結果を記録する。**
   **⛔ スコアの重み・式は1バイトも変えていない**（`packages/core/src/strategies/scoring.ts` は
   この PR で1行も変わっていない）。probe set（`examples/chat/src/probe-set.ts` の14件）・
   `DEFAULT_SCORE_THRESHOLD`・`limit`・`overFetchFactor` も変えていない。
2. **捨てられた計装を、捨てられない形で置き直す**（§6）。
   - `TermSpread` に `distinctCount`（厳密比較での通り数）を足す——**幅と通り数は別の主張である**
     （ADR 0081 §1.1）。
   - `decay`/`freshness` の**行ごと厳密等価**を数える純関数を足し、probe ごとに記録する。
   - arm 単位の集計を `armHeadline()` に足し、`MNEMORA_RETRIEVAL_JSON` に**省略可能欄**として載せる
     （ADR 0108 と同じ形。`schemaVersion` は上げない）。
   - **丸めない整形（`formatExactScoreValue`）**でコンソールにも出す——
     **ADR 0081 §6.2 の欠陥を、既存の印字を変えずに塞ぐ。**
3. **「いま緑で、前提が黙って変わったら赤」の歯を1本置く**（§6.2。ADR 0108 の歯と同じ向き）。
4. **ADR 0081 §1 の「`decay` の変域は 1e-8 桁」を訂正する**（§4）。
   **⟹ それはこの系の定数ではなく、取り込みから `recall()` までの実時間の関数である。**

### ⚠ 決めていないこと

- **⛔ 重みをどう変えるかを決めていない。**それは製品の判断であり、この ADR の範囲外である
  （ADR 0081 §7 も同じ線で閉じている）。**本 ADR は測っただけである。**
- **probe 集合を増やすかどうか。**触っていない（ADR 0058 / ADR 0108 と同じ線）。
- **`LexicalStore` を配線するかどうか。**[Issue #179](https://github.com/takecchi/mnemora/issues/179)
  へ切り出し済みの製品の判断であり、本 ADR は触れない。
- **基準値ファイル（`examples/chat/retrieval-baseline.json`）を取り直さない**（ADR 0108 と同じ）。

---

## 測った条件

**⚠ 数字は条件と一緒にしか意味を持たない**——この repo は条件を書かなかったために
**3度**数字を読み違えている（ADR 0068 が丸ごとその再発防止、ADR 0081 §3.2 が3度目の記録）。

```
env -u OPENAI_API_KEY MNEMORA_PROVIDER_SOURCE=recorded MNEMORA_DEBUG_RAW_SCORES=1 \
  DATABASE_URL="postgres://postgres@127.0.0.1:5544/mnemora_meas" \
  MNEMORA_RETRIEVAL_JSON=<path> \
  pnpm --filter @mnemora/example-chat run retrieval \
  >run<N>-stdout.log 2>run<N>-rows.log      # 2 run とも EXIT=0
```

| 何 | 値 |
|---|---|
| HEAD | **`222ded9`**（#178 マージ後の main） |
| DB | **PostgreSQL 17.11 + pgvector 0.8.6**。マイグレーション `0001`〜`0009` 適用 |
| provider | **`recorded`**（記録した実 API 応答の再生。[ADR 0051](./0051-recorded-provider-cassette.md)） |
| カセット | `examples/chat/cassettes/retrieval.json`（`recordedAt: 2026-09-06T21:35:13.480Z`、LLM=`gpt-4o-mini` 74件 / 埋め込み=`text-embedding-3-small` 256次元 152件） |
| 実 API 呼び出し | **0回。**3 arm すべてで「この run では OpenAI の API を一切叩いていない」が印字された（2 run とも） |
| arm × probe × limit | **3 arm × 7 probe × 10行 = 210行。**21組すべてがちょうど10行（欠けた組は無い） |
| 実行回数 | **2回**（run1 / run2。約9秒ずつ） |
| 変えなかったもの | 重み・式・閾値・`limit`・`overFetchFactor`・probe set・抽出プロンプト |

**⚠ この器には `OPENAI_API_KEY` が環境変数として存在する。**既定（`decideProviderSource`）は
「キーが在れば実 API」なので、**`env -u OPENAI_API_KEY` と `MNEMORA_PROVIDER_SOURCE=recorded` を
二重に掛けて起こしている**（ADR 0081 の測定と同じ規律）。

### 🔴 丸める前の値をどう取ったか（ここを外すと測定が自分の信号を消す）

**【現物】ベンチの印字 `formatScoreValue` は、絶対値が `1e-4` 以上なら `toFixed(6)` である。**
⟹ `decay = 0.9999996…` も `freshness = 0.9999998…` も、**どちらも `1.000000` と印字される。**
**⟹ 印字を根拠に「定数だった」と書くことはできない。**

**⟹ 本測定は印字を一切根拠にしていない。**`runRetrievalQualityArm` の中に一時計装
（`MNEMORA_DEBUG_RAW_SCORES` で括った1行1 JSON。ADR 0108 の測定が使った形と同じ）を入れ、
各行について**キーの存在（`hasOwnProperty`）**・**生の double**・**`toExponential(17)`** の
3つを出した。**⚠ この一時計装は commit していない**——代わりに、同じことを機械可読に残す口を
§6 で恒久化した。

---

## 1. 実測: 項ごとに「何通りの値を取ったか」【実測】

**arm ごと70行（7 probe × 10行）。厳密比較（`new Set(values).size`）。run1 の値。**

| 項 | 欄を持つ行 | probe ごとの通り数 | arm 内の通り数 | 実際に取った値（`toExponential(17)`） |
|---|---|---|---|---|
| `similarity` | **70/70**（3 arm とも） | 10 / 10 | **70**（全行が異なる） | arm C: `1.46187560199217303e-1` 〜 `6.74350356667191675e-1` |
| `lexicalMatch` | **0/70**（3 arm とも） | — | — | **欄そのものが存在しない**（§5.3） |
| `decay` | 70/70 | **10 / 10**（21組すべて） | A=69 / B=63 / C=66 | arm C: `9.99999525600768990e-1` 〜 `9.99999797832092807e-1` |
| `tagMatch` | 70/70 | **1 / 1** | **1** | **厳密に `1.00000000000000000e+0`** |
| `freshness` | 70/70 | **10 / 10** | A=69 / B=63 / C=66 | **`decay` と min/max・通り数が完全一致**（§2） |
| `strength` | 70/70 | **1 / 1** | **1** | **厳密に `1.00000000000000000e+0`** |

**⟹ `decay` と `freshness` は「定数」ではない。**どの probe でも10行すべてが異なる値を取っている。
**動いていないのは `tagMatch` と `strength` の2項だけである**（§3）。
**⟹ 動いているかどうかと、順位を動かせるかどうかは別の問いである**（§4・§5）。

**⚠ arm 内の通り数が70未満（63〜69）なのは、probe をまたいで同じ値が再出現するためである**
（同じ Memory が複数の probe で返り、`recall()` の `now` が近ければ同じ `decay` になりうる）。
**probe の中ではどの組も10通りである。**

---

## 2. 実測: `freshness` は `decay` の行ごと厳密な複製である【実測】

**run1・run2 とも、3 arm 合計 210行すべてで `decay === freshness`（厳密比較）。違った行は 0件。**

**⟹ ADR 0081 §2 の主張は、現 HEAD `222ded9` でも真である。**
（ADR 0081 は HEAD `01d352d`・別のカセット再生で同じことを測っている。**本測定はその再現である。**）

**【現物】なぜそうなるか**（`scoring.ts` / `decay.ts` の式の形）:

- `decay` の起点は `lastReinforcedAt ?? recordedAt`、`freshness` の起点は `occurredAt ?? recordedAt`
  （`decayBase()` は `params.lastReinforcedAt ?? params.recordedAt`）。
- **【現物】このベンチは `observe()` に `occurredAt` を渡していない**
  （`examples/chat/src/probe-set.ts` / `retrieval-quality.ts` に `occurredAt` の語が0件）。
  `buildNewMemoryFromCandidate` は `occurredAt: params.observation.occurredAt ?? null` を書く。
- **【現物】このベンチは強化を起こしていない**（`examples/chat/src` に `memory_usage` / `reinforce` が0件）
  ⟹ `lastReinforcedAt` は `null` のまま。
- ⟹ 両方とも `recordedAt` 起点・同じ `now`・同じ `halfLifeHours`・`strength = 1` で
  **同じ式に同じ引数を渡している。⟹ 同じ double が返る**（`Math.min(1, …)` は値が1未満なので効かない）。

**⚠ `memories` テーブルの `occurred_at` / `last_reinforced_at` の実カラムは、本測定では
SQL で数えていない。**上は式とベンチ側の呼び方からの導出である。
（**同じことを SQL で数えた記録は ADR 0081 §4.1 に在る**——arm C のテナントで
`occurred_at IS NOT NULL` が 0件、`strength <> 1` が 0件。**ただしそれは別 HEAD・別 run である。**）

**⟹ `freshness` は独立した項として存在していない。**§5 でこれを `total` の形にまで詰める。

---

## 3. 実測: `tagMatch` と `strength` は厳密に定数 1 である【実測】

**run1・run2 とも、210行すべてで `tagMatch === 1` かつ `strength === 1`**
（`toExponential(17)` で `1.00000000000000000e+0`。通り数はどちらも 1）。

**【現物】理由は2つとも構造である:**

- `tagMatch`: **ベンチは `recall(ctx, { text: probe.query })` しか呼ばない**
  （`retrieval-quality.ts` の `recall(` 呼び出しは1箇所、`tags` を渡している箇所は0件）
  ⟹ `queryTags` が空 ⟹ `computeTagMatch` は `1 + 0 × 0.1 = 1` を返す。
- `strength`: `buildNewMemoryFromCandidate`（`packages/core/src/extraction.ts`）が
  **無条件に `strength: 1` を書く**（同ファイル内の `strength:` は2箇所、どちらも `1`）。
  [ADR 0041](./0041-reinforce-does-not-change-strength.md) が「`reinforce` は `strength` を動かさない」と
  決めており、[ADR 0078](./0078-strength-value-range.md) は値域を `(0, 1]` に締めたが
  **値を動かす口は開けていない。**

**⟹ この2項は順位に構造上ゼロ寄与である。重みをいくら触っても、順位は1つも動かない。**

---

## 4. 実測: `decay` の変域 — そして ADR 0081 の「1e-8 桁」の訂正【実測】

**run1、arm ごと70行:**

| arm | min | max | `1 - max` | `1 - min` | 幅（max − min） | 通り数 |
|---|---|---|---|---|---|---|
| A | `9.99999541110999646e-1` | `9.99999804250120916e-1` | `1.95749879083884082e-7` | `4.58889000354290033e-7` | 約 `2.63e-7` | 69 |
| B | `9.99999546459355071e-1` | `9.99999823236787821e-1` | `1.76763212178521201e-7` | `4.53540644929084635e-7` | 約 `2.77e-7` | 63 |
| C | `9.99999525600768990e-1` | `9.99999797832092807e-1` | `2.02167907192851715e-7` | `4.74399231009670075e-7` | 約 `2.72e-7` | 66 |

**1 を超えた行は 0件**（3 arm・2 run とも）。

### 🔴 訂正: 「`decay` の変域は 1e-8 桁」は、この系の定数ではない

**【現物】ADR 0081 §1 は `decay` を「常に 0.99999991…〜0.99999996…（1.0 からの差が 1e-8 桁）」と
記録している。本測定の値は 1 からの差が `1.8e-7`〜`4.7e-7` で、桁が1つ違う。**

**⟹ どちらかが誤っているのではない。この値は測定器の速さの関数である。**
`decay = 0.5 ** (elapsed / 720h)` であり、`elapsed` は**その Memory を取り込んでから
`recall()` するまでの実時間**である。⟹ 1 からの差はおおよそ `ln2 × elapsed / 720h` に比例し、
本測定の `1.8e-7`〜`4.7e-7` は `elapsed ≈ 0.73 秒`〜`1.72 秒` に当たる（半減期の既定は 720時間）。**取り込みが速い器ほど 1 に近づく。**

**⟹ 「1e-8 桁」という数字を、この系の性質として引き継がないこと。**
**引き継ぐべきは桁そのものではなく、§5 の比である**——`similarity` の差との比だけが、
順位に効くかどうかを決める。（ADR 0081 §9 は「取り込みが長時間に分散したとき」を
覆る条件として挙げており、**その向きは正しかった。本測定はその条件が実際に効くことを示した。**）

**⚠ run1 と run2 でも `decay` の値は動いた**（例: arm A の min は
run1 `9.99999541110999646e-1` / run2 `9.99999522124338069e-1`）。
**順位・MRR・`hit@1`/`hit@10` は2 run で完全に一致した。**

---

## 5. 結論: `total` の順位を決めているのは `similarity` ただ1項である【実測】

**⚠ §1 のとおり `decay`/`freshness` は行ごとに違う値を取る。⟹ 「定数だから効かない」とは言えない。
⟹ 効くかどうかを、2つの独立した方法で測った。**

### 5.1 直接: `similarity` だけで並べ替えると、実際の順位が再現する

**run1・run2 とも、21組（3 arm × 7 probe）すべてで、`similarity` の降順だけで並べ替えた
候補の並びが、`total` が実際に作った並びと1件も違わずに一致した（21/21 × 2 run）。**

### 5.2 余裕: `decay²` の振れ幅は、隣接する順位の差より 2桁以上小さい

各組について、**隣り合う順位の `similarity` の相対差の最小値**と、
**その組で `decay × freshness`（= `decay²`）が作りうる最大の相対振れ幅**を比べた:

| | 値 |
|---|---|
| 最も詰まっていた組（arm A / diet）の隣接相対差 | `6.9433e-5` |
| 同じ組の `decay²` の最大相対振れ幅 | `3.5674e-7` |
| **21組すべてでの「隣接差 ÷ `decay²` の振れ幅」の最小値** | **約 195 倍** |
| `similarity` の相対変域 ÷ `decay²` の振れ幅 | **7.8×10⁴ 〜 1.6×10⁶ 倍** |

**⟹ `decay` と `freshness` は動いているが、順位を1つも動かせない。**
**⟹ 逆転させるには、隣接する候補の `similarity` が現状の 1/195 以下まで詰まる必要がある。**

### 5.3 `total` は210行すべてで `similarity × decay²` にビット単位で一致する

**run1・run2 とも、210行すべてで `total === similarity × decay × decay`（厳密比較、最大絶対誤差 `0`）。**
`affinity × decay × tagMatch × freshness × strength`（`scoring.ts` の式そのままの順序）での検算も
**210/210 で厳密一致、mismatch 0。**

**⟹ 「`total` は実質 `similarity × decay²`」は比喩ではない。このベンチでは厳密にそうである。**
根拠は §2（`freshness === decay`）と §3（`tagMatch === strength === 1`）と、
**`lexicalMatch` の欄が210行すべてで存在しないこと**（ADR 0108 の実測を、現 HEAD で再確認した。
`affinity` は `similarity ?? 1` に退化する）。

**⟹ 隠れた第6の項は無い。**`total` は5項の積として説明し切れている
（北極星の問い3「なぜ選ばれたかを後から説明できるか」に対する、この経路での答え）。

### 5.4 ⛔ ここから「では重みをこう変えよう」を導かないこと

**この ADR は測っただけである。**重みの変更は製品の判断であり、範囲外である。
**ただし測定が閉じたことは1つある**——**`tagMatch` と `strength` の重みを触る案は、
順位に対して構造上ゼロである**（§3）。ADR 0081 §7 と同じ結論に、別 HEAD で再び着いた。

---

## 6. 置いたもの — 測定を CI が忘れない形

**⚠ ADR 0081 の計装は捨てられ、2026-09-09 の測定は repo に何も残さなかった。**
**⟹ 同じことを繰り返さないために、今回は器の側へ置く。**

### 6.1 記録と印字だけを足す（⛔ 重み・閾値・probe set は変えない）

- `TermSpread.distinctCount`（厳密比較の通り数）。**幅 0 と「1通り」は別の主張である**（ADR 0081 §1.1）。
- `computeDecayFreshnessRowwise()` と `ProbeOutcome.decayFreshnessRowwise`。
- `ArmHeadline` の arm 単位集計（`termDistinct` / `decayFreshnessEqualRows` /
  `decayFreshnessDifferentRows`）——**`report.probes` からのみ導く**（ADR 0068 ②の線）。
- `MNEMORA_RETRIEVAL_JSON` の**省略可能欄**（ADR 0108 と同じ理由で `schemaVersion` は上げない）。
  **⭐ JSON は数値を丸めずに書く。⟹ ここが 1e-7 桁の差を機械可読に残す唯一の経路である。**
- **`formatExactScoreValue`（丸めない整形）**での2行の追加印字。
  **既存の `formatScoreValue` と既存の行の文面は1文字も変えていない**
  ——**ADR 0081 §6.2 の欠陥を、既存の出力を壊さずに塞ぐ。**
- **非門の Job Summary 節**（`scripts/retrieval-quality-summary-lib.mjs`）。
  `maxDistinctPerProbe === 1` の項を名指しし、`decay`/`freshness` が全行等価だったかを出す。
  **⛔ このジョブは門ではない**（`retrieval-quality` ジョブ自身がそう明記している場に相乗りする）。
  **欄を持たない古い JSON では何も言わない**——測れないことを「0 だった」と偽らない。

### 6.2 ⭐ 向きを反転させた歯（ADR 0108 の歯と同じ向き）

`examples/chat/src/__tests__/retrieval-quality.postgres.test.ts` に1本。
**「いま赤く、直ったら緑」ではなく、「いま緑で、前提が黙って変わったら赤」。**
測るのは欠陥ではなく、**§2・§3 が依存している前提そのもの**である:

- `tagMatch` がどの probe でも1通りで、厳密に 1 であること（＝ `recall()` に `tags` が渡っていない）
- `strength` が同上（＝ `Memory.strength` に 1 以外が書かれていない）
- `decay === freshness` が全行で成り立つこと（＝ `occurredAt` も `lastReinforcedAt` も埋まっていない）
- **候補が0行でないこと**（⚠ これが無いと「測れなかったから通っただけ」の歯になる）

**⚠ 値そのもの（`similarity`・`decay`・MRR・順位）は assert しない。**
カセットと実行時刻に依存するからである（ADR 0108 の歯と同じ規律）。

**⟹ この歯が赤くなったら、それは欠陥ではなく「§5 の結論の前提が変わった」という意味である。
⟹ そのときは順位を測り直すこと。⛔ 歯を消すだけにしないこと。**

---

## 7. 検討した代替案

- **ベンチの印字（`formatScoreValue`）そのものを丸めない形に直す。** **採らない。**
  既存の出力の文面を変えると、それを読んでいる歯（`retrieval-quality-score.test.ts` 等）と
  過去のログとの比較が同時に壊れる。**足すほうを選び、既存は1文字も変えなかった。**
- **`decay` の変域を「小さいから無視してよい」と宣言して終わる。** **採らない。**
  §1 のとおり `decay` は行ごとに違う値を取っており、**小さいことと効かないことは別である。**
  §5.2 の比（195倍の余裕）まで測って初めて「効かない」と言える。
- **重みを調整して `hit@1` を上げる。** **範囲外。**
  ADR 0081 §7 / [ADR 0055](./0055-extraction-prompt-subject-and-inference-not-added.md) が
  別の根拠で既に閉じている道でもある。
- **`LexicalStore` を配線して `lexicalMatch` を生かす。** **範囲外**
  （[Issue #179](https://github.com/takecchi/mnemora/issues/179)）。
- **probe に `occurredAt` を通して `freshness` を `decay` から分離する。** **採らない。**
  [ADR 0058](./0058-measure-the-time-term-in-a-separate-arm.md) が
  「`probe-set.ts` の14件は1文字も変えず、別 arm（`time-term-*`）で測る」と既に決めている。

---

## 8. 引き受けた負債・覆えていない範囲

- **`memories` テーブルの `occurred_at` / `last_reinforced_at` / `strength` を SQL で数えていない**（§2）。
  式とベンチ側の呼び方から導いており、**同じことを SQL で数えた記録は ADR 0081 §4.1（別 HEAD）である。**
- **一時計装は commit していない。**恒久化したのは §6 の集計であり、
  **1行ごとの生値ダンプそのものは repo に残っていない。**
  ⟹ 行単位でもう一度見たい人は、§「測った条件」の `MNEMORA_DEBUG_RAW_SCORES` 相当を足し直す必要が在る。
- **§5.2 の「195倍」は、このカセット・この haystack（60件）・この HEAD に固有の数字である。**
  probe が増えたり haystack が変われば、隣接差は詰まりうる。
- **生の出力ファイル（`run1-rows.log` / `run2-rows.log` ほか）は repo に入れていない。**
  作業器の中にあり、器が入れ替われば消える。**⟹ だから「測った条件」節と §6 が唯一の保全である。**
- **arm A（擬似埋め込み）の数字も §1〜§5 に含めている。**
  **⚠ arm A の MRR は 0.018（実質ランダム）であり、性能について何も言っていない**
  （AGENTS.md の警告）。**本 ADR が arm A を使っているのは、項の**構造**を測るためである。**
- **2 run しか取っていない**（ADR 0081 は4 run）。順位は2 run で完全一致した。

---

## 9. これが覆るとしたら

- **`recall()` に `tags` を渡す呼び出し側が現れたとき**（§3 が崩れる。§6.2 の歯が赤くなる）。
- **抽出が `strength` に 1 以外を書くようになったとき**（同上）。
- **`observe()` に `occurredAt` を渡す arm や、`memory_usage` による強化が入ったとき**
  ——`decay` と `freshness` の起点が分かれ、**§2 と §5.3 のビット単位の一致が崩れる**（歯が赤くなる）。
- **`LexicalStore` が配線されたとき**（Issue #179）——`affinity = max(similarity, lexicalMatch)` が
  `similarity` への退化をやめる。**⟹ §5 の結論はその時点で測り直しである**（ADR 0108 の歯が赤くなる）。
- **取り込みが長時間に分散したとき**——§4 のとおり `decay` の 1 からの差は経過時間に比例する。
  §5.2 の 195倍の余裕は、取り込みが数秒で終わることに依存している。
  **⟹ 取り込みが数時間に延びれば、`decay` は順位を動かしうる。**
- **埋め込みモデル／カセットを替えたとき**——`similarity` の分布そのものが変わる。

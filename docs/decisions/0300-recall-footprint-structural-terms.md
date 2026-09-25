# ADR 0300: `recall-footprint` の見積もりに、`indexBand` の実 JSON 構造から決まる4つの構造項を足す（Issue #340）

- **状態**: 採用 (2026-09-25)
- **日付**: 2026-09-25

> **⚠ この ADR は、自動化された担い手（マネージャーのセッションから切り出された worker
> セッション）が書いた。⛔ オーナー本人の判定ではない**（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
> マネージャーの委譲（[Issue #340](https://github.com/takecchi/mnemora/issues/340) の
> フォロー）に基づく技術的な修正であり、`docs/north-star.md` の方向そのものを変える
> 判断ではない。

**⚠ 各主張の出所を分ける**（ADR 0147 / 0166 / 0201 の体裁を踏む）。

- **【実測】** — この作業でコマンドを打って/歯を実行して確かめた。
- **【現物】** — この repo のコード・文書を読んで確かめた。
- **【受】** — 報告（Issue コメント・マネージャーの委譲文）として受け取り、この作業では再導出していない。

---

## 結論（先に）

[ADR 0147](./0147-recall-footprint-estimator.md) の `estimateRecallFootprint` は、
`BUILTIN_RECALL_FOOTPRINT_PROFILE`（`charsPerDigest` / `fixedIndexChars` の2係数）を
「目次帯が空・`totalInScope`/`digestBandCoverage.shown`/`digestBandCoverage.eligible` が
すべて1桁」という**特定の形**の `indexBand` から較正しているが、その形から外れたときの
実際の `JSON.stringify(indexBand)`（`recall-runtime.ts`）とのずれを1つも数えていなかった
（[Issue #340](https://github.com/takecchi/mnemora/issues/340) comment
[5822837148](https://github.com/takecchi/mnemora/issues/340#issuecomment-5822837148)、
以下「該当コメント」）。

**この PR（[#（本ブランチ）](https://github.com/takecchi/mnemora/tree/fix/recall-footprint-structural-terms)）は、該当コメントの主張を in-memory runtime で実際に `recall()` を呼んで当て直し、
JSON の構文だけから決まる4つの構造項を `estimateRecallFootprint` に加算項として足した。**
較正係数（`charsPerDigest` / `fixedIndexChars`）は1つも動かしていない——hold-in 標本
（`examples/chat/compare-baseline.json` の7行）はすべて「帯なし・1桁」の形であり、
今回の4項はそこでは全部0になるため。

## 文脈

**オーナー takecchi の逐語**（[ADR 0147](./0147-recall-footprint-estimator.md) が引用、
2026-09-16、マネージャー経由で受領。【受】）:

> **「10ターン未満では mnemora のほうが大きい」これについてですが、mnemora使った方が良い場面と
> 悪い場面を判別できるような関数があるといいかもしれません。**

これを受けて ADR 0147 が `estimateRecallFootprint` を導入し、[ADR 0201](./0201-recall-footprint-char-margin-canary.md)
が許容誤差の余白を字数で見る歯を足した。その過程で、未マージの
[PR #701](https://github.com/takecchi/mnemora/pull/701)（`bench/340-unique-filler`
ブランチ、Issue #340 の「filler の一意性」対処）で、ADR 0201 の余白の歯が赤くなった。
**別のクローンのセッションが「歯を緩めずに推定器の側を直せるか」を調べ**（該当コメント）、
**推定器が数えていない構造差**を4つ実測で特定したが、**「hold-out を見て項を選ぶことになる」
という理由でその場では直さず**、「別 PR で main の基準値に対して出す」とだけ書き残した。
**本 ADR・本 PR がその「別 PR」である。**

## 決定

### 決定1: 4つの構造項を「較正係数ではなく加算項」として実装する

`fixedIndexChars` を再較正するのではなく、`estimateRecallFootprint` の中で
**shape から構造的に決まる補正**として足す。理由: これらのずれは実データのばらつきでは
なく、`JSON.stringify` の構文（配列のカンマ・数値の桁数・省略可能キーの有無）そのもの
から決まる——**データを見て決める係数と、構文から決まる定数を、同じ2つの自由係数に
混ぜない**（`RecallFootprintProfile` の doc「自由な係数は2つだけである」という既存の
設計方針をそのまま守る）。

4項目（`packages/core/src/recall-footprint.ts` の該当コメント・doc に実装):

| 項 | 内容 | 効く条件 |
|---|---|---|
| (a) カンマ | 帯の配列の要素区切りは `n` 件で `n-1` 個だが、既存の `bandEntryChars` は1件ごとに区切り1字を計上している（`n` 個分）ため、帯が非空なら常に1字だけ数えすぎる | 帯が非空、かつ帯が文字数上限で飽和していない |
| (b) 桁上がり(totalInScope) | `totalInScope` は `IndexBand.totalInScope` と、**単一 group を仮定した** `groups[0].count`（同値）の両方に現れる。1桁を超えた分だけ、両方合わせて `2×(桁数-1)` バイト増える | 常時（`memoryCountInScope` が2桁以上） |
| (c) 桁上がり(shown/eligible) | `digestBandCoverage.shown`（=帯の件数）・`eligible`（=帯の資格件数）も同様に1桁を超えた分だけ増える | 常時（それぞれが2桁以上） |
| (d) limitedBy | 帯が entry_limit（または char_budget。バイト数は同じ11字）で切られたときだけ `digestBandCoverage.limitedBy` が足され、26字増える | 帯が件数で切られており、かつ帯が文字数上限で飽和していない |

### 決定2: 「単一 group」を仮定する。`RecallFootprintShape` は変えない

(b) の `groups[0].count` 側の桁上がりは、スコープ内が単一の subject（= `groups` が
1要素）であることを仮定している。**`RecallFootprintShape` は group の内訳を持たない**
——持たせると公開シグネチャが変わる（本 PR の制約）。単一 group はこのリポジトリの
較正データ（`examples/chat/compare-baseline.json`、1ユーザーの会話）の実際の形であり、
それ以外を持ち込む情報が shape に無い以上、これが「構造から決まる範囲で最善」の仮定
である。**複数 group では崩れる**（引き受けた負債1）。

### 決定3: 帯が文字数上限で飽和している領域には、(a)/(d) を適用しない

`estimateRecallFootprint` は「帯の件数 = `min(digestBandLimit, bandEligible)`」という
**既存の近似**を持っており、帯が実際には文字数上限（`DIGEST_BAND_MAX_CHARS`）で
先に打ち切られる領域（`bandSaturated`）では、この近似自体が実際の `packDigestBand` の
打ち切り位置と乖離している（本 PR 以前からの挙動——変えていない）。この領域では
「帯の件数」も「`limitedBy` がどの値になるか」ももはや shape だけからは決まらない
——ここで手を広げず、(a)/(d) は `!bandSaturated` のときだけ効かせる。**この既存の近似
自体の解消は本 PR の対象外**（引き受けた負債3）。

### 決定4: 較正は hold-in のみ。hold-out を見て項を選ばない

**hold-out（`compare-baseline.json` の `totalInScope > DEFAULT_RECALL_LIMIT` の5行）の
結果を見てから、通る項だけを選び取っていない。** 4項目はすべて、in-memory runtime の
実 `recall()` で JSON 構造を検算した結果として決めた——hold-out 行を1行も見ずに
導出できる（下の「測ったこと」参照）。

⚠ **これは該当コメントが名指しで警告していた自己参照を避けるためである**: 該当コメントは
「カンマの1項だけ直せば（PR #701 の基準値では）歯が緑になる」ことを実測していたが、
**それは hold-out を見てから項を選んだことになる**ため採らなかった、と明記している。
**本 PR も同じ理由で、4項全部を入れるか、4項とも入れないかの二択とし、
一部だけを拾う判断はしていない。**

## 測ったこと

### 【実測】構造項の当て直し（in-memory runtime、実 `recall()`）

`packages/testkit` を使わず（`packages/core` の既存の作法）、`runtime-fakes.ts` の
in-memory 実装で `createRuntime` を組み、digest 長を固定し、`memoryId` を本物の
UUID と同じ36字に揃えた（`DIGEST_BAND_ENTRY_FIXED_OVERHEAD_CHARS=63` が36字の UUID を
前提に実測した定数であるため——`mem-<counter>` のままだと id の桁が伸び縮みし、
検査したい構造差と無関係なノイズになる）。帯0/1/2/多数件・`totalInScope` 1/2/3桁・
帯切り詰めあり/なしの各シナリオで、実際の `usage.chars` と `estimateRecallFootprint`
の見積もり（`charsPerDigest`=固定した digest 長、`fixedIndexChars`=帯なし・単一group・
1桁の基準シナリオで実測した値）を比較した:

| シナリオ | 修正前の差 | 修正後の差 |
|---|---:|---:|
| 帯=0(1桁) | 0 | 0 |
| 帯=1(1桁) | +1 | 0 |
| 帯=2(1桁) | +1 | 0 |
| 帯=多数、切り詰めなし(totalInScope 2桁) | −3 | 0 |
| 帯がentry_limitで切られる(totalInScope 2桁) | −28 | 0 |
| 帯がentry_limitで切られる(totalInScope 3桁) | −31 | 0 |
| （参考）帯が文字数上限で飽和(totalInScope 3桁) | −20 | −20（変わらず、決定3で対象外） |
| （参考）groupsが複数件 | −132 | −132（変わらず、決定2で対象外） |

`packages/core/src/__tests__/recall-footprint.test.ts` の該当する歯（`describe`
「構造項をin-memory runtimeの実recall()に対して検算する」）が上表の主張をそのまま
主張・検査している。歯は実装前に赤いことを確認済み（コミット履歴参照）。

### 【実測】main の `compare-baseline.json` での hold-in 較正・hold-out 検算

`calibrateRecallFootprint`（hold-in 7行、すべて帯なし・1桁）で較正した係数は
**修正前後で完全一致**: `charsPerDigest≈15.4583333`, `fixedIndexChars≈170.8809524`。
——hold-in 7行はどれも4構造項の効かない形なので、これは決定4の設計通りの結果である。

hold-out 5行の誤差・余白（`ACCURACY_TOLERANCE=0.025`、`examples/chat/src/__tests__/recall-footprint-baseline.test.ts`
は一切変更していない）:

| turnCount | totalInScope | 前:誤差% | 後:誤差% | 前:上余白 | 後:上余白 | 前:下余白 | 後:下余白 | FLOOR |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 42 | 14 | 0.635% | 0.464% | 11.15 | 12.18 | 17.83 | 16.86 | 7.73 |
| 82 | 25 | 1.462% | 1.239% | 14.32 | 17.40 | 51.99 | 49.06 | 7.73 |
| 162 | 49 | 1.127% | 1.030% | 43.30 | 46.37 | 108.82 | 105.89 | 7.73 |
| 322 | 95 | 2.068% | 1.430% | 20.14 | 49.89 | 202.64 | 174.35 | 7.73 |
| 642 | 189 | 0.515% | 0.200% | 91.14 | 123.96 | 131.64 | 100.43 | 7.73 |

12行全体の最大誤差: **2.068% → 1.562%**（改善）。`recall-footprint-baseline.test.ts`
（24歯）は修正前後とも全緑。

### 【実測】未マージ PR #701（`bench/340-unique-filler`）の基準値では 82 行が赤くなる

`git show origin/bench/340-unique-filler:examples/chat/compare-baseline.json` を読み、
そのファイル（本 PR では一切変更していない main とは別物）に対して、**この PR の
実装**で同じ較正・検算を走らせた（【実測】、PR #701 をチェックアウトも merge もしていない
——読んだだけ）:

| | 82行 下側の余白（FLOOR 7.22字） | 12行全体の最大誤差% |
|---|---:|---:|
| 修正前（main の実装、PR #701 の基準値に対して） | 6.51字（**既に赤**） | 2.061% |
| 修正後（本 PR、PR #701 の基準値に対して） | 5.54字（**赤のまま、やや悪化**） | 2.061%（同一行が最大） |

**修正前の時点で PR #701 の基準値に対してはすでに赤い**（82行の下側余白が FLOOR を
下回る）。本 PR の構造項を足すと、82行の絶対誤差そのものは改善する方向に働くが
（見積もりが実測に近づく）、**下側の余白は縮む**——構造項が入る前は見積もりが実測より
大きくズレて「安全側」に寄っていたためで、これは該当コメントの表（「構造項をすべて
入れる」行、5.54字）と一致する【実測で再現・確認】。**⟹ 本 PR は PR #701 を緑にする
ものではなく、そう意図してもいない**（コメント・本 ADR とも明記済み）。PR #701 側の
赤（ADR 0201 の余白の歯）の対処は、この PR の射程外である。

### 【実測】変異試験

`packages/core/src/__tests__/recall-footprint.test.ts` の構造項の歯・言い直した3本の
歯に対し、以下の変異を入れて赤くなることを確認した（変異はすべて元に戻し済み）:

| 変異 | 構造項の歯（新設6本） | 言い直した3本 | baseline gate（24本） |
|---|---|---|---|
| (a) カンマ項を戻す(0固定) | 5 failed | 1 failed（ADR0166の歯） | 24 passed（**捕まえない**） |
| (b) 桁上がり項を落とす(0固定) | 3 failed | 3 failed（全部） | 24 passed（**捕まえない**） |
| (c) limitedBy項を落とす(0固定) | 2 failed | 0 failed（対象シナリオを含まないため） | 24 passed（**捕まえない**） |
| (d) カンマの1項だけ残す（hold-outに合わせた過適合。該当コメントが警告していたもの） | 3 failed | — | 24 passed、narrowest margin 10.13字（**捕まえない**） |

⟹ **baseline gate（examples/chat 側の24歯）単体では、上のどの変異も検知できない。**
これは該当コメントの指摘（「カンマの1項だけ拾えば緑になる」）と一致する実測であり、
`recall-footprint.test.ts` 側の歯が無ければ、(d) のような過適合が紛れ込んでも
baseline gate は気づけない。

## 採らなかった案

1. **カンマの1項だけを直す**（該当コメント「参考」欄）。main の基準値では歯を緑に
   保てるが、**hold-out（82行）の結果を見て「この項だけなら緑になる」と選んだことに
   なる**——決定4の理由で採らなかった。
2. **係数を再較正する**（`fixedIndexChars`/`charsPerDigest` の値そのものを変えて
   ずれを吸収する）。構造的なずれ（JSON 構文から決まる、shape の値ごとに変わる量）を
   定数1個で近似すると、`totalInScope` が変わるたびに誤差の向きと大きさが変わり
   続ける——**そもそも定数で吸収できる性質のずれではない**（決定1参照）。
3. **`RecallFootprintShape` に `groups` の内訳を持たせ、複数 group を正しく扱う**。
   本 PR の制約（公開シグネチャを変えない）に反するため採らなかった。将来的に
   group の内訳を shape に持たせる判断があるなら、そのときに決定2を見直す。

## 引き受けた負債

1. **複数 group のとき、決定2の「単一 group」仮定が崩れる。** `RecallFootprintShape`
   が group 内訳を持たないため、`estimateRecallFootprint` からは原理的に直せない
   （実測で+132〜+134字のずれ、上の表）。`recall-footprint.test.ts` の「既知の残差」
   の歯がこれを明示している。
2. **`totalInScope=0` のとき、実際の `groups` は空配列 `[]` になる**（`runtime-fakes.ts`
   ・`packages/postgres/src/memory-store.ts` の両方で確認【現物】）が、この構造項の
   計算はそれを考慮しない。`memoryCountInScope=0` は較正標本（`calibrateRecallFootprint`
   が `memoryCount > 0` の標本だけを使う）にも実質現れないため、影響は小さいと見て
   実装していない。
3. **帯が文字数上限（`DIGEST_BAND_MAX_CHARS`）で飽和する領域**の既存の近似（決定3）は
   本 PR の対象外のまま残る——`帯の件数` が実際の `packDigestBand` の打ち切り位置と
   乖離する状況で、(a)/(d) を適用しないというガードで隔離しただけである。
4. **既存の単体テスト3本**（`recall-footprint.test.ts`、境界の算術を検査するもの）が
   構造項の導入で赤くなったため、主張を構造から導く形に言い直した（本 PR 後半の
   コミット）。数値を実測値へ貼り替えたのではないが、**元の主張（「chars は完全に
   頭打ちで1バイトも動かない」等）が厳密には成り立たなくなったこと自体**は、
   このリポジトリの `recall-footprint.ts` の doc コメント（「O(1)で頭打ちになり」）
   にとって軽微だが実在するニュアンスであり、doc 側にも反映した
   （`estimateRecallFootprint` の doc、構造項(b)/(c)の節）。

## これが覆るとしたら

- `RecallFootprintShape` に group の内訳（または「単一 group かどうか」のヒント）を
  持たせる判断がされたら、決定2を見直す。
- `packDigestBand` の打ち切りモデル自体（`bandEntries`/`bandSaturated` の近似）が
  見直されたら、決定3のガード条件も見直しが要る。
- PR #701（もしくはその後継）がマージされ、`compare-baseline.json` の値が変われば、
  `BUILTIN_RECALL_FOOTPRINT_PROFILE` の再較正・ADR 0201 の余白の歯の扱いが別途
  必要になる——**本 ADR・本 PR はその引き金を引かない**（対象外のまま）。

## 確かめていないこと

- 実運用（多数の subject が混在するスコープ）で、決定2の「単一 group」仮定が
  どの程度の頻度で崩れるか。
- `totalInScope=0` かつ帯を要求する呼び出しが実際に発生するか（較正標本には現れない
  が、`estimateRecallFootprint` は入力を拒否しないため呼べてしまう）。
- CI（`example-chat` ジョブ）上での実測——この作業は `DATABASE_URL` を使わず
  `packages/core` の in-memory runtime と `examples/chat/compare-baseline.json`
  （commit 済みの値）だけで検算した。

## 人から受け取った前提（出所付き）

- **【受】** マネージャーの委譲文（本 PR の作業指示）: Issue #340 comment 5822837148
  の主張を実コードで当て直し、hold-in のみで較正し、hold-out を見て項を選ばないこと。
- **【受】** 該当コメント自身（クローンの委譲で動くセッションが書いたもの、
  オーナー本人の判定ではないと自ら名乗っている）: 4つの構造差の実測値・
  「カンマの1項だけなら hold-out で緑になる」という警告・「別 PR で main の基準値に
  対して出す」という申し送り。

# ADR 0306: `calibrateRecallFootprint` は、較正の前に構造項を差し引く（Issue #340 フォローアップ）

- **状態**: 採用 (2026-09-25)
- **日付**: 2026-09-25

> **⚠ この ADR は、自動化された担い手（マネージャーのセッションから切り出された worker
> セッション）が書いた。⛔ オーナー本人の判定ではない**（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
> マネージャーの委譲（[Issue #340](https://github.com/takecchi/mnemora/issues/340) の
> フォロー、[ADR 0302](./0302-recall-footprint-structural-terms.md) の続き）に基づく
> 技術的な修正であり、`docs/north-star.md` の方向そのものを変える判断ではない。

**⚠ 各主張の出所を分ける**（ADR 0147 / 0166 / 0201 / 0302 の体裁を踏む）。

- **【実測】** — この作業でコマンドを打って/歯を実行して確かめた。
- **【現物】** — この repo のコード・文書を読んで確かめた。
- **【受】** — 報告（マネージャーの委譲文）として受け取り、この作業では再導出していない。

---

## 結論（先に）

[ADR 0302](./0302-recall-footprint-structural-terms.md) は `estimateRecallFootprint` に、
`indexBand` の JSON 構造（帯のカンマ・`totalInScope`/`digestBandCoverage.shown`/`eligible`
の桁上がり・`limitedBy`）から決まる4つの構造項を**足した**。だが `calibrateRecallFootprint`
は較正の標本から `totalInScope` を知りようがなく、`totalChars` から同じ構造項を**差し引けて
いなかった**。ADR 0302 はこれを「hold-in（`compare-baseline.json` の7行）はすべて
`totalInScope` が1桁」という前提の下で許容していた——1桁なら構造項は常に0なので、
差し引かなくても較正係数はずれない。**この前提が崩れる**（`totalInScope` が2桁以上の標本を
較正に混ぜる）と、桁上がり分が較正係数（`charsPerDigest`/`fixedIndexChars`）へ吸い込まれた
うえで、`estimateRecallFootprint` がその係数の上にもう一度同じ構造項を足す——**二重計上**
になる。

**本 PR は**:

1. `RecallFootprintSample` に **任意** の `totalInScope?: number` を足した（非破壊の純追加）。
   `footprintSampleFromRecall` は `result.index.totalInScope` からそのまま埋める。
2. ADR 0302 が `estimateRecallFootprint` の中に書いた構造項(a)〜(d)の計算を
   `indexBandStructuralTerms` という1つの関数に外出しし、`estimateRecallFootprint`
   （足す側）と `calibrateRecallFootprint`（差し引く側）の**両方がこの関数だけを呼ぶ**
   形にした（二重実装を作らない）。
3. `calibrateRecallFootprint` は、`totalInScope` を持つ標本については
   `indexBandStructuralTerms` で構造項を計算し、最小二乗にかける前に `totalChars` から
   差し引く。`totalInScope` を省略した標本は構造項0として扱う——**挙動は以前と1バイトも
   変わらない。**
4. 公開関数のシグネチャ（`calibrateRecallFootprint(samples, fallback)` /
   `estimateRecallFootprint(shape, profile)` 等）は1つも変えていない。

`BUILTIN_RECALL_FOOTPRINT_PROFILE` の係数（`charsPerDigest≒15.458` /
`fixedIndexChars≒170.881`）は1つも動かしていない——main の hold-in 7行は
すべて `totalInScope` が1桁であり（下の「測ったこと」参照）、この形では構造項は
常に0になるため、差し引きは無演算になる。

## 文脈

ADR 0302 の「確かめていないこと」節は、この二重計上の可能性そのものは名指ししていない。
だがマネージャーの委譲文（本 PR の作業指示）が、ADR 0302 の実装（`estimateRecallFootprint`
が構造項を足す）と `calibrateRecallFootprint` の実装（標本から `totalInScope` を受け取って
いない）を突き合わせ、**「ADR 0302 が明示的に依拠している前提（hold-in はすべて1桁）が
崩れたときに何が起きるか」を先に指摘した**——それが本 PR の出発点である【受】。

## 決定

### 決定1: 構造項の計算を推定器と較正側で共有する（二重実装しない）

`indexBandStructuralTerms(inScope, returnedMemories, bandEntries, charsPerDigest)` という
1つの関数に、ADR 0302 の構造項(a)〜(d)の計算をまとめた。`estimateRecallFootprint` は
自分で計算した `bandEntries`（`min(digestBandLimit, bandEligible)`）を渡し、
`calibrateRecallFootprint` は標本の実測値 `bandEntryCount`（較正に使う標本は常に`0`)を
そのまま渡す——**`bandLimit` からではなく `bandEntries` 自体を引数に取る設計**にしたことで、
較正側は `digestBandLimit` を知らなくても構造項を計算できる。

理由: 2箇所に同じ計算を書くと、どちらかを直したときにもう片方が古いまま残り静かにずれる。
**本 ADR が塞ぐ不具合自体が、まさに「片方（推定器）だけが構造項を知っている」ことで
起きた二重計上だった**——同じ形の不具合を、直した後に再び作らないための設計である。

### 決定2: `totalInScope` は任意欄にし、省略時は構造項0（後方互換）

`RecallFootprintSample.totalInScope` を**任意**にした。理由:

- 公開シグネチャ（`RecallFootprintSample` は公開型）を破壊的に変えない、という制約
  （マネージャーの委譲文）を満たす。
- 呼び出し側が独自に組み立てた標本（`totalInScope` を持たない）を渡しても、
  これまでと1バイトも変わらない結果を返す——`docs/decisions/README.md` や
  ADR 0166「後方互換」と同じ作法。

`calibrateRecallFootprint` 内部では `structuralCarryForSample(sample)` が
`sample.totalInScope === undefined` のとき無条件に `0` を返す。

### 決定3: 較正に使う標本（`bandEntryCount === 0`）では、構造項のうち実質効くのは
`totalInScope` の桁上がり(構造項b)だけである

`calibrateRecallFootprint` が使うのは `bandEntryCount === 0`（帯が空）の標本だけである
（既存の設計、ADR 0147 由来）。この条件下で構造項(a)〜(d)がどうなるかを実コード・実 JSON
で当て直した（下の「測ったこと」）:

- **(a) カンマ**: `bandEntries === 0` のとき `bandEntryChars` の掛け算の相手が0になるため、
  常に0。
- **(b) `totalInScope` の桁上がり**: `totalInScope` が2桁以上なら非0。**これが本 PR が
  実際に差し引く対象のほとんどである。**
- **(c) `digestBandCoverage.shown`/`eligible` の桁上がり**: `shown`(=帯の件数)は
  `bandEntries === 0` なので常に1桁(0)——非0になるのは `eligible`(=帯の資格件数
  `bandEligible = totalInScope - returnedMemories`)が2桁以上のときだけ。
  **`bandEligible > 0` かつ帯が空、という組み合わせは `digestBandLimit === 0`
  を明示的に指定したときにだけ起きる**（`packages/core/src/digest-band.ts`
  `packDigestBand` の実装を読んで確認——`limit === 0` なら最初の候補で即座に
  `wouldExceedLimit` が真になり、`band` は空のまま `limitedBy` が立つ)。
- **(d) `limitedBy`**: 上と同じ条件（`bandEligible > bandEntries(=0)` かつ
  `digestBandLimit === 0` で切られた場合）でのみ非0（26字）。

⟹ **通常の呼び出し（`digestBandLimit` を省略、または0以外を指定）では、
較正に使われる標本の構造項は「(b) `totalInScope` の桁上がり」だけになる。**
(c)/(d) は `digestBandLimit === 0` という非通常のケースのみで効く——
`indexBandStructuralTerms` を共有しているので、そのケースが実際に発生しても
自動的に正しく差し引かれる（実装を分けていないので、想定外のケースを取りこぼさない）。

## 測ったこと

### 【実測】main の `compare-baseline.json` hold-in 7行は、いずれも `totalInScope` が1桁

```
turnCount totalInScope
2         2
4         3
6         3
8         3
10        4
12        5
22        8
```

`totalInScope <= DEFAULT_RECALL_LIMIT`(10) でフィルタした7行——`examples/chat/compare-baseline.json`
を `node` で読んで確認した。すべて1桁（0〜9）。

### 【実測】main の hold-in 7行に `totalInScope` を渡しても、較正係数はバイト単位で変わらない

`examples/chat/src/__tests__/recall-footprint-baseline.test.ts` に追加した歯
（describe「`calibrateRecallFootprint` — totalInScope を渡しても、hold-in 7行(すべて1桁)
では係数がバイト単位で変わらない」）が、`totalInScope` を渡した標本と渡さない標本の両方で
`calibrateRecallFootprint` を呼び、`Object.is` で `charsPerDigest`/`fixedIndexChars` の
完全一致を検査している。**24本だった既存の歯は1本も変えていない**——新しい `describe`
を1本（it 2本）追加し、ファイル全体は24 → 26 tests、全緑。

### 【実測】既知の真の係数からの合成標本で、赤→緑を確認した

`packages/core/src/__tests__/recall-footprint.test.ts` に、既知の真の係数
（`charsPerDigest=12.3`, `fixedIndexChars=200.7`）から `totalChars = f + n*c + 構造項(n)`
を合成する標本（`totalInScope` に1桁×2・2桁×2・3桁×2を混ぜた6点、帯は常に空
= `memoryCount = totalInScope`）を追加した:

- `totalInScope` を渡さない場合: `charsPerDigest` が真値から **+0.00754**、
  `fixedIndexChars` が **+1.026** ずれる（【実測】、構造項が係数へ吸い込まれた証拠）。
- `totalInScope` を渡す場合: 両係数とも真値に**浮動小数点の丸め（1e-13のオーダー）の
  範囲で一致する**。

この2本の歯は、実装（`structuralCarryForSample` による差し引き）を一時的に
「常に0を返す」へ戻すと(=fix適用前の挙動)前者は通ったまま、後者が
`toBeCloseTo(TRUE_CHARS_PER_DIGEST, 8)` で失敗することを確認済み（下の「変異試験」参照、
実装前の赤はこの変異と同じ形で確認した——実装と歯を同じ作業 セッション内で組んだため、
「実装前に書いた」という時間的順序そのものではなく、**「差し引きを外した状態で赤くなる」
という歯の実効性**を変異試験で直接確認したことを、ここに正直に書く）。

**【実測】修正前の実装に当てた赤（マネージャーが追加で確認した）**: 新しい歯をそのまま残し、
`packages/core/src/recall-footprint.ts` だけを `origin/main` の版（本修正の前）に戻して
`recall-footprint.test.ts` を走らせると、**4 failed / 40 passed** になった。
落ちた4本は次のとおり。

- 真の係数へ戻る歯
- `footprintSampleFromRecall` の写しの歯2本
- in-memory の往復の歯

修正後の版へ戻すと、**44 passed** になった。

### 【実測】in-memory runtime の実 `recall()` を使った較正 → 推定の往復

`packages/core/src/__tests__/recall-footprint.test.ts` の
「構造項をin-memory runtimeの実recall()に対して検算する」describe に追加した歯:

1. `totalInScope` が1桁(2件)・2桁(1件)・3桁(1件)になる4シナリオで、実際に
   `runtime.recall()` を呼ぶ（帯は常に空になるよう `limit` を `count` 以上にした）。
2. `footprintSampleFromRecall` で標本を作る（4件、`totalInScope` を自動的に含む）。
3. `calibrateRecallFootprint(samples)` で較正する。
4. 較正した `charsPerDigest` が、固定した digest 長（`DIGEST_LEN=10`）と一致する
   （`toBeCloseTo(10, 6)`）——構造項を正しく差し引けていれば、桁上がりに惑わされず
   真の digest 長が出る、という主張を実 `recall()` で検算。
5. 較正済みプロファイルで、held-out シナリオ（帯が非空のものを含む既存の
   `CLEAN_SCENARIOS`）を見積もり、実測 `usage.chars` と一致する
   （`toBeCloseTo(..., 6)`）ことを確認した。

この歯は全緑（【実測】、`pnpm --filter @mnemora/core exec vitest run
src/__tests__/recall-footprint.test.ts` で 44/44）。

### 【実測】`examples/chat/src/__tests__/recall-footprint-baseline.test.ts` は24/24緑のまま

新しい2本の歯を追加した後もファイル全体で26/26緑。既存の24本（`ACCURACY_TOLERANCE`/
`FLOOR_CHARS`/`compare-baseline.json`/hold-in・hold-out の分け方は1バイトも変更していない）
が引き続き全緑であることを実行して確認した。

### 【実測】`BUILTIN_RECALL_FOOTPRINT_PROFILE` は変わっていない

```
charsPerDigest: 15.458,
fixedIndexChars: 170.881,
```

`git diff` で該当2行が変更差分に含まれていないことを確認した。

### 【実測】変異試験

`packages/core/src/recall-footprint.ts` に対して、`cp` で退避してから以下4種の変異を
順に入れ、狙った歯が赤くなること・元に戻すと緑に戻ることを確認した（`git status --porcelain`
が変異試験の前後で空であることも確認済み）。

| # | 変異 | core（recall-footprint.test.ts、44本中） | baseline（recall-footprint-baseline.test.ts、26本中） |
|---|---|---|---|
| 1 | `structuralCarryForSample` を常に `0` を返すよう書き換える（差し引きを外す＝fix適用前） | 2 failed（合成標本の「真の係数へ戻る」/ in-memory round-trip） | 0 failed（**捕まえない**——hold-inは全部1桁なので差し引きが無演算） |
| 2 | 差し引く量を2倍にする（`totalChars - 2 * structuralCarryForSample(s)`） | 2 failed（同上2本） | 0 failed（**捕まえない**、理由同上） |
| 3 | `totalInScope` 省略時に `sample.memoryCount` を代わりに使ってしまう（省略時に桁上がりを仮定） | 4 failed（後方互換の歯・回帰防止の歯・合成標本2本のうち1本） | 0 failed（**捕まえない**——hold-inの `returnedCount` も全部1桁のため、この変異はそもそも発火しない） |
| 4 | 較正側だけ桁の数え方を1ずらした別実装（`String(n).length`、`-1`無し）に差し替える（二重実装・ドリフトの実例） | 3 failed | 1 failed（**捕まえる**——1桁(0〜9)でもこの変異は `mutatedExtraDigits` が1を返すため、hold-inのバイト単位一致テストが直接検知する） |

⟹ **合成標本・in-memory round-trip の歯（core側）は変異1〜4のすべてを捕まえる。
baseline側（hold-inの実データ）は変異4（実装の数え方そのものがずれる誤り）だけを捕まえ、
係数の値・差し引きの量に関わる変異1〜3は捕まえない**——hold-in 7行がすべて1桁で、
構造項がそもそも0になるため(決定3で説明した通り)。**これは想定通りである**——baseline
の歯は「main の実データでは何も壊れていない」ことを保証するものであり、
「較正の差し引きロジックが正しいか」を保証するのは core 側の合成標本・in-memory
round-trip の歯の役目である。

変異はすべて `cp` で退避したファイルへ戻して元に戻し、`git status --porcelain` が
空であることを確認した。

## 採らなかった案

1. **`fixedIndexChars`/`charsPerDigest` を再較正して構造的なずれを吸収する。**
   ADR 0302 決定1と同じ理由（構造から決まる量を、データ駆動の係数に混ぜない）で
   採らなかった——今回は較正**そのもの**の話なので、この案はそもそも「較正のやり方を
   変える」という本 PR の趣旨と矛盾する。
2. **較正側に構造項の計算を独自実装する。** マネージャーの委譲文が「二重実装しない」ことを
   明示的に要求している。変異試験の#4がまさにこの案を採った場合に起きるドリフトの実例——
   桁の数え方を1つずらすだけで、hold-in の実データですら検知できる誤差が出る
   （baseline側の変異表を見よ）。
3. **`RecallFootprintSample.totalInScope` を必須にする。** 呼び出し側の既存コード
   （`totalInScope` を持たない手組みの標本）を壊す。本 PR の制約（公開シグネチャを
   破壊的に変えない）に反するため採らなかった。

## 引き受けた負債

1. **`digestBandLimit === 0` を明示的に指定した呼び出しの標本を較正に混ぜると、
   構造項(c)/(d)（`digestBandCoverage.eligible`/`limitedBy` 由来）も差し引かれる。**
   これは決定3で説明した通り正しい挙動だが、この経路は本 PR のどの歯でも実際には
   踏んでいない（実測していない、確かめていないことの一部）。
2. **ADR 0302 決定2の「単一 group」仮定は本 PR でも変えていない。** 較正側の標本が
   複数 group のスコープから来ていた場合、`totalInScope` の桁上がり項は
   ADR 0302 と同じ理由で不正確になりうる。`RecallFootprintShape`/`RecallFootprintSample`
   のどちらも group 内訳を持たないため、これも本 PR の範囲では直せない
   （ADR 0302「引き受けた負債1」と同じ負債を較正側でも引き継ぐ）。

## これが覆るとしたら

- `RecallFootprintSample`/`RecallFootprintShape` に group の内訳を持たせる判断が
  されたら、`indexBandStructuralTerms` の「単一 group」仮定（ADR 0302 決定2）と
  合わせて見直しが要る。
- 較正の標本が `digestBandLimit === 0` の呼び出しを実際に含むようになったら、
  上の「引き受けた負債1」の経路を歯にして検算すること。
- `compare-baseline.json` の値が変わり、hold-in 7行に2桁の `totalInScope` が混ざる
  ようになったら、その時点で初めて `BUILTIN_RECALL_FOOTPRINT_PROFILE` の係数が
  本 PR の差し引きの影響を受けて動く——そのときは「測ったこと」節の実測値
  （バイト単位一致）を測り直すこと。

## 確かめていないこと

- `digestBandLimit === 0` の呼び出しが実運用で発生するか。
- 較正の標本が複数 group のスコープから来た場合に、桁上がり項がどの程度ずれるか
  （ADR 0302「確かめていないこと」と同じ、較正側への横滑り）。
- CI（`example-chat` ジョブ）上での実測——この作業は `DATABASE_URL` を使わず
  `packages/core` の in-memory runtime と `examples/chat/compare-baseline.json`
  （commit 済みの値）だけで検算した。

## 人から受け取った前提（出所付き）

- **【受】** マネージャーの委譲文（本 PR の作業指示）: ADR 0302 の「hold-in はすべて1桁」
  という前提が崩れたときに `calibrateRecallFootprint` が二重計上を起こすという指摘、
  構造項の計算を推定器と共有すること、公開シグネチャを変えないこと、変異試験4種の指定。

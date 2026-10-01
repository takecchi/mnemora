# ADR 0467: 穴探し38巡目 — recall footprint の見積もり関数が非有限の入力で結論を出さない・フォールバック digest を書記素の境界で切る

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-01

クローン miku の委譲先（担い手。マネージャー mgr-0d3098f9 の指示による）が書いた。直す線（約束に実装を戻す・落ちる入力を減らす・前例のある同種の穴は直す。新しく断る入力・既定値や公開の型の変更は材料に回す）は依頼主が決めた。オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手の判定、【未確認】は確かめていないこと。

- **文脈**: 38巡目は、今日の ADR 0441〜0466 が見ていない面を選ぶところから始めた。候補にした面と、見送った理由は「探した面」に書く。選んだのは、どちらも `packages/core` の純関数で、実 Postgres も LLM も要らない2つ。
  - **面A**: `recall-footprint.ts` の `compareWithFullLog`・`calibrateRecallFootprint`。`compareWithFullLog` 自身のコメントが「0除算の結果（Infinity / NaN）を結論の顔で返さない」と約束している。`#803`（`packDigestBand` の NaN を安全側に倒した）が同種の前例。
  - **面B**: `extraction.ts` の `truncateForFallbackDigest`。[ADR 0424](./0424-normalized-content-comparison-and-boundary-conformance.md) O-5 が `packDigestBand` だけを書記素の切りに替え、フォールバック digest は「保存される値で、別の影響の見積もりが要る」として意図して残した。この ADR がその見積もりを書く。

- **面A の実測（直す前）**【実測。`.hunt-r38/` に置いた探り棒を `packages/core` の vitest で走らせた。commit していない】:

  | 入力 | 直す前の結果 |
  |---|---|
  | `shape.memoryCountInScope`・`limit`・`digestBandLimit`・`associationCount` のどれかが NaN | `estimateRecallFootprint` の `chars` が NaN。`compareWithFullLog` は `verdict: "full_log_smaller"`、`estimatedShare: NaN` |
  | `fullLogChars: NaN` | `verdict: "full_log_smaller"`、`estimatedShare: Infinity`（`fullLogChars > 0` が偽） |
  | `calibrateRecallFootprint` の標本に `totalChars: NaN`（件数2種） | `fixedIndexChars: NaN` を `origin.kind: "calibrated"` で返す（傾きは借りた印が付く） |
  | 同 `totalChars: Infinity`（件数2種／1種） | 件数2種は `fixedIndexChars: Infinity`、1種は `charsPerDigest: Infinity` を借りた印なしで返す |
  | 同 `memoryCount: Infinity` | `observedMemoryCount.max: Infinity`、`fixedIndexChars: -Infinity` |
  | 標本が 100,000 件 | 正常（`charsPerDigest` 100、`fixedIndexChars` 200） |
  | 標本が 130,000・200,000・500,000 件 | `RangeError: Maximum call stack size exceeded`（`Math.min(...counts)`） |

- **面A の決定**:
  1. **`compareWithFullLog`: 見積もりか `fullLogChars` が NaN（または見積もりが非有限）のときは、`verdict: "too_close_to_call"`・`estimatedShare: NaN`・`within_tolerance` の札なしで返す。** 既存の `FullLogVerdict` の値だけで表した（「どちらとも言えない」）。`within_tolerance` は許容誤差の内側に入ったときの札で、NaN の `estimatedShare` を載せてしまうので立てない。`reasons` は空にならない（`dominant_term` は立つ）。有限な入力の結果は変えない（`fullLogChars: 0` は今までどおり `full_log_smaller`・`Infinity`）。
  2. **`calibrateRecallFootprint`: 件数・総量が有限でない標本は使える標本に数えない**（`bandEntryCount !== 0` の標本を数えないのと同じ。`sampleCount` は使った分）。**傾きが有限でないとき、切片が有限でないとき（有限の標本の合計がオーバーフローする場合）は、既定値から借りて `borrowedFromDefault` に名前で出す**（傾きが0以下のときに既にある形。`borrowedFromDefault` の既存の値 `"charsPerDigest"`・`"fixedIndexChars"` で表せた）。
  3. **`Math.min(...counts)`・`Math.max(...counts)` を、スプレッドを使わない走査に替えた。** 200,000 件でも通る。
  4. 「例外で断る」形は採っていない。

- **面A の歯**（`packages/core/src/__tests__/recall-footprint-nonfinite-inputs.test.ts`、17本）:
  - 直す前の実装に当てた結果【実測】: 16本中 14本が赤（NaN の4つの欄と `fullLogChars` の NaN、標本5形の有限性、切片・傾きを借りる2本、`sampleCount`、20万件の RangeError）。陽性対照の2本（有限な入力の結論・較正）は直す前から緑。傾きだけがオーバーフローする1本は、変異の確認の途中で足した。
  - 直した後: 17本とも緑。既存の `recall-footprint.test.ts` も通る（合わせて 64 本のときに確認）。
  - 変異【実測】: `undecidable` を常に偽にすると 5本赤／標本のフィルタを外すと 2本赤／切片のガードを外すと 2本赤／`derived` のガードを外すと 1本赤／最小・最大をスプレッドに戻すと 1本赤／傾きのガードを外すと、最初の歯では緑のまま残り（NaN になる形しか当てていなかった）、傾きだけが Infinity になる標本（`[{1 件, 0 文字}, {3 件, 4e307 文字}]`）の歯を足して 1本赤になった。

- **面B の実測（直す前）**:

  | 入力（本文, 長さ） | 結果 |
  |---|---|
  | `"あいう" + "か" + 結合濁点 + "xyz"`, 4 | `"あいうか…"`（「が」が「か」に化ける） |
  | `"ab" + 👨‍👩‍👧 + "cd"`, 5 | `"ab👨‍…"`（ZWJ が残る） |
  | 同, 7 | `"ab👨‍👩…"` |
  | `"x🇯🇵y"`, 3 | `"x🇯…"`（国旗が片方だけ残る） |
  | `"abcdef"`, NaN／0／-3／2.5／Infinity | `"…"`／`"…"`／`"…"`／`"ab…"`／`"abcdef"` |
  | 空・NaN／空白のみ・-1 | `"…"`／`"（内容なし）"` |
  | `"a😀b"`, 2／2.5 | どちらも `"a…"`（サロゲートペアは割れない。小数でも） |

- **面B の決定**: `truncateForFallbackDigest` の切りを `sliceAtGraphemeBoundary`（ADR 0424 O-5）にした。**素朴に置き換えてはいけない点が1つあった**: `sliceAtGraphemeBoundary` は NaN の長さで全文を返す（`next > NaN` が常に偽）。`RuntimeConfig.digestFallbackLength` の doc は「NaN だと digest は `"…"` だけ」と約束しているので、NaN は切りの前に分けて今までどおり本文を残さない。0・負・小数・`Infinity` の結果は変わらない（上の表の2行目と7行目が直した後も同じ）。`RuntimeConfig.digestFallbackLength` の doc に書記素の境界であることを足した。
  - 歯（`packages/core/src/__tests__/fallback-digest-grapheme.test.ts`、13本）: 直す前の実装に当てた結果【実測】は 13本中 4本が赤（NFD・ZWJ・国旗・最初の書記素だけで超える）。長さが数として変なときの8本と、陽性対照（収まる・日本語・サロゲートペア）は直す前から緑で、直した後も緑。変異【実測】: NaN の分岐を外すと 2本赤／切りをサロゲートペアだけを避ける旧関数に戻すと 4本赤。既存の `extraction.test.ts`・`helper-tsdoc-promises-restored.test.ts`・`runtime-config-defaults-doc.test.ts` は変えずに緑（4ファイル合わせて 96 本）。

- **面B の影響の見積もり**（保存される値が変わるので）:
  - **変わる入力**: 本文（trim 後）が `digestFallbackLength` を超え、かつ長さの境界が書記素の途中（結合文字の直前・ZWJ の途中・国旗の2つの間）に落ちるときだけ。それ以外（収まる、書記素の境目で切れる、NaN・0・負）は1バイトも変わらない。
  - **変わる幅**【実測】: その書記素1つぶん手前で止まる。NFD の「が」は UTF-16 で 2 コードユニット／UTF-8 で 6 バイト、国旗は 4／8、ZWJ で繋いだ家族の絵文字は 8／18。つまり digest は、1書記素ぶん（上の例なら最大 2〜8 コードユニット）短くなる。結合文字が何個も連なる書記素は、その全部が手前で落ちる（上限は無い。本文が1書記素だけで長さを超えれば `"…"` だけになる。上限0と同じ）。
  - **既存の保存値**: 触らない（書き換える口を足していない）。**新旧の混在**: 同じ本文でも、直す前に書いた digest は途中で切れた形、直した後に書く digest は書記素の手前で止まった形になる。再抽出（`reextract`）で書き直される記憶だけが新しい形になる。区別する欄は無い（`digestSource: "fallback"` は両方に付く）。
  - **dedupe・冪等**: 【現物】`contentHash` は `content`（`hashContent(candidate.content)`、`extraction.ts:714`・`runtime.ts:4125`）から作る。冪等キーは `(observationId, extractorVersion)`。既定の埋め込みの入力は `content`（`embeddingInput` を渡したときだけ digest が入りうる）。contested の検出（claim key・`findCorrectionCandidates`）は `content` の正規化比較で、digest を見ない。語彙チャンネルは `digest` を引かない（`lexical-store.ts` に `digest` の参照が無い）。**dedupe・冪等には影響しない。**
  - **recall への影響**: 返す `digest` の文字列と `usage.chars`（その分短くなる）、目次帯（`packDigestBand` は既に書記素の切り）。予算で切るかどうかの境目が、数文字ぶん動きうる。順位・スコアは変わらない（スコアに digest は入らない）。
  - **`embeddingInput` を渡す利用者**: digest を埋め込む入力にしている場合、新しく書く記憶の埋め込みだけが、数文字違う入力になる。既存の記憶の埋め込みは変わらない。【判断】数文字の差で近傍の順位が動くのは、digest を切る長さを変える（`digestFallbackLength`）のと同じ種類の動きで、許容できると読んだ。
  - 線の外側に当たるものは見つからなかった（公開の型・既定値は変えていない。保存済みの値の遡った書き換えも無い）。

- **探した形の一覧**（当てた入力と結果。見つからなかった形も書く）:
  - `estimateRecallFootprint`／`compareWithFullLog`【実測】: `memoryCountInScope` が NaN（上の穴）／`Infinity`（`limit` で切れ、有限の見積もり。`band_saturated`・`memories_capped_by_limit`）／負・0（`returnedMemories: 0`、有限）／`1e21`（有限。`extraDigitsBeyondOne` は `String(1e21)` が指数表記になり桁を誤るが、上限の `limit` で `returnedMemories` が決まるので影響は桁の数え1〜数字ぶん）／小数 10.5（`returnedMemories: 2.5` と小数のまま）。`limit` が NaN（穴）／負（`returnedMemories: -3`、有限だが意味が無い。材料）。`digestBandLimit` が NaN（穴）。`associationCount` が NaN（穴）／`Infinity`（構造上の上限で切れる、有限）。
  - `fullLogChars`【実測】: NaN（穴）／`Infinity`（`mnemora_smaller`・share 0。材料）／-1・0（`full_log_smaller`・`Infinity`・`full_log_below_fixed_cost`。0 は既存の歯）／`1e300`（share は 3.5e-297、`mnemora_smaller`）。`tolerance`: NaN（`too_close_to_call` に絶対ならない。材料）／-1（同）／`Infinity`（常に `too_close_to_call`）。
  - `calibrateRecallFootprint`【実測】: 上の表の形に加え、負の `totalChars`（`fixedIndexChars: -756.6`。有限なので借りない。標本が語っていることとして残す。材料）／件数が1種だけ（`same`: 両方借りる。既存）／件数が増えるほど総量が減る（`decreasing`: 傾きを借りる。既存）。`totalInScope` が NaN・`Infinity` の標本の構造項は、コードを読む限り有限の値になる【現物。走らせていない】（`extraDigitsBeyondOne` は `String` の長さを数えるため）。
  - `truncateForFallbackDigest`: 上の面B の表。サロゲートペア（小数の長さを含む）は直す前から割れない（見つからなかった）。
  - 見つからなかった面（読んだ範囲）: 保持期間の掃除の `limit`・cutoff（`interfaces/memory-store.ts` に実測つきの表がある）、`RecallQuerySchema` の数値（zod 4 が NaN・Infinity を拒む。#1066 は巨大 `overFetchFactor` を直済み）、`tenant_settings` の値域検査、openai の埋め込み応答の検査、clock の注入（`new Date()` の直書きは store の既定値のみ）。

- **探した面（見送ったもの。再調査を避けるため）**: 面C（provider のコンストラクタの数値オプション未検査: `maxTokens`・`temperature`・`dimensions`・`numThreads`）は、直す案が「構築時に断る」で外側。面D（`heuristicTokenCounter` の CJK 表と Unicode の照合）は、`\p{sc=Han|Hiragana|Katakana|Hangul|Bopomofo}` と突き合わせると表に無いのが325字（かな補助 U+1B000〜1B122 の291字ほか）。表は Block 単位の手書きで、doc も限界を書いている。足すと数え方が変わる。面E（LLM が返す digest・tags の長さ）は、長い tag が GIN の上限で落ちる件が `llm-aux-fields.ts` に既知の限界として書かれ、ADR 0443 が字数の上限を退けている。

- **検討した代替案**:
  1. **`compareWithFullLog` に新しい `FootprintReason` の code（例: `input_not_finite`）を足す。** 採らなかった。公開の型（`FootprintReason` の union）の変更で、依頼主の線の外側。材料に回した。今は `estimatedShare` が NaN であることで見分ける（TSDoc に書いた）。
  2. **NaN の入力に例外を投げる。** 採らなかった。新しく断る入力を増やす。
  3. **非有限の標本を使える標本に数えず、さらにその旨を名乗る。** 採らなかった。名乗る値（`FootprintCoefficientName`・`FootprintProfileOrigin` の欄）が無く、足すと公開の型が変わる。`sampleCount` が使った分であることで足りる。
  4. **面B: `sliceWithoutSplittingSurrogatePair` 自体を書記素の境界に変える**（ADR 0424 の「採らなかった案」にもある）。採らなかった。`failure-description.ts`（診断文。outbox の `last_error` に入る）も変わる。
  5. **面B: 既存の保存値も書き直す。** 採らなかった。遡った書き換えは線の外側。

- **引き受けた負債（材料）**:

  | 負債 | 再現 | 結果 | 緊急度 | 覆る条件 |
  |---|---|---|---|---|
  | NaN の入力を名乗る `FootprintReason` の code が無い | `compareWithFullLog({ fullLogChars: NaN, … })` | `too_close_to_call`・`estimatedShare: NaN`。理由の札で見分けられない | 低（見積もり関数。結論は出さなくなった） | 公開の型を変えてよいと決まったとき |
  | `estimateRecallFootprint` 自身は NaN の入力で `chars: NaN` を返す | `memoryCountInScope: NaN` | 呼び出し側が NaN を受け取る（`compareWithFullLog` は結論を出さない） | 低 | 検査（断る）か丸めを足してよいと決まったとき |
  | `limit` の負・小数、`fullLogChars: Infinity`、`tolerance` の NaN・負は検査しない | 上の一覧 | 有限だが意味の無い値（`returnedMemories: -3` など）／`mnemora_smaller`・share 0 | 低 | 同上 |
  | `extraDigitsBeyondOne` は 1e21 以上で桁を誤る | `memoryCountInScope: 1e21` | 構造項の桁の数えが数文字ずれる（`limit` で切れるので影響は小さい） | 低 | 巨大な件数を渡す利用者が現れたとき |
  | 負の `totalChars` の標本は借りずに採る | `[{2, -500}, {5, -900}]` | `fixedIndexChars: -756.6`（`origin.kind` は calibrated、傾きは借りる） | 低 | 標本の検査を足してよいと決まったとき |
  | `failure-description.ts` は今も書記素の途中で切る | outbox の `last_error` の診断文 | 診断文の末尾が結合文字の途中で終わりうる | 低（診断文。ADR 0424 が同じ判断） | 診断文を書記素で切ると決まったとき |
  | 面C・D・E（上の「探した面」） | 上 | 上 | 低〜中 | 上 |

- **これが覆るとしたら**: `FootprintReason` の union に入力不正の札を足すと決まったとき（面Aの `too_close_to_call` を札つきに替える）。フォールバック digest の保存値を書記素で切ることが、利用者の期待（`digestFallbackLength` は UTF-16 コードユニット数）とずれると分かったとき（面B。長さの単位は変えていない）。

- **測っていないこと**: 実 Postgres と実 API（どちらも使っていない。面A・Bとも純関数）。`reextract` で digest が新しい形に替わる経路の実走。`embeddingInput` で digest を埋め込む構成での近傍の順位の動き。`Intl.Segmenter` の書記素の規則が Node の版で変わったときの境界の差（ADR 0424 と同じ未確認）。

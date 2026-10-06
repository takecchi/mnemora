# ADR 0470: 穴探し41巡目 — ADR 0467 の材料のうち、線の内側のものを直す（footprint の桁の数え・失敗の説明の書記素切り）。`estimateRecallFootprint` の NaN は材料のまま

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-01

クローン miku の委譲先（担い手。マネージャー mgr-0d3098f9 の指示による）が書いた。直す線（約束に実装を戻す・落ちる入力を減らす・文書の直し・前例のある同種の穴は直す。新しく断る入力・既定値や公開の型の変更は材料に回す）は依頼主が決めた。オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手の判定、【未確認】は確かめていないこと。

- **文脈**: [ADR 0467](./0467-recall-footprint-nonfinite-inputs-fallback-digest-grapheme.md) の「引き受けた負債（材料）」のうち、3件を現物で確かめ直した。0467 の枝（#1575）の上に積む。

## 1. `extraDigitsBeyondOne` — 直した

- **実測（直す前）**【実測】: `estimateRecallFootprint` の `chars` の差で見た。`memoryCountInScope` を 1e20 から 1e21 に上げると、桁の項は +3 字（`totalInScope` の2回と `eligible` の1回）増えるはずが、**-48 字**減った（`String(1e21)` は `"1e+21"` で、21桁を4桁と数える）。`Number.MAX_VALUE`（309桁）の `chars` は、同じ309桁の 1e308 より 51 字多かった（4397.253 と 4346.253。指数表記の `"1.7976931348623157e+308"` を数えるため）。
- **直し方**: 有限で 1e21 以上のときだけ `BigInt(n).toString()` で10進の桁数を数える。1e21 未満は今までの `String`、**非有限（`Infinity`・`NaN`）は今までの `String` のまま**（`BigInt(Infinity)` は投げるので、有限かどうかの分岐で守る。`"Infinity"` は 8 字、`"NaN"` は 3 字として数える今の結果を変えない）。`Math.log10` は 10 の冪の近くで誤差が出るので使っていない。
- **歯**（`packages/core/src/__tests__/recall-footprint-digits-beyond-one.test.ts`、7本）: 直す前の実装で 3本赤（1e20→1e21、1e21 の直前の最大の double（`999999999999999868928`）→1e21、`MAX_VALUE`。出力は `.hunt-r38/red-0470.txt`）。残り4本（1e21 未満どうしの同じ桁、`MAX_SAFE_INTEGER`、5e3→5e4 の陽性対照、`Infinity`＝4352.253・`NaN`＝NaN）は直す前から緑で、直した後は7本とも緑。変異【実測】: BigInt の分岐を外す（常に `String`）と3本赤／有限ガードを外す（`BigInt(Infinity)` が投げる）と1本赤。
- **気づいたこと（歯の作り方）**: 件数 N から 10 を引いた `bandEligible` も桁の項に入るので、1e15 のように「引くと桁が減る」値は、基準にすると桁の差が3字にならない。歯は `5eK` の形か、引いても桁が変わらない値を基準にした。
- **影響**: 1e21 以上の件数を `memoryCountInScope` に渡すことは現実には無く、`chars` が数字数文字ずれるだけ。【判断】見積もりの精度としては無視できるが、桁数を数える関数が桁数を誤るのは約束との食い違いなので直した。

## 2. `failure-description.ts` の切り詰め — 直した

- **実測（直す前）**【実測】: `describeFailure(new Error(text))` で、4096字の境目が `か`+結合濁点・ZWJ で繋いだ家族の絵文字・国旗の途中に落ちると、本体の末尾が `か`／`👨‍…` の片割れ／`🇯` の片方で終わった（`sliceWithoutSplittingSurrogatePair` はサロゲートペアだけを避ける）。
- **直し方**: `sliceAtGraphemeBoundary`（0467 面B と同じ）に替えた。印 `… (truncated by mnemora, original length N chars)` の書き方と、`N`（切る前の UTF-16 の長さ）の数え方は変えていない。本体は上限（4096）を超えない（`sliceAtGraphemeBoundary` は上限以下に収まる最長の書記素の並びを返す）。最初の書記素だけで上限を超える入力は本体が空になり、印だけが残る【現物。上限が4096で、1書記素が4096字を超える入力は結合文字を数千個並べた場合のみ】。長さの引数は定数なので、0467 で問題になった NaN は起きない。
- **歯**（`packages/core/src/__tests__/failure-description-grapheme-cut.test.ts`、6本）: 直す前の実装で 3本赤（NFD・ZWJ・国旗）。ちょうど収まる書記素を残す・`N` が元の UTF-16 の長さのまま・本体が上限以下・上限以下はそのまま・素直な長い文字列とサロゲートペアの陽性対照は直す前から緑で、直した後は6本とも緑。変異【実測】: 旧関数に戻すと3本赤。既存の `tick-last-error-redacts-params.test.ts`（4本）は変えずに緑。
- **影響の見積もり**（保存される値が変わるので）:
  - **変わる入力**: `describeFailure` の結果が 4096 字を超え、かつ 4096 字目の境目が書記素の途中に落ちるときだけ。それ以外は1バイトも変わらない。変わる幅は、その書記素1つぶん（NFD の「が」は UTF-16 で 2 コードユニット／UTF-8 で 6 バイト、国旗は 4／8、家族の絵文字は 8／18）手前で止まるだけ。【判断】失敗の説明は SQL・エラー文・値の文面で、結合文字や絵文字が境目に当たるのは例外的。
  - **どこに入るか**【現物】: `OutboxStore.fail` の `last_error`（`runtime.ts` の `tick`）、`forget`・`purge`・`restoreArchived`・`reextract` などの結果の `error` の欄（`embeddingCleanup`・`residueCleanup`・`reinforceError` など）、`tick` が投げる例外の文面。保存されるのは `last_error`（`outbox_jobs`）で、残りは呼び出しの戻り値か例外。
  - **既存の保存値**: 書き換えない。**新旧の混在**: 同じ失敗でも、直す前に書いた `last_error` は書記素の途中で切れ、直した後に書く値は手前で止まる。区別する欄は無い。再試行で `fail` が書き直されるジョブだけが新しい形になる。
  - **突き合わせ・集計**: 【現物】`last_error` を比較・索引にする経路は見当たらない（読むのは人間と `attempts` の判断）。【未確認】利用者が `last_error` の文字列を集計に使っている場合、境目を持つ失敗だけキーが変わる。
  - 線の外側に当たるものは見つからなかった（公開の型・既定値は変えていない。遡った書き換えも無い）。

## 3. `estimateRecallFootprint` 自身が NaN を返す件 — 材料のまま（TSDoc に今の振る舞いを書いた）

- **確かめたこと**【現物】: `RecallFootprintEstimate` の欄は `chars`・`byTier`・`returnedMemories`・`associationCount`・`bandEntries`・`memoriesCappedByLimit`・`bandSaturated`・`extrapolated`（数か真偽）・`profileOrigin` だけで、「見積もれなかった」を既存の値で表す欄が無い（`compareWithFullLog` の `verdict` のように、既存の値に「どちらとも言えない」がある型ではない）。表すには欄か値を足すしかなく、公開の型の変更に当たる。
- **決定**: 直さない。`estimateRecallFootprint` の TSDoc に、NaN の入力で `chars` ほか NaN から計算した欄が NaN のまま返ること（検査しない今の振る舞い）、`chars` が NaN であることで見分けること、`compareWithFullLog` はそれを受けて結論を出さないこと（ADR 0467）を書いた。NaN を名乗る `FootprintReason` の code も、公開の型の変更なので材料のまま。
- **これが覆るとしたら**: 公開の型に「見積もれなかった」を足してよいと決まったとき（`RecallFootprintEstimate` に欄を足す、または `FootprintReason` に code を足す）。

## 探した形の一覧

- `extraDigitsBeyondOne`（`estimateRecallFootprint` 経由）【実測】: 1e20・1e21・1e22・`999999999999999868928`（1e21 未満の最大の double）・9.99e20・5e15・`MAX_SAFE_INTEGER`・5e16・`MAX_VALUE`・1e308・5e3・5e4・`Infinity`・`NaN`。穴だったのは 1e21 以上（1e21・1e22・`MAX_VALUE`・1e308）。
- `describeFailure`【実測】: 境目が NFD の「が」・ZWJ の家族の絵文字・国旗の途中（穴）／ちょうど収まる家族の絵文字（割れない）／上限以下／上限ちょうどの `x`／サロゲートペアの途中（割れない。直す前から）。
- 見つからなかった形: 最初の書記素だけで 4096 字を超える入力は【未確認】（歯に入れていない。結合文字を数千個並べる入力で、本体が空になり印だけが残ると読んだ）。

## 検討した代替案

1. **`Math.log10` で桁数を求める。** 採らなかった。10 の冪の近く（`999999999999999868928` など）で誤差が出る。
2. **`estimateRecallFootprint` の NaN を丸める（0 や既定値に倒す）。** 採らなかった。呼び出し側の誤りを、もっともらしい数に変えて隠す。0467 の `compareWithFullLog` のように「結論を出さない」側へ倒すには、結論を出さないと表せる欄が要る。
3. **`sliceWithoutSplittingSurrogatePair` を書記素切りに変える**（0424・0467 の代替案にもある）。採らなかった。呼び出しごとの影響の見積もりを別に書く方針を続けた。この ADR で呼び出し元は `failure-description.ts` が最後になり、`sliceWithoutSplittingSurrogatePair` は本体のコードからは呼ばれなくなった（テストと将来の呼び出し用に残してある）。

## 引き受けた負債（材料）

| 負債 | 再現 | 結果 | 緊急度 | 覆る条件 |
|---|---|---|---|---|
| `estimateRecallFootprint` は NaN の入力で NaN を返す（型に表す欄が無い） | `memoryCountInScope: NaN` | `chars` ほかが NaN。`compareWithFullLog` は結論を出さない | 低 | 公開の型に欄を足してよいと決まったとき |
| NaN を名乗る `FootprintReason` の code が無い | 同上 | `estimatedShare` が NaN であることで見分ける | 低 | 同上 |
| `last_error` の旧い値は書記素の途中で切れたまま | 4096字を超える失敗の説明 | 新旧が混在 | 低 | 遡った書き換えを許すと決まったとき |
| `shape.limit` の負、`fullLogChars: Infinity`、`tolerance` の NaN・負、負の `totalChars` の標本（0467 の表から残り） | 0467 を見ること | 同上 | 低 | 同上 |

## これが覆るとしたら

失敗の説明を書記素ではなくコードユニット数で正確に切りたい用途（保存先の列の長さの制約など）が出たとき。`last_error` を集計に使う利用者が、境目の違いを困ると言ったとき。

## 測っていないこと

実 Postgres（`outbox_jobs.last_error` への書き込み。`tick-last-error-redacts-params.test.ts` は Fake の outbox で走る）、実 API。最初の書記素だけで 4096 字を超える入力。利用者の `last_error` の集計。

## 追記（2026-10-07、Issue #1779）

代替案3で「テストと将来の呼び出し用に残してある」とした `truncationBoundary` と `sliceWithoutSplittingSurrogatePair`（`packages/core/src/text-truncation.ts`）を、Issue #1779 で消した。クローン miku の判断で、オーナーの判断ではない。

- **理由**【現物】: 製品のコードからもテストからも呼ばれていない。`index.ts` からも出しておらず、`package.json` の `exports` は `"."` だけで、公開の口ではない。呼び出し元3か所は ADR 0424・0467・0470 で `sliceAtGraphemeBoundary` へ移った。
- **振る舞いは変わらない**: 切り詰めはすでに書記素の境界に揃っている。公開 API も変わらない。
- 本文は書き換えていない。`failure-description.ts` と `text-truncation.ts` のコメントから、消えた名前への言及を外した。

## 追記（2026-10-07、Issue #1798）

素朴な `slice` のまま残っていた2か所のうち、`packages/core/src/recall-runtime.ts` の `describeQueryEmbeddingFailure`（クエリ埋め込みの失敗の `cause` の `providerErrorKind`・`errorName`。上限 `CAUSE_LABEL_MAX` = 64）を `sliceAtGraphemeBoundary` に直した。クローン miku の判断で、オーナーの判断ではない。

- **単位の約束**【現物】: `docs/recall.md` は「先頭64文字まで」と書く上限で、「ちょうど64」とは約束していない。書記素で切って 64 コードユニットを下回っても約束は破らない。上限の単位はコードユニットのまま。
- **振る舞い**: 64 コードユニットの位置にサロゲートペア・結合文字が跨るとき、その書記素の手前で切る（以前は孤立サロゲートが残るか、結合文字が落ちた）。64 以下の入力は変わらない。公開の型・API は変わらない。
- **残したもの**: `packages/postgres/src/lexical-query-cap.ts` の `capLexicalQueryTotalChars`（600）は直していない。`sliceAtGraphemeBoundary` が core の内部関数で公開していないこと、testkit の fixture `in-memory-lexical-store.ts` が同じ切り詰めを写していて、そろえるには fixture の編集が要ることが壁である。fixture の扱いについてのオーナーの答えを待つ（Issue #1798）。
- 本文は書き換えていない。

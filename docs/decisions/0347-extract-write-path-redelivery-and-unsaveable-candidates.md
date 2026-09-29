# ADR 0347: extract のジョブは再配達で既に記憶が在れば書かず、保存できない候補はその候補だけを落として残りを書く

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-28

> **⚠ これはクローン miku の判断であり、オーナーの判断ではない。**本文はクローン miku の委譲先が書いた。
> 案の選択（#1092 は案2、#1063 は方向1、落とした候補の記録は `created` の `meta` だけ、全件が落ちたら例外、
> 一部だけを書いて止まった場合の残りは受け入れて書く）はクローン miku が決めた。

---

## 文脈

抽出の書き込みの経路（`runtime.ts` の `processExtractJob` → `runExtraction` → `createMemoriesFromCandidates`）に、
2つの形が在った。どちらも PR #1306 が今の振る舞いとして doc に書き、2実装（`@mnemora/postgres` と testkit の
fixture）で縛っていた。

- **[Issue #1092](https://github.com/takecchi/mnemora/issues/1092)（逐次の再配達）**: extract のジョブの1回目が
  Memory を書いた後・`complete` の前に止まり、リースが切れた後の2回目が同じジョブを処理すると、LLM の出力が
  変われば2回分が両方 `active` で残った（A → B で2件。LLM の失敗 → A で、全文フォールバックと A の2件）。
  `OutboxStore` の doc は、呼び出し側に「冪等で書くこと」を求めている。
- **[Issue #1063](https://github.com/takecchi/mnemora/issues/1063)（保存できない候補）**: LLM の抽出結果に、
  schema は通るが store が保存できない値（本文の NUL、Postgres の tsvector の上限を超える本文など）が在ると、
  候補は1件ずつ書かれるので、手前の候補だけが書かれたまま `observe()` が例外で止まった。

2つは同じ経路を触るので、一緒に設計した。

## 決めたこと

1. **#1092: `processExtractJob` だけで、LLM を呼ぶ前に
   `MemoryStore.listBySourceObservation(ctx, observationId, extractorVersion)` を見る。1件でも在れば、抽出は
   済んでいるものとして何も書かずに返す**（`tick` がジョブを `complete` する）。
   - status では絞らない。全文フォールバック・forget / purge した Memory も「在る」に数える
     （再配達で、忘れさせた内容を蘇らせない。#897 と同じ向き）。
   - 版で絞る。旧い版の Memory しか無い Observation は、今どおり新しい版で抽出する（#873）。
   - sync の `observe()`（Observation を作った直後）と `Runtime.reextract`（既存が在ってもやり直すのが目的）は
     この確認を通らない。
2. **#1063: `createMemoriesFromCandidates` で、`createMemoryWithOutbox` の呼び出しだけを候補ごとに捕まえ、
   投げた候補は落として、残りの候補を書く。**
   - 書けた後の `created` の追記・claim key の衝突検出の失敗は、今どおり投げる。
   - **全件が落ちたら、最初の例外をそのまま投げ、何も書かない。**この変更の前から例外になっていた入力であり、
     投げる入力は減る側にだけ変わる。店が丸ごと落ちている一時的な障害も、今どおり例外で伝わる。
3. **落とした候補の記録は、残った候補の `created` イベントの `meta.droppedCandidates` だけに置く。**
   要素は `{ index, contentHash, code, message }`。
   - `index` は LLM が返した順の 0 起点。候補の本文は写さない（落ちた理由がまさに本文であることが多く、写すと
     `created` の追記まで同じ理由で落ちる）。
   - `code`・`message` は `cause` の連鎖の最も内側から取る（drizzle の外側の `message` は SQL の params
     ＝候補の本文を含む）。`message` の NUL と孤立サロゲートは目に見える形に置き換え、500 文字で切る。
   - 落とした候補が無ければ、このキーは無い（`meta` の形は変わらない）。
   - **`observe()` の戻り値には出ない。**`memoryIds` が候補の数より少なくなるだけで、`extraction` は `"ok"`、
     `extractionFailure` は `null` のまま。
4. **候補を全件書いてから `created` を積む**（落とした候補は、全件を書き終えるまで分からないため）。
   以前は候補ごとに「書く → `created` を積む」を繰り返していた。正常な入力で最後に残る状態は変わらない。

## 採らなかった案

- **#1092 の案1（フェンシング）**: store の口に claim の `attempts` を渡す形になり、公開の interface が変わる。
  並行の2本まで塞げるが、この線の外である。
- **#1063 の方向2（全文フォールバックへ倒す）**: 「LLM が成功したが保存できなかった」を名乗る値を
  `ExtractionOutcome` に足す必要がある（公開の union への値の追加）。
- **#1063 の方向3（`supersedeWithNewMemories(news, [])` で全部かゼロかにする）**: 1件の壊れた候補で正しい候補まで
  失う（今より薄い側に倒れる）。正常な入力の書き込み経路も変わる。途中まで書いて止まった再配達の窓は閉じられるが、
  それは下の「引き受けた負債」として受け入れた。
- **#1063 の方向4（NUL などを保存前に置き換える）**: 保存するデータの意味を変える。
- **事前の検査（NUL などを書く前に見る）**: tsvector の上限などは adapter の都合で、core からは検査できない。
  書き込みが投げたことを根拠にするほうが、store を問わず同じに効く。
- **落とした候補の記録に、extract ジョブを `fail`（`lastError`）にする形を併用する**: 記憶を書けたジョブを
  `failed` に数えると、「`failed` ＝処理が失敗して結果が無い」という既存の読み方を変える。自動の再試行が無い今、
  `failed` を見た運用者が誤った一手を取る。全件が落ちた場合（`meta` の載せ先が無い）は、決定2のとおり例外に
  なるので、それで覆える。
- **`ObserveResult` に落とした候補の欄を足す**: 公開の型の変更になる。
- **`memoryId: null` のイベントで記録する**: `MemoryEvent.memoryId` の doc と migration が「null は
  `events_purged` のときだけ」と書いている。

## 引き受けた負債

- **並行の2本の再配達は塞げない。**どちらも書く前に決定1の確認を通る（#1092 の本文。フェンシングの側に残る）。
- **1回目が候補の一部だけを書いて止まった場合、残りの候補は作られない。**以前は、LLM が同じ出力を返せば2回目が
  冪等に埋めた。`Runtime.reextract` で回復する（`tick-sequential-redelivery.postgres.test.ts` の歯）。
  1回目が全文フォールバックで止まった場合も、再配達は書かず、フォールバックが残る。これも `reextract` で回復する。
- **core は保存できない値と一時的な障害を見分けられない。**3件のうち1件だけが一時的な障害で書けなかった場合も、
  「落とした候補」として記録され、例外にならない。
- **sync の `observe()` の呼び出し側は、戻り値だけでは候補を落としたことを知れない。**監査ログの `created` の
  `meta` を読む必要がある。
- **`created` の追記が遅れる窓が広がった。**以前は1件を書くたびにその `created` を積んでいたが、今は全件を
  書いてから積む。その間に止まると、`created` を持たない Memory が増えうる（その窓自体は以前から在る。
  ADR 0100「守れないもの」）。
- 落とした候補の再試行（`created: false` の冪等な再書き込みで終わった場合）では、`created` を積まないので、
  落とした記録も残らない。決定1により、再配達でこの経路に来ることは無い。

## これが覆るとしたら

- フェンシング（claim の `attempts` を書き込みと同じトランザクションで確かめる）が store の口に入ったとき。
  決定1の確認は要らなくなりうる。
- 「LLM が成功したが保存できなかった」を `ExtractionOutcome` か `ObserveResult` で名乗ることがオーナーに認められた
  とき。決定3の記録の場所を、戻り値へ移しうる。
- 保存できない値と一時的な障害を、store が型で名乗るようになったとき（決定2で一時的な障害だけを投げ直せる）。

## 確かめたこと

- 歯: `packages/postgres/src/__tests__/observe-unsaveable-candidate.postgres.test.ts`、
  `packages/postgres/src/__tests__/tick-sequential-redelivery.postgres.test.ts`（どちらも `@mnemora/postgres` と
  testkit の fixture の2実装）。PR #1306 の歯を先にこの ADR の振る舞いへ書き換えて赤を確かめ、実装で緑にした。
- 変異試験（戻した後、緑に戻ることも確かめた）: 確認を外す・常に飛ばす・版を無視する・候補を落とさずに投げる・
  全件が落ちても投げない・`meta` のキーを常に付ける・外側の `message` を使う・確認を `reextract` にも入れる、の
  8つがそれぞれ赤になった。
- 確かめていないこと: core の Fake（`packages/core/src/__tests__/runtime-fakes.ts`）での同じ当て方。並行の2本の形。

## 追記（2026-09-28）: core の Fake での当て方と、並行の2本の実測

上の「確かめていないこと」の2点を、テストだけで確かめた。**振る舞いは変えていない。**

### core の Fake

- `packages/core/src/__tests__/extract-redelivery-unsaveable-fake.test.ts` で、上の2本の歯と同じ場面を
  `createFakeRuntimeStores()` に当てた。**結果は Postgres・testkit の fixture と同じだった**（本文の NUL の候補だけを
  落とし、`meta.droppedCandidates` の `code` は testkit の fixture と同じく `null`。全件が落ちたら投げる。逐次の
  再配達では2回目が LLM を呼ばず書かない。旧い版だけなら抽出する。一部だけ書いて止まった残りは `reextract` で回復する）。
- 語の多い 1MB 超の本文は当てていない。Fake は testkit の fixture と同じく受け入れる（Postgres は tsvector の
  上限で拒む）。`Runtime.observe` の doc の「保存できる値の範囲は store で違う」のとおりである。
- 変異試験（戻した後、緑に戻ることも確かめた）: 決定1の確認を外すと再配達の5件が赤、候補を落とさずに投げると
  NUL の2件が赤になった。

### 並行の2本（Postgres で実測）

`packages/postgres/src/__tests__/tick-concurrent-extract.postgres.test.ts`（Postgres だけ）。**今の振る舞いを縛る歯で
あり、望ましい姿ではない。**1本のテストの中で2つの `tick` を `Promise.all` で走らせ、順序は時計と門で決めた——
①が claim して決定1の確認を通り LLM の中で止まる → 時計をリースより先へ進め、②が同じジョブを claim（attempts 2）し、
決定1の確認を通って書いて `complete` する → ①を進める。

| ①の LLM | ②の LLM | 残る Memory（その Observation から） | `created` |
|---|---|---|---|
| `候補A` | `候補B` | `候補A`・`候補B` が両方 `active` | 2件（`extracted`） |
| `候補A` | `候補A` | `候補A` の1件（冪等の鍵で同じ行に当たる） | 1件 |
| 失敗 | `候補B` | `候補B` と全文フォールバック（`発話`）が両方 `active` | 2件（`extracted`・`extraction_failed_whole_observation_fallback`） |

- どの形でも、extract の行は②が `complete` する（attempts 2・`claimed_by` は②）。①の `TickResult` は
  `processed: 0`・`failed: 0`・`leaseConflicts` に `extract` の `complete` が1件。embed のジョブは残った Memory の数だけ積まれる。
- ⟹ 「引き受けた負債」の1行目のとおり、**決定1の確認は並行の2本を塞がない。**形は Issue #1092 本文の L1・L5 と
  同じで、この ADR の前から変わっていない。
- 同じテストを5回続けて走らせ、5回とも同じ結果だった。
- 変異試験（戻した後、緑に戻ることも確かめた）: リース競合の `complete` を `processed` にも数えると3件が赤、
  候補を書く直前にもう一度同じ確認を入れる（並行を塞ぐ側へ倒す）と、違う本文と LLM の失敗の2件が赤になった
  （同じ本文の1件は、どちらでも1件なので緑のまま）。
- 当てていないこと: ②が先に LLM の中で止まり①が先に書く順、3本以上、testkit の fixture と core の Fake での並行。

## 追記（2026-09-29）: 語の多い 1MB 超の本文は、Postgres でも保存できない候補ではなくなった

[Issue #1222](https://github.com/takecchi/mnemora/issues/1222)・[ADR 0364](./0364-lexical-tsvector-fallback-for-oversized-content.md)
の migration 0025 で、`idx_memories_lexical` の式に tsvector の上限へのフォールバックを挟んだ。以後、
語の多い 1MB 超の本文は `@mnemora/postgres` でも書け、落とされない（testkit の fixture・core の Fake と揃った）。
上の「文脈」と「追記（2026-09-28）」に在る「Postgres の tsvector の上限を超える本文」「Postgres は tsvector の
上限で拒む」は、migration 0025 より前の振る舞いである。この ADR の決定（保存できない候補だけを落とし、残りを書く）は
変わらない——本文の NUL などは今も落ちる。
`packages/postgres/src/__tests__/observe-unsaveable-candidate.postgres.test.ts` の 1MB 超の歯は、2実装とも3件を書く主張に反転した。

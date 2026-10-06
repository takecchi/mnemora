# ADR 0630: `MemoryStore` の Memory の書き込みの口は、読み戻すと `MemorySchema` を通らない値を入口で拒む

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-06

出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手・マネージャーの判定、【未確認】は確かめていないこと。

**出所**: オーナー回答 70449a95（承認キュー）の問2「store に渡す値の中身の検査」による（2026-10-05T18:03Z）。**オーナーが決めたのは、推奨（入口で拒む）を採ることだけである。**範囲（どの欄・どの口か）・例外の種類・文面・範囲外にするものは、マネージャー（mgr-3cdbd12b）が決め、担い手が実装した。【判断】破壊的変更を v1.X.0 で出してよいことは、オーナーの回答による。

## 背景

`MemoryStore` の `createMemory`・`createMemoryWithOutbox`・`supersedeWithNewMemories` は、`NewMemory` の中身を検査せず、書いたら読み戻したときに `MemorySchema` を通らない値を黙って書いていた（TSDoc に「返った Memory は `MemorySchema` を通らないことがある」と明記し、PR #1362・#1365 と `store-input-current-behaviour.postgres.test.ts` がその振る舞いを縛っていた）。【現物】

前回の調査で、次が `@mnemora/postgres` と testkit の `InMemoryMemoryStore` の両方で、黙って書かれ、読み戻すと `MemorySchema` を通らないことを実測していた。【実測】⚠ ただし **`claimKey` の片側だけ（`{ subject: "s" }` など）は Postgres には当てはまらない**: 直す前の Postgres でも書けて、読み戻しは `rowToClaimKey` が鍵なし（`null`）として返すため `MemorySchema` を通った（独立確認 mgr-ceace21d の実測、2026-10-06）。この形で読み戻しが `MemorySchema` を通らなかったと実測したのは fixture である（core の Fake は【未確認】）。拒む範囲は変えず、3実装とも書き込みで拒む（下の決定6）。

- `digest`・`contentHash`・`extractorVersion` の空文字
- `claimKey` の `subject`・`predicate` の空文字・片側だけ
- `provenance` の中身の欠け・値域外（`imported` の `batchId: ""`、`consolidated` の `sources` が空、`inferred` の `confidence: 2`、`at` が空文字など）
- `attributes` の値が文字列以外

## 決定

1. **core に共有の検査関数 `assertWellFormedNewMemory(owner, input)` を置き**（`packages/core/src/new-memory-check.ts`、公開 API）、3実装（`@mnemora/postgres`・testkit の `InMemoryMemoryStore`・core の `FakeMemoryStore`）が、3つの口の入口から呼ぶ。【判断】
2. **判断の基準は「書いたら、読み戻したときに `MemorySchema` を通らなくなるか」**。見る欄は `digest`・`contentHash`・`extractorVersion`・`claimKey`・`attributes`・`provenance` の6つ。判定は `MemorySchema.shape.<欄>` の schema をそのまま使う（写さない。`MemorySchema` が変われば検査も変わる）。`extractorVersion`・`claimKey` の `null`・省略、`attributes` の `null`・省略・空のオブジェクトは通す。
3. **拒むときは何も書かない**（Memory・ラベル・outbox・イベントのどれも進めない）。**冪等の既存の行が在っても拒む**（検査は冪等の衝突の判定より前。NUL・列挙の既存の検査と同じ位置）。`supersedeWithNewMemories` は、2件目以降が壊れていても先の要素・`supersede` の対象・イベントを残さない。
4. **例外は素の `Error`**。文面は `<実装名>: <欄> is malformed (<理由>); the stored Memory would not pass MemorySchema when read back`（欄は `claimKey.subject`・`provenance.confidence` のように入れ子を `.` でつなぐ。値は載せない）。【判断】理由: 既存の同種の入口の検査（`strength`・`halfLifeHours`・NUL・列挙・Invalid Date）がどれも素の `Error` で `<実装名>: <欄> …` の形であり、それに揃えた。
5. **検査の位置**: Postgres は `assertNoNulInNewMemory` の直後（3か所）、testkit は `assertStorableNewMemory` の末尾（NUL・列挙の後）、Fake は `provenance.kind` の列挙の検査の後。すでに在る検査が断る入力の文面・順を変えないため、`provenance.kind` が列挙に無いとき・`provenance` が `null` のときは、この検査は見ない。
6. **conformance suite に歯を足した**（3口 × 21形の拒否 × 冪等の既存行 × 19形の通す側、`supersede` の2件目の巻き戻し）。**片側だけの `claimKey` を `createMemory` で作って「数えない」ことを縛っていた歯**（`listActiveClaimPredicates`、Issue #1238 A7）は、約束を書き換えた: 書き込みの口が拒むこと、拒まれた書き込みが一覧を汚さないこと。**読み側の「それより前に書かれた行は鍵なしとして扱う」は、実装ごとの歯**（fixture・Fake。内部の行を書き換えて作る）が縛る。
7. **`RuntimeConfig.extractorVersion` が空文字・空白だけなら、`createRuntime` が組み立ての時点で `Error` を投げる**（`undefined`・`null` は今どおり既定の `"v1"`）。【判断】レビュアー（miku）の決定。理由: store の検査だけだと、空文字の `extractorVersion` では抽出した候補がすべて壊れた候補になり、**候補が1件以上ある `observe` が毎回投げる**（Postgres・testkit で実測。歯は上の observe の節）。オーナーが選んだのは「入口で拒む」であり、observe のたびに投げるより、組み立ての1回で分かるほうが利用者に優しい。`llmModelId`・`promptVersion` の空文字を既定に寄せる扱いは変えない。
8. **`supersedeWithNewMemories` で「壊れた `news`」と「存在しない `supersede` の対象」が同時にあるときは、壊れた値の例外が先**（Postgres の順）。testkit の fixture と core の Fake は、以前は対象の not found を先に投げていたので、Postgres に揃えた（独立確認 mgr-ceace21d の指摘。歯: conformance と Fake のテスト）。【判断】

### 範囲外（触らない）

`subjectId`（空文字を含む。別の担当が進めている）、Observation・Event・`createRecall` の書き込み、既に拒んでいる欄（`strength`・`halfLifeHours`・列挙・Invalid Date など。この検査はそれらより後に置き、例外は変えない）、`tags` に数が入る件、`validFrom > validUntil` の逆転、`content`・`tags` の中身・日時。範囲外であることは、歯でも縛る（`subjectId: ""` はこの検査の文面で拒まれない、`createObservation` は `attributes: { a: 1 }` を今までどおり通す）。

⚠ **以前から拒まれていた入力のうち、例外の種類が変わったものがある**（独立確認 mgr-ceace21d の指摘。base `cb891be3` と PR の head を3実装×3口で実測、2026-10-06）。`digest` の `null`・省略と `contentHash` の省略は、`MemorySchema` の欄の schema がそもそも通さないので、この検査が先に断る:

| 入力 | 実装 | 以前 | いま |
|---|---|---|---|
| `digest: null` | Postgres | `DrizzleQueryError`（`cause.code` `23502`） | `Error`（`PostgresMemoryStore: digest is malformed (…)`） |
| `digest` 省略・`contentHash` 省略 | Postgres | `DrizzleQueryError`（`cause.code` `42601`） | `Error`（`… digest is malformed`／`… contentHash is malformed`） |
| 上の3形 | core の Fake | `TypeError`（`Cannot read properties of null/undefined (reading 'includes')`） | `Error`（`FakeMemoryStore: … is malformed (…)`） |
| 上の3形 | testkit の fixture | `TypeError`（同上） | **変わらない**（`TypeError`。この検査より前の入口の検査が先に読む） |

3口（`createMemory`・`createMemoryWithOutbox`・`supersedeWithNewMemories`）とも同じ結果だった。fixture だけ種類が揃っていないのは、そのまま残す（引き受けた負債）。

### `createMemoriesWithOutboxAndEvents?`（3つの口の外）

依頼の範囲は3口だったが、`@mnemora/postgres` と testkit では `createMemoriesWithOutboxAndEvents?` が同じ入口（`insertMemoryWithOutboxRows`・`createMemoryIdempotent`）を共有するため、**検査が自然に掛かる**（壊れた候補は、保存できない他の候補と同じく `dropped` に積まれ、ほかは書く。**全候補が壊れていれば、observe は最初の例外（この検査の `Error`）をそのまま投げ、Memory は1件も書かない**——Postgres は `observe-new-memory-well-formed.postgres.test.ts`、testkit は `in-memory-observe-new-memory-malformed-candidate.test.ts` が縛る【実測】）。core の Fake はこの口を持たない。口を分けて掛けない案は、共有部分を割る必要があり採らなかった。歯を足した（Postgres・fixture）。【判断】

## 採らなかった案

- **型付きの例外クラス（`MalformedIdentifierError` のような）を新設する**: 呼び手が分岐する必要が無く（どの実装でも「書けない入力」を直すだけ）、公開面と foreign-realm 判定（ADR 0418）の負担が増える。既存の値の検査は素の `Error`。
- **欄ごとに手書きの検査を3実装に写す**: `MemorySchema` とずれる。共有関数＋ schema の流用を採った。
- **読み戻すときに直す・読み側で弾く**: オーナーが選んだのは「入口で拒む」。
- **既に書かれた行の掃除（マイグレーション）**: 範囲外。下の負債。

## 引き受けた負債

- **既に書かれた不正な行は残る**。Postgres の `rowToClaimKey` は片側だけの行を鍵なしとして返し続ける。空文字の `digest` などの行は読み側に残りうる（recall は壊れない。歯: `recall-pipeline.test.ts`）。掃除はしない。
- **`RuntimeConfig.extractorVersion` に空文字・空白だけを渡している利用者**は、上げた後、`createRuntime` が例外を投げて Runtime を作れなくなる（決定7）。以前は書けて、読み戻すと `MemorySchema` を通らなかった。
- **外部の adapter**: conformance suite の判定が厳しくなった（上の決定6）。自前の `MemoryStore` は、同じ入力を拒む必要がある。`assertWellFormedNewMemory` を呼べばよい。
- 表が2か所に在る（`packages/core/src/__tests__/malformed-new-memory-cases.ts` と `memory-store-conformance.ts`）。core のテストは testkit を import できないため。
- `digest` の `null`・省略と `contentHash` の省略に、testkit の fixture だけ `TypeError` を投げる（Postgres と core の Fake はこの検査の `Error`。上の範囲外の節の表）。
- `provenance.sourceObservationId` と `input.sourceObservationId` の食い違い、`provenance` の列挙外の `kind`・`null` の例外の種類が実装で違う点は、そのまま。

## 変異試験の結果（2026-10-06）

【実測】Postgres 17 + pgvector を手元で立て、変異を入れて歯が赤くなるかを見た。**当てた変異 約90 のうち、足りない側・やりすぎた側の主要なものは最初から噛んだ。噛まなかったもの（穴）は下の5つで、歯を足して赤→緑を確かめた。**

- **噛んだ（足りない側）**: 3実装×口（createMemory・createMemoryWithOutbox・supersedeWithNewMemories。Postgres と testkit は `createMemoriesWithOutboxAndEvents` も）ごとの呼び出しの除去／6欄それぞれの検査の除去／provenance の5つの kind それぞれの除去／欄ごとの形（空文字・欠け・confidence の範囲など）／検査を「冪等の既存行の判定より後」「書いた後」へ動かす／supersede で2件目以降を検査しない／observe 経路で拒んだ例外を漏らす・全件が壊れても投げない。
- **噛んだ（やりすぎた側）**: confidence の 0 と 1・claimKey 無し・extractorVersion が null・attributes が `{}`・省略・値が空文字・digest が1文字・content が空文字を拒む／`subjectId` の空文字・`validFrom > validUntil`・createObservation を拒む。
- **穴（噛まなかった）→ 歯を足した**:
  1. `supersedeWithNewMemories` で news の「先頭と末尾だけ」検査する変異（3実装すべてで生き残った。歯は2件のみだった）→ 3件の真ん中が壊れている歯を、conformance（Postgres・fixture）と core の Fake に足した。
  2. 欄の検査は残したまま特定の形だけ見逃す変異（stated の sourceObservationId 空・at 無し、inferred の confidence NaN・無し・文字列、model 空、promptVersion、basis の欠け・空文字、consolidated の sources、reflected の sources が配列でない、attributes が配列・文字列・真偽値）→ 表（core と conformance の2か所）に18形を足した。
  3. `attributes: null`・`extractorVersion` 省略を拒む変異 → 通す側の表に足した。
  4. `createObservationWithOutbox`（3実装）と core の Fake の `createObservation` で、attributes の値が文字列以外なら拒む変異 → 範囲外の歯を3実装に足した。
  5. observe 経路: 壊れた候補と正常な候補が混ざる場面の歯が Postgres に無く、testkit の InMemory と core の Fake には observe 経路の歯がそもそも無かった（例外を observe 全体へ漏らす変異が Fake 経路で生き残った）→ 3実装に足した（壊れた候補は store の手前の Proxy で作る。Runtime が作る NewMemory では自然には作れないため）。
- **確かめていない**: createRecall・Event の書き込みを拒む変異は入れていない（自然な「やりすぎ」の形を決められなかった。範囲外の歯は subjectId と createObservation 系のみ）。欄ごとの検査の除去は、重ならない形の変異をまとめて入れて失敗した歯の名前で見分けた（1つずつではない）。Postgres での全形の再実行は、口ごとの除去と supersede の変異でのみ行い、欄ごとの変異は core と testkit で見た（表は同じ）。

## 覆るとしたら

オーナーが「書き込みの口は値の中身を見ない（読み側が弾く）」へ戻したとき。そのときは、3実装の呼び出しと conformance の歯を外し、TSDoc を戻す。`MemorySchema` に欄が増えたときは、`assertWellFormedNewMemory` の見る欄に足すかを決める（今は6欄の列挙）。

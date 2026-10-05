# ADR 0630: `MemoryStore` の Memory の書き込みの口は、読み戻すと `MemorySchema` を通らない値を入口で拒む

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-06

出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手・マネージャーの判定、【未確認】は確かめていないこと。

**出所**: オーナー回答 70449a95（承認キュー）の問2「store に渡す値の中身の検査」による（2026-10-05T18:03Z）。**オーナーが決めたのは、推奨（入口で拒む）を採ることだけである。**範囲（どの欄・どの口か）・例外の種類・文面・範囲外にするものは、マネージャー（mgr-3cdbd12b）が決め、担い手が実装した。【判断】破壊的変更を v1.X.0 で出してよいことは、オーナーの回答による。

## 背景

`MemoryStore` の `createMemory`・`createMemoryWithOutbox`・`supersedeWithNewMemories` は、`NewMemory` の中身を検査せず、書いたら読み戻したときに `MemorySchema` を通らない値を黙って書いていた（TSDoc に「返った Memory は `MemorySchema` を通らないことがある」と明記し、PR #1362・#1365 と `store-input-current-behaviour.postgres.test.ts` がその振る舞いを縛っていた）。【現物】

前回の調査で、次が `@mnemora/postgres` と testkit の `InMemoryMemoryStore` の両方で、黙って書かれ、読み戻すと `MemorySchema` を通らないことを実測していた。【実測】

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

### 範囲外（触らない）

`subjectId`（空文字を含む。別の担当が進めている）、Observation・Event・`createRecall` の書き込み、既に拒んでいる欄（`strength`・`halfLifeHours`・列挙・Invalid Date など。文面も変えない）、`tags` に数が入る件、`validFrom > validUntil` の逆転、`content`・`tags` の中身・日時。範囲外であることは、歯でも縛る（`subjectId: ""` はこの検査の文面で拒まれない、`createObservation` は `attributes: { a: 1 }` を今までどおり通す）。

### `createMemoriesWithOutboxAndEvents?`（3つの口の外）

依頼の範囲は3口だったが、`@mnemora/postgres` と testkit では `createMemoriesWithOutboxAndEvents?` が同じ入口（`insertMemoryWithOutboxRows`・`createMemoryIdempotent`）を共有するため、**検査が自然に掛かる**（壊れた候補は、保存できない他の候補と同じく `dropped` に積まれ、ほかは書く）。core の Fake はこの口を持たない。口を分けて掛けない案は、共有部分を割る必要があり採らなかった。歯を足した（Postgres・fixture）。【判断】

## 採らなかった案

- **型付きの例外クラス（`MalformedIdentifierError` のような）を新設する**: 呼び手が分岐する必要が無く（どの実装でも「書けない入力」を直すだけ）、公開面と foreign-realm 判定（ADR 0418）の負担が増える。既存の値の検査は素の `Error`。
- **欄ごとに手書きの検査を3実装に写す**: `MemorySchema` とずれる。共有関数＋ schema の流用を採った。
- **読み戻すときに直す・読み側で弾く**: オーナーが選んだのは「入口で拒む」。
- **既に書かれた行の掃除（マイグレーション）**: 範囲外。下の負債。

## 引き受けた負債

- **既に書かれた不正な行は残る**。Postgres の `rowToClaimKey` は片側だけの行を鍵なしとして返し続ける。空文字の `digest` などの行は読み側に残りうる（recall は壊れない。歯: `recall-pipeline.test.ts`）。掃除はしない。
- **`RuntimeConfig.extractorVersion` に空文字を渡している利用者**は、抽出した Memory が書けなくなる（以前は書けて、`MemorySchema` を通らなかった）。Runtime の config はこの値を検査していない。【未確認】（実際の落ち方は測っていない。保存できない候補として落ちるはず）
- **外部の adapter**: conformance suite の判定が厳しくなった（上の決定6）。自前の `MemoryStore` は、同じ入力を拒む必要がある。`assertWellFormedNewMemory` を呼べばよい。
- 表が2か所に在る（`packages/core/src/__tests__/malformed-new-memory-cases.ts` と `memory-store-conformance.ts`）。core のテストは testkit を import できないため。
- `provenance.sourceObservationId` と `input.sourceObservationId` の食い違い、`provenance` の列挙外の `kind`・`null` の例外の種類が実装で違う点は、そのまま。

## 覆るとしたら

オーナーが「書き込みの口は値の中身を見ない（読み側が弾く）」へ戻したとき。そのときは、3実装の呼び出しと conformance の歯を外し、TSDoc を戻す。`MemorySchema` に欄が増えたときは、`assertWellFormedNewMemory` の見る欄に足すかを決める（今は6欄の列挙）。

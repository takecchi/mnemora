# ADR 0672: 09/25 にマージされた PR の確かめ直しで見つかったすり抜けに歯を足す（Issue #1775）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-07

**これはクローン（miku）の判断で、オーナーの判断ではない**（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。出所は Issue [#1775](https://github.com/takecchi/mnemora/issues/1775)。
出所の区別: 【現物】は読んだコード、【実測】は手元で走らせた結果、【受】は自分で測らずに受け取ったもの、【判断】は担い手の判定。
これは試験だけの変更で、実装・TSDoc・migration・fixture・CHANGELOG・公開の適合テスト（`*-conformance.ts`）は触らない（[ADR 0665](./0665-merged-0924-recheck-teeth.md) と同じ）。

## 経緯

2026-09-25（UTC）にマージされた50本の PR に、足りない側とやりすぎた側の変異を当てた記録が #1775 のコメントにある。【受】すり抜けた変異のうち、約束が PR 本文・公開の doc・ADR に書いてあるものに歯を足す。

**作業中の版**: この PR は群ごとに commit を積んでいる。下の表は、足した群までの分である。残りは #1775 のコメントで追う。

## 決定【判断】

1. **実装は変えない。**公開の適合テストにも足さない。歯は、各パッケージに固有のテストに置く。
2. 歯の範囲は、約束が PR 本文・公開の doc・ADR に書いてあるものとする。前任が「約束の外・要判断」と付けた案でも、doc・ADR に書いてある約束なら入れる。
3. 約束が後の ADR で狭まっているときは、いまの約束に当てる。#736 は ADR 0474（べき等性の例外の入力には当てない）、#745 は ADR 0377・0473 で狭まり 0378・0381 で広がった後の約束に当てる。

### 足した歯

「赤」は、元のすり抜けの変異を `cp` で当てた状態で、足した歯が落ちたこと。戻して `cmp` が一致し、緑に戻ることも確かめた。

| PR | すり抜けた変異 | 足した歯（置き場所） | 変異での赤 |
| --- | --- | --- | --- |
| #697 | 同伴（`fetchMandatoryCompanions`）の `timeWeighting` を `undefined` にする | 2者間の対で同伴の `score.freshness` が eventAware なら 1・legacy なら 1 未満（core `recall-time-weighting-companion-association-wiring.test.ts`） | 赤（1） |
| #697 | 同伴の別経路（relationStore）で `undefined` を渡す | 多者間の群で同上 | 赤（1） |
| #697 | 連想枠の `timeWeighting` を `undefined` にする | 連想候補の `score.freshness` が eventAware なら 1 | 赤（1） |
| #697 | `RecallQuerySchema.timeWeighting` を `z.string().optional()` にする | `"bogus"`・`""`・`1` が拒まれる `it.each` | 赤（2。`1` は `z.string()` でも拒まれる） |
| #712 | 特例を `subjectId.trim().toLowerCase() === "null"` にする | `"NULL"`・`"Null"`・`" null "`・`"nil"`・`"None"` 等が一覧外として弾かれる `it.each`（core `extraction-string-null-variants.test.ts`） | 赤（4） |
| #712 | `buildSubjectCandidateInstruction` の「明示的に null を設定」を文字列 `"null"` の指示にする | 指示文が「明示的に null を設定してください」を含み、引用符つき `"null"` を含まない | 赤（1） |
| #726・#733 | `consolidate({ seedMemoryId })` の近傍 `recall()` を、呼び手の `ctx` に関わらず種の subject に絞る | 種 A・近傍 B。`ctx.subjectId` なしの dryRun で B が eligible、`ctx.subjectId` が A なら入らない、B（種と別）でも B の scope（core `consolidate-scope-teeth.test.ts`） | 赤（2） |
| #726・#733 | `processConsolidateJob` が、種の `subjectId` が null のとき `ctx.subjectId` を外す | 種が null・`tick` の `ctx.subjectId` が B・近傍が B と A → B の近傍だけ統合、A は active | 赤（1） |
| #733 | 種が見つからないとき `processConsolidateJob` が投げる | 存在しない `memoryId` を指す consolidate ジョブで `tick` が `processed: 1, failed: 0` | 赤（1） |
| #824 | `fetchMandatoryCompanions` が `decayFloorAt` が過去の対向を弾く | `decayFloorAt` が now より前の contested の対向も companion として返る（core `recall-companion-status-gate.test.ts` に追記） | 赤（1） |
| #834 | `resolveEmbeddingInput` の既定を `memory.content` から `memory.digest` にする | フックなしで content と digest が違う記憶を `tick` し、provider が受け取るのが content（core 新規 `embedding-input-default-sends-content.test.ts`） | 赤（1） |
| #838 | `DEFAULT_RECALL_ASSOCIATION.maxCount` を `0` にする（on と名乗るが1件も選ばない） | 既定値が `{ maxCount: 10 }` であること、`association` を省略しても連想でしか届かない記憶が `retrievedVia: "association"` で入ること（core `recall-association.test.ts` に追記） | 赤（2） |
| #792 | `buildKnownSubjectInstruction` から第三者の2文を落とす | `knownSubjects` を渡した system が「第三者」と「'user' ではなく」を含む（core `claim-key.test.ts` に追記） | 赤（1） |
| #792 | `resolveKnownSubjects` が空配列のとき `["user"]` を返す | `claimKey.knownSubjects: []` の claim key 呼び出しが省いた場合と `toEqual`（core `runtime.test.ts` に追記） | 赤（1） |
| #792 | `knownSubjects` があるとき `knownPredicates` を `deriveClaimKeys` へ渡さない | `observe` を通して predicate と subject の両方の見出しが system に出て、predicate が先 | 赤（1） |
| #764 | 抽出の `created` イベントの actor を `{ type: "clone" }` にする（`buildCreatedEventFor`） | `observe` → `tick`（抽出・埋め込み・consolidate/reflect）の全イベントの `actor` が `{ type: "system" }`（core `tick-consolidate-reflect-job-event-actor.test.ts` に追記） | 赤（1） |
| #832 | `contestedWith` を、同伴取得（`companionOf` あり）で来た記憶には付けない | 同伴取得で来た対の両側に `contestedWith` が付く（core `recall-pipeline.test.ts` に追記） | 赤（2。うち1本は #1806 の既存の歯） |
| #832 | 付かないとき `contestedWith = undefined` をキー付きで書く | 「付かない」2本に `Object.hasOwn(..., "contestedWith")` が false | 赤（2） |
| #828 | testkit `InMemoryVectorStore.search`・core `FakeVectorStore.search` から `memoryId` の段を外す | upsert を id の降順に打っても id 昇順で返る（testkit `in-memory-vector-store-tiebreak.test.ts`・core `fake-vector-store-tiebreak.test.ts` に追記） | 赤（各1） |
| #828 | 距離の差が 1e-3 以下なら同点として `recordedAt` へ進める（testkit・core） | 近いが違う距離は距離が先 | 赤（各1） |
| #828 | 同点の日時を `occurredAt ?? recordedAt` にする（testkit・core） | `occurredAt` の順と `recordedAt` の順が逆の2件 | 赤（各1） |
| #828 | `{ memoryId, distance }` に絞らず `recordedAt` 付きで返す（testkit・core） | `Object.keys(hits[0])` が `["memoryId","distance"]` | 赤（各1） |
| #771 | InMemory `setEmbeddingStatus` が、別テナントの行が見つかったとき投げる前にその行の `updatedAt` を書く | 失敗の前後で持ち主の行を `updatedAt` ごと丸ごと比べる（testkit `in-memory-cross-tenant-failure-no-side-effects.test.ts`。InMemory 固有） | 赤（1） |
| #772 | InMemory `updateStatusWithEvent` が、別テナントの行で失敗するとき呼んだ側（B）のテナントにイベントを積む | 失敗の後で B 側を含めイベントが1件も無い | 赤（1） |
| #773 | InMemory `supersedeWithNewMemories` が、別テナントの行で失敗するとき呼んだ側のテナントにイベントを積む | 同上（`expectedStatus` 無しと `"active"` 付きの両方で例外、イベント無し） | 赤（1） |
| #811・#813 | InMemory `claimBatch` の負数・非整数の `limit` の検査を、claim を済ませた後へ動かす | claim 可能なジョブ2件で `limit: -1`・`1.5` を拒んだ後、ジョブが `claimedAt` 未設定・`attempts` 0（testkit `in-memory-claim-batch-invalid-limit-no-claim.test.ts`。InMemory 固有） | 赤（2） |
| #815 | InMemory `setDefaultHalfLifeRecalls` の上側の境界を `9e38` までにする | 実測の両端 `3.4028235677973362e38`（通る）・`3.4028235677973366e38`（拒む）と、`3.5e38`・`9e38`・`1e39` を拒む（testkit `in-memory-fixtures-half-life-recalls-float4-overflow.test.ts` に追記） | 赤（3） |
| #815 | 境界を float4 の最大値（`3.4028234663852886e38`）でぴったり切る | 同上（最大値と丸めの境界の間の `3.4028235677973362e38` が通る） | 赤（1） |
| #716 | `SeededLLMProvider.completeStructured` がスキーマに合わない種の記録を握り潰してそのまま返す | 種の記録がスキーマに合わないとき「いまのスキーマを満たさない」で投げ、`usage.seeded` が増えない（testkit `seeded-provider.test.ts` に追記） | 赤（1） |
| #716 | `SeededEmbeddingProvider` の `expectedSpace` の照合から `dimensions` を外す | 種・委譲先と同じ3次元で `expectedSpace` だけ次元違いなら構築時に例外 | 赤（1） |
| #716 | 委譲先が件数違いを返したときの例外を外す | 欠け2件で1件だけ返す委譲先なら例外 | 赤（1） |
| #716（参考 E4） | 欠けた分の戻りを逆順で元の位置へ戻す | 種と欠けを交互に混ぜた入力（欠け3件）で戻りが入力の順 | 赤（1） |
| #827 | 適合テストの `supportsFindActiveByClaimKey` の枝を `false` でも本物の歯を走らせる（`=== true` を `!== undefined`） | `false` を渡す3つ目の呼び出し（メソッドを持たない Proxy）。本物の歯は走らず、「実装していない」assert が3メソッドの有無を読みに行く（testkit `memory-store-conformance.supports-labels-and-claim-key-optional.test.ts` に追記） | 赤（12） |
| #827 | `supportsLabels: false` の枝の assert（`listLabels`/`registerLabel` が無いこと）を空にする | 同上（プロパティの読み出し回数が 0 になる） | 赤（1） |
| #827 | `supportsFindActiveByClaimKey: false` の枝の assert を空にする | 同上 | 赤（1） |
| #773 | Postgres `supersedeWithNewMemories` の、`expectedStatus` 付きで対象が引けなかったときの `SELECT status` から `tenant_id` を外す | 別テナントの active な行を `expectedStatus: "active"` 付きで渡すと `conflicted` でなく「対象が無い」例外、news ロールバック、持ち主の行は無傷（postgres 新規 `supersede-with-new-memories-cross-tenant-expected-status.postgres.test.ts`） | 赤（1） |
| #724 | Postgres `PostgresLexicalStore` の `filter.attributes` を `@>` から向き違いの `<@` 相当にする | 複数キーの条件は全キー一致だけ返す、属性が `{}` の記憶は条件があれば返らない（postgres 新規 `lexical-store-attributes-and.postgres.test.ts`。Postgres 固有） | 赤（2） |
| #724 | InMemory `InMemoryLexicalStore` の `filter.attributes` の `every` を `some` にする | 同上（testkit 新規 `in-memory-lexical-store-attributes-and.test.ts`。InMemory 固有） | 赤（1） |
| #724 | runtime の `survivesAttributesFilter` の `every` を `some` にする | adapter が `attributes` を無視し、片方のキーだけ一致する記憶を返しても結果に出ない（core `recall-attributes-filter.test.ts` に追記） | 赤（1） |
| #724 | 連想枠（段3.5）の `survivesAttributesFilter` を外す | 連想用の `search()` だけが `attributes` を無視して外の記憶を返しても、連想枠に乗らない | 赤（1） |
| #743 | 連想枠の `survivesLabelsFilter` を外す | 連想用の `search()` だけが `labels` を無視しても連想枠に乗らない（core `recall-taxonomy-filter.test.ts` に追記） | 赤（1） |
| #743 | 目次帯の引き直しから `scope.labels` を外す | `scope.labels` を無視する `aggregateScope` から外の `digest` が返っても `digestBand` に乗らず `countKind` が `'unknown'` | 赤（1） |
| #743 | 同伴（段3）にも `labels` を掛ける | contested の組の片方だけが `labels` に一致するとき、もう一方が同伴として残る | 赤（1） |
| #743 | `labels` だけで `taxonomyGroups` 相当の群を作る | `labels` だけを渡した `recall()` の `index.groups` に `axis:'taxonomy'` が無い | 赤（1） |
| #743 | 後置フィルタ `survivesLabelsFilter` を大文字小文字を無視して比べる | adapter が `labels` を無視しても、大文字小文字だけが違う名前は混入しない | 赤（1） |
| #745 | `enabled: true` だけで検出が走る（`createMemoriesFromCandidates` へ `claimKeyOptions !== undefined` を渡す） | `{ enabled: true }`・`{ enabled: true, detectContested: false }` で `findActiveByClaimKey`・`findContestedByClaimKey` が0回、`contestedDetection` が無い。陽性対照は `detectContested: true`（core 新規 `claim-key-detection-gating-teeth.test.ts`） | 赤（2） |
| #745（C2 の言い換え） | 観測を持たない（`sourceObservationId` が null の）既存の記憶を、兄弟として一致から落とす | null 観測の active な記憶と同じ鍵・重なる期間なら、後から `observe` した記憶と contested になる | 赤（1） |
| #746 | Worker の処理関数が `tick` に `{}` を渡す（`leaseMs` が落ちる） | `Worker` のモックから処理関数を取り出して呼び、`runtime.tick` の引数が設定の `ctx`・`tick` と同一の値、呼び出しは1回、戻り値を返し `onTickResult` に渡る（bullmq 新規 `tick-driver.processor.test.ts`。Redis 不要） | 赤（1） |
| #746 | 処理関数が `runtime.tick` を2回呼ぶ | 同上 | 赤（1） |
| #746 | 処理関数が別の `ctx`（`{ tenantId: "other" }`）で `tick` を呼ぶ | 同上 | 赤（1） |

### 入れなかったもの

| PR | 案 | 入れなかった理由 |
| --- | --- | --- |
| #811・#813 | `limit: 0` を渡して例外にならず空 | doc・ADR のどこにも書いていない |
| #811・#813 | `limit: 2 ** 60` で例外にならない | doc・ADR のどこにも書いていない |
| #810 | `Infinity` を有効とするか | 仕様を決める必要がある。Issue #1785 |
| #832 | 条件(c)（相手が返却集合に居る） | 歯では塞げない。Issue #1786 |
| #783 | ベンチ本体（`same-ms-usage-bench.ts`）の検査の修正 | テスト以外のコードを直す必要がある |
| #839 | `ORDER BY id ASC` を外す変異（デッドロック） | 重すぎて作れない |
| #722 | `digestBandLimit: 0` の標本で往復が一致する（変異7・8: eligible の桁上がり・`limitedByChars` を差し引かない） | 実 `recall()` では到達しない。`digestBandLimit` は正の整数だけ（`RecallQuerySchema` が `positive()`）で 0 を渡すと検証で落ちる。帯が空で範囲内が12件以上になる標本は、合成した標本で式を再実装する形になり、約束の検査にならない |
| #745 | C2「検出する側の記憶の観測が `null`（`null` 同士を同じ観測と見なす）」 | 到達しない。`detectClaimKeyContested` の呼び出しは `observe` の抽出経路の2か所だけで、そこで作る記憶は必ず `sourceObservationId` を持つ。代わりに到達できる向き（null 観測の既存の記憶を兄弟として落とす変異）に歯を入れた（上の表） |
| #745 | C14「冪等な再送（`created === false`）でも検出する」 | 到達しない。同じ `externalId` の `observe` は入口で `resend` として返り、抽出・検出の経路に入らない（【実測】2回目の `memoryIds` は空）。`created === false` が検出の経路で起きるのは並行の競合だけで、Fake では作れない |
| #745 | C13（自分自身を `excludeMemoryId` なしで除く） | 振る舞いが変わらない変異（前任が「不要」と判定） |
| #750 | 変異6「空のとき `[]` を返す」 | 振る舞いが変わらない変異（`resolveKnownPredicates` の空配列は「渡していない」と同じ扱い。前任が「不要」と判定） |
| #782 | 変異i「`NOT EXISTS` を外す」 | 振る舞いが変わらない変異（前任が「歯は不要」と判定。字句検査は壊れやすい） |
| #839 | 変異f「`ORDER BY` を降順にする」 | 振る舞いが変わらない変異（一貫した順なので観測できる差が無い） |
| #830 | （すり抜け 0） | 前任の結果が「すり抜けは0」 |
| #724 | 変異31「除外分の副問い合わせ」・#743 変異27「除外分の数え」 | `recall()` からは到達しない（振る舞いが変わらない）。`aggregateScope` の直接呼びの話で、約束の外に近い |

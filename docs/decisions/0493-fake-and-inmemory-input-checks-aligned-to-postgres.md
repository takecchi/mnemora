# ADR 0493: 穴探し60巡目 — core の Fake と testkit の InMemory が、`@mnemora/postgres` の断る入力を通していた口を揃える（形 A〜E を横に掃いた）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-02

クローン miku の委譲先（担い手。マネージャー mgr-2c9f30d0 の指示による）が書いた。直す線（約束に実装を戻す・落ちる入力を減らす・文書の直し・前例のある同種の穴〔Fake・InMemory を Postgres に揃える〕）の中だけを直し、新しい断り・既定値の変更・公開 API を足す・conformance suite に約束を足す・遡ってのデータの書き換え・適用済み migration の編集・Postgres の返りを変える向き、は「材料」に回した。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果（Node.js v22、PostgreSQL 17 + pgvector を自分専用のポート `54871` で。`C.UTF-8`）、【判断】は担い手の判定、【未確認】は確かめていないこと。

- **文脈**: 60巡目は、ADR 0480〜0492 で見つかった「割れの形」が、まだ当てていない口に残っていないかを、形ごとに横に掃いた。形は5つ: A（3実装〔core の Fake・testkit の InMemory・`@mnemora/postgres`〕の食い違い）・B（uuid の大文字小文字）・C（消した後の参照）・D（型の外の入力）・E（Fake だけ検査が甘い）。**ADR 0480〜0491（main 上）と別 PR の 0486（#1593）・0488（#1599 RelationStore）・0492（#1600 recall fuzz）の面は外した**（`RelationStore`・`createRecall`・`observe` の入力の種類・`TokenCounter`・`findCorrectionCandidates` の `excludeMemoryIds` の runtime 層・recall の `channels`・`embeddingInput` の戻り値・言語の事後検査・claim key の相対期間）。
- **方法**【実測】: 使い捨てのスクリプトで、同じ入力を Fake・InMemory・Postgres の3者に流し、`ok`／例外と戻り値を突き合わせた（約600入力。MemoryStore・VectorStore・LexicalStore・EventStore・OutboxStore・TenantSettingsStore の口）。スクリプトはコミットしていない。

## 1. 当てた形（直した。Fake と InMemory だけ。`@mnemora/postgres`・conformance suite・既定値は変えていない）

### 1a. 先に当てた分（commit 21fc2923）— 形 E

core の Fake の `VectorStore.search`・`LexicalStore.search` の `filter`（`occurredAfter`・`occurredBefore`・`validAt` の Invalid Date、`subjectId`・`tenantId` の NUL、`LexicalStore` の `attributes` の NUL）、`EventStore.list` の `since`・`until`（Invalid Date）、`OutboxStore.claimBatch` の `claimedBy` の NUL、`complete`・`fail` の `opts.at`（Invalid Date）、`purgeCompletedJobs` の `olderThan`（Invalid Date）。歯は `fake-read-and-claim-input-checks.test.ts`。

### 1b. この続きで当てた分 — 形 E（Fake。非公開なので、公開面で落ちる入力は増えない）

Fake だけが通していた。InMemory・Postgres はどちらも断る【実測】。

| # | 口（`packages/core/src/__tests__/runtime-fakes.ts`） | 断るようにした入力 |
|---|---|---|
| E1 | 全 Fake の全公開メソッド（Memory・Vector・Lexical・Event・Outbox・TenantSettings・Relation） | `ctx.tenantId` の NUL・孤立サロゲート（`MalformedIdentifierError`）。各メソッドの冒頭で `assertWellFormedCtx(ctx)` を呼ぶ（Proxy 包みにしない）。`createMemory` の「`tenantId` は共通の入口が無いので扱わない」という古いコメントも直した |
| E2 | `aggregateScope` の `scope` | `occurredAfter`・`occurredBefore`・`validAt`・`decayFloorAtAfter` の Invalid Date、`decayFloorSeqAfter` の非整数・NaN・Infinity、`subjectId` の NUL・孤立サロゲート、`attributes`・`labels` の NUL（`scopeAggregate: "skip"` で `digestBand` 無しのときは Postgres が問い合わせを出さないので見ない） |
| E3 | `FakeVectorStore.search` の `filter` | `decayFloorAtAfter` の Invalid Date、`decayFloorSeqAfter` の非整数（1a は `occurredAfter`・`occurredBefore`・`validAt` までで、この2欄が漏れていた） |
| E4 | イベントを積む全口（`buildStoredEvent` が合流点。`EventStore.append`・`updateStatusWithEvent`・`supersedeWithNewMemories`・`purgeMemory`・`markContested*`・`resolve*`） | `actor`・`meta` の NUL・孤立サロゲート（キー・値・入れ子）、`actor`・`meta` の BigInt（`TypeError`。他のどの検査より先）、`digestSnapshot` の NUL、`sizeBeforeBytes` の int4 外・非整数。testkit の `assertStorableMemoryEvent` と同じ判定 |
| E5 | `reinforce` の `opts.nowSeq` | `halfLifeRecalls` を持つ記憶のとき、`nowSeq` が NaN・Infinity・非整数・2^63 以上、書く値（`nowSeq` か `nowSeq + S_x`）が負のとき。何かを書き換える前に断る（以前は NaN や 1e300 を `decayBaseSeq` に書いた） |
| E6 | `createMemory` | `decayBaseSeq`・`decayFloorSeq`（非整数・負・2^63 以上）、`halfLifeRecalls`（`(0, ∞)` の外・float4 で 0 や Infinity に丸まる値）、`extractorVersion` の NUL、`subjectId` の孤立サロゲート、`status`・`digestSource`・`embeddingStatus` の列挙外、`decayFloorAt`・`lastReinforcedAt` の Invalid Date（D1 と同じ） |
| E7 | `createObservation`・`createObservationWithOutbox` | `subjectId`・`externalId` の孤立サロゲート |
| E8 | `archiveDecayed` | `now` の Invalid Date、`nowSeq` の非整数 |
| E9 | `createObservationWithOutbox`（`opts.now`・`opts.claimedBy`）・`createMemoryWithOutbox`（`jobKinds`）・`supersedeWithNewMemories`（`opts.now`）・`requeueEmbedJobs`（`writeOpts.now`） | `now` の Invalid Date、`claimedBy`・`jobKinds` の NUL。**行を実際に書くときだけ**、何も書く前に見る（`jobKinds` が空・冪等の既存の行に当たるときは、Postgres が INSERT しないので見ない）。`supersedeWithNewMemories`・`requeueEmbedJobs` には検査のためだけの任意引数を足した（Fake はほかの `opts` の欄を使わない。いまも使わない） |
| E10 | `updateStatus`・`updateStatusWithEvent`・`setEmbeddingStatus`・`resolveContestedPair`・`resolveContestedGroup` | 列挙外の `status`・`embeddingStatus`（`"bogus"`・`"purged"` など）。**`updateStatus` の `"contested"` は、この Fake が意図して断らない**（ADR 0140 決定2・Issue #768）ので変えていない |
| E11 | `archiveDecayed` | `limit: 0` の `reachedLimit` を `false` にした（InMemory・Postgres と同じ。以前は `true`） |
| E12 | `FakeVectorStore` | 成分を float4 に丸めて持つ（`Math.fround`）。`1e-50` は 0 に丸まり距離が `NaN`、問い合わせの `1e39` も `NaN`（InMemory・Postgres と同じ） |

**触っていないもの**【判断】: `halfLifeHours` の範囲（`(0, ∞)`。Fake は意図して見ない。`recall-pipeline.test.ts` が `halfLifeHours: 0` の「壊れた」記憶を作る。上の E6 の対照の歯が、通ることを縛る）。**E6 で `decayFloorSeq` の負を断ると、`recall-decay-gate.test.ts` の2本が落ちた**（「活動時計では既に沈んでいる値」として `-1` を書いていた）。同じ意味（`nowSeq` ちょうどで沈む）になる `0` に、その2本のデータを替えた（Postgres の CHECK `memories_decay_seq_non_negative` は負を拒むので、`-1` は本番に無い形だった）。

### 1c. 当てた形 — 形 D（InMemory。testkit は公開なので、落ちる入力が増える）

InMemory も Fake も通し、Postgres だけが断っていた入力【実測】。

| # | 口 | 断るようにした入力 | Postgres |
|---|---|---|---|
| D1 | `InMemoryMemoryStore.createMemory`（Fake も同じ） | `NewMemory.decayFloorAt`（必須）・`lastReinforcedAt`（省略可）が Invalid Date。`recordedAt`・`occurredAt`・`validFrom`・`validUntil` は #807 で断っていて、この2欄だけが漏れていた。以前は Invalid Date のまま保持して成功した | `timestamptz` で断る |
| D2 | `InMemoryMemoryStore.createObservationWithOutbox`（Fake も同じ） | `opts.claimedBy` の NUL（`outbox.claimed_by` は `text`）。`claimBatch` の `claimedBy` は ADR 0434 で断っていて、こちらが漏れていた。行を実際に書くときだけ | `22021` で断る。行を書かないとき（`jobKinds` が空・冪等の既存の行）は見ない |
| D3 | `InMemoryMemoryStore`・`InMemoryVectorStore`・`InMemoryOutboxStore` の `eraseTenant`（Fake も同じ。`TenantSettingsStore.eraseTenant` は Postgres も `limit` を使わないので触らない） | `limit` が NaN・非整数・Infinity・2^63 以上。以前は `reachedLimit: false` で成功した | `bigint` の引数として断る。`@mnemora/core` の独立関数 `eraseTenant` は元から `limit` を正の整数に限る（`erase-tenant.ts`）ので、影響を受けるのは port を直接呼ぶ呼び出しだけ |

**公開面で落ちる入力は増えるか**【判断】: Fake（非公開）は増えない。InMemory の D1・D2・D3 は**増える**。ただし Postgres は元から同じ入力で断るので、InMemory を本番の代わりに使っているだけのテストが、本番と同じ振る舞いになる側への変更である。**記録先は ADR 0434・0466・0469 の前例どおり、CHANGELOG の `[1.2.0]` の `### Fixed` と `docs/migration-v1.md` の 🟡 の節**（「公開の fixture が新しく例外を投げる変更は破壊的と数えない」というオーナーの回答〔ask_human `3f3411c5`〕の延長。ADR 0466 が同じ置き方をしている）。🔴 の項目には数えていない（本物の adapter が新しく断る変更ではない）。**これはマネージャーの依頼文の「🔴 に載せる」とは違う置き場所である**。前例に倣って 🟡 に置いたので、🔴 に移すかはマネージャーの判断（移すなら、`migration-v1.md` の 🔴 の項目54 として足し、🟡 の項目から指す）。

## 2. 当てていない形（測ったが穴なし）

### 形 C: 消した後の参照 — 穴なし【実測。3者が一致した】

- 状態の記憶（`forgotten`・`archived`・`superseded`・`purge` 済みの墓石）に対する操作: `updateStatus` の遷移（active・forgotten・archived・superseded へ）、`setEmbeddingStatus`、`reinforce`、`reinforceMany`、`recordUsage`、`VectorStore.upsert`・`search`・`lex.search`（既定の status）、`aggregateScope`（`digestBand` を含む）、`archiveDecayed`、`requeueEmbedJobs`、`markContestedPair`、`EventStore.append`、`createMemory` の `supersededById`、`restoreSupersededBy`（superseder が消えている場合）、`listBySourceObservation`・`listBySourceObservationAllVersions`、`purgeMemory` の再呼び出し（`MemoryPurgeConflictError`）。
- `eraseTenant` の後: `get`・`reinforce`・`setEmbeddingStatus`・`updateStatus`・`vec.search`・`vec.upsert`・outbox の `claimBatch`・`complete`（claim 済みの行）・`EventStore.list`・`append`・`getRecall`・`recordUsage`・settings・活動カウンタ・同じ `contentHash`・同じ `externalId` の再作成・2回目の `eraseTenant`・`dryRun`。
- `purgeExpiredRecalls` の後の `getRecall`・`recordUsage`。
- 差は id の文字列の形（`mem-N` と uuid）と message の接頭辞だけ。
- 外した面: `RelationStore`（ADR 0488 が当てた。`link`・`listRelated` の `kind` は `"contradicts"` だけ）。
- **未確認**: Runtime 層（`forget`→`recall` など）の組み合わせ、`purgeExpiredEvents` の後の `EventStore.get`・`list`。

### 形 D・A: 3者が一致した入力【実測】

- `createMemory`: `strength`（NaN・Infinity・負・0・1.5・1e300）、`contentHash`・`content`・`digest`・`subjectId` の空文字と NUL、`tags[0]` の NUL、`recordedAt`・`occurredAt`・`validFrom`・`validUntil` の Invalid Date、`halfLifeHours` の Invalid 以外の範囲（InMemory・Postgres は断り、Fake は意図して見ない）。
- `createObservation`: `occurredAt` の Invalid Date・year 10000・文字列・数、`kind` の bogus・空文字、`subjectId`・`externalId` の NUL・空文字。`reinforce` の `at` の Invalid Date、`reinforceMany`・`recordUsage` の空配列。
- `EventStore.append`: `kind` の bogus・空文字・null、`at` の Invalid・year 10000・year -1、`meta` の配列・文字列・Date。`EventStore.list`: `memoryId` の NUL・空文字、`kind` の bogus。
- outbox: `claimBatch` の `leaseMs`（NaN・負・0・Infinity・1.5・2^31・2^53）、`now` の Invalid Date、`kinds`（bogus・空・重複）、`claimedBy`（空文字・10万字）、`complete`・`fail` の `expectedAttempts` と jobId（NUL・空・サロゲート）、`fail` の `error`（NUL・空・100万字）。
- 識別子: `get`・`getMany`・`getRecall`・`getObservation`・`EventStore.get`・`vec.upsert`・`vec.delete`・`deleteAcrossSpaces` の NUL・空文字・uuid でない文字列。
- `requeueEmbedJobs` の `statuses`・`memoryIds`、`archiveDecayed` の `clock` の bogus、`aggregateScope` の `digestBand.excludeMemoryIds`（NUL・空・非 uuid）・`digestBand.limit: 0`・`excludeProvenanceKinds`・`scopeAggregate` の bogus・`decayFloorAnyAxis`。
- `supersedeWithNewMemories`（`supersededByIndex` の範囲外・負・NaN・0.5、空の `news`、重複 id、対象不在、`expectedStatus` の bogus）、`markContestedGroup` の3件未満・重複、`resolveContestedPair` の `superseded` で `supersededById` 無し。
- `TenantSettingsStore` の書き込み（NaN・0・負・1.5・巨大値・null・bogus。ADR 0479 の面）。
- `limit`（`eraseTenant` 以外）の NaN・1.5・Infinity・-1・0・2^63（`archiveDecayed`・`purgeExpired*`・`purgeCompletedJobs`・`listActiveClaimPredicates`・`requeueEmbedJobs`・`digestBand.limit`・vec／lex／event の `limit`）。`limit: -1` で Postgres が `LIMIT limit+1` の癖で通す口は、#804 の既知の不一致で、歯が `-2` を使っている。
- ベクトルの次元違い・未登録の `space`・空の `provider` などは、InMemory・Fake が通し Postgres だけが断る。`VectorStore.upsert`・`search` の TSDoc の表（`vector-store.ts`）が既に書いている仕様であり、割れではない。
- 語彙検索（lexical）の一致は、Fake が部分文字列一致、InMemory が語の一致、Postgres が tsvector なので、URL・`1.2.3`・`foo.bar`（Postgres は1語にする）などで過剰にヒットする。構造的な近似の差であり、ここでは揃えない（後述 E14）。

### 形 B: uuid の大文字小文字 — **新しい割れは無い。全て ADR 0446・0469 が引き受けた負債の中**

操作の対象の `id` を大文字にすると、Postgres は同じ行として扱い（`normalizeUuidCase`）、Fake・InMemory は別 id として不在扱いにする。fixture の id は小文字の `mem-N` で uuid ではない。ADR 0469 が「操作の対象の `id` の大文字小文字は変えない（ADR 0446 の既存の違い）」と引き受けた。ここでは**揃えない**（下の材料1）。

## 3. 材料（オーナーの領分。直していない）

1. **形 B を揃えるか**【判断】: Fake・InMemory の id は小文字の `mem-N` なので、入口で小文字化しても別 id と混ざらず、落ちる入力は減る側（🟡）。ただし ADR 0469 の決定3が範囲を絞った判断で、広げるなら1本の ADR になる。**エラーではなく、黙って結果が変わる口**があるので、揃えるなら先にここから:
   - `aggregateScope` の `digestBand.excludeMemoryIds` に大文字: Postgres は除外し、Fake・InMemory は除外しない（digest が1件多い）。ADR 0485 は runtime 層の `findCorrectionCandidates` だけ直した。
   - `VectorStore.delete`・`deleteAcrossSpaces` に大文字: Postgres は消え、Fake・InMemory はベクトルが残り `search` に出続ける。
   - `requeueEmbedJobs({ memoryIds })`・`restoreSupersededBy`・`previewRestoreSupersededBy`・`onlyMemoryIds` に大文字: Postgres は 1件、Fake・InMemory は 0件。
   - outbox `complete` に大文字の jobId: Postgres は完了、Fake・InMemory は無視して再 claim される。
   - `markContestedGroup` に同じ id の大文字と小文字が混在: Postgres は `RangeError`（ids must be unique）、Fake・InMemory は not found。
   - そのほか、エラーになる口（`get`・`getMany`・`updateStatus`・`setEmbeddingStatus`・`reinforce`・`recordUsage`・`createMemory.sourceObservationId`・`markContestedPair`・`resolveOrphanedContested`・`EventStore.get`・`list`・`VectorStore.upsert` ほか。Postgres は通し、Fake・InMemory は `memory not found`）。
2. **E13**（Fake の `VectorStore.search`・`LexicalStore.search` の `filter.status: null`）: Fake は例外、Postgres は通す（0件）。型の外の入力なので放置。
3. **E14**（`FakeLexicalStore` の検索語の扱い）: 引用符・先頭の `-`（`-banana`・`"banana split"`）・記号だけの語・孤立サロゲートで InMemory・Postgres とヒット数が割れる。引用符・先頭の `-` を空白に落とすのは前例（migration `0023`）に沿うが、Fake の語彙検索は構造的な近似なので、どこまで揃えるかはオーナーの判断（範囲を広げすぎると別の実装を書くことになる）。
4. **D4**（型の外の入力）: `createObservation` の `kind: null`・`payload: undefined`、`EventStore.append` の `actor`・`meta` が undefined は、InMemory・Fake が通し Postgres が断る。新しい断りで、型の外の入力でもあるので、直していない（落ちる入力が増える。公開の fixture）。
5. **E4 の `markContestedGroup`・`resolveContestedGroup` の `sizeBeforeBytes: NaN`**: Postgres はこの2口だけ、複数のイベントを1つの `jsonb` の配列で渡すので、`NaN`・±Infinity が `null` になって通る（testkit は `asJsonSerializedSizeBeforeBytes` で写す）。Fake は全口で断る（そこまで写していない）。使う側のテストはまず無い。

## 4. 決定したこと

1. 上の 1b・1c を直した（Fake と InMemory だけ）。`packages/postgres` の実装・conformance suite・既定値・公開 API は変えていない。
2. Fake の各メソッドの `ctx` の検査は、Proxy 包みではなく各メソッドで明示した（読む人が口ごとに検査を追える。`InMemory`・`Postgres` と同じ形）。
3. InMemory の D1・D2・D3 は、CHANGELOG の `[1.2.0]` の `### Fixed` と `docs/migration-v1.md` の 🟡 に載せた（ADR 0434・0466 の前例。上の 1c の末尾）。
4. 歯は新しいファイルに置き、conformance suite には足さない（ADR 0434 決定5）。

## 5. 歯

- core: `packages/core/src/__tests__/fake-input-checks-round2.test.ts`（断る側と、やりすぎの対照を口ごとに）。1a の `fake-read-and-claim-input-checks.test.ts` と対をなす。
- testkit: `packages/testkit/src/__tests__/in-memory-input-checks-adr0493.test.ts`（D1・D2・D3 と対照）。
- Postgres（実 DB。Postgres が断る側を基準として縛る）: `packages/postgres/src/__tests__/input-checks-parity-0493.postgres.test.ts`（D1・D2・D3 と、E1〜E12 の「Postgres が断る」側の根拠）。
- 既存の歯の変更: `recall-decay-gate.test.ts` の2本の `decayFloorSeq: -1` を `0` に（上の 1b の末尾）。

## 6. 変異試験【実測】

直した検査を1つずつ外し（または、やりすぎの方向に曲げ）、歯が落ちることを確かめた。戻した後は `git status` が空であることを確かめた。**47 件の変異がすべて赤になった**（括弧は赤になった `it` の数）。

- **足りなくて赤**（検査を外す）: E1 の `assertWellFormedCtx` を全て（30）、E2 の `decayFloorSeqAfter`（3）・`occurredAfter`（1）・`subjectId`（2）・`labels` の NUL（1）、E3 の `decayFloorAtAfter`（1）・`decayFloorSeqAfter`（2）、E4 の int4（10）・BigInt（2）・`actor` の NUL（4）・`meta` の NUL（6）・`digestSnapshot` の NUL（2）、E5 の `nowSeq` の bigint（4）・書く値が負（1）、E6 の seq の負（1）・`halfLifeRecalls` の範囲（3）・`extractorVersion` の NUL（1）・`decayFloorAt` の Invalid（1）・`embeddingStatus` の列挙（1）、E7 の `externalId` の孤立サロゲート（1）、E8 の `now`（1）・`nowSeq`（1）、E11 の `reachedLimit`（1）、E9 の `claimedBy`（1）・`jobKinds`（2）・outbox の `now`（1）・supersede の `now`（1）・requeue の `now`（1）、E10 の `updateStatus`（1）・`setEmbeddingStatus`（1）・`resolveContestedPair`（1）、E12 の upsert の丸め（1）・問い合わせの丸め（1）、D3 の Fake の `eraseTenant`（4）、D1 の InMemory の `decayFloorAt`（1）・`lastReinforcedAt`（1）、D2 の `claimedBy`（1）、D3 の InMemory の memory（5）・vector（4）・outbox（4）。
- **やりすぎで赤**: E4 の「対になったサロゲートも断る」（1）、E5 の「`halfLifeRecalls` が無い記憶でも `nowSeq` を見る」（1）、E6 の「`halfLifeHours` の範囲を見る」（1）、E9 の「`jobKinds` が空でも見る」（1）、E10 の「`updateStatus` の `contested` を断る」（1）、D2 の「行を書かなくても `claimedBy` を見る」（1）。
- **変異を入れていないもの**: E10 の `updateStatusWithEvent`・`resolveContestedGroup` の列挙の検査（同じ関数を呼ぶので、1口ずつの変異は省いた。歯自体は両方を縛る）、E1 の口ごとの個別の外し（全部を外す変異のみ）。

## 7. 走らせたテスト（名指し）【実測】

- 新規: `fake-input-checks-round2.test.ts`（117本）、`in-memory-input-checks-adr0493.test.ts`（10本）、`input-checks-parity-0493.postgres.test.ts`（12本。実 Postgres 17）。
- Fake を広く使う既存の core のテスト（回帰）: `runtime`・`fake-store-postgres-parity`・`recall-pipeline`・`fake-reinforce-now-seq`・`fake-vector-store-filter`・`fake-vector-store-nan-order`・`fake-archive-decayed-clock`・`fake-memory-store-tsdoc-edges`（と `-round2`・`-round3`）・`fake-event-write-atomicity`・`fake-referential-integrity`・`fake-observation-event-rejects`・`recall-decay-gate`（直したあと）・`erase-tenant`・`apply-correction`・`consolidate`・`reextract`・`purge`・`forget`・`mark-contested-group`・`extraction`。いずれも緑。全テストは走らせていない（CI に任せる）。
- `pnpm -r --filter core --filter testkit --filter postgres run typecheck`・`eslint`・`prettier --check`（ts）は通した。

## 8. これが覆るとしたら

- オーナーが、InMemory の D1〜D3 を 🟡 ではなく 🔴 に数えると決めたとき（`migration-v1.md` の項目を足す）。
- オーナーが、Fake の `halfLifeHours` の範囲検査を入れてよいと決めたとき（`recall-pipeline.test.ts` の「壊れた」記憶を作り替える）。
- 形 B（操作の対象 id の大文字小文字）を fixture でも揃えると決めたとき（材料1）。

## 9. 測っていないこと

- Runtime 層（`forget`→`recall` など）の大文字 id・消した後の組み合わせ。
- `FakeLexicalStore` の語彙検索の網羅（材料3のとおり、構造的な近似の差は揃えていない）。
- 実 API（LLM・埋め込み）。
- `createMemoriesWithOutboxAndEvents`（Fake は実装していない任意メソッド）。
- `LexicalStore.search` の `filter` に `decayFloorAtAfter`・`decayFloorSeqAfter` の欄が有るか（E3 は `VectorStore` だけを見た）。

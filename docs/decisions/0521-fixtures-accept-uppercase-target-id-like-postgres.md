# ADR 0521: 穴探し — testkit の InMemory と core の Fake が、操作の対象の id（記憶・observation・recall・outbox のジョブ）を大文字で渡されても、`@mnemora/postgres` と同じ記憶・同じ行として扱うようにした。fuzz の `argupper` を3実装の差分に載せた

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-02

クローン miku の委譲先（担い手。マネージャー mgr-0d3098f9 の指示による）が書いた。直す線（約束に実装を戻す・落ちる入力を減らす・文書の直し・前例のある同種の穴〔Fake・InMemory を Postgres に揃える〕は直す。オーナーの領分の6つ〔前例の無い新しい断り・既定値の変更・公開 API を足す・suite に約束を足す・遡ってのデータの書き換え・適用済みの migration の編集〕は材料に回す）は依頼主が決めた。オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果（PostgreSQL 17 + pgvector を自分専用のポートで。`C.UTF-8`）、【判断】は担い手の判定、【未確認】は確かめていないこと。

## 要点

- **前提**: [ADR 0494](./0494-fuzz-relations-and-argument-mutation.md)（PR #1601）が、大文字の対象 id の扱いが3実装で割れている（Postgres は受け、fixture〔testkit の `InMemory*`・core の Fake〕は黙って何もしないか `memory not found` を投げる）ことを実測し、材料1・2として残した。これはその続き。[ADR 0446](./0446-apply-correction-no-write-before-winner-check-case-insensitive-candidate-reason-winner.md)・[0469](./0469-fake-event-target-and-uuid-case.md)・[0475](./0475-eventstore-append-uuid-case.md) は、イベントの指し先（`NewMemoryEvent.memoryId`）だけを揃えて、操作の対象の `id` は「既存の違い」として残していた【現物】。
- **向き**: 「Postgres に揃える」。fixture の id は小文字の `mem-N`・`obs-N`・`rcl-N`・`job-N` だけで、小文字にそろえても別の id と混ざらない。**落ちる入力が減る側**の変更で、新しく断る入力は無い（前例: ADR 0434・0466・0469・0475・0488）。
- **直した**（fixture だけ。`@mnemora/postgres`・conformance suite・既定値・公開 API は変えていない）: 記憶・observation・recall・outbox のジョブの id を取る fixture の口の入口で、id を小文字にそろえる。下の「決定」。
- **大文字の対象 id を操作の入口で断る・黙って何もしない、という ADR 0446 の「既存の違い」は無くなった**。fuzz の `argupper` を3実装の差分に載せ、`acceptsUpperCaseIds` の分岐を外した。

## 3実装の突き合わせ（直す前と直した後）

【実測】同じ4件（restore 用に1件は半減期1時間）の記憶に、操作の対象の id を小文字／大文字で渡し、返り値・終わった時点の status・積まれたイベントの `memoryId`・例外の有無を3実装で比べた。使い捨ての試験（コミットしていない）で、口は Runtime（`forget`・`purge`・`restoreArchived`・`markContested`・`resolveContested`・`consolidate`・`restoreSuperseded`・`markContestedGroup`・`resolveContestedGroup`・`observe(memory_usage)`・`findCorrectionCandidates`・`applyCorrection`）と store（`MemoryStore`・`VectorStore`・`RelationStore`・`EventStore`・`OutboxStore`）。**同じ比較を、直したあとの固定の歯として入れた**（下の「歯」）。

「同じ」= 大文字の結果が、小文字の結果と（返り値・最終 status・イベントの `memoryId` が小文字であること・例外の有無まで）同じ。返り値の中の id の綴りの echo（呼び出し側が渡した綴りで返る outcome の `memoryId`）と、順序を規定しない配列の並びは比べない。

| 口 | Postgres | InMemory・Fake（直す前） | InMemory・Fake（直した後） |
|---|---|---|---|
| `forget`・`forget({ memoryIds })` | 同じ（大文字でも forgotten。イベントの `memoryId` は小文字） | 何も起きない（`not_found`。status もイベントも変わらない） | 同じ |
| `purge` | 同じ | 何も起きない | 同じ |
| **`restoreArchived`（前回の未確認の1点）** | 同じ（archived → active。`restored` イベントの `memoryId` は小文字） | 何も起きない（`not_found`。archived のまま） | 同じ |
| `markContested` | 同じ（2件が contested。`contestedWithId` は小文字） | 何も起きない（`ineligible`、両側 `not_found`） | 同じ |
| `resolveContested`（`supersede`・`both_active`） | 同じ | 何も起きない（対のまま） | 同じ |
| `consolidate` | 同じ | 何も起きない（`nothing_to_consolidate`、対象は `not_found`） | 同じ |
| `restoreSuperseded` | 同じ | 何も起きない（`outcomes: []`） | 同じ |
| `markContestedGroup`・`resolveContestedGroup` | 同じ | 何も起きない（`ineligible`） | 同じ |
| `observe({ kind: "memory_usage" })` | 同じ | **`memory not found for tenant` を投げる** | 同じ |
| `findCorrectionCandidates` の `excludeMemoryIds`（ADR 0485） | 同じ | 同じ（core の `runtime.ts` が小文字にそろえる） | 同じ |
| `applyCorrection`（大文字の `correctedId`・`correctingId`） | 同じ（解決する） | InMemory: 何も起きない（`not_a_candidate`）。Fake: 試験できない（下の注） | 同じ（Fake は注のとおり） |
| `MemoryStore.get` | 同じ（小文字の行を返す） | `null` | 同じ |
| `MemoryStore.getMany`（`[a, A, B]`） | 同じ（綴り違いの重複は1件） | 大文字は落ちる | 同じ |
| `updateStatus`（`supersededById` が大文字も） | 同じ（`supersededById` は小文字で持つ） | **`memory not found` を投げる** | 同じ |
| `setEmbeddingStatus`・`reinforce`・`reinforceMany`・`recordUsage` | 同じ | **`memory not found` を投げる** | 同じ |
| `restoreSupersededBy`・`previewRestoreSupersededBy`（`supersededById`・`onlyMemoryIds`） | 同じ | 何も起きない（0件） | 同じ |
| `aggregateScope` の `digestBand.excludeMemoryIds` | 同じ（除外される） | 除外されない（帯が1件多い） | 同じ |
| `requeueEmbedJobs({ memoryIds })` | 同じ（1件積み直す） | 0件 | 同じ |
| `VectorStore.upsert`・`getVectors` | 同じ | `upsert` は **`memory not found` を投げる**。`getVectors` は大文字が落ちる | 同じ |
| `VectorStore.delete`・`deleteAcrossSpaces` | 同じ（消える） | **ベクトルが残り `search` に出続ける** | 同じ |
| `RelationStore.link` | 同じ | **`memory not found` を投げる** | 同じ |
| `RelationStore.listRelated`・`unlink` | 同じ | `listRelated` は空・`unlink` は行が残る | 同じ |
| `EventStore.list({ memoryId })` | 同じ | 空 | 同じ |
| `findActiveByClaimKey`・`findContestedByClaimKey` の `excludeMemoryId` | 同じ（除外される） | 除外されない | 同じ |
| `OutboxStore.complete`・`fail`（ジョブ id が大文字） | 同じ（終端になる） | **終端にならず、再 claim される** | 同じ |
| `getObservation`・`listBySourceObservation`・`createMemory` の `sourceObservationId` | 同じ | `null`・空・**`observation not found` を投げる** | 同じ |
| `getRecall`・`recordUsage` の `recallId` | 同じ | `null`・**`recall not found` を投げる** | 同じ |
| 同じ記憶を綴り違いで2回: `markContested(a, A)`・`forget([a, A])`・`markContestedGroup([a, A, b])` | 同じ（2つ目の綴りは Runtime が `not_found` と返す） | 同じ（元から同じ） | 同じ |

- **同じ入力で3実装が割れていた行は、前の列の太字を含めて、後の列で全部そろった**（50 余りの口 × 小文字・大文字、3実装）。直す前は 44 の口で fixture が Postgres とずれていた【実測。固定の歯 `uppercase-target-id-parity.postgres.test.ts` を直す前の fixture に当てると、その時点の 49 本中 44 本が赤。その後 claim key の `excludeMemoryId` の2本を足して 51 本。この2本は、`excludeMemoryId` の小文字化を外す変異で赤になることを確かめた】。
- **Fake の注**: Fake は全文の語彙一致を持たないので、`text` だけの recall は候補を返さない。`findCorrectionCandidates`・`applyCorrection` の2口は、Fake では「大文字」の比較が意味を持たないので、突き合わせから外した（`findCorrectionCandidates` の `excludeMemoryIds` の大文字は fuzz の I13〔ADR 0494〕が Fake・InMemory・Postgres で見る）。
- **Postgres の側に揃わない点・疑わしい点は、見つからなかった**【実測】。測った口のすべてで、Postgres は大文字を小文字と同じ行として扱い（結果は uuid 型の列で比べる・入口の `normalizeUuidCase`）、積まれるイベントの `memoryId`・読み戻す id は小文字の正規形だった。「大文字を uuid の型に通さず文字列のまま比べて取りこぼす」口は無かった。**ただし、測っていない口がある**（下の「測っていないこと」）。

## 決定

1. **fixture の口の入口で、操作の対象の id を小文字にそろえる**【判断。Postgres を正とする】。`@mnemora/postgres` が入口で `normalizeUuidCase` を掛ける口（`markContestedPair`・`resolveContestedPair`・`markContestedGroup`・`resolveContestedGroup`・`resolveOrphanedContested`・`purgeMemory`・`getMany`・`restoreSupersededBy`・`findActiveByClaimKey`・`findContestedByClaimKey`）は、同じ形（入口で1回そろえてから、重複・相互参照・CAS を比べる）にした。Postgres が uuid 型の列で暗黙に比べる口（`get`・`updateStatus*`・`setEmbeddingStatus`・`reinforce*`・`recordUsage`・`createMemory` の参照欄・`VectorStore`・`RelationStore`・`EventStore.list`・`OutboxStore.complete`/`fail`・`getObservation`・`getRecall`・`listBySourceObservation*`・`aggregateScope` の `digestBand.excludeMemoryIds`・`requeueEmbedJobs` の `memoryIds`）も、同じ入口でそろえた。
   - **testkit**（`packages/testkit/src/__fixtures__/`）: `in-memory-memory-store.ts`・`in-memory-vector-store.ts`・`in-memory-relation-store.ts`・`in-memory-event-store.ts`・`in-memory-outbox-store.ts`。
   - **core**（`packages/core/src/__tests__/runtime-fakes.ts`。非公開）: `FakeMemoryStore`・`FakeVectorStore`・`FakeRelationStore`・`FakeEventStore`・`FakeOutboxStore`。
   - **積む値**: 持つ id（`supersededById`・`contestedWithId`・イベントの `memoryId`・ベクトルの鍵・関係の行・使用の行の鍵）も小文字。読み戻す id も小文字（Postgres の uuid 型の列の正規形）。
   - **断るときの message** は、操作の対象の id については小文字にそろえた id を載せる（Postgres の `memoryNotFound` も小文字にそろえた id を載せる。ADR 0469・0475 が決めた、イベントの指し先の message は渡された id のまま、は変えていない）。
2. **Runtime（core の `runtime.ts`）は変えていない**。Runtime は store に従うだけで（ADR 0446）、store の答えが変わった分だけ結果が変わる。outcome の `memoryId` は、渡された綴りのまま返る（Postgres でも同じ。下の材料2）。
3. **fuzz の `argupper` を3実装の差分に載せ、`acceptsUpperCaseIds`（ADR 0494 の分岐）を外した**。fixture が大文字を受けるので、「fixture は断るので違反にしない」という許容が要らなくなった。`FuzzBackend`・`runOps` の例外の扱いは ADR 0494 の前の形に戻った。
4. **既存の歯の変更**【判断】: ADR 0446・0469・0475 が「fixture は大文字を受けない」ことを固定していた歯を、Postgres と同じ側に替えた（下の「歯」）。conformance suite には何も足していない（ADR 0434 決定5）。

## 歯（個別のテストファイル。conformance suite には足していない）

| ファイル | 内容 | 直す前に当てた赤 |
|---|---|---|
| `packages/core/src/__tests__/fake-uppercase-target-id.test.ts`（9本） | Fake が大文字の対象 id を Postgres と同じに受ける（forget・purge・restoreArchived・markContested・resolveContested・群・consolidate・restoreSuperseded・使用報告・`MemoryStore`/`VectorStore`/`RelationStore`/`EventStore` の口） | 8本が赤 |
| `packages/testkit/src/__tests__/in-memory-uppercase-target-id.test.ts`（9本） | 同じ内容を InMemory に | 8本が赤 |
| `packages/postgres/src/__tests__/uppercase-target-id-parity.postgres.test.ts`（51本。実 Postgres） | 上の表の口を、Postgres で「大文字＝小文字」（基準）と、InMemory・Fake が Postgres と同じ、を突き合わせる | 49本の時点で44本が赤（残りの2本は claim key。上のとおり変異で確認） |
| 既存: `uppercase-uuid-lookup`・`uppercase-uuid-store-entry`・`uppercase-uuid-contested-runtime`・`apply-correction-case-and-no-partial-write`（postgres）の fixture の leg | 各 `kit` の `caseInsensitive` が fixture では `false` だった。`true` にした（Postgres と同じ側の分岐を通る）。**`false` の側の分岐は、いまは通らない（削除していない）** | 直す前は緑、直した後に `true` にしないと赤（16本） |
| 既存: `packages/testkit/src/__tests__/in-memory-event-target-belongs-to-ctx-tenant.test.ts` | 「操作の対象の id は完全一致のまま（`NOT_FOUND`）」の assert を、「受ける」に替えた | 直した後に旧 assert が赤（1本） |

## fuzz への載せ方と変異試験

- **差分に載せた**: `recall-invariant-fuzz.postgres.test.ts` に「差分（argupper、indexscan_off）」を足した（環境変数 `RECALL_FUZZ_PG_ARGUPPER_DIFF_SEEDS`、既定 10）。【実測】10 シード（既定）・80 シード（seed 2000〜2079）で、Fake・testkit の InMemory と Postgres の recall の結果は食い違わなかった。`argdead` の差分 80 シード・`argupper` の単独の不変条件 80 シードも緑。
- **既存の profile の同じ seed の操作列が変わっていないこと**【実測】: 変更前の harness（`bde1acef`＝ADR 0492 の版）と、この枝の `genOps` の出力を、`default`／`wide`／`fields` × seed 1〜500 × 長さ 60／120（3000 通り）で `JSON.stringify` が一致することを使い捨ての試験で一度示した。ADR 0494 の版（`85c06451`）とは、6 つの profile × 同じ範囲（6000 通り）で一致した。この枝は `genOps` を変えていない。
- **前回の4つの変異**（`recall-invariant-fuzz.postgres.test.ts` の `default`・`fields`・`relations`・`argdead`・`argupper` の leg と差分、core の `recall-invariant-fuzz.test.ts`、固定の歯を当てた）:

| 変異 | fuzz（ADR 0494 の時点） | fuzz（この ADR の後） | 固定の歯 |
|---|---|---|---|
| ADR 0469 の Fake の `assertEventTargetOwn`（`memoryId.toLowerCase()` を外す） | 緑（拾えなかった） | **赤**。core の `argupper`（`mark: FakeMemoryStore: memory not found for tenant: MEM-4` ほか seed 1・3・5・6・7・10）と、Postgres の差分（argupper、`recall #3 の $.omitted[1].count` ほか seed 1・3・5・7・9・10）。`default`・`fields`・`relations`・`argdead` は緑のまま | 赤（postgres 2 ファイル、10本） |
| ADR 0469 の Postgres の `checkedRef`（`id.toLowerCase()` を外す） | 緑 | **緑のまま（拾えない）** | 赤（`event-target-parity` の `markContestedGroup`・`resolveContestedGroup` と、`uppercase-target-id-parity` の同2本、計4本） |
| ADR 0475 の Fake の `FakeEventStore.append`（`event.memoryId.toLowerCase()` を外す） | 緑 | **緑のまま（拾えない）** | 赤（core の `fake-event-target-belongs-to-ctx-tenant.test.ts` の1本。`event-target-parity`・`uppercase-target-id-parity` は緑のまま） |
| ADR 0475 の Postgres の `event-store.ts`（`normalizeUuidCase(event.memoryId)` を外す） | 緑 | **緑のまま（拾えない）** | **緑のまま**（`event-target-parity`・`uppercase-target-id-parity` とも） |

- **拾えないものの理由**【判断。上の実測に基づく】:
  - `checkedRef`（0469 の Postgres 側）: fuzz の `group`／`resolveGroup` の操作は、メンバーの id を変形しない（ADR 0494 の `mu` は `group`・`resolveGroup` に無い）。この変異は `markContestedGroup`・`resolveContestedGroup` に大文字のメンバーを渡したときだけ結果が変わる（固定の歯が実測で赤）。**等価な変異ではない**。`group` に `mu` を足せば届く（下の「残ったこと」）。
  - `FakeEventStore.append`（0475 の Fake 側）: Runtime が `EventStore.append` を呼ぶのは `created` などで、渡す `memoryId` は store が返した小文字の id。操作の引数の綴りが `EventStore.append` まで届かない。**等価ではない**（固定の歯が赤）が、fuzz の操作からは届かない。
  - `PostgresEventStore.append`（0475 の Postgres 側）: **結果が変わらない変異（等価）**【実測】。`normalizeUuidCase` を外しても、`isUuidLike` は大文字小文字を区別せず、`memory_events.memory_id` は uuid 型の列なので、書き込みも返り値も小文字の正規形のまま（固定の歯が、大文字の `memoryId` で `append` したときの保存・返りの小文字を縛っていて、変異を入れても緑）。
- **この ADR で揃えた5つの口**（#1603〔[ADR 0493](./0493-fake-and-inmemory-input-checks-aligned-to-postgres.md)〕が材料に挙げた `excludeMemoryIds`・`vec.delete`・`requeueEmbedJobs`・`restoreSupersededBy`・`outbox.complete`）の変異【実測。InMemory 側の小文字化を1つずつ外した】: いずれも **`uppercase-target-id-parity` が赤**（`digestBand.excludeMemoryIds`・`vs.delete`・`requeueEmbedJobs`・`restoreSupersededBy` 系3本・`outbox.complete`/`fail`）で、**fuzz の `argupper`（leg・差分）は緑のまま**。理由: Runtime が `digestBand.excludeMemoryIds` に渡すのは `recall()` が返した小文字の id、`restoreSupersededBy`・`requeueEmbedJobs`・`outbox.complete` は fuzz の操作に無い、`vec.delete` は `forget`・`purge` が呼ぶが、消えたベクトルは status のゲートで recall に出ないので結果から見えない。claim key の `excludeMemoryId` も同じ（変異で `uppercase-target-id-parity` の2本が赤、fuzz は緑）。

## 足した分の実行時間

【実測】

| ファイル | 足した分 |
|---|---|
| `recall-invariant-fuzz.postgres.test.ts` | 差分（argupper）5.1 秒（Fake・testkit。既定 10 シード）。ファイル全体は 110.1 秒（ADR 0494 の測定では 112.3 秒。実行ごとのばらつきの範囲）。これ以外の既存の leg は変わらない |
| `uppercase-target-id-parity.postgres.test.ts`（51本、実 Postgres） | 約 12 秒（記憶の再作成を口ごとに3実装 × 2回行うので、`resetTestDatabase` が支配的） |
| `fake-uppercase-target-id.test.ts`・`in-memory-uppercase-target-id.test.ts` | それぞれ 9 本、テスト本体は数十ミリ秒（変換時間を含めても 3〜4 秒） |
| core の `recall-invariant-fuzz.test.ts` | 変わらない（`argupper` はもともと core の Fake だけで回していた） |

## 探した形

- **操作 × 変形**（上の表の口 × 小文字／大文字）: Runtime の12口、`MemoryStore` の `get`・`getMany`・`updateStatus`・`setEmbeddingStatus`・`reinforce`・`reinforceMany`・`recordUsage`・`restoreSupersededBy`・`previewRestoreSupersededBy`・`aggregateScope`・`requeueEmbedJobs`・`findActiveByClaimKey`・`findContestedByClaimKey`・`getObservation`・`listBySourceObservation`・`createMemory`（`sourceObservationId`）・`getRecall`、`VectorStore` の `upsert`・`delete`・`deleteAcrossSpaces`・`getVectors`、`RelationStore` の `link`・`unlink`・`listRelated`、`EventStore.list`、`OutboxStore.complete`・`fail`。
- **端の形**: 同じ記憶を綴り違いで2回（`markContested(a, A)`・`forget([a, A])`・`markContestedGroup([a, A, b])`）、`resolveContested` の `winnerId` だけが大文字／対の片方だけが大文字、`restoreArchived([a, A])`、purge 済みの記憶への `purge` の再呼び出し（`already_purged`）、`updateStatus` の `supersededById` が大文字。
- **fuzz の形**: ADR 0494 の `argdead`・`argupper`・`relations` の形（`RunOutcome.shapes` が数える）をそのまま。

## 材料（直していない。決めるのはクローンまたはオーナー）

1. **Runtime が、同じ記憶の2つの綴りを「同じ記憶」と見ない**【実測。3実装で同じ】: `forget({ memoryIds: [a, A] })` は、2つ目を `not_found` と返す（`getMany` が小文字の1件だけ返し、Runtime が渡された綴りで突き合わせるため）。`markContested(a, A)` は `RangeError`（ids must differ）ではなく `ineligible`（2つ目の側が `not_found`）、`markContestedGroup([a, A, b])` も `ineligible`。store を直接呼ぶと、`PostgresMemoryStore`・fixture とも重複を断る（fixture は入口でそろえてから重複を比べる。Postgres も同じ形【現物】だが、Postgres の store を直接呼んだ実測は取っていない＝【未確認】）。Runtime が綴りをそろえてから重複を扱うようにするのは、振る舞いを変える（`RangeError` を新しく投げる等）ので、オーナーの領分。
2. **Runtime の outcome の `memoryId` は、渡された綴りのまま返る**【実測。Postgres でも同じ】。store の行の `id`・積まれるイベントの `memoryId` は小文字。呼び出し側が大文字で渡すと、返り値の `memoryId` と `get()` が返す `id` が綴りで食い違う。直すなら返り値の綴りを変える公開の振る舞いの変更なので、オーナーの領分。
3. **`group`／`resolveGroup` の操作が id を変形しない**（fuzz。ADR 0494 の `mu` は `mark`・`forget` などにだけ付く）。大文字のメンバーを渡す形は固定の歯（`uppercase-target-id-parity`・`event-target-parity`）が見ているが、fuzz の操作の列では見ていない。`group` に `mu` を足すと `relations` か `argupper` の操作列が変わるので、足していない。
4. **既存の4つの歯の `caseInsensitive: false` の側の分岐が、通らないまま残っている**（`uppercase-uuid-lookup`・`uppercase-uuid-store-entry`・`uppercase-uuid-contested-runtime`・`apply-correction-case-and-no-partial-write`）。削除すると各ファイルが大きく変わるので、この ADR では `true` に替えるだけにした。
5. **conformance suite に足せば、外部の adapter 作者にも「大文字の対象 id を同じ記憶として受けるか」を約束させられる**が、約束を足すことはオーナーの領分（ADR 0434 決定5）。この ADR は suite に足していない。個別の歯だけで縛っている。**suite を足さないと縛れない点は無かった**（3実装の突き合わせを、postgres package の個別の試験に置けた）。

## ADR 0493 の材料のうち、どれをこの ADR で閉じたか

ADR 0493（#1603。main に入った）は、形 B（大文字の対象 id）を「ADR 0521 で扱う」として手を付けず、材料1〜5を残した【現物】。**0493 の文書は直していない。**main を取り込んだ後（#1603・#1608 などとの衝突を、`runtime-fakes.ts` の19か所で手で解いた。順序は「`assertWellFormedCtx(ctx)` で不正な ctx を断る → 対象の id を小文字にそろえる → 各口の検査」。Postgres も識別子の検査を入口で行ってから id を扱う）【判断】、上の表が崩れていないことを確かめた【実測】: `uppercase-target-id-parity.postgres.test.ts`（51本）・`fake-uppercase-target-id`・`in-memory-uppercase-target-id`・0493 の歯（`fake-input-checks-round2`・`fake-read-and-claim-input-checks`・`in-memory-input-checks-adr0493`・`input-checks-parity-0493.postgres`）はすべて緑。

| 0493 の材料 | この ADR |
|---|---|
| 1: 形 B を揃えるか（`digestBand.excludeMemoryIds`・`VectorStore.delete`・`deleteAcrossSpaces`・`requeueEmbedJobs`・`restoreSupersededBy`・`previewRestoreSupersededBy`・`onlyMemoryIds`・outbox `complete`・`get`・`getMany`・`updateStatus`・`setEmbeddingStatus`・`reinforce`・`recordUsage`・`createMemory.sourceObservationId`・`VectorStore.upsert` ほか） | **閉じた**（上の表）。`markContestedPair`・`resolveOrphanedContested` は Runtime 経由の間接の確認まで |
| 1 の一部: `markContestedGroup` に同じ id の大文字と小文字が混在 | store の入口でそろえてから重複を比べる形にしたので、store を直接呼ぶと重複を断る（Postgres と同じ形【現物】）。Runtime 経由は3実装とも `ineligible`（下の材料1）。store を直接呼んだ Postgres との突き合わせは未測定 |
| 1 の一部: `EventStore.get` | イベントの id を取る口で、記憶の id ではないので触っていない |
| 2: E13（`filter.status: null`）・3: E14（`FakeLexicalStore` の語）・4: D4（型の外の入力）・5: E4 の `sizeBeforeBytes: NaN` | **閉じていない**（この ADR の範囲外。0493 の判断のまま） |

## 検討した代替案

1. **fixture を揃えず、Postgres を fixture に合わせて大文字を断る**。採らなかった。新しく断る入力で、`@mnemora/postgres` の実装を変える向き（オーナーの領分）。ADR 0446・0469・0475 の向き（落ちる入力が減る側）とも逆。
2. **操作ごとに大文字を許す口・許さない口を決める**。採らなかった。fixture が「操作によって黙って何もしない／例外」と割れていたのが問題で、許可表を持つとさらに割れる。
3. **Runtime で渡された id を入口で小文字にそろえる**。採らなかった。大文字小文字を区別する store（外部の adapter）で別の記憶を指す id を同じとみなしうる（ADR 0446 が退けた案2と同じ理由）。store の `get` に聞く現在の形のまま。
4. **fixture の id の小文字化を、uuid の形のときだけ掛ける**（Postgres の `normalizeUuidCase` と同じ形）。採らなかった。fixture の id は uuid の形ではなく（`mem-N`）、形で分けると何もそろわない。fixture の id は小文字の英数字とハイフンだけなので、一律に小文字にそろえて混ざらない。

## 引き受けた負債

| # | 負債 | 緊急度 |
|---|---|---|
| 1 | 材料1〜2（Runtime 層の綴りの扱い） | 低 |
| 2 | fuzz が `group` 系・5つの口を届かない（上の変異試験の表と材料3）。固定の歯だけが守る | 低 |
| 3 | 既存の4つの歯の死んだ分岐（材料4） | 低 |
| 4 | fixture の「小文字にそろえる」が、小文字以外の id を持つ fixture（外部の adapter の作者が `InMemory*` を継承して id を採番し直す場合）では、別の id を混ぜうる | 低。fixture は id を自分で採番し、`NewMemory` に id の欄は無い。【未確認】継承して使っている利用者の有無 |

## これが覆るとしたら

- fixture が大文字の対象 id を断る側に戻す（Postgres も断る側にする）とオーナーが決めたとき。
- conformance suite に「大文字の対象 id を同じ記憶として受ける」約束を足すと決めたとき（個別の歯を suite に移す）。
- Runtime が綴り違いの重複を扱う約束に改めたとき（材料1）。

## 測っていないこと

- **直したが、Postgres との突き合わせを Runtime 経由の間接でしか見ていない口**: `markContestedPair`・`resolveContestedPair`・`resolveOrphanedContested`・`supersedeWithNewMemories` の `supersede[].id`・`scrubPurged`・`listBySourceObservationAllVersions`・`createMemory` の `supersededById`・`contestedWithId`（store を直接大文字で呼んだ突き合わせは取っていない）。
- `LexicalStore`（id を取る口が無いので触っていない）、`TenantSettingsStore`、`createObservationWithOutbox` の payload の id。
- fixture を継承した外部の adapter（上の負債4）。
- 実 API（LLM・埋め込み）。

## 追記（Issue #1759。クローン miku の判断で、根拠はオーナー回答 374f6f88 の問2。オーナーの判断ではない）: 例外の message の id の綴りの訂正

**上の本文の「Postgres の `memoryNotFound` も小文字にそろえた id を載せる」は、口によって違った。**【実測】Postgres 17 + pgvector（`C.UTF-8`）、main `de41711c`。存在しない大文字の id（`AAAAAAAA-…`）を渡すと、次のようになる。

| 口 | `@mnemora/postgres` の message の id |
| --- | --- |
| 操作の対象が無い: `updateStatus`・`updateStatusWithEvent`・`setEmbeddingStatus`・`reinforce`・`supersedeWithNewMemories` の置き換え対象 | **渡された綴りのまま** |
| 操作の対象が無い: `purgeMemory`・`markContestedPair`・`resolveContestedPair`・`markContestedGroup`・`resolveContestedGroup`・`resolveOrphanedContested` | 小文字 |
| 参照先が無い: `createMemory` の `supersededById`・`contestedWithId`、`updateStatus`・`updateStatusWithEvent` の `supersededById`、`recordUsage` の `memoryIds` | 小文字 |

fixture（`InMemoryMemoryStore`）は、1行目を小文字、3行目を渡された綴りのまま載せていて、Postgres と逆だった。**Postgres の側に揃えた**（fixture の message だけを変えた。例外の種類と、断るかどうかは変えていない）。歯は `packages/postgres/src/__tests__/testkit-fixture-alignment-not-found-spelling-and-decay-floor-null.postgres.test.ts`（同じ入力を2実装へ流す）。core のテスト専用 Fake は変えていない。CHANGELOG `[1.3.0]`・migration-v1 の 🟡。

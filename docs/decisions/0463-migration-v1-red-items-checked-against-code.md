# ADR 0463: 穴探し35巡目 — `docs/migration-v1.md` の 🔴（v1.1.0 → 次の版）の各項目を、現物の実装と歯に突き合わせた記録

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-01

クローン miku の委譲先（担い手。マネージャー mgr-86b4be97 の指示による）が書いた。照合の線はクローン miku が決めた。オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元（PostgreSQL 17）や名指しのテストで走らせた結果、【判断】は担い手の判定。**コードとテストは変えていない（文書だけ）。**

- **文脈**: v1.2.0 を出す前に、利用者が読む移行の手引き（`docs/migration-v1.md` の 🔴「破壊的変更（v1.1.0 → 次の版）—— 未リリース」）が現物と合っているかを、項目 29・31〜51 について、中身（「何が変わったか」「誰が影響を受けるか」「どう直すか」と、そこに書かれた型・例外・フラグ・手順・SQL）まで突き合わせた。
  項目 30 は出荷済みの節にあるので対象外。項目 52 は #1569（ADR 0461）にしか無く、この時点で main に無い。#1569 の枝で読み、下に記録した。前回の ADR 0461 の「項目 29〜51 は識別子・ADR・PR・リンクの実在までの照合」という負債に応える仕事である。

- **照合の方法**（陽性対照つき）:

  1. **主張を1つずつ取り出し、現物（ファイル:行、公開 API の snapshot、conformance suite の `it`、歯のテスト）に当てた。**
  2. **コード片・型・例外名・フラグ名は typecheck にかけた**【実測。`.mgr-notes/r35-snippets/snippets.ts` を `tsc -p` で】: 項目 29・31・35・38・41・42・45・49・50・51 の書き方（`assertWellFormedCtx/Identifier/Filter`、`isMalformedIdentifierError`、`isSourceMemoryStatusChangedError`、`ConsolidateOutcome`/`ReflectOutcome` の `"aborted_source_status_changed"`、`ReflectBasisOutcome` の `status_changed_before_write` と `observedStatus`、`opts.abortIfSuperseded`/`abortIfAllConflicted`、各 suite の `supportsEraseTenant`・`prepareMemoryId`・`prepareRecallId`・`countScopeAggregateQueries`、`supportsMarkContestedGroup`/`supportsResolveContestedGroup`、`eraseTenant(ctx, deps, opts)`、`RuntimeDeps.relationStore`、`purge(ctx, { memoryIds })`、`embed(ctx, [], { signal })`、`z.record` → `z.array(z.object({ key, value }))` の置き換えと `AnthropicLLMProviderError` の `kind`）。通った。
     **陽性対照**: `status_changed_before_write` を1文字欠かし、`prepareRecallId` を `prepareRecallIds` にすると、それぞれ `TS2367`・`TS2561` で赤になった（戻した）。走査が空振りしていない。
  3. **項目 50 の SQL は、migrate 済みの DB で実行した**【実測】: 構文が通り、`purged_at` が入り `tags`・`memory_labels` が残る行を作ると1行、`tags` を空にし `memory_labels` を消すと0行になった（陽性・陰性の対照。作った行は消した）。
  4. **識別子・ADR・PR・リンクの実在は ADR 0461 で済み**、ここでは、PR 番号と中身の対応（#1442・#1444・#1462・#1498・#1452・#1455・#1484・#1492・#1523・#1527・#1457 の件名）も確かめた。

- **項目ごとの照合の結果**（「実走」は名指しのテストを走らせたもの。それ以外は読んだ・grep・snapshot）:

  | 項目 | 照らした主張 | 現物 | 結果 |
  |---|---|---|---|
  | 29 | `RelationStore`（link/unlink/listRelated）、`PostgresRelationStore`・`InMemoryRelationStore`、`describeRelationStoreConformance`を2つの suite が当てる、`markContestedGroup?`/`resolveContestedGroup?`、フラグ `supportsMarkContestedGroup?`/`supportsResolveContestedGroup?`（任意の boolean）、`ContestedGroupMembershipMismatchError`、`contested_group`・`stage: "relation"`、`RuntimeDeps.relationStore?`、migration `0026`、「非破壊に数え直した」の注記 | `interfaces/relation-store.ts:53,122`、`memory-store-conformance.ts:504,518`、`core/src/interfaces/memory-store.ts:86`、`runtime.ts:292,512-531`、`recall.ts:54`、`0026_memory_relations.sql`、`in-memory-fixtures.conformance.test.ts:33`・`conformance.postgres.test.ts:9` | **一部ずれ（直した）**: `RelationStore` の口を `link`/`unlink`/`listRelated` と書き、任意の `listRelatedMany?`（フラグ `implementsListRelatedMany?`）が抜けていた。足した。ほかは合っていた |
  | 31 | `eraseTenant(ctx, deps, opts)`、4つの port の `eraseTenant?`（任意）、4つの suite の `supportsEraseTenant: boolean`（必須）、migration `0027` の8本の索引と埋め込み空間の表の `(memory_id)` の索引、`0028`〜`0032` の索引の定義、`DEFAULT_DIGEST_BAND_LIMIT = 50`、`scopeAggregate`、本数（`v1.1.0` から 0026〜0032 の7本、`v1.0.2` から 0023〜0032 の10本）、項目6 の例に `supportsEraseTenant: false` | `erase-tenant.ts:213`、各 `interfaces/*.ts`（`eraseTenant?`）、各 `*-conformance.ts`（必須）、`0027`〜`0032` の `CREATE INDEX`、`recall.ts:876`、`migration-v1.md:601`。本数は ADR 0461 で `migrations/` の実ファイルと照合済み | 合っていた。deadlock と索引構築の所要時間の数字（ADR 0442・0059・0062・0383・0389 の実測の引用）は再測定していない |
  | 32 | `OpenAIEmbeddingProvider.embed` が件数・`index`・次元・有限性で `OpenAIEmbeddingProvider:` で始まる素の `Error` | `openai/src/embedding-provider.ts`（7箇所）、実走: `embedding-response-validation.test.ts` 11 本が緑 | 合っていた（実走） |
  | 33 | embed ジョブは `upsert` の前、recall は問い合わせベクトルを使う前に、長さと有限性を検査、`stage_skipped`・`candidate_generation`・`embedding_provider_unavailable`、`RecallQuery.vector` 直渡しと `VectorStore` 直呼びは検査しない | `runtime.ts` の `processEmbedJob`（長さ・有限性）、`recall-runtime.ts`（`QueryEmbeddingFailure`）。#1565 で型付き配列も受けるようになったが、この項目の主張とは食い違わない | 合っていた |
  | 34 | `RelationStore.link` が両端を確かめ、`PostgresRelationStore:`/`InMemoryRelationStore:` で始まる `memory not found for tenant` を含む `Error`、`Runtime` は `link`/`unlink` を呼ばない、`prepareMemoryId` | `postgres/src/relation-store.ts:17`、`in-memory-relation-store.ts:44`、`core/src/*.ts` に `.link(`/`.unlink(` の呼び出しが無い、`relation-store-conformance.ts` の `prepareMemoryId` | 合っていた |
  | 35 | `AnthropicLLMProvider.completeStructured` が `messages.create` の前に `kind: "schema_unsupported"` の `AnthropicLLMProviderError`、core の4つの LLM スキーマに `z.record` は無い、`z.lazy`・`default`・根が union は送る、`@mnemora/openai` は元から落とす | `anthropic/src/llm-provider.ts:297`、実走: `structured-output-zod-shapes.test.ts`・`core-schemas-send-shape.test.ts`・`provider-parity.test.ts` の3ファイル 44 本が緑。core の `z.record` は `observation.ts`・`event.ts`・`attributes.ts`・`outbox.ts`・`recall.ts`（LLM に送るスキーマの外） | 合っていた（実走） |
  | 36 | 対象の suite と口（`unlink`、kind 付き `listRelated`、`complete`・`fail`、`eraseTenant?`（`dryRun`）、`purgeCompletedJobs?`、`getDefaultHalfLifeHours`、`hasSubjectActivityCounters?`）、「新しい `it` はフラグ無しで走る」 | `relation-store-conformance.ts:145-171`、`outbox-store-conformance.ts:457,481,832,846,1099,1124`、`tenant-settings-store-conformance.ts:183,472,590` | **ずれ（直した）**: 「フラグ無しで走る／フラグでは避けられない」は、`unlink`・kind 付き `listRelated`・`complete`・`fail`・`getDefaultHalfLifeHours` の分だけ正しい。`eraseTenant?` の分は `if (supportsEraseTenant)`（`outbox-store-conformance.ts:755`・`tenant-settings-store-conformance.ts` 544 付近）の内側、`purgeCompletedJobs?` の分は `supportsPurgeCompletedJobs === true`（同 930）の内側、`hasSubjectActivityCounters?` の分は `if (advanceSubjectActivitySeq)` のフックの枝の内側にあり、その口を持たない実装には当たらない。影響範囲を過大に書いていた。その形に直した |
  | 37 | `reinforce` の後に `memory_events` が増えない、`reinforceMany?` もあれば同じ（フラグ無し） | `memory-store-conformance.ts:3677,3696` | 合っていた |
  | 38 | `aggregateScope(..., { scopeAggregate: "skip" })` の結果（`groups` 空・`totalInScope` 0・`countKind: "unknown"`・`filtered*`・`notIndexed.*`・`digestEligible`）、省略と `"exact"` が同じ、任意のフック `countScopeAggregateQueries`、`recall.ts` の旧い文面の訂正 | `memory-store-conformance.ts:10143,10165,10203,10214`、`recall.ts:2033`（訂正済み）、`docs/recall.md:678` | 合っていた（型は snippets で通った） |
  | 39 | `supportsListActiveClaimPredicates: true` の枝に同着の `it` が3本、`claim_key_predicate COLLATE "C" ASC`、フラグで避けられる | `memory-store-conformance.ts:2848,2866,2892`、`postgres/src/memory-store.ts:3564` | 合っていた |
  | 40 | `createObservationWithOutbox` の `opts.claimedBy`（claim 済み・`attempts: 1`／省略で未 claim・`attempts: 0`）の `it` が2本、フラグ無し | `memory-store-conformance.ts:1170,1188` | 合っていた |
  | 41 | `MalformedIdentifierError`（`kind: "malformed_identifier"`）、`isMalformedIdentifierError`、`assertWellFormedCtx/Identifier/Filter`、`Runtime` の全メソッドの入口、7つの suite に `it`、対をなすサロゲートは通る、`observe` の `externalId`、本文は断らない | `core/src/identifier.ts:29,51`、snapshot、実走: `runtime-identifier-well-formed.test.ts`・`identifier-helpers.test.ts` の 25 本が緑（`公開の全メソッドが ctx.tenantId を断る` ほか）。7つの `*-conformance.ts` が malformed のケースを使う | 合っていた（実走） |
  | 42 | `consolidate`/`reflect` の `aborted_source_status_changed`、`status_changed_concurrently`（`observedStatus`）・`not_attempted`・`atomicity: "not_attempted"`、`status_changed_before_write`、`abortIfSuperseded`・`abortIfAllConflicted`、`SourceMemoryStatusChangedError`、行ロックの下の見直し | snapshot、`consolidate-reflect-superseded-race.postgres.test.ts`（実走: 28 本が緑。`atomicity`・各 `kind`・全件 archived の打ち切り・部分成功は consolidated のまま） | 合っていた（実走） |
  | 43 | `OutboxStore` の4件（`opts.at` が Invalid Date／`opts.at` の複製／`fail` の NUL を `\u0000` に／`peekJob` の条件）、`RelationStore` の2件（列挙外の `kind` は `relation kind` を含む例外／`createdAt` の複製）、`PostgresRelationStore: unknown relation kind: <kind>` | `outbox-store-conformance.ts:304,320,346`、`relation-store-conformance.ts:262`、`postgres/src/relation-store.ts:30` | 合っていた |
  | 44 | float4 の文面 `does not fit in a Postgres "real" (float4) column`、`unlink`/`listRelated` の uuid でない id、3つの suite の `it` | `postgres/src/half-life-float4.ts:15`（0 になる値も断る）、`relation-store-conformance.ts:105,118`、`tenant-settings-store-conformance.ts:367` | 合っていた |
  | 45 | `OpenAIEmbeddingProvider.embed`・`LocalEmbeddingProvider.embed` が abort 済みなら空配列でも `signal.reason` で reject | 実走: `openai/src/__tests__/abort-signal.test.ts`（6本）・`local-embedding/src/__tests__/abort-signal.test.ts`（4本）が緑。`rejects.toBe(` で reason の同一性まで | 合っていた（実走） |
  | 46 | NFC + trim で同じ `content` を一致に数えない、`findActiveByClaimKey?`・`findContestedByClaimKey?` | `runtime.ts:4665` 付近、実走: `claim-key-normalized-equal-not-contested.test.ts` が緑 | 合っていた（実走） |
  | 47 | `packDigestBand` の書記素切り、`maxEntryChars` の単位は UTF-16、最初の書記素だけで上限超なら空文字列、`DIGEST_BAND_ENTRY_FIXED_OVERHEAD_CHARS` | `core/src/text-truncation.ts:47-67`（`Intl.Segmenter`）、実走: `digest-band.test.ts`（27 本の一部。`ZWJ`・空文字列・ASCII の対照）が緑 | 合っていた（実走） |
  | 48 | lexical の NUL 検索語（`query` と NUL を名指し）、vector の `upsert` の `1e308`（`RangeError`・`float4`）と `search` は投げず比較不能、memory の `contentHash` の NUL、3つの suite にフラグ無しの `it`、`createMemoriesWithOutboxAndEvents` は該当候補だけ `dropped` | `lexical-store-conformance.ts:742`、`vector-store-conformance.ts:1280,1299`、`memory-store-conformance.ts:13544`、`postgres/src/input-check.ts:20-34`・`lexical-store.ts:323`・`memory-store.ts:732,796,1342`。実走: `read-scope-filter-nul.postgres.test.ts`・`repurge-legacy-residue.postgres.test.ts` が緑 | 合っていた |
  | 49 | `EventStore.append`・`VectorStore.upsert` の検査、メッセージの接頭辞、`prepareMemoryId(ctx)`、`events_purged`（`memoryId` null）は検査しない、`eraseTenant` の `blocked_by_foreign_reference` | ADR 0436、`erase-tenant.ts:44-47`、snippets の `prepareMemoryId`（`EventStoreConformanceOptions`・`VectorStoreConformanceOptions`）が通った | 合っていた |
  | 50 | `subjectIds[i]`・`record.advanceActivityClock.subjectId` の `MalformedIdentifierError`、公開ヘルパー9本の `params:` 落とし、`scrubPurged?`、`purge` が `already_purged` で呼ぶ、`runtime.purge(ctx, { memoryIds })`、SQL | `postgres/src/tenant-settings-store.ts:211`、`memory-store.ts:2821`、`runtime.ts:2021-2047`、snapshot（`purge(ctx, target: PurgeTarget)`。`{ memoryId }`・`{ memoryIds }` の両方を受ける `runtime.ts:6880`）、SQL を実行（上の方法 3） | 合っていた（SQL は実走。陽性・陰性の対照） |
  | 51 | 口 × 欄 × 主語の表、`prepareRecallId`、9本の `it` | `postgres/src/memory-store.ts:287-296`（`${kind} not found for tenant`）、`memory-store-conformance.ts` の ADR 0439 の `it` 9本（12338〜12784）、snippets の `prepareRecallId` | 合っていた |
  | 52（#1569） | H4 の9つの口が書く前に `event.memoryId` を確かめる、一致なら問い合わせない、`null`/`undefined` は確かめない、断るメッセージは `PostgresMemoryStore: memory not found for tenant: <id>`、uuid でない id は以前も落ちていた、conformance は変えていない | `postgres/src/memory-store.ts:319-340`（`assertEventTargetInTenant`）、呼び出し 223・1239・1460・3117・3349・3694・3779、群は `insertMemoryEventsBatch`（464〜）が1文で確認 | 合っていた。**確かめていないこと**とした `InMemoryMemoryStore` について、下の「実装の側で気になったこと」の測定結果を得た |

- **直した文書**（`docs/migration-v1.md` の 2 か所だけ）: 項目 29（`listRelatedMany?` を足した）、項目 36（影響範囲の記述を、フラグ無しで走る `it` と、フラグ・フックの枝の内側の `it` に分けた）。

- **実装の側で気になったこと**（直していない）:

  - **`InMemoryMemoryStore` は、別テナントの記憶を指す `NewMemoryEvent.memoryId` を断らない**【実測。`.mgr-notes/r35-inmem-h4.mts`】: `updateStatusWithEvent(A, a.id, "archived", {}, event)` に、B の記憶を指す `event.memoryId` を渡すと受け入れられた（`@mnemora/postgres` は ADR 0456 の H4 で断る）。ADR 0456 の M7（確かめていない）の答え。fixture が新しく例外を投げる変更は破壊的と数えない規律の下で、直すかどうかはクローンの判断。
  - 手元の Postgres で、upgrade の歯の `afterAll` が `DROP DATABASE` の checkpoint 待ちで時間切れになる件は、ADR 0414・0461 のとおり環境の遅さ。

- **検討した代替案**:

  1. **項目 36 の「避けられない」の記述をそのまま残し、注記だけ足す。** 採らなかった。影響範囲の記述が過大だと、フラグを渡していない利用者が不要に身構える。
  2. **項目 52 を直す。** 直す点が無かった。測定結果（InMemory は断らない）を、#1569 のマージ後に項目 52 の「確かめていないこと」へ反映するかは、マネージャーの指示を待つ。

- **引き受けた負債**:

  - 引用した実測（deadlock・索引の構築時間・`eraseTenant` の時間・各 ADR の測定）は再測定していない。ask_human の ID の指す回答、Issue・PR の本文の中身も、リンク先の実在と件名までしか見ていない。
  - 照合はこのコミット（main `5e7f1c2b`）時点。CHANGELOG の `### Breaking` の各箇条との文面の一致は、項目番号の対応（ADR 0461）までで、箇条の中身は読み比べていない。
  - Postgres の conformance 全体（`conformance.postgres.test.ts`）は走らせていない（CI が走らせる）。名指しで走らせたのは上の表に書いた歯。

- **これが覆るとしたら**: 🔴 の項目の書き方が変わったとき（番号の振り直し、項目の統合）。項目の根拠の ADR・PR が変わったとき。

- **測っていないこと**: 項目 31 の索引の構築時間・deadlock の頻度、`@mnemora/postgres` の conformance 全体、実 API。

# `v1.2.0` の Release 本文（草稿）

**担い手（Claude）が CHANGELOG から起こした草稿。オーナーが書いたものではない。載せ方の最終判断と Release の作成はオーナーが行う。**

⛔ **この文書は Release を作る手順ではない。「Release を作るときに GitHub の本文へ貼るテキスト」の草稿である。**

| | |
|---|---|
| **正はどれか** | ⛔ **この草稿ではない。**変更の一覧と根拠の PR/Issue/ADR は [`CHANGELOG.md`](../CHANGELOG.md) の `## [1.2.0] - 2026-10-02` 節（**`v1.1.0`（`5eb6e9d`）… `d49c46c`** を数えたもの）が正。破壊的変更の定義と移行手順は [`migration-v1.md`](./migration-v1.md) の「🔴 破壊的変更（v1.1.0 → v1.2.0）」と「🟡 v1.1.0 → v1.2.0」の節が正 |
| **なぜ複製するか** | Release 本文を読むのは repo の外に居る採用者であり、リンクだけでは伝わらない。⟹ 複製を許す代わりに、この表を必ず添える |

🔴 **⛔ この草稿に、`v1.2.0` の変更の総件数を書かないこと**（[ADR 0234](./decisions/0234-bake-no-numbers-into-tools-and-artifacts.md)）。本文に出る件数は、CHANGELOG / `migration-v1.md` の見出しが自分で名乗っている数（マイグレーションの本数・`### Breaking` の項目数）だけである。

## 貼る前に確かめること

1. **CHANGELOG `[1.2.0]` 節が数えた範囲の末尾が、まだ `d49c46c` か。**`grep -n '数えた基準を明記する' -A2 CHANGELOG.md` で当日引き直すこと。動いていたら、動いた分だけこの草稿に漏れがある。
2. **`packages/postgres/migrations/` の最後尾が、まだ `0032_purge_indexes.sql` か。**`ls packages/postgres/migrations | tail -1`。
3. **`v1.1.0` より新しい Release が切られていないか。**`gh release list --limit 5`・`git tag -l "v1.*"`。
4. **リンクが生きているか。**`grep -oE '(issues|pull)/[0-9]+' docs/release-notes-v1.2.0.md | sort -u` の各番号を `gh api repos/takecchi/mnemora/issues/<n> -q .number` で、ADR は `docs/decisions/<file>` の実在で確かめる（起こした時点では全部通った）。

## 草稿（ここから下を貼る）

> ## mnemora v1.2.0
>
> この版は **`v1.1.0`** からの差分です。変更の一覧とそれぞれの根拠 PR/Issue/ADR は [CHANGELOG.md](https://github.com/takecchi/mnemora/blob/main/CHANGELOG.md) の `[1.2.0]` 節が正です。**`v1.0.x` から直接この版へ上げる方は**、同じファイルの `[1.1.0]` 節（`v1.0.1` 以前からなら `[1.0.2]`・`[1.0.1]` 節も）を合わせて読んでください。
>
> ### 🔴 まず
>
> - **postgres を使っている方へ**: `v1.1.0` からマイグレーションが7本増えています（`0026`〜`0032`）。`mnemora-postgres-migrate`（または `runMigrations`）を実行してください。`v1.0.2` から上げる場合は `0023`〜`0032` の10本、`v1.0.1` からは `0022`〜`0032` の11本、`v1.0.0` からは `0019`〜`0032` の14本が要ります。既存の `0001`〜`0025` は変わっていません。
>   - `0026_memory_relations.sql`：多者間 `contested` の関係グラフの表 `memory_relations` を新設します（[PR #1442](https://github.com/takecchi/mnemora/pull/1442)）。既存のデータは動かしません。
>   - `0027_erase_tenant_fk_indexes.sql`：外部キー検査用の単一列索引8本と、既存の `memory_embeddings_<space>` 表への `(memory_id)` 索引を張ります（[PR #1444](https://github.com/takecchi/mnemora/pull/1444)、[ADR 0383](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0383-erase-tenant.md)）。
>   - `0028_digest_band_index.sql`：`memories` に目次帯用の部分索引を張ります（[PR #1455](https://github.com/takecchi/mnemora/pull/1455)、[ADR 0384](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0384-digest-band-index-and-scope-aggregate-skip.md)）。
>   - `0029_memories_claim_predicates_index.sql`：`memories` に `listActiveClaimPredicates` 用の部分索引を張ります（[PR #1457](https://github.com/takecchi/mnemora/pull/1457)）。
>   - `0030_recalls_digest_band_index.sql`：`recalls` に目次帯の式 GIN 索引を張ります（[PR #1459](https://github.com/takecchi/mnemora/pull/1459)、[ADR 0389](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0389-recalls-digest-band-index.md)）。
>   - `0031_memory_labels_label_id_index.sql`：`memory_labels (label_id)` の索引を張ります（[PR #1477](https://github.com/takecchi/mnemora/pull/1477)、[ADR 0400](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0400-general-fk-index-tooth.md)）。
>   - `0032_purge_indexes.sql`：`recalls` と完了済みの `outbox` の purge 用の索引2本を張ります（[PR #1497](https://github.com/takecchi/mnemora/pull/1497)、[ADR 0412](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0412-purge-target-select-indexes.md)）。
>   - ⚠ **7本とも1ファイル1トランザクションの中で走り、`CONCURRENTLY` は使いません。**索引を作るあいだ、対象の表への書き込みは `ShareLock` で止まります（読み取りは通ります）。**いちばん長いのは `0030` です**：既定の目次帯（50件）で使ってきた `recalls` では、【実測】10万行あたり約25秒・索引約381MB です（100万行は未測定。[ADR 0389](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0389-recalls-digest-band-index.md) の追記）。
>   - ⚠ **`0027` は、アプリの書き込みを止めてから当ててください。**`observe`・`recall`・`tick` を動かしたまま当てると、【実測】5回中4回で deadlock（`40P01`）しました（[ADR 0442](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0442-migrate-deadlock-subject-injection-ddl-lock-wait-docs.md)、[docs/migration-v1.md](https://github.com/takecchi/mnemora/blob/main/docs/migration-v1.md) の項目31）。
>   - `v1.0.2` 以前から上げる場合は、`v1.1.0` の注意（`0025` の適用中は `memories` への読み書きが `ACCESS EXCLUSIVE` で止まる）も当てはまります。
>
> ### 🔴 破壊的変更
>
> CHANGELOG の `### Breaking` の項目ごとに1行で挙げます。多くは「自前の store・provider を実装して `@mnemora/testkit` の conformance suite に当てている方」か「型の外の値・壊れた値を渡していた方」にだけ当たります。
>
> - **識別子（`tenantId`・`subjectId`・`observe` の `externalId`）に孤立サロゲートか NUL（U+0000）を含む値を、書き込みの前に `MalformedIdentifierError`（`kind: "malformed_identifier"`）で断るようになりました。**以前は実装によって U+FFFD への置き換え・DB の生の例外・素通りと扱いが割れていました。こうした値を渡しうる方と、自前の store を conformance suite に当てている方が影響を受けます（[PR #1520](https://github.com/takecchi/mnemora/pull/1520)、[ADR 0423](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0423-identifier-well-formed-and-error-message-without-params.md)）。
> - **テナント単位で全表から行を消す独立関数 `eraseTenant` と、4つの port の任意メソッド `eraseTenant?` が増え、conformance suite に省略できないフラグ `supportsEraseTenant: boolean` が増えました。**conformance suite を呼んでいる方は、このフラグを渡すまで型検査に落ちます（[Issue #1207](https://github.com/takecchi/mnemora/issues/1207)、[PR #1444](https://github.com/takecchi/mnemora/pull/1444)、[ADR 0383](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0383-erase-tenant.md)）。
> - **`@mnemora/openai` の `OpenAIEmbeddingProvider.embed()` が、応答の件数・`index`・次元・成分の有限性を検査し、崩れていれば `OpenAIEmbeddingProvider:` で始まる `Error` を投げるようになりました。**以前は食い違った応答が素通りしていました（[PR #1462](https://github.com/takecchi/mnemora/pull/1462)、[Issue #860](https://github.com/takecchi/mnemora/issues/860)、[ADR 0305](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0305-embedding-provider-input-limit-contract.md) の追記）。
> - **`@mnemora/core` が、provider の返す埋め込みの長さ（`space.dimensions`）と成分の有限性を確かめるようになりました。**次元違い・`NaN`/`Infinity` を含む embed ジョブは失敗になり、recall では同じ問い合わせベクトルが `embedding_provider_unavailable` になります。インメモリ・Fake の経路でこれまで `'ready'` で保存されていたものが `failed` になります（[PR #1463](https://github.com/takecchi/mnemora/pull/1463)、[Issue #860](https://github.com/takecchi/mnemora/issues/860)、[ADR 0393](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0393-core-checks-embedding-dimension.md)）。
> - **`RelationStore.link` が、両端の記憶が `ctx` のテナントに属さない（または実在しない）ときに例外を投げるようになりました。**自前の `RelationStore` を実装している方と、そうした呼び出しをしていた方が影響を受けます（[PR #1474](https://github.com/takecchi/mnemora/pull/1474)、[ADR 0398](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0398-relation-store-link-checks-both-ends-belong-to-ctx-tenant.md)）。
> - **`@mnemora/anthropic` の `completeStructured` が、`z.record` を含むスキーマを、送る前に `kind: "schema_unsupported"` の `AnthropicLLMProviderError` で落とすようになりました**（[PR #1483](https://github.com/takecchi/mnemora/pull/1483)、[ADR 0360](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0360-schema-unsupported-thrown-before-send.md) の追記）。
> - **`describeRelationStoreConformance`・`describeOutboxStoreConformance`・`describeTenantSettingsStoreConformance` が、別テナントの ctx からの呼び出しがそのテナントの行に触れない・見えないことを、より多くの口で検査するようになりました。**`@mnemora/postgres` の実装は変わっていません。自前の実装を当てている方が影響を受けます（[PR #1498](https://github.com/takecchi/mnemora/pull/1498)）。
> - **`describeOutboxStoreConformance`・`describeRelationStoreConformance` が、adapter 間の食い違い4点（`complete`/`fail` の Invalid Date の `opts.at`、`fail` の `error` の NUL、列挙の外の relation `kind` など）を検査するようになりました。**自前の `OutboxStore`/`RelationStore` を当てている方が影響を受けます（[PR #1517](https://github.com/takecchi/mnemora/pull/1517)）。
> - **`describeMemoryStoreConformance` が、自前の `MemoryStore` に4つの約束を新しく課すようになりました**——`reinforce`/`reinforceMany?` が `memory_events` を書かないこと、`aggregateScope` が `scopeAggregate: 'skip'` を守ること、`createObservationWithOutbox` が `opts.claimedBy` を守ること（この3つはフラグ無しで走ります）、`listActiveClaimPredicates?` の同着の並び（`supportsListActiveClaimPredicates: true` のときだけ）です（[PR #1452](https://github.com/takecchi/mnemora/pull/1452)・[PR #1455](https://github.com/takecchi/mnemora/pull/1455)・[PR #1484](https://github.com/takecchi/mnemora/pull/1484)・[PR #1492](https://github.com/takecchi/mnemora/pull/1492)）。
> - **DB の生の例外で失敗していた3つの入力が、明示の扱いになりました**：`@mnemora/postgres` は float4 に収まらない `halfLifeHours`・`halfLifeRecalls` を DB へ渡す前に断り、`@mnemora/openai`・`@mnemora/local-embedding` の `embed()` は abort 済みの `signal` なら空配列でも reject し、`RelationStore.unlink`/`listRelated` は uuid の形でない id を「存在しない id」と同じに扱います。conformance suite の `it` も増えました。DB の生の例外の文言で捕まえていた方が影響を受けます（[PR #1525](https://github.com/takecchi/mnemora/pull/1525)）。
> - **`runtime.consolidate`・`runtime.reflect` が、材料が superseded になったときと、統合元がすべて CAS に弾かれたときに、統合先・内省を書かずに `outcome: 'aborted_source_status_changed'` で打ち切るようになりました。**outcome を網羅的に分岐している方と、自前の `MemoryStore` を実装している方が影響を受けます（[ADR 0420](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0420-consolidate-reflect-abort-on-superseded-and-all-conflicted.md)、[PR #1523](https://github.com/takecchi/mnemora/pull/1523)）。
> - **contested の検出が、NFC と NFD の違いや前後の空白だけが違う同じ `content` を矛盾と判定しなくなりました**（[ADR 0424](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0424-normalized-content-comparison-and-boundary-conformance.md)、[PR #1527](https://github.com/takecchi/mnemora/pull/1527)）。
> - **`packDigestBand` が、1件の digest を書記素の境界で切り詰めるようになりました。**以前は UTF-16 コードユニットで切っており、NFD の濁点や ZWJ で繋いだ絵文字が壊れていました。目次帯の文字列が変わりえます（[ADR 0424](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0424-normalized-content-comparison-and-boundary-conformance.md)、[PR #1527](https://github.com/takecchi/mnemora/pull/1527)）。
> - **conformance suite に入力の境界の `it` が増え、`@mnemora/postgres` は DB の生の例外の代わりに明示の例外を投げるようになりました。**自前の store を当てている方と、生の例外の文言に頼っていた方が影響を受けます（[ADR 0424](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0424-normalized-content-comparison-and-boundary-conformance.md)、[PR #1527](https://github.com/takecchi/mnemora/pull/1527)）。
> - **`EventStore.append`・`VectorStore.upsert` が、記憶が `ctx` のテナントに属さない（または実在しない）ときに例外を投げるようになりました**（[PR #1543](https://github.com/takecchi/mnemora/pull/1543)、[ADR 0436](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0436-event-vector-write-checks-memory-belongs-to-ctx-tenant.md)）。
> - **`TenantSettingsStore.getSubjectActivitySeqs` の `subjectIds` と、`MemoryStore.createRecall` の `advanceActivityClock.subjectId` も、孤立サロゲートか NUL を含む値を `MalformedIdentifierError` で断るようになりました**（[PR #1545](https://github.com/takecchi/mnemora/pull/1545)、[ADR 0437](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0437-helpers-params-subject-ids-repurge.md)、[ADR 0423](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0423-identifier-well-formed-and-error-message-without-params.md)）。
> - **`MemoryStore` の書き込み口が、別の行を指す参照（`recallId`・`sourceObservationId`・`contestedWithId`・`supersededById` など）の参照先が `ctx` のテナントの行でないとき、行を書かずに例外を投げるようになりました**（[PR #1549](https://github.com/takecchi/mnemora/pull/1549)、[ADR 0439](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0439-memory-store-reference-writes-check-target-belongs-to-ctx-tenant.md)）。
> - **型の外の入力を、5つの口で新しく例外で断るようになりました**：`findCorrectionCandidates`、`resolveContested`・`resolveContestedGroup`・`applyCorrection`（未知の `resolution.kind`）、`tick`（`opts`・`leaseMs`）、`decayFloorOffset`・`floorAt`（壊れた数値）、`observe`・`recall` の `attributes`（キー `__proto__`）です。TypeScript の型どおりに呼んでいる限り何も変わりません（[PR #1608](https://github.com/takecchi/mnemora/pull/1608)、[ADR 0496](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0496-core-entry-rejections-adr-0446-0445-0472-0474-0485.md)）。
> - **差し替えた `TokenCounter` が、有限で 0 以上でない `tokens` か壊れた戻り値を返すと、`recall()` が `RangeError` で断るようになりました。**以前は予算が黙って外れていました。自前の `TokenCounter` を `createRuntime` に渡している方が影響を受けます（[PR #1604](https://github.com/takecchi/mnemora/pull/1604)、[ADR 0497](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0497-recall-rejects-broken-token-counter.md)）。
> - **provider のコンストラクタ（`@mnemora/openai`・`@mnemora/anthropic`・`@mnemora/local-embedding`）と `createBullmqTickDriver`（`@mnemora/bullmq`）が、壊れた数値オプションを構築時に例外で断るようになりました**（[PR #1606](https://github.com/takecchi/mnemora/pull/1606)、[ADR 0498](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0498-constructor-config-checks.md)、[ADR 0477](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0477-bullmq-tick-driver-everyms-jobname-queuename-not-checked.md)、[ADR 0467](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0467-recall-footprint-nonfinite-inputs-fallback-digest-grapheme.md)）。
> - **`@mnemora/postgres` の `MemoryStore` の書き込み口が、`NewMemoryEvent.memoryId` が `ctx` のテナントの記憶でないイベントを断るようになりました**（[PR #1562](https://github.com/takecchi/mnemora/pull/1562)、[ADR 0456](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0456-llm-returned-values-malformed-read-filter-nul-named.md) の H4）。
> - **`@mnemora/openai` の `completeStructured` が、応答の `"__proto__"` の欄の中身を継承された値として読まなくなり、それで通っていた応答が `ZodError` になる場合があります**（[PR #1576](https://github.com/takecchi/mnemora/pull/1576)、[ADR 0468](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0468-openai-null-strip-copies-own-proto-key-as-own-property.md)）。
>
> 移行の手順は [docs/migration-v1.md](https://github.com/takecchi/mnemora/blob/main/docs/migration-v1.md) の「🔴 破壊的変更（v1.1.0 → v1.2.0）」の節（項目29・31〜56）を見てください。
>
> ### 新機能
>
> - **多者間（3件以上）の `contested` を表す関係グラフ `memory_relations` と、それを書く・読む口（`RelationStore`）が増えました。**1つの記憶が複数の記憶と同時に争われる場合を表せます（[Issue #207](https://github.com/takecchi/mnemora/issues/207)/[Issue #933](https://github.com/takecchi/mnemora/issues/933)、[PR #1442](https://github.com/takecchi/mnemora/pull/1442)、[ADR 0381](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0381-contested-group-write-path-implementation.md)）。
> - **テナント単位で全表から行を消す `eraseTenant`**（上の破壊的変更を参照。[ADR 0383](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0383-erase-tenant.md)）。
> - **古い `recalls` と完了済みの `outbox` 行を消す任意メソッド `MemoryStore.purgeExpiredRecalls?`・`OutboxStore.purgeCompletedJobs?`。**保持期間の既定値は無く、呼び出し側が `olderThan` と `limit` を渡します（[ADR 0404](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0404-purge-expired-recalls-and-completed-outbox-jobs.md)、[PR #1479](https://github.com/takecchi/mnemora/pull/1479)）。
> - **`RecallQuery.scopeAggregate?: "exact" | "skip"`**：`recall()` のたびに走る件数集計を、明示的に選んだときだけ止められます（[PR #1455](https://github.com/takecchi/mnemora/pull/1455)、[ADR 0384](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0384-digest-band-index-and-scope-aggregate-skip.md)）。
> - **`RecallQuery.relationMaxCount?`**：多者間の `contested` 群の同伴取得の上限件数を変えられます。省略すると従来の10のままです（[Issue #1449](https://github.com/takecchi/mnemora/issues/1449)、[PR #1470](https://github.com/takecchi/mnemora/pull/1470)、[ADR 0396](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0396-recall-relation-max-count.md)）。
> - **`RelationStore.listRelatedMany?`**：幅優先探索の1段を1往復で読みます（[Issue #1449](https://github.com/takecchi/mnemora/issues/1449)、[ADR 0402](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0402-relation-store-list-related-many.md)）。
> - **recall の埋め込みが失敗したときの `stage_skipped` に、原因の種類を返す任意の欄 `cause`**（`provider_threw`・`no_vector`・`dimension_mismatch`・`non_finite`。[PR #1504](https://github.com/takecchi/mnemora/pull/1504)）。
> - **抽出の言語の事後検査**：日本語の観測からラテン文字だけの本文が出たら、`created` イベントの `meta.languageMismatch` に印を付けます（[Issue #1370](https://github.com/takecchi/mnemora/issues/1370)、[ADR 0391](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0391-language-mismatch-mark-on-created-event.md)）。
> - **`createOptionalTrigramIndexConcurrently(db)`**（`@mnemora/postgres`）：trigram の索引を `CREATE INDEX CONCURRENTLY` で、書き込みを止めずに張ります（[PR #1457](https://github.com/takecchi/mnemora/pull/1457)、[ADR 0319](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0319-optional-trigram-lexical-store.md)）。
> - **`LocalEmbeddingProvider.dispose()`**：読み込んだ ONNX のモデルを手放します（[ADR 0419](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0419-local-embedding-provider-dispose.md)）。
> - **`runtime.purge` の outcome に任意の欄 `embeddingCleanup?`・`residueCleanup?`**：後始末が失敗したときだけ付きます（[PR #1475](https://github.com/takecchi/mnemora/pull/1475)、[ADR 0399](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0399-purge-embedding-cleanup-outcome-field.md)、[ADR 0437](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0437-helpers-params-subject-ids-repurge.md)）。
>
> ### 挙動が変わるもの・主な修正
>
> - **入力側の公開型の任意欄が `?: T | undefined` になりました。**`exactOptionalPropertyTypes: true` でも `undefined` を渡せます（[ADR 0429](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0429-exact-optional-property-types-input-types.md)）。
> - **`Runtime` が投げ直す例外の message から、SQL に付けた値（params）を落とすようになりました**（[ADR 0423](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0423-identifier-well-formed-and-error-message-without-params.md)、[Issue #1064](https://github.com/takecchi/mnemora/issues/1064)）。
> - **`@mnemora/bullmq` の tick driver が、`runtime.tick()` の失敗と `Queue` 側の `'error'` も `onTickError` に渡すようになりました。**`onTickError` を渡している方は通知が増えることがあります。
> - **`recall()` が、検索のあとに archived・forgotten になった記憶を返すことがあったのを直しました**（[ADR 0432](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0432-recall-status-recheck-and-archive-docs.md)）。
> - **抽出が、記憶を書いたのに `created` イベントが0件のまま残る取りこぼしを塞ぎました**（[ADR 0410](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0410-extract-created-event-in-same-transaction.md)）。
> - **`@mnemora/postgres`：同じ語彙を逆の並びで `tags` に持つ記憶を同時に作ると `deadlock detected`（40P01）で落ちたのを直しました**（[ADR 0476](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0476-label-upsert-lock-order-and-taxonomy-probes.md)）。
> - **`@mnemora/postgres`：Postgres の再起動を数回挟むと pool が枯れる穴を塞ぎ、トランザクションの `rollback` が失敗しても元のエラーが投げられるようにしました**（[PR #1555](https://github.com/takecchi/mnemora/pull/1555)、[ADR 0444](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0444-pool-begin-release-rollback-error-preserved.md)）。`Failed query: rollback` の文面に頼っていた方は見直してください。
> - **`runMigrations`（と `mnemora-postgres-migrate`）が、台帳と手元の `migrations/` が食い違うとき警告を出すようになりました**（[ADR 0425](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0425-migrate-warns-on-ledger-drift.md)）。
> - **`v1.1.0` より前に purge した行に残っていた `tags`・`attributes`・claim key・`memory_labels` が、purge をかけ直すと消えるようになりました**（[ADR 0437](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0437-helpers-params-subject-ids-repurge.md)）。
> - **`@mnemora/core`・`@mnemora/postgres` は TypeScript の `lib`・`target` に ES2022 以上を要します**（README に明記しました。コードは変わっていません。[ADR 0441](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0441-changelog-migration-refs-consumer-smoke-names.md)）。
>
> ほかの変更・修正の全体は [CHANGELOG.md](https://github.com/takecchi/mnemora/blob/main/CHANGELOG.md) の `[1.2.0]` の `### Changed`・`### Fixed` を、手順は要らないが気づいておくとよい振る舞いの変化は [docs/migration-v1.md](https://github.com/takecchi/mnemora/blob/main/docs/migration-v1.md) の「🟡 v1.1.0 → v1.2.0」の節を見てください。
>
> 上げる前に、[docs/migration-v1.md](https://github.com/takecchi/mnemora/blob/main/docs/migration-v1.md) で、自分に当たる項目と手順を確かめてください。

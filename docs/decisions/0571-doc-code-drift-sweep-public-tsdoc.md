# ADR 0571: 文書とコードのずれを横に掃く（第12弾）— core を除く公開パッケージの TSDoc を、今の main の実装に照らす

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-03

ADR 0569（#1681）の続き。今回は、`packages/postgres`・`packages/testkit`・`packages/openai`・`packages/anthropic`・`packages/local-embedding` の公開 TSDoc（各パッケージの入口から export される型・関数・クラス・メソッド・オプション）を、実装と突き合わせる。コメントだけの PR で、型・振る舞い・公開 API の表面は変えない。

**照合の基準は main `5f3be61e`。**

出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手の判定、【未確認】は確かめていないこと。

決まり（前回と同じ）: CHANGELOG の `[1.2.0]` 以前、採用済み ADR の本文、開いている PR・期限待ちの Draft PR が触るファイル、`packages/core/src`（別の担当が Fake を触っている。core の TSDoc は前の弾で一部を掃いている）、`__tests__` は触らない。TSDoc を実装に合わせて直し、実装のほうを変えるべきものは直さずに材料として残す。日付の付いた追記・訂正の本文は変えない。数は写さず、在りかを指す。公開 TSDoc を直したので、CHANGELOG の `[1.3.0]` の Fixed に1項目足した。

## 掃いたもの

「公開」は、パッケージの入口（`index.ts`。testkit は `fixtures.ts` も）から再 export されるファイルとした。そこから、開いている PR が触るファイルを除いた。

- **postgres**: `advisory-lock.ts`・`content-hash.ts`・`embedding-space-table.ts`・`pgvector-capability.ts`・`relation-store.ts`・`schema-namespace.ts`・`tenant-settings-store.ts`・`vector-space.ts`
- **testkit**: `event-store-`・`lexical-store-`・`llm-provider-`・`outbox-store-`・`relation-store-`・`tenant-settings-store-`・`vector-store-conformance.ts`、`test-data.ts`、`__fixtures__/` の `cassette.ts`・`cassette-recorder.ts`・`deterministic-embedding-provider.ts`・`deterministic-llm-provider.ts`・`recorded-embedding-provider.ts`・`recorded-llm-provider.ts`・`seeded-provider.ts`・`in-memory-relation-store.ts`・`in-memory-tenant-settings-store.ts`
- **openai**: `client-types.ts`・`embedding-provider.ts`・`errors.ts`・`json-schema.ts`・`llm-provider.ts`
- **anthropic**: `client-types.ts`・`json-schema.ts`
- **local-embedding**: `errors.ts`・`local-embedding-provider.ts`・`pipeline.ts`

除いたもの（開いている PR が触る）: postgres の `client`・`migrate`・`bin/migrate`・`memory-store`・`event-store`・`outbox-store`・`lexical-store`・`trigram-lexical-store`・`vector-store`・`mapping`。testkit の `memory-store-conformance`・`embedding-provider-conformance`・`fixtures`・`__fixtures__/in-memory-{event,lexical,memory,outbox,vector}-store`・`query-check`。anthropic の `errors`・`llm-provider`。

観点: 何を返すか、いつ何を投げるか（例外の型・code）、既定値、時刻の扱い、大文字小文字の扱い、テナントの扱い、参照先（ADR・ファイル・節）の実在、写された数。

## 直したもの

### postgres

- **`PostgresRelationStore.link`**: 「返り値の `ok` で見る」「どちらの端も在らなければ投げる」と書いていた。戻り値は `Promise<void>` で、見ているのは文が返す `from_ok`/`to_ok`。どちらか一方の端が無くても投げ、両方無いときは `fromId` 側を報告する。列挙外の `kind` を端の検査より前に断ること、id を小文字にそろえること、同じ行が在れば何もしないこと（core の `RelationStore.link` の doc と同じ）を足した。【現物】
- **`AdvisoryLockErrorFactories.unavailable`**: 「待つ前に、ロックを取れなかった（接続の失敗など）とき」と書いていた。実装は `lock_timeout` の超過（55P03）以外の失敗すべて（`set_config` の失敗、`pg_advisory_lock` の権限不足・接続断。待ったあとの失敗を含む）に使う。そう直した。【現物】
- **`acquireAdvisoryLock`**: どの失敗にどの factory を使うか、戻り値 `{ client, waitedMs }`、`client` を `releaseAdvisoryLock` で返す責務を足した。【現物】
- **`registerEmbeddingSpace`**: 検査が「ロックより前」とだけ書き、何をどの型で投げるかが無かった。`dimensions` が数でなければ `TypeError`、正の整数でない・上限を超えると `RangeError`、`schema`/`extensionSchema` が `assertSafeSchemaName` を通らなければ `Error`（`extensionSchema` は `schema` を渡したときだけ検査）を足した。【現物】

### testkit

- **`__fixtures__/cassette.ts`・`deterministic-llm-provider.ts`**: AGENTS.md の provider の層を「二層」「3層」と写していた（AGENTS.md の節は今は4層）。`cassette.ts` は、カセットを使うのが `retrieval` だけとも書いていた。層の数を写さず、AGENTS.md の表を指した。【現物】
- **`recorded-embedding-provider.ts`・`recorded-llm-provider.ts`**: 再生するモデル名を固定で書いていた。どのカセットでも再生できるので、「記録元のモデル（同梱のカセットでは …）」にした。【現物】
- **`in-memory-tenant-settings-store.ts` の `ownEventRetentionDays`**: どの backing が無いときの代わりかを取り違えていた（実際は `eventRetentionDaysBacking`）。【現物】
- **`describe*Conformance` とそのオプションの doc**: event・relation・tenant-settings・outbox・lexical・vector の各 suite で、実際の `it` が検査しているのに doc に無い項目を足した。たとえば、識別子の入口検査（ADR 0423）、外部キー・テナント一致（ADR 0047・0398・0436）、複製、CAS（ADR 0142）、`eraseTenant`、`purgeCompletedJobs`、lexical・vector の `filter` の欄、`supports*` のフラグで分かれる節。`supportsDecayClock` の「4メソッド」は数を消して列挙にした。`prepareMemoryId` は、実在しない `docs/testkit` ではなく `buildNewMemoryEventFixture` を指した。`PrepareLexicalMemoryAttrs` の任意の欄の列挙の不足も直した。【現物】
- **`tenant-settings-store-conformance.ts` の定数の doc**: `INVALID_DAYS_ERROR` の doc が `FLOAT4_MESSAGE` の上にあり、対応がずれていた。宣言の順を入れ替えて、doc を対応する定数に付けた（値は変えていない）。【現物】
- **`vector-store-conformance.ts`**: ずれた行番号の参照（`scale-bench.ts:667`）を、関数名（`benchVectorSearch`）の参照にした。【現物】

### openai・anthropic・local-embedding

- **`OpenAILLMFailureKind` の `"no_content"`**: どの経路でも投げるように読めた。投げるのは `completeStructured` だけで、`complete` は同じ場合に空文字を返す（ADR 0072「引き受けた負債」2 の既知の設計）。そう書いた。【現物】
- **`translateForOpenAIStructuredOutput`**: 挙動の記述が無かった。`$schema` を落とすこと、根が object でなければ1欄の object に包むこと、表せない形はここで投げ provider が `schema_unsupported` に包むことを足した。【現物】
- **`translateForAnthropicStructuredOutput`**: 投げるものの記述が無かった。`z.record` を含むと送る前に素の `Error`、`z.tuple`・`z.date`・`transform` は `zodOutputFormat` の例外がそのまま伝わること、戻りは `{ type, schema }` だけであることを足した。【現物・実測】
- **`LocalEmbeddingProviderOptions.revision`**: 「実挙動は確かめていない」「キャッシュ鍵が固定 revision をどう扱うか決めていない」と書いていた。ADR 0365 の挙動（既定の `createPipeline` は `revision` を `env.remotePathTemplate` に埋め、キャッシュの根を revision ごとに分ける。差し替えた `createPipeline` には `spec.revision` がそのまま渡る）を書いた。指紋照合（ADR 0253）の扱いが未決なことは残した。【現物】
- **`LocalEmbeddingProvider.warmup()`**: `dispose()` の後は素の `Error` で reject することを足した。【現物】
- **`defaultLocalEmbeddingRetryDelayMs`**: CI のジョブ数の写しを外した。【現物】

## 直さなかったもの

- **実装を変えるべき食い違い**: 無かった。TSDoc が約束していて実装が破っているもの、テストや ADR が TSDoc の側を支持しているものは見つからなかった。【現物】
- **`tenant-settings-store.ts` などの「roadmap.md 段階3」**: roadmap §2 は削除済み（#762）だが、roadmap.md 自身が「コードのコメントの『段階N』は墓標から辿れ」と書いているので直していない。【判断】
- **`schema-namespace.ts` の「DML は裸のテーブル名」の列挙**: すべての store を挙げてはいないが、例示と読んで直していない。【判断】
- **`LocalEmbeddingProviderOptions.cacheDir`**: revision ごとに根が分かれることを、ここにも書くかは保留した（`revision` の doc に書いた）。【判断】
- **`LocalEmbeddingProvider` の `retry.attempts`**: 非整数を丸めない（`maxBatchSize` は切り捨てる）。doc はこれについて何も約束していないので、食い違いとは数えていない。【現物】

## 走らせたもの

- `pnpm install --frozen-lockfile` のあと、postgres・testkit・openai・anthropic・local-embedding の typecheck、触ったファイルの eslint と prettier --check。すべて通った。【実測】
- `pnpm -r build` のあと `pnpm run api:check` と `scripts/__tests__/check-public-api-surface.test.mjs`（postgres の分を当てた時点）。通った。`scripts/__snapshots__/public-api/*.d.ts` は TSDoc を含まないので、更新は要らない。【実測】
- local-embedding の `local-embedding-defaults-doc`・`default-cache-dir-doc`・`architecture-doc-default-space` のテスト。通った。【実測】

## 【未確認】

- Postgres を要するテスト、testkit の適合テストは手元で走らせていない。CI に任せる。
- doc の中の外部の実測値（PostgreSQL・pgvector の版ごとの実測、RSS・スループットなど）の再現。実 API・実モデルでの挙動。
- 参照先の ADR・Issue の本文との突き合わせは、実在と見出しまで。
- 突き合わせは下請けの作業者3体が行った。担い手は、差分がコメントの行と testkit の定数1つの宣言の順の入れ替えだけであることを確かめた。

## 残り

- 除いたファイル（上の「除いたもの」）の TSDoc は、それぞれの PR が片づいたあとに掃く。
- `packages/core/src` の TSDoc は、Fake の担当が片づいたあとに掃く。

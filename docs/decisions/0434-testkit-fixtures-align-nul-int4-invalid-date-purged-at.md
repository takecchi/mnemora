# ADR 0434: testkit のインメモリ実装を Postgres 実装に揃える（NUL の口の追加・`sizeBeforeBytes` の int4・`reinforce` の `nowSeq`・outbox の `now` の Invalid Date・`createMemory` の `purgedAt`）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-01

クローンの委譲先（マネージャー mgr-0629e6a2）が書いた。直し方はクローン miku が決めた。オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
**オーナーが覆せる点は「これが覆るとしたら」にまとめてある。**
出所の区別: 【現物】は読んだコード、【実測】は手元で走らせた結果、【判断】は担い手の判定。

- **文脈**:

  穴探しの14巡目で、`@mnemora/testkit` のインメモリ実装と `@mnemora/postgres` に同じ入力を流したところ、3組のずれが見つかった。先例は [ADR 0426](./0426-in-memory-erase-tenant-postgres-alignment.md)（Postgres 実装を正とし、インメモリ側を直した）。この ADR も同じ向きで、Postgres を正とした。

  1. **NUL（U+0000）**。【現物】`packages/testkit/src/fixtures.ts` の冒頭に、NUL を拒む口の一覧がある（`createMemory` 系の `content` など、`createObservation` 系の `payload` など、`createRecall`、`claimBatch` の `claimedBy`、`lexical.search` の検索語）。この一覧に無い口で、インメモリは通し、Postgres は生の例外（`22021` `invalid byte sequence for encoding "UTF8": 0x00`、`jsonb` の引数では `22P05` `unsupported Unicode escape sequence`）で断る。
  2. **数値と日時の検査の欠け**。`MemoryEvent.sizeBeforeBytes`（Postgres は `integer` 列）、`reinforce` の `opts.nowSeq`（`bigint` 列 `decay_base_seq`・`decay_floor_seq`）、outbox の行を書くときの `opts.now`（`timestamptz`）。インメモリは通して保存し、`reinforce` は `decayBaseSeq` に `NaN` を書いていた。
  3. **`createMemory` の `purgedAt`**。【現物】`MemoryStore.purgeMemory` の doc は「`purgedAt` を書く経路はこの口以外に無い」と言う。インメモリは渡された `purgedAt` を保存し、Postgres は INSERT に含めず `null` になる。

- **決めたこと**:

  1. **Postgres が今拒む入力だけを、インメモリも拒む。Postgres が通す入力は通す。**各口について、拒む側と通す側（境界ちょうどの値を含む）の両方を、同じ表でインメモリと Postgres に当てて決めた（下の「測ったこと」）。断り方は既存の検査の形に揃えた: 例外は `Error`、文面は `<口または欄> must not contain NUL characters (U+0000)` など。数値・日時は `query-check.ts` の作法（`assertQueryDate`・`assertQueryInteger` と同じ文面）で、書く口の欄は `memory_events.<欄> …` の形にした。
  2. **候補2（NUL）**。`fixtures.ts` の冒頭の一覧に載せた口:
     - 書き込み: `createMemory` 系（`createMemoryWithOutbox`・`supersedeWithNewMemories` の新しい行・`createMemoriesWithOutboxAndEvents` を含む）の `claimKey.subject`・`claimKey.predicate`・`extractorVersion`。冪等の既存の行が在っても拒む（他の欄と同じ位置、`assertStorableNewMemory`）。イベントの `digestSnapshot`（イベントを受け取るすべての口が通る `assertStorableMemoryEvent`）。`purgeMemory` の墓石の `content`（と `digest`）。`jobKinds` の要素。
     - 読み取り: `findActiveByClaimKey` の `claimKey.subject`・`claimKey.predicate`、`listBySourceObservation` の `extractorVersion`、`aggregateScope` の `attributes`・`labels`、`InMemoryLexicalStore.search` の `filter.attributes`、`InMemoryTenantSettingsStore.getSubjectActivitySeqs` の `subjectId`。
     - **Postgres が値を見ない場合は、インメモリも見ない**（【実測】）: `jobKinds` は outbox の行を**実際に書くとき**だけ（`jobKinds` が空・冪等の既存の行に当たるときは、NUL があっても通る）。`aggregateScope` は `scopeAggregate: "skip"` で `digestBand` が無いときだけ（クエリを1本も発行しない）通る。`purgeMemory` の墓石の NUL は、対象の行が無くても・CAS に弾かれる状態でも拒む（行を引く前に見る）。
  3. **候補3（数値と日時）**。
     - `sizeBeforeBytes`: 数のとき、整数で、`-2^31`〜`2^31 - 1` なら通す。整数でない・`NaN`・`±Infinity`・範囲の外は拒む（`assertStorableMemoryEvent` の中。イベントを受け取るすべての口）。**負の数そのものは拒まない**（【実測】列に CHECK は無く、`-1`・`-2^31` は Postgres も通す）。`null`・`undefined` は検査しない。**例外が1つある**: `markContestedGroup`・`resolveContestedGroup` は、Postgres が複数のイベントを1つの `jsonb` の配列で渡す（`insertMemoryEventsBatch`）ので、`NaN`・`±Infinity` は `JSON.stringify` で `null` になって通る（【実測】）。この2つの口だけ、`NaN`・`±Infinity` を拒まず `null` で保存する（`1.5`・範囲の外は拒む）。
     - `reinforce` の `nowSeq`: 対象の Memory が `halfLifeRecalls` を持つときだけ（持たなければ Postgres は `nowSeq` を使わず、`NaN` も負も通す）。整数でない・`NaN`・`±Infinity`・2^63 以上（-2^63 未満）を拒む。`archiveDecayed` の `nowSeq` と同じ `assertQueryInteger` に `bigint` の範囲を足した `assertQueryBigint`。**何も書かない呼び出し（起点より古い `at`）でも拒む**（Postgres は同じ UPDATE を発行し、引数の変換で落ちる）。**負は、実際に書くときだけ拒む**（`memories_decay_seq_non_negative` の CHECK は、行を書くときに効く。【実測】no-op の呼び出しでは `nowSeq: -1` が通る）。`addOwnSubjectSeq` のときは書く値が `nowSeq + S_x` なので、その値が負のときだけ拒む。壁時計側の列を書き換える前に決めて投げる。`reinforceMany`・`recordUsageAndReinforce` は `reinforce` を呼ぶので同じになる。
     - `opts.now` の Invalid Date: outbox の行を**実際に書くとき**だけ拒む（`jobKinds` が空・冪等の既存の行に当たるときは、Postgres も通す。`createMemoriesWithOutboxAndEvents` は、拒まれた候補だけ `dropped` になり、全候補が拒まれたときだけ例外になる）。口は `createMemoryWithOutbox`・`createObservationWithOutbox`・`supersedeWithNewMemories`・`createMemoriesWithOutboxAndEvents`。行を書く分岐の直前（`createMemoryIdempotent`・`createObservationIdempotent` の `beforeInsert`）で見るので、拒んだときは何も書かない。`requeueEmbedJobs` の `writeOpts.now` は、対象が0件でも拒む（Postgres は `now` を INSERT の引数に使う）。`memoryIds` が空配列のときだけ、Postgres はクエリを発行しないので見ない。
  4. **候補4（`purgedAt`）**。`createMemory` 系に渡された `purgedAt` は、断らずに無視し、`null` で保存する。`purgeMemory` だけが書く。**公開の型（`NewMemory.purgedAt`）は変えない。**
  5. **歯は testkit 自身のテストと、Postgres の `__tests__` に置いた。**`packages/testkit/src/*-conformance.ts` には手を入れていない（適合テストを足すのはオーナーの判断。自前の adapter に課す約束は増えていない）。
     - `packages/testkit/src/__tests__/in-memory-nul-numeric-purged-at-postgres-alignment.test.ts`（128本。インメモリだけ。DB が要らない。例外の文面も縛る）。
     - `packages/postgres/src/__tests__/testkit-fixtures-nul-numeric-purged-at-alignment.postgres.test.ts`（256本。同じ128本の表を、インメモリと Postgres の両方に当てて、どちらも同じ側になることを縛る）。2つの表は同じ内容の複製で、片方だけ直すとずれる（引き受けた負債）。
  6. **公開 API**: 変わらない。検査の関数は内部モジュール `__fixtures__/query-check.ts` にあり、`.d.ts` に出ない。`@mnemora/core` の `EventStore.append` の doc の1行（`sizeBeforeBytes` の扱い）を、新しい振る舞いに合わせて直した。

- **検討した代替案**:

  1. **`NewMemory` から `purgedAt` を外す。** 採らなかった。公開の型の破壊的変更になる（`NewMemory.purgedAt` は公開の型の欄で、渡している呼び出し元がありうる）。無視すれば Postgres と doc に合い、型は変わらない。
  2. **`purgedAt` を渡されたら例外にする。** 採らなかった。Postgres は断らずに無視する。Postgres が通す入力を断ると、「Postgres が通す値は断らない」の向きに反する。
  3. **`reinforce` の `nowSeq` を、`halfLifeRecalls` の有無に関係なく検査する（`archiveDecayed` と完全に同じ検査にする）。** 採らなかった。【実測】`halfLifeRecalls` を持たない Memory に `NaN` を渡しても Postgres は通す。`nowSeq` が読まれるのは活動時計の列を書くときだけである。
  4. **`reinforce` の `nowSeq` の負を、no-op の呼び出しでも拒む。** 採らなかった。【実測】no-op の UPDATE は行を書かないので CHECK 制約が効かず、Postgres は通す。
  5. **`opts.now` を、`jobKinds` の有無にかかわらず常に検査する。** 採らなかった。【実測】`jobKinds` が空・冪等の既存の行に当たるときは、Postgres は outbox へ INSERT せず `now` を見ない。
  6. **`sizeBeforeBytes` の負を拒む。** 採らなかった。列に CHECK は無く、Postgres は通す（core の `MemoryEventSchema` は `nonnegative()` だが、`EventStore.append` の doc のとおり、store は形を検査しない）。
  7. **conformance に同じ要件を足す。** 採らなかった。自前の adapter に新しい約束を課すことになり、オーナーの判断に当たる。ADR 0426 と同じ理由。
  8. **候補5（型の外の入力）も揃える。** 見送った。今回の3組は、型に合う入力（NUL を含む文字列・範囲の外の数・Invalid Date・`purgedAt`）で起きる。型を外した呼び出し（`sizeBeforeBytes` に文字列など）は、Postgres の側の引数の変換が型ごとに分かれるので、別に実測して決める必要がある（この ADR では測っていない）。

- **引き受けた負債**:

  - **Postgres が拒み、インメモリがまだ通す入力が残っている**（【実測】）: `findContestedByClaimKey` の `claimKey` の NUL、`InMemoryLexicalStore.search` の `filter.labels` の NUL、紀元前4713年より前の `opts.now`（`22008`。#1041 と同じ根）。`VectorStore.search` の filter の NUL は確かめていない。`fixtures.ts` の「揃えていないもの」に書いた。今回の範囲（依頼の一覧）に入っていない。
  - **`listBySourceObservation` の NUL は、`observationId` が uuid の形でないとき揃わない。** Postgres はその入力でクエリを発行せず `[]` を返して NUL を見ないが、インメモリの id は uuid の形ではないので、形で分けられない。`requeueEmbedJobs` の `memoryIds` に uuid の形でない id しか無いときも同じで、Postgres はクエリを発行せず `now` を見ない（インメモリは拒む）。
  - **`purgeMemory` の墓石の `digest` の NUL は、依頼の一覧に無かったが、同じ引数の同じ列なので一緒に拒んだ**（【実測】Postgres は `digest` の NUL も拒む）。
  - **`assertStorableMemoryEvent` は、Postgres がイベントを書かない経路でも検査する**（既存の作り）。CAS に弾かれるときなど、拒み方が Postgres と違う入力が、新しい検査の分だけ増えうる。`updateStatusWithEvent` は CAS の後に検査するので、Postgres と同じ順である。
  - 歯の表が2か所に複製されている（上の決定5）。
  - `reinforce` の `addOwnSubjectSeq` で `nowSeq + S_x` が 2^63 を超えるときは、Postgres の `bigint` の足し算が溢れるが、インメモリは倍精度の数のまま通す。実測していない。

- **これが覆るとしたら**:

  - オーナーが「NUL・int4・Invalid Date を拒むこと」を conformance の約束にすると決めたら、要件は conformance suite に移り、インメモリ実装はその一例として検査される。
  - `NewMemory.purgedAt` を型から外す判断が出たら（破壊的変更として数える）、決定4の「無視する」は型の側で表現される。
  - Postgres 側が変わったとき（`size_before_bytes` を `bigint` にする、`outbox` の行を書く前に `now` を検査するなど）は、この ADR の「測ったこと」の表がずれるので、歯の表ごと見直す。

- **測ったこと**（【実測】2026-10-01、手元の Postgres 17、UTF8（`C.UTF-8`）、pgvector あり。インメモリと Postgres に同じ入力を流し、受理・拒否と SQLSTATE を並べた）:

  - **NUL**: 書き込みの口（`createMemory`・`createMemoryWithOutbox`・`supersedeWithNewMemories`・`createMemoriesWithOutboxAndEvents` の `claimKey`・`extractorVersion`・`jobKinds`、`EventStore.append`・`updateStatusWithEvent` の `digestSnapshot`、`purgeMemory` の墓石）と読み取りの口は、Postgres が `22021`（`text`）か `22P05`（`jsonb` の引数）で拒み、直す前のインメモリは通した（`markContestedGroup` の `digestSnapshot` の NUL も Postgres は `22P05` で拒む）。通す側: NUL の無い値（`\u0001` などの他の制御文字、文字どおりの `\\u0000`）、`jobKinds` が空・冪等の既存の行、`scopeAggregate: "skip"` で `digestBand` 無し、`labels: []`、`attributes: {}`、`subjectIds: []`。`createMemoriesWithOutboxAndEvents` で一部の候補だけ拒まれるときは、Postgres もその候補だけ `dropped` にして通った。
  - **`sizeBeforeBytes`**: Postgres は `2^31`・`-2^31 - 1`（`22003`）、`1.5`・`NaN`・`±Infinity`（`22P02`）を拒み、`2^31 - 1`・`-2^31`・`0`・`-1`・`null` を通した。`EventStore.append`・`updateStatusWithEvent`・`purgeMemory`・`createMemoriesWithOutboxAndEvents`・`supersedeWithNewMemories` の各経路で同じ側になった。`markContestedGroup`・`resolveContestedGroup`（一括の `jsonb_to_recordset` の経路）だけは、`NaN`・`Infinity` が `null` になって通り、`1.5`・`2^31`・`-2^31 - 1` は拒んだ。`updateStatusWithEvent` の CAS に弾かれる呼び出しは、`sizeBeforeBytes` を見ずに競合の例外になる。
  - **`nowSeq`**: `halfLifeRecalls` を持つ Memory で、Postgres は `-1`（`23514`）、`1.5`・`NaN`・`±Infinity`（`22P02`）、`2^63`（`22003`）を拒み、`0`・`1`・`2^53`・`2^62`・`Number.MAX_SAFE_INTEGER`・`2^63 - 1024`・`-0` を通した。`addOwnSubjectSeq` でも同じ。no-op の呼び出しでは、`NaN`・`1.5`・`Infinity`・`2^63` は拒み、`-1` は通した。`halfLifeRecalls` を持たない Memory は、どの値も通した。
  - **`opts.now`**: Postgres は、outbox の行を書く呼び出しで Invalid Date を `22007` で拒み、`jobKinds` が空・冪等の既存の行では通した。`requeueEmbedJobs` は対象が0件・`limit: 0`・`statuses: []` でも `22007` で拒み、`memoryIds: []` のときだけ通した。
  - **`purgedAt`**: `createMemory` に渡すと、`get` の結果はインメモリが日時、Postgres が `null` だった（直した後はどちらも `null`）。
  - **歯**: インメモリだけの128本は、直す前の fixture に当てると 73本が赤・55本が緑だった（赤は拒む側・`purgedAt`・一括の経路の `NaN`/`Infinity` を通す側、緑は他の通す側）。直した後は128本とも緑。Postgres も含む256本は、直す前は 73本が赤（すべてインメモリの側）、Postgres の側の128本は直す前から緑。直した後は256本とも緑。
  - **やりすぎの変異**（一時的に入れて赤を確かめ、`cp` で戻した）: int4 の上限を `>=` にずらす（5本が赤）、下限を `<=` にずらす（1本）、NUL の判定を「文字列なら常に拒む」にする（多数）、`bigint` の上限を `2^62` に下げる（2本）、`jobKinds` が空でも `now` を見る（5本）、`halfLifeRecalls` が無くても `nowSeq` を見る（1本）、`nowSeq` の検査が負も拒む（2本）、`aggregateScope` の skip の例外を外す（1本）、`requeueEmbedJobs` が `memoryIds: []` でも `now` を見る（1本）、`sizeBeforeBytes` の負を拒む（2本）、一括の経路の `NaN`・`Infinity` を拒む（4本）、`purgedAt` を保存する（3本）。どれも戻した後は128本とも緑。
  - **測っていないこと**: `VectorStore.search` の filter の NUL。型の外の入力（候補5）。`nowSeq + S_x` が 2^63 を超える `addOwnSubjectSeq`。SQL_ASCII の DB での NUL の拒否（`22021` は UTF8 の DB で測った）。Postgres 16 以前。`InMemoryRelationStore`・`InMemoryOutboxStore` の他の口。

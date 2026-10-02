# ADR 0500: testkit の fixture を Postgres に揃える（`findContestedByClaimKey`・検索の `labels` の NUL、`timestamptz` の下限、`reinforce` の bigint 溢れ、LLM 応答の参照、core Fake の float4 読み戻し）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-02

クローン miku の決定。担い手が書いた。オーナーではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
**オーナーが覆せる点は「これが覆るとしたら」にまとめてある。**
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手の判定、【未確認】は確かめていないこと。

- **文脈**: [ADR 0434](./0434-testkit-fixtures-align-nul-int4-invalid-date-purged-at.md)・[ADR 0456](./0456-llm-returned-values-malformed-read-filter-nul-named.md)・[ADR 0479](./0479-tenant-settings-write-fake-alignment.md)・[ADR 0452](./0452-testkit-provider-fakes-align-with-contract.md) が「材料」「引き受けた負債」に残した、fixture（`@mnemora/testkit/fixtures` の InMemory・provider の fake、core のテスト専用 Fake）と本物の差を、Postgres を正として揃える。先例と向きは ADR 0434・0426 と同じ。

- **見つけたこと**【現物】（依頼の記述と食い違う点は ⚠）:
  1. `InMemoryMemoryStore.findContestedByClaimKey` は claimKey の NUL を断らない。兄弟の `findActiveByClaimKey` は ADR 0434 で `assertQueryTextWithoutNul` を足してある。
  2. `InMemoryLexicalStore.search` は `filter.labels` の NUL を断らない（`attributes` は ADR 0434 で断る）。
  3. `InMemoryVectorStore.search` は `filter.labels`・`filter.attributes` の NUL を断らない。⚠ `searchMany` は `search` を呼ぶだけなので、`queries` が空だと一度も検査が走らない。Postgres の `searchMany` は往復の前に絞りを検査する。
  4. 読みの口の日時の検査（`assertQueryDate`）は `NaN` だけを見る。
  5. `reinforce` の `addOwnSubjectSeq` は `nowSeq + S_x` を float64 で足して通す。
  6. core の `FakeTenantSettingsStore.setDefaultHalfLifeRecalls` は渡された値のまま保存する。
  7. `RecordedLLMProvider`・`SeededLLMProvider`・`RecordingLLMProvider` が返す応答は、記録・種の参照のまま。

- **決めたこと**【判断】:
  1. **NUL（項目1〜3）**: `findContestedByClaimKey` に `claimKey.subject`・`claimKey.predicate` の NUL の検査（兄弟と同じ文面）。`InMemoryLexicalStore.search` に `filter.labels`、`InMemoryVectorStore.search` に `filter.labels`・`filter.attributes`。`InMemoryVectorStore.searchMany` には、`queries` が空でも走るよう、同じ検査を `search` の前に足す（Postgres が往復の前に検査するのと同じ順）。labels 用に `assertQueryLabelsWithoutNul` を `query-check.ts`（内部。公開の面に出ない）へ足した。
  2. **`timestamptz` の下限（項目4）**: 下限は 4714-11-24 BC 00:00:00 UTC（JS の `Date.UTC(-4713, 10, 24)`）。**それより前を、Postgres が `22008` にする口にだけ**断る（`assertQueryTimestamptz`。`RangeError`。文面は `<口>: <欄> must not be earlier than 4714-11-24 BC (the lower bound of a Postgres timestamptz)`、入力値は載せない）。下限ちょうどは通す。**断らない口**: `purgeExpiredEvents`・`purgeExpiredRecalls`・`purgeCompletedJobs` の `olderThan`（Postgres は下限より前の cutoff を問い合わせずに「0件」で返す。`PG_TIMESTAMPTZ_MIN_MS`）。`jobKinds` が空の `*WithOutbox` の `now` も、ADR 0434 と同じく見ない（outbox へ INSERT しない）。口の表は「測ったこと」。
  3. **`reinforce` の bigint 溢れ（項目5）**: Postgres は `addOwnSubjectSeq` のとき、`decay_base_seq = nowSeq + S_x` と、床 `LEAST(nowSeq + S_x + offset::bigint, MAX_SAFE_INTEGER)` を bigint で足し、**どちらかが 2^63 以上なら UPDATE ごと `22003` で失敗する**【実測】。fixture は、実際に書く分岐（起点より新しい `at`）で、同じ値を BigInt で足して同じ条件で断る。⚠ Postgres が足す `nowSeq` は、ドライバが文字にした値（`String(2**63 - 1024)` は `"9223372036854775000"`）なので、`BigInt(String(nowSeq))` を使う（float64 の和では境界がずれる）。`offset` は `defaultActivityDecayStrategy.floorAt({ baseSeq: 0, … })`（Postgres の `${offset}::bigint` と同じ値）。
  4. **LLM 応答の参照（項目7）**: 参照が漏れる実例を先に歯で示した（下）。漏れたので、`structuredClone` で複製して返す（ADR 0452 A-6 と同じ作法）。`completeStructured` は、複製してから呼び出し側の `schema` で検証する（schema が作り直さない欄は参照のまま通り抜けるため）。`RecordingLLMProvider` は、記録に入れる値・並列に待つ側へ渡す値・呼び出し側へ返す値を、それぞれ別の写しにする。
  5. **core Fake の float4（項目6）**: ⚠ **依頼は「`Math.fround` で保存」だったが、そうしなかった。** `Math.fround(720.1)` は `720.0999755859375` で、Postgres が読み戻す `720.1` と食い違う（`720.1::float8::real::text` は `720.1`【実測】）。ADR 0479 の「材料」が言う `toFloat4Readback`（float4 に丸めたうえで、元に戻る最短の10進表記）と同じ式を、Fake の側に非公開の関数として持つ（core は testkit に依存できない）。`Math.fround` だけにすると、いま一致している `720.1`・`0.1` が食い違う退行になる（歯: `720.1`・`0.1` の「やりすぎ」）。
  6. **公開 API は増えない**（新しい export・例外クラスなし。`pnpm api:check` が変わる変更ではない）。conformance suite に it は足していない。

- **採らなかった案**:
  1. **下限をすべての日時の口に掛ける（`assertQueryDate` 自体に足す）。** 採らなかった。`purge*` の `olderThan` は Postgres が通す（0件を返す）。通す入力まで断る「やりすぎ」になる。
  2. **`Math.fround` で保存する（依頼どおり）。** 上の決めたこと5のとおり、通常の値（`720.1`）で退行する。
  3. **core の Fake が testkit の `toFloat4Readback` を import する。** `packages/core/src/__tests__/dependency-boundary.test.ts` と循環の禁止に反する。
  4. **LLM 応答を `JSON.parse(JSON.stringify(…))` で複製する。** 採らなかった。JSON 経由は `Date` を文字列にする。カセットの値は JSON だが、`Recording` が受ける delegate の戻りは JSON とは限らない。【未確認】関数を含む戻りは、JS の仕様では `structuredClone` が `DataCloneError` を投げる（本物の provider は関数を返さない）。
  5. **`archiveDecayed`・`aggregateScope`・段1の `decayFloorSeqAfter + S_x` の溢れも、この ADR で断る。** 今回は直していない（下の「材料」）。

- **引き受けた負債**:
  - `reinforce` 以外の `S_x` を足す口（`archiveDecayed` の `nowSeq + S_x`、`aggregateScope`・`VectorStore.search` の `decayFloorSeqAfter + S_x`）も、Postgres は `22003` にする【実測】が、fixture は通す。依頼の範囲が `reinforce` だったので直していない（材料）。
  - 下限を掛けた口は、ADR 0456 の M2（Postgres 側が `22008` を生の DB 例外のまま出す）の範囲外。fixture の文面と Postgres の文面は違う（例外の種類は揃えない。`fixtures.ts` の冒頭）。
  - 書く口（`createMemory` の `occurredAt`・`validFrom` など、行に日時を書く口）の下限は調べていない【未確認】。依頼は「`opts.now`・日時の条件」だった。
  - `RecordingLLMProvider` が記録に入れる複製と、delegate が返したオブジェクトは別なので、delegate 自身が戻りを後から書き換えても記録は動かない（本物の provider でも、記録の側から見れば同じ）。呼び出し側が返り値を書き換えても、記録・次の再生には漏れない。
  - `S_x` の足し算の溢れは `nowSeq` が 2^63 に近い巨大な値のときだけ起きる。実際の `nowSeq` はテナントの活動時計（小さい整数）なので、現実の入力では到達しない。fixture と Postgres の差を、到達しない入力で縮めた。

- **これが覆るとしたら**:
  - オーナーが「fixture が新しく断る入力は、`@mnemora/testkit` の利用者に影響するので 🔴 に数える」と決めたとき（ADR 0461 の判断を覆すとき）。この ADR は 🟡 に置いた。
  - Postgres が `timestamptz` の下限より前を通すようになったとき（PostgreSQL の仕様変更）。歯 `testkit-fixture-alignment.postgres.test.ts` が落ちる。
  - `addOwnSubjectSeq` の足し算を Postgres 側で数値型に変える（`bigint` で足さない）とき。
  - `float4Readback` の最短表記が、ドライバ・Postgres の float4 出力の形式（`extra_float_digits`）で変わったとき。歯 `testkit-fixture-alignment.postgres.test.ts` の最後の表が落ちる。

- **材料（直していない）**:
  - 上の `archiveDecayed`・`aggregateScope`・段1の検索の `S_x` の溢れ（【実測】`nowSeq: 2**63 - 1024`・`S_x = 1024` の `archiveDecayed`（`clock: "activity"`・`usesSubjectActivityCounters: true`）と、`decayFloorSeqAfter` 同条件の `aggregateScope` は、どちらも `22003 bigint out of range`）。
  - 書く口の日時の下限。

- **測ったこと**（【実測】2026-10-02、手元の Postgres 17、UTF8（`C.UTF-8`）、pgvector あり。セッションの `TimeZone` は `Asia/Tokyo`）:
  - **下限**: `'4714-11-24 00:00:00+00 BC'::timestamptz` は通り、`'4714-11-23 23:59:59.999+00 BC'` は `22008 timestamp out of range`。JS では `Date.UTC(-4713, 10, 24)` がちょうど下限。`toPgTimestamp` は `+00:00` を付けるので、セッションの時間帯に依らない。
  - **口ごとの表**（日時を、下限の1ms 前・紀元前9001年・下限ちょうどの3つで渡した）:

    | 口 | 下限より前 | 下限ちょうど |
    | --- | --- | --- |
    | `EventStore.list` の `since`・`until` | `22008` | 通る |
    | `VectorStore.search`・`searchMany` の `occurredAfter`・`occurredBefore`・`validAt`・`decayFloorAtAfter` | `22008` | 通る |
    | `LexicalStore.search`・`TrigramLexicalStore.search` の `occurredAfter`・`occurredBefore`・`validAt` | `22008` | 通る |
    | `OutboxStore.complete`・`fail` の `opts.at` | `22008`（行が無くても） | 通る |
    | `MemoryStore.aggregateScope` の `occurredAfter`・`occurredBefore`・`validAt`・`decayFloorAtAfter` | `22008` | 通る |
    | `MemoryStore.requeueEmbedJobs` の `writeOpts.now`（対象 0 件でも） | `22008` | 通る |
    | `MemoryStore.archiveDecayed` の `now` | `22008` | 通る |
    | `findActiveByClaimKey`・`findContestedByClaimKey` の `validFrom`・`validUntil` | `22008` | 通る |
    | `createObservationWithOutbox`・`createMemoryWithOutbox`・`createMemoriesWithOutboxAndEvents`・`supersedeWithNewMemories` の `opts.now`（`jobKinds` が空でない） | `22008` | 通る |
    | 同 `createObservationWithOutbox` の `opts.now`（`jobKinds` が空） | 通る（見ない） | 通る |
    | `purgeExpiredEvents`・`purgeExpiredRecalls`・`OutboxStore.purgeCompletedJobs` の `olderThan` | **通る（0件）** | 通る |

    `TrigramLexicalStore` の fixture は無い（InMemory は1つ）。
  - **`reinforce` の溢れ**: `nowSeq = 2**63 - 1024`、`halfLifeRecalls: 100`（`offset` 433）。`S_x = 0`・`374` は通り、`375`・`807`・`808`・`5000` は `22003`（`reinforce`・`reinforceMany` とも）。375 は、`9223372036854775000 + 375 + 433 = 2^63`（床の式）、807 は `base` がちょうど入る上限。`addOwnSubjectSeq: false` は `S_x = 1024` でも通る。起点より古い `at`（何も書かない呼び出し）は、溢れる組み合わせでも通る（WHERE が行を外すので SET が評価されない）。
  - **float4 の読み戻し**: `720.1`→`720.1`、`0.1`→`0.1`、`16777217`→`1.6777216e+07`、`33554431`→`3.3554432e+07`、`123456.789`→`123456.79`、`3e38`→`3e+38`。
  - **LLM 応答の参照が漏れる実例**（直す前に赤）: `complete` は Recorded・Seeded・Recording（再生）の3つとも、返した `content` を書き換えると次の再生が変わる。`completeStructured` は、schema に `z.unknown()`・`z.record(z.string(), z.unknown())` を持つと、入れ子の値を書き換えたものが次の再生に漏れる（zod の `z.object`・`z.array` は新しい入れ子を作るが、`unknown` の中は参照のまま）。`Recording` の初回の戻りと、並列に待った側の戻りは、同じ参照を共有していた。
  - **歯の赤→緑**: `packages/testkit/src/__tests__/in-memory-fixtures-read-filter-nul.test.ts`（8本中5本が赤）、`in-memory-fixtures-timestamptz-floor.test.ts`（58本中30本が赤）、`in-memory-fixtures-reinforce-seq-overflow.test.ts`（6本中5本が赤）、`provider-fakes-llm-response-isolation.test.ts`（初回の組み立てで10本中9本が赤。並列の先着の歯を足して11本）、`packages/core/src/__tests__/fake-tenant-settings-half-life-recalls-float4-readback.test.ts`（11本中4本が赤）。実 DB で2実装を並べた `packages/postgres/src/__tests__/testkit-fixture-alignment.postgres.test.ts` は、直す前の fixture に対して47本中36本が赤、直した後は47本とも緑。
  - **変異**: 歯が噛むことを、足りない実装とやりすぎの実装の両方で確かめた（PR 本文に一覧）。

# ADR 0596: `OutboxStore.complete`・`fail` は `timestamptz` の下限より前の `opts.at` を、3実装とも `jobId` の形より先に `RangeError` で断る。`requeueEmbedJobs`・`archiveDecayed` の「負の `limit` は Postgres が投げる」コメントを実測に合わせる

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-03

出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手の判定、【未確認】は確かめていないこと。

**決めたのはクローン（オーナーの価値観を写した判断役。オーナーではない）である**（2026-10-03。「下限より前を断る側に寄せる。🔴（Breaking）」）。破壊的変更を v1.X.0 で出してよいことは、オーナーの回答による。担い手が決めたのは、断る例外の置き場所と、conformance・Fake の歯の組である。【判断】

この ADR は2つのことを書く。(1) ADR 0575 の「評価されなければ投げない」が他の口に広がっているかの実測と、コメントの直し（コードは変えない）。(2) ADR 0594「残り」の、下限より前の `opts.at` のずれの実測と、それを塞ぐ変更。

## 1. 負の `limit` のコメントの実測（コードは変えない）

`in-memory-*` の fixture・core の Fake・それを引くテストのコメントは、「`PostgresMemoryStore.<口>` は `limit` を生 SQL の `LIMIT` に渡すため、負数を渡すと Postgres 自身が `LIMIT must not be negative` で例外を投げる」と書いていた。ADR 0575 は、`LIMIT` が結合の内側・CTE にあると、外側が0行のとき評価されず投げないことを outbox で測った。同じ形が他の口にあるかを、専用の Postgres で測った。【実測】

- **成り立たない口**: `requeueEmbedJobs`・`archiveDecayed`。`LIMIT` が `WITH target AS (… LIMIT $n FOR UPDATE SKIP LOCKED) … UPDATE memories m … FROM target t` の CTE の中にある。テナントの行が無く `memories` の統計が古い（`reltuples = 0`）と、`Limit` は `never executed` になり、何も書かずに `{ requeued: 0 }`・`{ archived: [] }` で返る。行が1本でもあるか、統計が無ければ投げる。
- **成り立つ口**: `EventStore.list`・`VectorStore.search`・`LexicalStore.search`・`purgeExpiredEvents`（`-1` は `LIMIT 0` で通る・`-2` 以下は投げる。コメントが既にそう書いている）・`aggregateScope` の `digestBand.limit`。`LIMIT` が最上位か、GROUP BY の無い集約の副問い合わせで、どの状態でも投げた。
- 直したのは、`requeueEmbedJobs`・`archiveDecayed` のコメント（`in-memory-memory-store.ts`・`runtime-fakes.ts`）と、それを引くテストの冒頭のコメント3箇所（testkit の2本・core の parity 1本）。「どの状態で投げないか」と「Postgres は負数を断る約束ではない（core の interface は負数の結果を約束しない）。fixture・Fake は常に断る」を書いた。コードは変えていない。
- 詳しい表と EXPLAIN は ADR 0575 の追記に置いた（ここには複製しない）。
- **揺れうる Postgres 側の歯**: 見つからなかった。outbox に古い統計を残した状態で、`store-boundary-diff`・`event-filter-actor-schema-vs-store`・`vector-search-many-diff`・`readme-unbound-promises` を走らせ、24本とも通った。`store-boundary-diff` の `claimBatch(limit:-1)` が揺れないのは、`claimWith` が撃つ前に同じテナントの行を入れるため。【実測】
- outbox の口（`in-memory-outbox-store.ts`・`in-memory-fixtures-negative-limit.test.ts` の冒頭・`fake-store-postgres-parity.test.ts` の冒頭・`testkit/src/fixtures.ts` の一般記述）は、#1706（ADR 0594）の作業と重なるので、ここでは触れていない。【未確認】それらの記述が、評価されなければ投げないことに触れているか。

## 2. `timestamptz` の下限より前の `opts.at`（コードを変える）

### 実測（直す前）

`opts.at` に下限（`Date.UTC(-4713, 10, 24)`）の1ミリ秒前・ちょうど・Invalid Date を、`complete`・`fail` に渡した。`jobId` は形の崩れた・uuid の形で不在・実在（claim で得た `attempts`）。【実測】

| `jobId` | 下限より前 | 下限ちょうど |
| --- | --- | --- |
| 形の崩れた | Postgres: **静かに返る**（main・#1706 とも）。InMemory: `RangeError`。Fake: **静かに返る** | 3実装とも返る |
| uuid の形で不在 | Postgres: `DrizzleQueryError`（`cause.code` `22008`）。InMemory: `RangeError`。Fake: **静かに返る** | 3実装とも返る |
| 実在 | Postgres: `22008`（行に触れない）。InMemory: `RangeError`。Fake: **静かに返り、下限より前の日時を `completedAt`・`failedAt` に書く** | 3実装とも返る |

Invalid Date は、#1706 の版で3実装とも素の `Error`（`<method>: opts.at must be a valid Date (got Invalid Date)`）に揃っている（ADR 0594）。

### 決定

1. **下限より前の `opts.at` は、3実装とも、`jobId` の形・行の有無を見る前に `RangeError` で断る。** 文面は testkit の `InMemoryOutboxStore`（`assertQueryTimestamptz`）と同じ `<method>: opts.at must not be earlier than 4714-11-24 BC (the lower bound of a Postgres timestamptz)`。下限ちょうどは通す。
   - `PostgresOutboxStore.complete`・`fail`: `assertWellFormedCtx`・`assertValidDate`（ADR 0594）の直後、`isUuidLike` の前に、`input-check.ts` の `assertNotBelowTimestamptzMin`（新設。判定は ADR 0547 で入った `isBeforePgTimestamptzMin`）を置く。`@mnemora/postgres` は testkit を実行時には import しないので、testkit のヘルパは使えない（ADR 0594 決定2と同じ）。
   - core の `FakeOutboxStore.complete`・`fail`: 同じ位置で、同じ型・文面。実在の `jobId` で下限より前の日時を書いていた件も、これで塞がる。
2. **断る側に寄せる根拠**【判断】:
   - ADR 0594 は「InMemory・Fake を Postgres に寄せる（形の崩れた `jobId` なら静かに返す）」案を、「呼び手のバグを黙って通す側に寄せる理由が無い」と退けた。同じ理屈が下限より前の `opts.at` にも当たる。
   - ADR 0547 決定5は、書く口（行の値になる日時）の `RangeError` を残すと決めた（Postgres が `22008` にするため）。`complete`・`fail` の `opts.at` は書く口であり、読みの口の「下限へ寄せて比べる」は当たらない。反対側（InMemory の `RangeError` を外して Postgres に寄せる）は、この決定に反する。
   - ADR 0423・0521 の「入口で検査する」。
3. **conformance に歯を8本足す**（`outbox-store-conformance.ts`）: `complete`・`fail` × {形の崩れた `jobId`、uuid の形で不在の `jobId`、実在の `jobId`} × 下限より前 → 例外（`peekJob` があれば行に触れていない）。加えて、`complete`・`fail` × 下限ちょうど（実在の `jobId`）→ 例外にならない。例外の型は縛らない（ADR 0594 の conformance と同じ）。型は、Fake の歯（`packages/core/src/__tests__/fake-outbox-complete-fail-at-floor.test.ts`。Fake は conformance に繋がっていない）が `RangeError` と文面で縛る。
4. **core の `OutboxStore.complete` の TSDoc に、下限を書いた。**

### 直す前の赤・直した後の緑・変異【実測】

- 直す前: Postgres の conformance で赤が2本（`complete`・`fail` × 形の崩れた `jobId`。uuid の形の2×2は、DB の `22008` で以前から通っていた）。Fake の歯で赤が6本（`complete`・`fail` × 3つの `jobId`）。対照（下限ちょうど）は両方とも緑のまま。InMemory は直す前から緑。
- 直した後: Postgres の conformance の「下限」8本・Fake の8本・InMemory の conformance の「下限」8本が緑。
- 直しを外す変異: Postgres の `complete` だけ → 赤1本（`complete` × 形の崩れた `jobId`）、`fail` だけ → 赤1本。Fake の `complete` だけ → 赤3本、`fail` だけ → 赤3本。
- やりすぎの変異（下限ちょうども断る）: Postgres → 下限ちょうどの対照が2本赤。Fake → 下限ちょうどの対照が2本赤。
- 変異のたびに、対象を `cp` で退避し、`cp` で戻し、`cmp` で一致を確かめた。

## 🔴 Breaking と数える理由

クローンが、migration の数え方の規律2（⛔）に従って決めた。項目57・60・64（ADR 0594）と同じ形である。【判断】

- **本物の adapter が新しく例外を投げる**: 形の崩れた `jobId` ＋ 下限より前の `opts.at` は、以前の `@mnemora/postgres` では静かに返っていた。
- **例外の型が変わる**: uuid の形の `jobId`（実在・不在とも）で、下限より前の `opts.at` は、`DrizzleQueryError`（`cause.code` `22008`）から `RangeError`（`cause` 無し）に変わる。`cause.code === "22008"` で分岐していた呼び手は、`RangeError` へ分岐し直す。
- **conformance の判定が厳しくなる**: 外部の `OutboxStore` 実装で、形の崩れた・存在しない `jobId` なら下限より前でも静かに返す実装は、新しい歯で赤になる。
- core の Fake は publish される成果物ではない（テスト用）が、Fake を使う利用者の挙動は変わる（以前は書けた下限より前の日時を断る）。

CHANGELOG `[1.3.0]` の `### Breaking` と、migration の項目65に置いた。

## 採らなかった案

- **InMemory の `RangeError` を外し、Postgres の挙動（形の崩れた `jobId` なら静かに返す）に寄せる**: ADR 0594・0547 決定5に反する。
- **Postgres の入口で、下限だけでなく `timestamptz` に入らない値を全部断る**: 上限（紀元後294276年）は JS の `Date` の範囲（約27万年）に収まらない側にあり、`Invalid Date` と下限の2つで足りる。【判断】
- **Fake だけ直さない**: Fake が実在の `jobId` で、Postgres が書けない値を書くのは、「Postgres で通らないテストが Fake で通る」ずれである。

## 引き受けた負債

- **`cause.code` が `22008` で分岐していた呼び手**（`jobId` が uuid の形のとき）は分岐し直す必要がある。🔴 に数えた。
- **testkit の conformance は公開面である**。外部 adapter が `describeOutboxStoreConformance` を使っているなら、「形の崩れた・存在しない `jobId` でも下限より前は投げる」に合わせる必要がある。
- ADR 0594 の `assertValidDate` と、この ADR の `assertNotBelowTimestamptzMin` は別の関数のまま、同じ口に2行並ぶ。1つにまとめる案もあるが、`assertValidDate` は読みの口の将来の利用（Invalid Date だけを断る）を残すため、分けた。【判断】

## 覆るとしたら

オーナーが「べき等な終端更新は、入力が何であれ静かに返る」へ契約を戻したとき（ADR 0594 と同じ）。そのときは、Postgres・Fake の検査と conformance の8本を戻す。

## 確かめていないこと

- 外部の adapter・外部の呼び手が、下限より前の `opts.at` を実際に渡しているか。
- `SQL_ASCII` の DB（実測は UTF8 の DB だけ）。
- 下限の上限側（JS の `Date` の最大値 ±8.64e15 ms は紀元後約27万年で、`timestamptz` の上限の紀元後294276年より内側）。測っていない。
- 1の「outbox の口」のコメントの現状（上に書いた）。

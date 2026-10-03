# ADR 0594: `PostgresOutboxStore.complete`・`fail` は、`opts.at` の Invalid Date を `jobId` の形より先に断る

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-03

出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手の判定、【未確認】は確かめていないこと。

**決めたのはクローン（オーナーの価値観を写した判断役。repo の上ではオーナーと同じ名前に見えるが、オーナーではない）である**（2026-10-03 02:41Z。「Postgres を fixture・Fake の順に寄せる」）。担い手が決めたのは、断る例外の型と文面の置き場所（決定2）と、conformance に足す歯の組（決定3）である。【判断】

## 背景

`PostgresOutboxStore.complete`・`fail` は、`assertWellFormedCtx` の後、まず `isUuidLike(jobId)` が偽なら静かに返し（「べき等な終端更新。存在しない・形式が不正な id でも例外を投げない」という契約）、その後で `opts.at` を使っていた。Invalid Date の検査は入口に無く、`timestamptz` への変換を DB が拒む（`22007`）のに任せていた。【現物】

testkit の `InMemoryOutboxStore` と core の `FakeOutboxStore` は、`opts.at` の Invalid Date を、行を探す前に断る（ADR 0493・0521 の「入口で検査する」）。【現物】

つまり、**形の崩れた `jobId` と Invalid Date を同時に渡すと、Postgres は静かに返し、InMemory・Fake は投げた。**

## 実測（直す前）

`opts.at = new Date(NaN)`、`attempts` は claim で得た値、ctx は同じテナント。自前の Postgres 17（`--encoding=UTF8 --locale=C`）で、`PostgresOutboxStore`・`InMemoryOutboxStore`・`FakeOutboxStore` に同じ組を渡した。【実測】

| `jobId` | Postgres（直す前） | InMemory | Fake |
| --- | --- | --- | --- |
| 形の崩れた（`not-a-uuid`） | `complete`・`fail` とも**静かに返る** | 投げる | 投げる |
| uuid の形だが存在しない | 投げる（`DrizzleQueryError`。`cause.code` は `22007`。message は `Failed query: …`） | 投げる | 投げる |
| 実在 | 投げる（同上） | 投げる | 投げる |

InMemory・Fake が投げるのは、どの組でも素の `Error`・message `complete: opts.at must be a valid Date (got Invalid Date)`（`fail` は先頭が `fail:`）。【実測】

## 決定

1. `PostgresOutboxStore.complete`・`fail` は、`assertWellFormedCtx` の直後、`jobId` の形を見る前に、`opts.at` が Invalid Date（`getTime()` が `NaN`）なら投げる。省略（`undefined`）は検査しない。新しく断る入力は、**「形の崩れた `jobId`」かつ「Invalid Date」**だけである（呼び手のバグの組み合わせ）。uuid の形の `jobId` では、以前から DB が拒んでいた。
2. 例外は、InMemory・Fake と同じ型・同じ文面（素の `Error`、`<method>: opts.at must be a valid Date (got Invalid Date)`）にする。置き場所は `packages/postgres/src/input-check.ts` の `assertValidDate`（新設）。ここには同じ作りの入口の検査（`assertNoNul` ほか。ADR 0424 の系統）が既にあり、`@mnemora/postgres` は testkit を実行時には import しない（`devDependencies`）ので、testkit の `assertQueryDate` は使えない。【判断】
   - **副作用**: uuid の形の `jobId`（実在・不在とも）で Invalid Date を渡したときの例外が、`DrizzleQueryError`（`cause.code` `22007`）から素の `Error`（`cause` 無し）に変わる。断る入力は同じ。【実測】
3. conformance（`outbox-store-conformance.ts`）に歯を4本足す: `complete`・`fail` × {形の崩れた `jobId`、uuid の形だが存在しない `jobId`} で、Invalid Date は例外（`rejects.toThrow()`。型・文面は縛らない——既存の歯と同じ）。形の崩れた `jobId` が新しく縛る歯で、uuid の形の側は上の実測で直す前から緑だが、InMemory の「行を探す前に断る」実装が後退したときの歯として残す。【判断】
4. 下限（紀元前4714年11月24日より前）は今回の対象外（【未確認】、「残り」）。`assertValidDate` は `NaN` だけを見る（core の Fake の `assertFakeQueryDate` と同じ）。

## 採らなかった案

- **InMemory・Fake を Postgres に寄せる（形の崩れた `jobId` なら Invalid Date でも静かに返す）**: クローンが退けた（02:41Z の決定）。呼び手のバグを黙って通す側に寄せる理由が無い。
- **文面を Postgres に合わせず、DB の `22007` に任せる（`jobId` を uuid の形かどうかで分けず、常に DB へ撃つ）**: 形の崩れた `jobId` は uuid 型の列に渡すと `22P02` になるので撃てない（`isUuidLike` が入口に在る理由）。
- **`assertQueryTimestamptz` と同じ下限の検査まで揃える**: 範囲の外。決定4。

## 引き受けた負債

- **`cause.code` が `22007` で分岐していた呼び手**（`jobId` が uuid の形のとき）は、message か `Error` かで分岐し直す必要がある。**🔴（Breaking）と数える**（下の「🟡 か 🔴 か」）。CHANGELOG の `### Breaking`・migration の項目64 に置いた。
- **testkit の conformance は公開面である**。外部 adapter が `describeOutboxStoreConformance` を使っているなら、「形の崩れた `jobId` でも Invalid Date は投げる」に合わせる必要がある。

## 🟡 か 🔴 か（迷った経緯と、決まったこと）

最初、担い手は CHANGELOG の `Changed`・migration の 🟡 に置いた（クローンの最初の指示）。迷いは次の2つだった。【判断】

- **🟡 の根拠**: 型・シグネチャ・既定値は変わらない。実在の `jobId` では、Invalid Date は以前から例外だった。新しく断るのは「形の崩れた `jobId` ＋ Invalid Date」という呼び手のバグの組み合わせだけ。
- **🔴 の根拠**: migration の「数え方の規律への追記（2026-09-28）」の規律2 の ⛔ は、fixture 以外の本物の adapter が新しく例外を投げる変更と、conformance の判定を厳しくする変更を、これまでどおり数えると書く。今回はどちらにも当たる。さらに、uuid の形の `jobId` で例外が `DrizzleQueryError` から素の `Error` に変わる形は、項目57・60 が 🔴 に数えた形と同じである。

**決まったこと**: クローンが、migration の数え方の規律2 に従って 🔴（Breaking）に決めた（破壊的変更を v1.X.0 で出してよいことは、オーナーの回答による）。⟹ CHANGELOG の `[1.3.0]` の `### Breaking` と、migration の 🔴 の項目64 に置いた。上の決定の中身（検査の順を寄せる）は変わらない。

## 覆るとしたら

オーナーが「べき等な終端更新は、入力が何であれ静かに返る」へ契約を戻したとき（ADR 0493 の入口検査の系統が覆るとき）。そのときは、InMemory・Fake の検査順と、conformance の4本を戻す。

## 残り

- 下限より前の日時（`new Date(-1e15)` など）は、InMemory が `RangeError` で（行を探す前に）、Fake は断らず、Postgres は uuid の形の `jobId` では DB が `22008`、形の崩れた `jobId` では静かに返る。同じ形のずれ（形の崩れた `jobId` ＋ 下限より前）が残る。測っていない。【未確認】
- `store-boundary-diff.postgres.test.ts` には、`complete`/`fail` × Invalid Date の組が無い。conformance の4本が、3実装の差を縛る唯一の歯である。
- **同じ書き方のコメント（直していない。取り直した grep の結果。`rg`/`grep -rn "LIMIT must not be negative" packages`、`__tests__` 以外）**: 「Postgres 自身が `LIMIT must not be negative` で例外を投げる」と、評価されなければ投げない（ADR 0575）ことに触れずに書いてある場所。それぞれの口の `LIMIT` が結合の内側・CTE にあるか、最上位かは測っていない（ADR 0575 は `EventStore.list(-1)` などを最上位と見て安全としている）。【未確認】
  - `packages/testkit/src/__fixtures__/in-memory-event-store.ts:122`
  - `packages/testkit/src/__fixtures__/in-memory-vector-store.ts:187`
  - `packages/testkit/src/__fixtures__/in-memory-lexical-store.ts:274`
  - `packages/testkit/src/__fixtures__/in-memory-memory-store.ts:1735`、`:2374`、`:2562`、`:2644`
  - `__tests__` の中: `packages/core/src/__tests__/runtime-fakes.ts:2394`、`packages/testkit/src/__tests__/in-memory-fixtures-archive-decayed-limit.test.ts`、`in-memory-fixtures-requeue-embed-jobs-limit.test.ts`、`in-memory-fixtures-negative-limit.test.ts`（同じ表現が在る。`runtime-fakes.ts` は core の Fake のコメント）
  - 直した場所（ADR 0575 を指す）: `in-memory-outbox-store.ts` の `claimBatch`（コミット 99ff3c97）。
  - `packages/testkit/src/__tests__/` と `runtime-fakes.ts` は、grep の対象外にした `__tests__` の側にも同じ語が在った、という記録で、中身は読んでいない。

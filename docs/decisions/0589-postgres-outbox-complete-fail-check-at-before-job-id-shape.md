# ADR 0589: `PostgresOutboxStore.complete`・`fail` は、`opts.at` の Invalid Date を `jobId` の形より先に断る

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-03

出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手の判定、【未確認】は確かめていないこと。

**決めたのはオーナーである**（2026-10-03 02:41Z。「Postgres を fixture・Fake の順に寄せる」）。担い手が決めたのは、断る例外の型と文面の置き場所（決定2）と、conformance に足す歯の組（決定3）である。【判断】

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

- **InMemory・Fake を Postgres に寄せる（形の崩れた `jobId` なら Invalid Date でも静かに返す）**: オーナーが退けた。呼び手のバグを黙って通す側に寄せる理由が無い。
- **文面を Postgres に合わせず、DB の `22007` に任せる（`jobId` を uuid の形かどうかで分けず、常に DB へ撃つ）**: 形の崩れた `jobId` は uuid 型の列に渡すと `22P02` になるので撃てない（`isUuidLike` が入口に在る理由）。
- **`assertQueryTimestamptz` と同じ下限の検査まで揃える**: 範囲の外。決定4。

## 引き受けた負債

- **`cause.code` が `22007` で分岐していた呼び手**（`jobId` が uuid の形のとき）は、message か `Error` かで分岐し直す必要がある。**🟡 と数える**（CHANGELOG・migration の項）が、本物の adapter が新しく例外を投げる変更と、conformance の判定を厳しくする変更は、migration の「数え方の規律への追記（2026-09-28）」の規律2 の ⛔ では 🔴 に数える側の形である。オーナーが 🟡（Changed）に置くと指示したので従ったが、**数え方が規律と食い違う可能性は残る**。【判断】
- **testkit の conformance は公開面である**。外部 adapter が `describeOutboxStoreConformance` を使っているなら、「形の崩れた `jobId` でも Invalid Date は投げる」に合わせる必要がある。

## 覆るとしたら

オーナーが「べき等な終端更新は、入力が何であれ静かに返る」へ契約を戻したとき（ADR 0493 の入口検査の系統が覆るとき）。そのときは、InMemory・Fake の検査順と、conformance の4本を戻す。

## 残り

- 下限より前の日時（`new Date(-1e15)` など）は、InMemory が `RangeError` で（行を探す前に）、Fake は断らず、Postgres は uuid の形の `jobId` では DB が `22008`、形の崩れた `jobId` では静かに返る。同じ形のずれ（形の崩れた `jobId` ＋ 下限より前）が残る。測っていない。【未確認】
- `store-boundary-diff.postgres.test.ts` には、`complete`/`fail` × Invalid Date の組が無い。conformance の4本が、3実装の差を縛る唯一の歯である。

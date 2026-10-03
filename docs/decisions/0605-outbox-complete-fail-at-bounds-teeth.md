# ADR 0605: OutboxStore.complete・fail の `opts.at` の境界の確かめ直し（ADR 0597）で見つかった穴を塞ぐ（Postgres の例外の型・西暦10000年・紀元前100年）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-04

クローンのマネージャーの作業者が書いた。確かめ直して穴を塞ぐと決めたのは、クローンの判断で、オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手の判定、【前回の確かめ直し】は、PR #1709 の確かめ直しで別の担い手が実測し、マネージャーが依頼に書いてきた観測（この ADR の担い手が再現していないもの。クローンの観測ではない）。
これは試験だけの変更で、実装・CHANGELOG は触らない（[ADR 0600](./0600-erase-tenant-recheck-teeth.md) などの試験だけの PR と同じ）。

## 経緯

マージ済みの [ADR 0597](./0597-outbox-complete-fail-at-below-floor-rejected-and-negative-limit-comment-measured.md)（`OutboxStore.complete`・`fail` は `timestamptz` の下限（紀元前4714年11月24日 00:00 UTC）より前の `opts.at` を `jobId` の形より先に断る）を確かめ直し、3つの穴を見つけた。【前回の確かめ直し】

| #   | 約束・境界（出所）                                                                                                                     | すり抜けた変異                                                                 | 通った理由                                                                                                                    |
| --- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| 1   | 断る例外の型は `RangeError`。ADR 0597 の本文は「型は Fake の歯が縛る」と書く                                                           | `packages/postgres/src/input-check.ts` の `RangeError` を素の `Error` に変える | Fake の歯は Fake の型しか縛らない。Postgres の型を縛る歯が無かった。conformance は型を縛らない（外部の adapter にも効くため） |
| 2   | 下限より後は通す。西暦9999年より後（西暦10000年など。`Date` の範囲内で、Postgres の `timestamptz` にも収まる）も断らない（やりすぎ側） | 上限側（西暦9999年末より後）も断る（Postgres・Fake・InMemory）                 | 通る側の歯が「下限ちょうど」の1点だけだった                                                                                   |
| 3   | 下限と西暦1年の間（紀元前100年など）は、下限より後なので通す（やりすぎ側）                                                             | 下限と西暦1年の間（ちょうど下限は除く）も断る（Postgres・Fake）                | 同上                                                                                                                          |

## 現物で確かめた挙動【実測】

本物の Postgres 17（`--encoding=UTF8 --locale=C.UTF-8`、ポート 55790）、core の Fake、testkit の InMemory に、`complete`・`fail` の `opts.at` を渡した。実在の `jobId`（claim 済み）で、歯の中の `peekJob`・`listJobs` が書いた値を読んだ。

| `opts.at`                                    | Postgres（`PostgresOutboxStore`）                                                                                                                | Fake（`FakeOutboxStore`）  | InMemory（`InMemoryOutboxStore`）                                     |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------- | --------------------------------------------------------------------- |
| 西暦10000年（`Date.UTC(10000, 0, 1)`）       | 断らず通り、同じ値が `completedAt`・`failedAt` に入る                                                                                            | 同じ（通り、同じ値が入る） | 同じ（通り、同じ値が入る）                                            |
| 紀元前100年（`Date.UTC(-99, 0, 1)`）         | 同じ                                                                                                                                             | 同じ                       | 同じ                                                                  |
| 下限の1ms前（`Date.UTC(-4713, 10, 24) - 1`） | `RangeError`（`complete: opts.at must not be earlier than 4714-11-24 BC (…)`。`fail` も同じ形）。形の崩れた `jobId`・実在の `jobId` のどちらでも | `RangeError`（同じ文面）   | 既存の歯が断ることを縛る（型は ADR 0597 の本文のとおり `RangeError`） |

⟹ Postgres は西暦10000年も紀元前100年も実際に通した。止める条件（Postgres が断る）には当たらなかった。

## 決定【判断】

1. 実装は変えない。
2. 歯を足す（試験だけ）。
   - **穴1（型）**: `packages/postgres/src/__tests__/outbox-complete-fail-at-floor-error-type.postgres.test.ts`（Postgres 専用）。`complete`・`fail` × {形の崩れた `jobId`、実在の `jobId`} × 下限の1ms前 → `RangeError` で、文面は `<メソッド>: opts.at must not be earlier than 4714-11-24 BC (the lower bound of a Postgres timestamptz)`。**conformance には置かない**: 型を conformance に足すと、`RangeError` 以外で断る外部の adapter も落とす（ADR 0597 の conformance が型を縛らなかった理由と同じ）。
   - **穴2・3（通る側）**: `packages/testkit/src/outbox-store-conformance.ts` の「`complete`・`fail` は `opts.at` が {紀元前100年, 西暦10000年}（timestamptz の範囲内）なら、例外にせず通り、その値を書く」（4本。`peekJob` があれば書いた値まで見る）。通る側の歯なので、外部の adapter にも課してよい（`timestamptz` の範囲内の日時を拒む adapter は、断りすぎている）。Postgres と InMemory に流れる。
   - **Fake**: `packages/core/src/__tests__/fake-outbox-complete-fail-at-floor.test.ts` に、同じ2つの日時の歯（4本）。Fake は conformance に繋がっていない（Issue #768）。
3. 西暦10000年は、`Date` の範囲（西暦275760年まで）にも Postgres の `timestamptz`（西暦294276年まで）にも収まる値として選んだ。上限側に実装の上限は無く、断る側に倒す理由が無い。

## 変異試験【実測】

実装ファイルを `/tmp/mgr-587fc473-t1709-bak/` に `cp` で退避し、変異を Edit で入れ、名指しのファイルを走らせて赤を確かめ、`cp` で戻して `cmp` で同一を確かめ、同じファイルで緑に戻した。赤と緑は、それぞれ別のコマンドで3回ずつ走らせた。Postgres 17 は、この作業のために立てた専用のインスタンス（ポート 55790）。

| 歯                 | 変異                                                                           | ファイル                                           | 赤になった it（3回とも同じ）                                                                                         | 戻して                                         |
| ------------------ | ------------------------------------------------------------------------------ | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| 1                  | `RangeError` を `Error` に変える                                               | `packages/postgres/src/input-check.ts`             | Postgres 専用の歯 4本すべて（complete・fail × 形の崩れた・実在の `jobId`）                                           | `cmp` 一致。同じファイル 4本 緑（3回）         |
| 2（Postgres）      | 下限より前に加え、`getTime() > Date.UTC(9999, 11, 31, 23, 59, 59, 999)` も断る | 同上                                               | conformance の「complete／fail は opts.at が 西暦10000年（…）なら、例外にせず通り…」2本                              | `cmp` 一致。`-t "範囲内"` 4本 緑（3回）        |
| 2（Fake）          | 同じ上限側の変異                                                               | `packages/core/src/__tests__/runtime-fakes.ts`     | 「complete: 西暦10000年（…）」「fail: 西暦10000年（…）」2本                                                          | `cmp` 一致。ファイル 12本 緑（3回）            |
| 2（InMemory）      | 同じ上限側の変異                                                               | `packages/testkit/src/__fixtures__/query-check.ts` | conformance の西暦10000年の2本（InMemory の適合テストの `-t "範囲内"`）                                              | `cmp` 一致。`-t "範囲内"` 4本 緑（3回）        |
| 3（Postgres）      | 下限より後で西暦1年（`-62135596800000`）より前（ちょうど下限は除く）も断る     | `packages/postgres/src/input-check.ts`             | conformance の「紀元前100年（…）」2本。下限ちょうどの歯は緑のまま                                                    | `cmp` 一致。`-t "下限\|範囲内"` 12本 緑（3回） |
| 3（Fake）          | 同じ変異                                                                       | `packages/core/src/__tests__/runtime-fakes.ts`     | 「complete: 紀元前100年（…）」「fail: 紀元前100年（…）」2本。下限ちょうどの歯は緑のまま                              | `cmp` 一致。ファイル 12本 緑（3回）            |
| 既存側（Postgres） | 下限の定数を1ms下へずらす（`PG_TIMESTAMPTZ_MIN_MS` を `- 1`）                  | `packages/postgres/src/mapping.ts`                 | conformance の既存の2本（complete・fail × 形の崩れた `jobId` の「下限より前なら例外を投げ」）。足した歯4本は緑のまま | `cmp` 一致。`-t "下限\|範囲内"` 12本 緑        |
| 既存側（Fake）     | 下限を1msずらす（`< Date.UTC(-4713, 10, 24) - 1`）                             | `packages/core/src/__tests__/runtime-fakes.ts`     | 既存の6本（complete・fail × 3つの `jobId`）。足した歯は緑のまま                                                      | `cmp` 一致。ファイル 12本 緑                   |

既存側の変異は1回ずつ（足した歯が邪魔をしないことと、既存の歯が赤のままであることを見るため）。紀元前100年の変異は、初めに「ちょうど下限も断る」形で1度当て、依頼の形（ちょうど下限は断らない）に直して当て直した。表は後者。

## 縛っていないもの

- 西暦275760年（`Date` の上限）・西暦294276年（Postgres の `timestamptz` の上限）の境目そのもの。西暦10000年の1点だけ。上限の近くで Postgres が `22008` で断る値は、`Date` の範囲外か、書けても読み返せない値になりうるが、確かめていない。
- InMemory の下限側の変異（下限を1msずらす）と、InMemory への変異3。依頼で当てる対象に入っていない。InMemory の下限側は既存の歯が縛る。
- 紀元前100年・西暦10000年以外の日時（`Date.UTC` の `0..99` 年の読み替えを避けるため、紀元前100年は天文学的年 `-99` で書いた）。
- 例外の型の歯は `complete`・`fail` のこの2つの口だけ。ほかの口（`claimBatch` の `opts.now` など）の型は縛っていない。

## これが覆るとしたら

`timestamptz` の下限以外にも書ける範囲の上限を Postgres 側で設けるとき（そのときは上限側の断りと歯を決め直す）。conformance が例外の型まで縛る方針に変わるとき（そのときは穴1の歯を conformance へ移せる）。

# ADR 0682: 09/28 にマージされた C 群3本（#1365・#1368・#1371）の確かめ直しで見つかった穴に歯を足す（Issue #1827）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-07

**これはクローン（miku）の判断で、オーナーの判断ではない**（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。出所は Issue [#1827](https://github.com/takecchi/mnemora/issues/1827)。
これは試験だけの変更で、実装・`*-conformance.ts`・`__fixtures__/`・core の Fake（`runtime-fakes.ts`）は触らない（変異を一時的に当てただけで、控えを `cp` で取り、`cp` で戻して `cmp` で一致を確かめた）。
C 群の3本は、core のテスト用 Fake の振る舞いを変えた試験の PR である。Fake は store（Postgres と testkit の InMemory）の写しとして約束を持つので、「Postgres・InMemory と同じ振る舞いをする」ことを約束として確かめ直した。

## 経緯【実測】

約束ごとに、足りない側とやりすぎた側の変異を Fake に当てた。結果の表は Issue #1827 のコメントにある。約束が後の採用済み ADR で動いていた点は次のとおり。

- ADR 0630（書いたら読み戻して `MemorySchema` を通らない値は入口で拒む）は、#1365 の「`provenance` の中身の欠け・値域外は受け付ける」を逆にした。この点は当てていない。Fake の側の試験は ADR 0630 の側で書き換わっている。#1365 の「`stated`・`inferred` なのに列の `sourceObservationId` が `null` でも Fake は受け付ける」は動いていないので、今の約束に当てた。
- ADR 0493（Fake・InMemory の入力の検査を Postgres に揃える）は、イベントの `actor`・`meta` の NUL・BigInt、`sizeBeforeBytes` の整数でない値を Fake が拒む形に広げた。広がっただけなので、今の約束に当てた（#1368 の「`sizeBeforeBytes: 1.5` は Postgres だけが拒む」は、ADR 0434 と ADR 0493 で3実装が拒む形になったので、当てていない）。
- ADR 0469（イベントの指す記憶は `ctx` のテナントの行）、ADR 0640（`timestamptz` の下限）は、イベントを積む口の検査を広げた。広がっただけなので、今の約束に当てた。

## 足した歯

| PR    | すり抜けた変異                                                                                                                                                                                                         | 歯                                                                                 |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| #1365 | `provenance.kind` の拒否を冪等の衝突の判定の後へ動かす／行（とラベル）を書いた後へ動かす                                                                                                                               | `packages/core/src/__tests__/fake-create-memory-provenance-kind-rejection.test.ts` |
| #1368 | Observation の Invalid Date の拒否を冪等の衝突の判定の後へ動かす／空文字の `kind`・`subjectId` と数の `attributes` を拒む／`tenantId` を入力から取る                                                                   | `packages/core/src/__tests__/fake-observation-input-store-parity.test.ts`          |
| #1368 | イベントの `meta` がオブジェクトでない（配列・文字列）とき拒む／イベントの `tenantId` を入力から取る                                                                                                                   | `packages/core/src/__tests__/fake-event-input-store-parity.test.ts`                |
| #1368 | `updateStatusWithEvent` が、イベントを組み立てる前に `supersededById` を書く                                                                                                                                           | `packages/core/src/__tests__/fake-event-write-atomicity-side-effects.test.ts`      |
| #1371 | `purgeMemory` が、イベントを組み立てる前にラベルの紐付けと目次帯の要旨を書き換える／`supersedeWithNewMemories` の事前の検査が1件目の対象を見ない／`restoreSupersededBy` が対象の無いときも Invalid Date の `at` を拒む | 同上（`fake-event-write-atomicity-side-effects.test.ts`）                          |

歯は、元の変異を当てると赤になることを確かめてから入れた。

## 塞がなかったもの

- 名指しの歯は緑のままだが、別のファイルが赤にしたもの: Fake が `reflected` の `provenance` を拒む変異（`fake-new-memory-rejects`）、Observation の `null` の日時で `TypeError` になる変異（`fake-written-timestamptz-floor`・`fake-input-checks-round2`・`fake-supersede-atomic-controls`）、`events_purged` の `memoryId: null` まで拒む変異（`fake-memory-store-purge-expired-events`）、`updateStatusWithEvent` が組み立てる前に `updatedAt` を書く変異（`fake-written-timestamptz-floor`）、ペアの口で2件目のイベントを先に組み立てる変異（`fake-event-target-belongs-to-ctx-tenant`）。約束の内の穴ではなく、重ねて歯を足さない。

## 残した食い違い（直していない）

- `supersedeWithNewMemories` で、CAS に弾かれる対象のイベントが書けない（列挙に無い `kind`・Invalid Date の `at`）とき、Postgres は投げずに `conflicted` で返し、Fake と fixture は投げる（Fake は #1371 が fixture に揃えた）。直すかはオーナーの判断。
- `stated`・`inferred` なのに列の `sourceObservationId` が `null` の `Memory` は、Fake だけが受け付ける（#1365 が意図して残した違い。揃えるには core の既存の試験25件のデータを見直す）。
- `payload: undefined` の Observation は、Postgres だけが拒む（Fake と fixture は受け付ける）。

## これが覆るとしたら

Fake の `provenance.kind`・Observation の日時・イベントの入力の拒否と受け付ける形、イベントを積む口が状態を書き換える前にイベントを組み立てること、のどれかが変わるとき。CAS に弾かれる対象のイベントを Postgres に揃えるときは、`fake-event-write-atomicity-side-effects.test.ts` の1件目の対象の試験と見比べること。

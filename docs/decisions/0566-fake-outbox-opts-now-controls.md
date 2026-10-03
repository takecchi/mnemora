# ADR 0566: ADR 0555 の歯の穴を塞ぐ——Fake の outbox 行の時刻を「やりすぎ」「外す」側からも縛り、0555 の文面のずれを訂正する

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-03

クローン miku の委譲先（担い手。マネージャー mgr-49d096cf の指示による）が書いた。決めたのはクローンで、オーナーではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード、【実測】は手元で走らせた結果、【判断】は担い手の判定、【未解決】は直していないこと。

## 何が穴だったか【実測】

[ADR 0555](./0555-core-fake-outbox-rows-honor-opts-now.md)（PR #1666）の歯 `packages/core/src/__tests__/fake-outbox-opts-now.test.ts`（25 本）は、「`opts.now` を渡したら outbox 行の時刻がその値になる」側と、ADR 0555 が直した箇所を戻す変異だけを見ていた。やりすぎる変異と、検査の置き場所を外す変異は、確かめ直しでいくつも生き残った。

| 記号 | 生き残った変異                                                                                                                                                  | 約束（現物）                                                                                                                                     |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| A    | `requeueEmbedJobs` で `memory.updatedAt = new Date(rowOpts.now.getTime())`                                                                                      | `updatedAt` は壁時計のまま（`interfaces/clock.ts`。Postgres は `now()`）                                                                         |
| I    | `createObservationWithOutbox` で `input.recordedAt` が無いとき `observation.recordedAt` を `opts.now` に。`createMemoryWithOutbox` の記憶の `recordedAt` も同様 | 約束が `opts.now` に従わせるのは outbox 行の時刻だけ（Postgres は `input.recordedAt ?? new Date()`）                                             |
| F    | `createMemoryWithOutbox`・`createObservationWithOutbox` の冒頭で `assertFakeOutboxRowsWritable` を呼ぶ                                                          | 行を実際に書くときだけ見る（[ADR 0493](./0493-fake-and-inmemory-input-checks-aligned-to-postgres.md)）。冪等な再送（`created: false`）は断らない |
| D    | `supersedeWithNewMemories` の検査 loop を `news.slice(0, 1)` に                                                                                                 | 全部の news を、何も書く前に検査する（ADR 0555 決定3）                                                                                           |
| H    | `enqueueJob` の `availableAt`・`createdAt` を `new Date(now.getTime())` でなく `now` 自身に                                                                     | 行ごとに `Date` の複製を持つ（ADR 0555 決定1）。歯が全部 `toEqual` で、参照の共有を見分けなかった                                                |
| C    | `jobKinds` が空なら見ない、の歯が `createMemoryWithOutbox` にしか無い                                                                                           | 3つの口とも、行を積まないなら `opts` を見ない                                                                                                    |

## 足した歯【実測】

`packages/core/src/__tests__/fake-outbox-opts-now-controls.test.ts`（新しいファイル。既存の `fake-*.test.ts` は編集していない）。期待値は `packages/testkit` の `InMemoryMemoryStore` と `packages/postgres/src/memory-store.ts` を読んで合わせた（Postgres は `outboxNow` を行を INSERT するときにだけ `toPgTimestamp` で読み、`recorded_at` は `input.recordedAt ?? new Date()`、`updated_at` は壁時計）。

- A・I: `requeueEmbedJobs` の `updatedAt` が壁時計、`createObservationWithOutbox` の `recordedAt` の既定が壁時計・渡せばその値、`createMemoryWithOutbox`・`supersedeWithNewMemories` の記憶の `recordedAt` が入力のまま（5本）。
- F: `createMemoryWithOutbox`（Invalid Date・NUL の2本）、`createObservationWithOutbox`（externalId が衝突する再送で、Invalid Date・NUL・`claimedBy` の NUL、1本）。
- D: 2件目の `jobKinds` の NUL を、1件目も書かずに断る／1件目が空でも2件目が積むなら Invalid Date を断る（2本）。
- H: 4つの口を `describe.each` で通し、`availableAt`・`createdAt` が `opts.now` とも互いにも他の行とも別の `Date` であること、返った job の `Date` を書き換えても `opts.now` や他の行に響かないこと（2本×4口 = 8本）。
- C: `createObservationWithOutbox`（Invalid Date・`claimedBy` の NUL）、`supersedeWithNewMemories`（全 news が空）（2本）。

合計 20 本（`it.todo` を除く）。

## 変異試験【実測】

変異を1つずつ `runtime-fakes.ts` に入れ、`fake-outbox-opts-now-controls.test.ts`（と、本文が数える欄は `fake-outbox-opts-now.test.ts`）を走らせ、`git checkout` で戻した。戻した後は 2 ファイルで 45 本緑・1 todo。

| 変異                                                                             | 赤になった it                                                                                                     | 戻すと |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------ |
| A: `requeueEmbedJobs` の `updatedAt` を `opts.now` に                            | 1（`updatedAt` を壁時計のままにする）                                                                             | 緑     |
| I: `createObservationWithOutbox` の `recordedAt` の既定を `opts.now` に          | 1（壁時計を使う）                                                                                                 | 緑     |
| I: `createMemoryWithOutbox` の記憶の `recordedAt` を `opts.now` に               | 1（`recordedAt` に `opts.now` を使わない）                                                                        | 緑     |
| F: `createMemoryWithOutbox` の冒頭で検査                                         | 2（Invalid Date・NUL の再送）                                                                                     | 緑     |
| F: `createObservationWithOutbox` の冒頭で検査                                    | 1（再送）                                                                                                         | 緑     |
| D: `news.slice(0, 1)`                                                            | 2（2件目の NUL・1件目が空のときの Invalid Date）                                                                  | 緑     |
| H: `availableAt` を `now` 自身に                                                 | 8（4口×2）                                                                                                        | 緑     |
| H: `createdAt` を `now` 自身に                                                   | 8（4口×2）                                                                                                        | 緑     |
| C: `assertFakeOutboxRowsWritable` の `if (jobKinds.length === 0) return;` を外す | 3（`createMemoryWithOutbox` の既存の1本、新しい `createObservationWithOutbox`・`supersedeWithNewMemories` の2本） | 緑     |

- **F の supersede の変異は入れていない。**今の `supersedeWithNewMemories` は最初から、news を作る前に全部の news を検査している（「冒頭に置く」形が現状）ので、変異になる余地が無い。逆向きの食い違いは下の【未解決】を見ること。
- I の `supersedeWithNewMemories` の歯（記憶の `recordedAt`）については、対応する変異を入れていない。

## ADR 0555 の訂正【実測】【現物】

0555 の本文は書き換えない（この ADR が訂正を持つ）。

1. **変異表の赤の本数が現物とずれている。**0555 の表を作った後に、戻り値の `jobs` を見る2本が足されたため（0555 の歯の節にも「2本」と書いてある）。現物の `fake-outbox-opts-now.test.ts` で再実測した:

   | 変異                                              | 0555 の表 | 現物 |
   | ------------------------------------------------- | --------- | ---- |
   | `enqueueJob` の `availableAt` を `new Date()` に  | 14        | 16   |
   | `enqueueJob` の `createdAt` を `new Date()` に    | 10        | 12   |
   | `createObservationWithOutbox` が `now` を渡さない | 3         | 6    |
   | `supersedeWithNewMemories` が `now` を渡さない    | 2         | 3    |

   他の行は再実測していない。`createObservationWithOutbox` の「渡さない」は `{ claimedBy: rowOpts.claimedBy }` だけを渡す形で入れた（`claimedAt` も壁時計になるので、本数は変異の入れ方に依る）。

2. **名前の誤り。**`enqueueJob` は、現物では `FakeMemoryStore.enqueueJob`（`runtime-fakes.ts` の private メソッド）。`FakeBackingStore`（共有の保管庫）にも `FakeOutboxStore` にも `enqueueJob` は無い。0555 の本文は `enqueueJob` とだけ書いていて、この誤った名前は出てこない（`grep` で確認）。誤った名前は、0555 が書き換えたコメントの2か所にある: `abort-signal.test.ts` の「以前の Fake は `availableAt` を `FakeBackingStore.enqueueJob` が…」と `runtime.test.ts` の同趣旨の1か所。どちらも既存のテストファイルの中のコメントで、この PR では直していない（衝突を避けるため。読むときは `FakeMemoryStore.enqueueJob` と読み替えること）。

## 【未解決】supersede の冪等な再送を、Fake は先に断る

足した歯の確認中に見つかった、Fake の本物のずれ。`supersedeWithNewMemories` の全部の news が既存の行に当たる（`created: false` になる）再送でも、Invalid Date の `opts.now`・`jobKinds` の NUL を Fake は先に断る。`InMemoryMemoryStore`（`createMemoryIdempotent` の `beforeInsert` で、行を書くときだけ検査し、失敗したら書き込みを巻き戻す）と `PostgresMemoryStore`（job を INSERT するときにだけ時刻を読む）は断らない。`createMemoryWithOutbox`・`createObservationWithOutbox` の Fake は ADR 0493 のとおり断らない。

直さなかった理由【判断】: 直しは news を作る loop に入る。そこは開いている PR #1674（ADR 0564。`supersedeWithNewMemories` の原子化、`runtime-fakes.ts` の約 1565 行目以降）が書き換えていて、原子化（失敗したら巻き戻す）が入れば、検査を `createMemoryIdempotent` の `beforeInsert` へ移して InMemory と同じ形にできる。先に私が直すと、同じ範囲を二重に書き換える。歯は `it.todo` として `fake-outbox-opts-now-controls.test.ts` に名前だけ残した。#1674 のマージ後に、`it.todo` を赤い歯にして直すこと。

## `runtime-fakes.ts` について【現物】

この PR は `runtime-fakes.ts` を**触っていない**（変異試験で一時的に書き換え、全て `git checkout` で戻した）。足した歯は、上の【未解決】の1件を除き、今の main で緑。

## CHANGELOG と migration【判断】

- **CHANGELOG は書かない。**変えたのは `packages/core/src/__tests__/` の新しいテストだけで、テスト用の非公開の Fake は出荷物に入らない（0555 決定4と同じ）。公開 API・型・testkit・Postgres・runtime は触っていない。
- **`docs/migration-v1.md` の項目21（`describeMemoryStoreConformance`/`describeOutboxStoreConformance` の項）の「どう直すか」の「（これらの欄は壁時計のまま）」は、今の main でも残っていた**（1307 行目）。[ADR 0559](./0559-clock-reaches-outbox-available-at.md) が示したとおり、`Runtime` は注入した時計の値を outbox の `available_at` へ渡す。この括弧は「`Runtime` からの呼び出しが、これらの欄を壁時計のままにする」とも読めるため、「自分の実装が渡された値を無視し続ける間、その実装が書く欄は壁時計のまま。`Runtime` 自身は注入した時計の値を渡している」と書き直した（意味は変えていない。ADR 0559 は migration-v1.md を直していなかった）。

## 走らせたもの【実測】

`fake-outbox-opts-now-controls.test.ts` と `fake-outbox-opts-now.test.ts`（合わせて 45 本緑、1 todo）、`tsc --noEmit -p packages/core`、prettier --check、eslint。全テストは走らせていない。

## これが覆るとしたら

interface の `opts.now` の約束が変わるとき（0555 と同じ）。【未解決】の件は、#1674 のマージ後に直した時点で、この節を消すのでなく追記で閉じる。

---

## 追記（ADR 0577）: 上の【未解決】は解けた

`supersedeWithNewMemories` の冪等な再送の件は [ADR 0577](./0577-fake-supersede-idempotent-resend-skips-opts-checks.md) で直した（検査を news を作る loop の中へ移し、`it.todo` を歯にした）。上の本文は当時のまま残す。

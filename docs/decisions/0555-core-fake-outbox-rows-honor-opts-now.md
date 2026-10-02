# ADR 0555: core の Fake が積む outbox 行の時刻も、`opts.now` に従う（`availableAt`・`createdAt`。InMemory・Postgres と揃える）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-03

クローン miku の委譲先（担い手。マネージャー mgr-172a1ac7 の指示による）が書いた。決めたのはクローンで、オーナーではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード、【実測】は手元で走らせた結果、【判断】は担い手の判定。

## 割れ【現物・実測】

- 約束: `MemoryStore` の interface（`packages/core/src/interfaces/memory-store.ts` の `createObservationWithOutbox`・`createMemoryWithOutbox`・`supersedeWithNewMemories`・`requeueEmbedJobs`）は、「`opts.now` を渡すと、積む outbox 行の `availableAt`/`createdAt` にその値を使う。省略時は実装が壁時計を使う」と書いている（[ADR 0407](./0407-sync-observe-extract-job-lease.md) は `claimedBy` のときの `claimedAt` を同じ値にした）。`PostgresMemoryStore` と testkit の `InMemoryMemoryStore` は `const outboxNow = opts?.now ?? new Date()` と、呼び出しの中で壁時計を1回だけ読んで、積む全部の行に使う。
- 割れ: `packages/core/src/__tests__/runtime-fakes.ts` の `FakeMemoryStore` は、共通の `enqueueJob` が `availableAt`・`createdAt` にいつも `new Date()` を入れていた（`claimedAt` だけ `opts?.now ?? new Date()`）。さらに口ごとに:
  - `createObservationWithOutbox`: `opts` を `enqueueJob` へ渡していたが、上の理由で `now` は `claimedAt` にしか効かなかった。
  - `createMemoryWithOutbox`・`supersedeWithNewMemories`: `enqueueJob` へ `opts` を渡していなかった（前者は `opts` の引数自体が無く、後者は Invalid Date の検査にだけ使っていた）。
  - `requeueEmbedJobs`: `writeOpts.now` を検査するだけで、`enqueueJob` へ渡していなかった。
- 実害: 注入した時計が実時刻より過去だと、Fake に積まれた job は `availableAt <= now` を満たさず、`claimBatch` が拾えなかった。この食い違いをよけるために、約13本のテストが時計を実時刻より先に置くか実時計に切り替えている（下の「残り」）。

## 決定【判断】

1. 共通の `enqueueJob` が `const now = opts?.now ?? new Date()` と1回だけ読み、`availableAt`・`createdAt`・`claimedAt` に使う（行ごとに `Date` の複製を持たせる。Postgres が行ごとに別の値を返すのと同じで、返した job を書き換えても他の行に響かない）。
2. 4つの口は、呼び出しの中で `now` を1回だけ解決して（`opts?.now ?? new Date()`）全部の行へ渡す。`enqueueJob` に任せると、1回の呼び出しが積む複数の行で壁時計を読み直して値が割れる（InMemory・Postgres は割れない）。`createMemoryWithOutbox` には `opts?: { now?: Date }` を足した（interface と同じ形）。
3. `supersedeWithNewMemories` は、`opts.now` の Invalid Date に加えて `jobKinds` の NUL も、行を書く前に断るようにした（`assertFakeOutboxRowsWritable` を news ごとに呼ぶ）。**「受け取りと受け渡しを足すだけ」の範囲を一歩だけ越えている**: 先に置かれた赤いテスト（`supersedeWithNewMemories は、jobKinds に NUL があれば何も書かずに断る`）が要求していたのに、Fake は NUL を見ていなかった。`createMemoryWithOutbox` の NUL の検査（ADR 0493）と同じ関数なので、足した。
4. **CHANGELOG と migration は書かない**: Fake は core の `src/__tests__/` にあるテスト専用で、公開していない（パッケージの出荷物に入らない）。
5. 公開 API・型・testkit・Postgres・runtime は触っていない。

## 歯と実測【実測】

- 歯: `packages/core/src/__tests__/fake-outbox-opts-now.test.ts`（25 本）。4つの口を `describe.each` で同じ4本に通す: (1) `opts.now` を渡すと `availableAt`・`createdAt` がその値で `claimedAt` は null、(2) 過去の clock の `claimBatch` が積んだ job を全部拾う、(3) 省略すると呼ぶ前と後の間の壁時計、(4) 省略したとき、壁時計が読むたびに1ms進むと仮定しても、1回の呼び出しの全部の行が同じ時刻（`Date` を差し替えて壁時計の読み直しを検出する）。加えて `createObservationWithOutbox` の `claimedBy` のとき `claimedAt` も同じ時刻、Invalid Date・NUL の拒否、**戻り値の `jobs` も `opts.now` を使う**（testkit の適合テストの `opts.now` のケースに相当する歯を、Fake に1本ずつ。2本）。
- 直す前の赤: 先に置かれた23本のうち16本が赤、7本が緑。赤は4つの口の (1)(2)(4) の12本、`claimedBy` の2本（時刻が実時刻のまま／3つの時刻が割れる）、`createMemoryWithOutbox` の Invalid Date を断らない1本、`supersedeWithNewMemories` の NUL を断らない1本。(3) の4本は元から緑（壁時計にはなっていたので）。直した後は 25 本とも緑。
- 変異試験（直した箇所を1つずつ誤りへ戻し、戻した後は緑）:

| 変異した箇所 | 赤になった it |
|---|---|
| `enqueueJob` の `availableAt` を `new Date()` に | 14（4つの口の (1)(2)(4) と `claimedBy` の2本） |
| `enqueueJob` の `createdAt` を `new Date()` に | 10（4つの口の (1)(4) と `claimedBy` の2本。(2) は `availableAt` だけを見るので赤にならない） |
| `enqueueJob` の `claimedAt` を `new Date()` に | 2（`claimedBy` の2本） |
| `createObservationWithOutbox` が `now` を渡さない | 3（(1)(2) と `claimedBy` の (1)） |
| `createObservationWithOutbox` の1回読みを外す（`opts` をそのまま渡す） | 2（(4) と `claimedBy` の (4)） |
| `createMemoryWithOutbox` が `now` を渡さない | 2（(1)(2)） |
| `supersedeWithNewMemories` が `now` を渡さない | 2（(1)(2)） |
| `requeueEmbedJobs` が `writeOpts.now` を渡さない | 2（(1)(2)） |
| `requeueEmbedJobs` の1回読みを外す | 1（(4)） |
| `supersedeWithNewMemories` の NUL の検査を外す | 1（NUL） |

- 既存の歯（前後比較）: Fake・clock・`tick`・`claimBatch`・`listJobs` を一緒に使うテストファイルを、`grep -lE "createFakeRuntimeStores|FakeMemoryStore|runtime-fakes" -r src --include=*.test.ts` の結果から「`claimBatch`・`listJobs` のどちらかと、`tick(` と `clock` のどちらか」「`tick(` と `clock` の両方」のどちらかを含むものとして39本に絞り（和集合。正確な名前の一覧は PR 本文）、直す前と直した後に名指しで走らせた。**直す前 39 ファイル 672 本緑、直した後 39 ファイル 672 本緑**（変化なし）。全テストは走らせていない。
- 型検査: `tsc --noEmit -p packages/core` は通る（出力なし）。

## 直したコメント【判断】

「固定 clock だと claim されない」「Fake の outbox 行の `availableAt` は実時刻で付くので」と、今の Fake について嘘になるコメントを、「以前の Fake は…だった。今は `opts.now` に従う（ADR 0555）。組み替えていない」へ書き換えた: `reflect.test.ts`（2か所）・`consolidate.test.ts`（2か所）・`runtime.test.ts`・`abort-signal.test.ts`・`observe-attributes.test.ts`・`embed-job-error-cause.test.ts`・`tick-last-error-cause.test.ts`・`tick-last-error-redacts-params.test.ts`・`extract-redelivery-unsaveable-fake.test.ts`・`tick-batch-lease-expiry.test.ts`・`runtime-branch-teeth.test.ts`・`embed-job-missing-vector.test.ts`・`decay-activity-clock-memory-own-subject.test.ts`。コードは変えていない。

## 引き受けた負債（残り）

- **テストの組み替えをしていない。** 上の13ファイルは、時計を実時刻より先に置くか実時計に切り替えている。Fake が直ったので、固定の過去の時計に組み替えられる。だが組み替えは各テストが縛っているものを変えうるので、この PR では範囲外とした。
- **Fake は testkit の適合テストを通らない（Issue #768）。** 適合テストの `opts.now` のケース（`memory-store-conformance.ts` の `createObservationWithOutbox`・`createMemoryWithOutbox` の `opts.now` の2本）は、Fake に対して走っていない。この ADR の歯（`fake-outbox-opts-now.test.ts`）が同じ期待を Fake へ別に当てているだけで、適合テストの追加・変更に自動では追随しない。`supersedeWithNewMemories`・`requeueEmbedJobs` の `opts.now` の適合テストが在るかは確かめていない。
- **`write-diff-fuzz-harness.ts`・`write-diff-fuzz.test.ts` の「outbox の `available_at` は store が実時刻で埋める」という注記は、直していない**（Postgres 側の話で、範囲外。今も正しいかは確かめていない）。`runtime.ts` の `clock` の TSDoc（「注入した時計は…outbox の `availableAt` など には届かず」）と `interfaces/clock.ts` の記述も、現物の `runtime.ts` が `now` を渡している箇所（`createMemoryWithOutbox`・`createObservationWithOutbox`・`requeueEmbedJobs`）と食い違って見えるが、本 ADR は触っていないし、食い違いを確かめてもいない（公開の TSDoc なので別の PR で扱う）。

## 採らなかった案

- 口ごとに壁時計を読ませる（`enqueueJob` の読みだけを直す）。1回の呼び出しが複数の行を積む口で値が割れ、InMemory・Postgres と合わない（歯の (4) が見張る）。
- 先の時計をよけたテストを一緒に組み替える。上の理由で採らなかった。

## これが覆るとしたら

interface の `opts.now` の約束（積む outbox 行の時刻に使う）が変わるとき。そのときは3実装（Fake・InMemory・Postgres）を一緒に直す。

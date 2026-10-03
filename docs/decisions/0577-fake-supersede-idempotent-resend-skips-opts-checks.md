# ADR 0577: Fake の `supersedeWithNewMemories` は、全部の news が既存の行に当たる冪等な再送で opts・jobKinds を断らない（ADR 0566 の未解決を解く）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-03

クローンの委譲先（担い手。マネージャー mgr-919c76c2 の指示による）が書いた。決めたのはクローンで、オーナーではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード、【実測】は手元で走らせた結果、【判断】は担い手の判定。

## 経緯【現物】

[ADR 0566](./0566-fake-outbox-opts-now-controls.md) の【未解決】: `packages/core/src/__tests__/runtime-fakes.ts` の `FakeMemoryStore.supersedeWithNewMemories` は、冒頭で全部の news の `jobKinds` と `opts` を検査していた。そのため、全部の news が既存の行に当たる冪等な再送でも、Invalid Date の `opts.now`・`jobKinds` の NUL を先に断った。`InMemoryMemoryStore`・`PostgresMemoryStore` は行を書くときだけ見て、`created: false` を返す。0566 は、同じ範囲を書き換えていた #1674（[ADR 0564](./0564-core-fake-supersede-atomic-and-new-row-retention-default.md) の巻き戻し）のマージを待って直す、と `it.todo` に残していた。0564 は main に入っている。

## 決定【判断】

1. 検査（`assertFakeOutboxRowsWritable`）を冒頭から、news を作る loop の中（`createMemoryIdempotent` が `created: true` を返したとき、`enqueueJob` の前）へ移した。`created: false` の news は検査しない。
2. 壁時計（`opts?.now ?? new Date()`）は、最初に行を積むときに1回だけ読み、以降の news はその値を使う（ADR 0555 の「呼び出しの中で1回だけ」は保つ）。全部が再送なら、壁時計も読まない。
3. 先の news を作った後で、後ろの news の検査が投げても、ADR 0564 の `catch` が先に作った記憶・索引・ラベル・outbox の行を戻す。ADR 0555 の変異 D の歯「2件目の `jobKinds` に NUL があれば、1件目も書かずに断る」の性質は保たれる。
4. `it.todo` を実際の歯にした（`fake-outbox-opts-now-controls.test.ts`。Invalid Date の `opts.now` と `jobKinds` の NUL の2本。再送で断らず、`created: false`・`jobs: []`・outbox 行が増えない）。
5. エラーの出る順番は変わる: 以前は `supersededByIndex` の範囲外・not found・イベント検査より前に opts・NUL を断った。今は後ろ（記憶を作る loop）で断る。`supersedeWithNewMemories` を叩く core の既存テスト17ファイルは、変更なしで緑だった（順番に依存するものは無かった）。
6. 採らなかった案: 検査を `createMemoryIdempotent` の中（`InMemoryMemoryStore` の `beforeInsert` と同じ形）へ移す案。Fake は検査と書き込みが同居していて、`supersede` の事前検証との順を保ちやすいのは loop の中だった。

## CHANGELOG と migration【判断】

書かない。変えたのは `packages/core/src/__tests__/` の非公開の Fake とテストだけで、出荷物に触れない（0555 決定4・0573 と同じ）。

## 走らせたもの【実測】

- 直す前: 新しい2本の歯が赤（`supersedeWithNewMemories: opts.now must be a valid Date`、`jobKinds must not contain NUL characters`）。
- 直した後: `fake-outbox-opts-now-controls.test.ts`、`fake-memory-store-supersede-atomic.test.ts`、`fake-tenant-settings-new-row-retention-default.test.ts`、その他 `supersedeWithNewMemories` を叩く core のテストを合わせて17ファイル・544本が緑。`tsc --noEmit -p packages/core`、prettier --check、eslint。全テストは走らせていない。
- 変異: 検査を冒頭へ戻す → 新しい2本が赤。検査を消す → 変異 D の2本（2件目の NUL、1件目が空で2件目が Invalid Date）が赤。戻した後は差分が直しだけであることを確かめた。

## これが覆るとしたら

InMemory・Postgres が、再送でも opts を検査する側へ変わるとき。

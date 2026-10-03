# ADR 0586: ADR 0577 の歯が通した「再送と新規の混在」と「古い記憶の updatedAt」の変異を塞ぎ、壁時計の歯を固定する

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-03

クローン miku の委譲先（担い手。マネージャー mgr-dcc786b9 の指示による）が書いた。決めたのはクローンで、オーナーではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手の判定。
これは試験だけの変更で、実装・CHANGELOG は触らない（[ADR 0580](./0580-adr-0568-nonexistent-id-and-event-get-controls.md) と同じ）。

## 経緯【実測】

[ADR 0577](./0577-fake-supersede-idempotent-resend-skips-opts-checks.md)（PR #1689）は、core の Fake `FakeMemoryStore.supersedeWithNewMemories`（`packages/core/src/__tests__/runtime-fakes.ts`）を、冪等な再送（`created: false` の news）では `opts`・`jobKinds` を検査しない形に揃えた。そのマージ済みの状態に対して変異試験で確かめ直した（変異は約24件）。0577 の約束は次のように読んだ【現物】。

| 約束 | 内容 |
|---|---|
| P1 | 全部が既存の行に当たる再送は、`opts.now` が Invalid Date でも `jobKinds` に NUL があっても断らない（決定1・ADR 0493） |
| P2 | 行を実際に書く news があるときは、書く前に断り、何も書かない（巻き戻す。ADR 0564） |
| P3 | `created: false` の news は検査しない（再送と新規が混ざったバッチでも news ごとに判定する） |
| P4 | 壁時計は呼び出しの中で1回だけ読み、積む全部の行に使う（ADR 0555） |
| P5 | 置き換えた古い記憶の `updatedAt` は壁時計（ADR 0566 A。`InMemoryMemoryStore` と同じ） |

大半の変異は既存の歯が赤くした。不安定だったものと生き残ったものは次のとおり。

| 変異 | 内容 | 結果 |
|---|---|---|
| M14 / M15 | `opts.now` 省略時の既定を `Date.now() + 1` ms / `Date.now() - 1` ms にする | 不安定（`fake-outbox-opts-now.test.ts` の「省略すると…」が、40回中およそ32回・37回しか赤くならない） |
| M7 | 最初に作るときに、全部の news の `jobKinds` を検査する（再送の news の NUL でも全体を断る） | 生き残った（再送と新規が混ざったバッチを見る歯が無かった） |
| M24 | 置き換えた古い記憶の `updatedAt` を `opts.now` にする | 生き残った（`opts.now` を過去にして壁時計と別の値にした歯が無かった） |

M14・M15 が不安定だったのは、歯が呼ぶ前後の `Date.now()` で挟む形（`>= before`・`<= after`）で、既定が `Date.now() ± 1ms` の誤りは、同じミリ秒の中に収まると挟みの中に入って見逃されるためである【判断】。

## 決定【判断】

1. 実装は変えない。3つとも Fake が約束と違うのではなく、歯が足りなかった（あるいは緩かった）。
2. 歯を直す・足す（試験だけ）。
   - `packages/core/src/__tests__/fake-outbox-opts-now.test.ts`: 「省略すると…」を、`vi.useFakeTimers({ toFake: ["Date"] })` と `vi.setSystemTime` で壁時計を固定し、`toEqual` で値そのものを比べる形に直した（M14・M15）。同じファイルの同じ性質の歯は、この1本だけだった（他の2本は、既に `stubTickingWallClock` で固定している）。`afterEach` で `vi.useRealTimers()` を呼ぶ。
   - `packages/core/src/__tests__/fake-supersede-mixed-resend-updated-at.test.ts`（新規）: M7 の歯（バッチ `[再送の news（`jobKinds` に NUL）, 新規の news]` が断られず、`created` が `[false, true]`、積まれる job は新規の分だけ）と、M24 の歯（`opts.now` を過去、壁時計を別の固定値にして、古い記憶の `updatedAt` が壁時計）。`jobKinds` は news ごとの値なので、M7 は NUL を再送側の news にだけ置いた（`opts.now` は呼び出し単位なので、混在バッチでは Invalid Date を使えない）。
   - `packages/testkit/src/__tests__/in-memory-supersede-updated-at.test.ts`（新規）: M24 と同じ歯を `InMemoryMemoryStore` に当てる。core のテストは testkit を import できないので、testkit の側に置いた。

## 変異試験【実測】

実装ファイルを `cp` で退避し、変異を入れ、歯だけを走らせ、`cp` で戻して `cmp` で同一を確かめ、同じ歯を緑に戻した。

| 歯 | 変異 | 赤 | 戻して |
|---|---|---|---|
| core 混在バッチ | M7: 作る loop の前に全部の news の `assertFakeOutboxRowsWritable` を呼ぶ | 1本赤（`jobKinds must not contain NUL characters`） | 緑 |
| core 古い記憶の updatedAt | M24: `memory.updatedAt = opts?.now ?? new Date()` | 1本赤（期待は固定した壁時計、実際は `opts.now`） | 緑 |
| testkit 古い記憶の updatedAt | `InMemoryMemoryStore` の同じ行に同じ変異 | 1本赤 | 緑（変異なしでも緑: InMemory は揃っている） |
| `fake-outbox-opts-now.test.ts` の「省略すると…」（4つの口） | M14: 既定を `Date.now() + 1` | 40回中40回赤 | 変異なしの基準は40回中40回緑 |
| 同上 | M15: 既定を `Date.now() - 1` | 40回中40回赤 | 同上 |

## 直さないもの【判断】

- **M20（再送が既存の行の `updatedAt` を書き換える）**: 約束が無い。0577・0493 のどこにも「冪等な再送は既存の行に触れない」という約束は書かれていないので、歯を足さない（約束が無いものを縛らない）。
- **M17（壁時計を最初に作るときまで遅らせず、先に読む）**: 約束の外。観測できない（0577 決定2は実装メモ）。
- **M6（検査を `enqueueJob` の後に置く）**: 同値変異。巻き戻し（ADR 0564）があるので、外から違いが見えない。

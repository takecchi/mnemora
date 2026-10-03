# ADR 0583: core の Fake の `supersedeWithNewMemories` も写しを返し、ADR 0578 の【未確認】だった口ごとの変異を入れる

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-03

クローンの委譲先（担い手。マネージャー mgr-4ba236a4 の指示による）が書いた。決めたのはクローンで、オーナーではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード、【実測】は手元で走らせた結果、【判断】は担い手の判定、【未確認】は確かめていないこと。

## 背景【現物】

[ADR 0578](./0578-core-fake-returns-copies-for-remaining-writers.md) は、core の Fake（`packages/core/src/__tests__/runtime-fakes.ts`）の残りの口を写しを返す形に直したが、次の2つを残していた。

- `supersedeWithNewMemories` の `created[].jobs`（`enqueueJob` が backing に積んだ行そのもの）と、`superseded` の event（`backing.events` に積んだオブジェクトそのもの）は「別の担当（#1689、[ADR 0577](./0577-fake-supersede-idempotent-resend-skips-opts-checks.md)）が同じメソッドを直しているので触らない」。
- 変異試験は直した口ごとには入れておらず、`resolveContestedPair`・`restoreSupersededBy`・`updateStatusWithEvent`・`reinforceMany`・`registerLabel` などは「直す前に赤だった」ことと `scribble` が届くことで間接的に支えているだけ【未確認】。

本 ADR は #1689 を取り込んだ上で、この2つを片付ける。

## 決定【判断】

1. `supersedeWithNewMemories` の `created[].jobs` を `jobs.map((job) => fakeSnapshot(job))`、`superseded` の event を `fakeSnapshot(storedEvent)` にした（`createMemoryWithOutbox`・`updateStatusWithEvent` と同じ作法）。触ったのは `created.push(... jobs ...)` と `superseded.push(...)` の行だけで、#1689 の検査の位置（`assertFakeOutboxRowsWritable`・`rowOpts ??=`）は触っていない。`created[].memory` は ADR 0562 で写し済み、`conflicted` は新しく組んでいるので対象外。
2. 歯は既存の `fake-returns-copies-for-writers.test.ts` に describe を足した（新しいファイルにしない理由: `scribble`・`seed`・`newMemory`・`eventInput`・`Stores` を同じファイルの中で共有でき、「返り値を書き換えても行は変わらない」歯が1か所に揃う）。`created[].jobs` を書き換えて `listJobs`・`claimBatch` が変わらないこと、`superseded` を書き換えて `eventStore.get/list/events` が変わらないことの2本と、対照2本（jobs は store の job と同じ id・中身で Date のまま・凍結されていない／event は eventStore と同じ中身で `at` は Date・`meta.supersededById` は作った記憶の id・古い行は get で superseded）。

## 実測【実測】

- **直す前**（歯だけを当てた WIP commit）: 50 本中 **2 本が赤**（`created[].jobs を書き換えても、listJobs・claimBatch は変わらない`、`superseded の event を書き換えても、eventStore の get・list は変わらない`）、48 本が緑（対照2本を含む）。
- **直した後**: `fake-returns-copies-for-writers.test.ts`（50 本）と `fake-isolates-caller-mutation.test.ts`（24 本）で 74 本緑。`runtime-fakes` を import している core のテスト 205 ファイルを名指しで走らせ、2518 本緑。core の `tsc`、変更2ファイルへの eslint・`prettier --check` も指摘なし。

### `createMemoryWithOutbox` の M2 は `created: false` 側にも入るか

ADR 0578 の M2（`createMemoryWithOutbox` の `memory` が行をそのまま）が両側に入っていたかは表からは読めなかったので、側ごとに再現した。

| 変異 | 赤になった歯 |
|---|---|
| 新規側（`created: true`）だけ `memory: memory` | `memory（新規・既存の両方）と jobs を書き換えても…`、対照 `createMemoryWithOutbox が作った行は liveRowForTest で…`（2本） |
| `created: false` 側だけ `memory: memory` | `memory（新規・既存の両方）と jobs を書き換えても…`（1本） |

**M2 は新規側の変異だった可能性が高いが、`created: false` 側だけの変異でも同じ歯が赤になる**（`scribble(again.memory)` が行を書き換え、`expectRowUnchanged` が見つける）。両側とも歯で縛られている。ただし ADR 0578 の M2 が実際にどちらを外したかは、当時の変異の記録が無く確かめられない【未確認】。

### 変異の表

`runtime-fakes.ts` を `cp` で退避し、Edit で変異を入れ、`fake-returns-copies-for-writers.test.ts` と `fake-isolates-caller-mutation.test.ts` を走らせ、`cp` で戻した。**どの変異も1〜2本の歯が赤になり（本数は表のとおり）、戻した後は同じ歯が緑に戻った**（最後の `git status --porcelain` は commit 済みの差分だけ）。

| 口 | 変異（写しを外す） | 赤になった歯 |
|---|---|---|
| createObservation（新規・再送。同じ戻り値の1行） | 行をそのまま返す | `createObservation: 返り値を書き換えても…`、`createObservation: 同じ externalId の再送が…`（新規・再送とも別々の歯で赤） |
| createObservationWithOutbox（再送 `created: false`） | `observation` が行そのもの | `createObservationWithOutbox: observation（新規・既存の両方）と jobs を…` |
| createObservationWithOutbox（新規 `observation`） | 同上 | 同上 |
| createObservationWithOutbox（`jobs`） | `jobs` が行そのもの | 同上 |
| registerLabel | 行をそのまま返す | `registerLabel: 返り値を書き換えても、次の listLabels は…` |
| createMemoryWithOutbox 新規側 `memory` | 行そのもの | 上の M2 の表の2本 |
| createMemoryWithOutbox `created: false` 側 `memory` | 行そのもの | `memory（新規・既存の両方）と jobs を…` |
| listBySourceObservationAllVersions | 行そのもの | `listBySourceObservationAllVersions: 返した要素を…` |
| updateStatusWithEvent の `memory` | 行そのもの | `updateStatusWithEvent: memory と event を…` |
| updateStatusWithEvent の `event` | 行そのもの | 同上 |
| setEmbeddingStatus（書く側） | 行そのもの | `setEmbeddingStatus: 書いた返り値・巻き戻しを断った（no-op）…` |
| reinforce（書く側） | 行そのもの | `reinforce: 書いた返り値・no-op の…`、`reinforceMany: 返した要素を…` |
| reinforce（no-op 側） | 行そのもの | `reinforce: 書いた返り値・no-op の…` |
| reinforceMany | `reinforce` の戻り値を `liveOf` で行に引き直して集める（`reinforceMany` 自体は写しを取らない作りなので、「行を返す」形にして試した） | `reinforceMany: 返した要素を…` |
| purgeMemory の `memory` | 行そのもの | `purgeMemory: memory と event を…` |
| markContestedPair の `second` | 行そのもの | `markContestedPair: first・second・events を…` |
| markContestedPair の `events` | 行そのもの | 同上 |
| resolveContestedPair の `first` | 行そのもの | `resolveContestedPair: first・second・events を…` |
| resolveContestedPair の `second` | 行そのもの | 同上 |
| resolveContestedPair の `events` | 行そのもの | 同上 |
| markContestedGroup の `members` | 行そのもの | `markContestedGroup: members・events を…` |
| markContestedGroup の `events` | 行そのもの | 同上 |
| resolveContestedGroup の `members` | 行そのもの | `resolveContestedGroup: members・events を…` |
| resolveContestedGroup の `events` | 行そのもの | 同上 |
| resolveOrphanedContested の `memory` | 行そのもの | `resolveOrphanedContested: memory・event を…` |
| resolveOrphanedContested の `event` | 行そのもの | 同上 |
| restoreSupersededBy | 行そのもの | `restoreSupersededBy: restored の要素を…` |
| findContestedByClaimKey | `.map((m) => m)`（行そのもの） | `findContestedByClaimKey: 返した要素を…` |
| supersedeWithNewMemories `created[].jobs` | 行そのもの | `created[].jobs を書き換えても、listJobs・claimBatch は…` |
| 同上 | 浅い `{ ...job }`（`payload`・Date が共有） | 同上 |
| supersedeWithNewMemories の `superseded` event | 行そのもの | `superseded の event を書き換えても、eventStore の…` |
| 同上 | 浅い `{ ...storedEvent }`（`meta` が共有） | 同上 |

### 生き残った変異

**無い**。上の全部が、少なくとも1本の歯で赤になった。したがって、歯は足していない（足したのは仕事Aの2本と対照2本だけ）。ただし、`scribble` が `tenantId` まで書き換えるので、行そのものを返す変異は「`get` が `null` になる」という粗い赤でも捕まる。`reinforceMany` のように写しを取る行が無い口は、「`reinforce` の写しを外した」ときに `reinforceMany` の歯が赤になることは確かめたが、`reinforceMany` 自身の写しの取り忘れは、上のように `liveOf` で行を引き直す形の変異でしか試せていない【未確認】。

## 直さないもの【判断】

- `supersedeWithNewMemories` の `created[].memory`（`created: false` 側を含む）の変異は、今回の依頼の対象外で入れていない（ADR 0562 の歯 `fake-isolates-caller-mutation.test.ts` が新規側を押さえている）。
- `listLabels`・`getMany`・`claimBatch` などの、依頼の一覧に無い口の変異。
- 検査用の口（`events` getter・`listJobs`・`liveRowForTest`・`liveOf`）。ADR 0578 のとおり。
- ADR 0578 自体は書き換えない（本 ADR が指す）。

## CHANGELOG と migration【判断】

変えない。Fake は `packages/core/src/__tests__/` のテスト専用で出荷物ではない。

## これが覆るとしたら

Fake を適合テストに通すようになったとき（歯が適合テストに吸収される。ADR 0578 と同じ）。

# ADR 0562: core の Fake も、呼び手の書き換えから自分の中身を守る（Issue #1412 A8 の9本と、同じ原因の1本）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-03

クローンの委譲先（担い手。マネージャー mgr-cb86a0fd の指示による）が書いた。決めたのはクローンで、オーナーではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手の判定、【未確認】は確かめていないこと。

## 方針【現物】

core のテスト用 Fake（`packages/core/src/__tests__/runtime-fakes.ts`）は testkit の適合テストを通らない。Issue #768 のコメント2（2026-09-25T13:12Z。クローン miku の委譲セッションが書き、クローン miku が決めた。オーナーではない）が「conformance には通さない・除外オプションも足さない・直したものは専用の `fake-*.test.ts` で押さえる」と決めている。**本 ADR はその方針に乗る。** 適合テストへは何も足さず、除外のオプションも作らない。

## 測り方【判断】（案 (a)。テストとしては残さない）

一時的に testkit から Fake へ適合テストを流し、ずれを数えた。再現の手順:

1. `packages/testkit/src/__tests__/tmp-fakes-conformance.test.ts` を一時的に作る。`../../../core/src/__tests__/runtime-fakes.js` の `createFakeRuntimeStores()` から各 store を取り、`describeMemoryStoreConformance`・`describeRelationStoreConformance`・`describeVectorStoreConformance`・`describeLexicalStoreConformance`・`describeEventStoreConformance`・`describeOutboxStoreConformance`・`describeTenantSettingsStoreConformance` に渡す。配線は `in-memory-fixtures.conformance.test.ts` と `in-memory-conformance-options.ts` に倣う。
2. `FakeBackingStore` は export されていないので、events・outboxJobs・relations を読むフック（`listEventsForMemory`・`listPurgedEvents`・`listRelationsForMemory`・`seedJob`・`peekJob`）は `(memoryStore as any).backing` 経由で書く。
3. Fake が持たない任意機能（`supportsScrubPurged`・`supportsCreateMemoriesWithOutboxAndEvents`・`supportsSearchMany`・`implementsListRelatedMany`・`supportsSupersedeCreatedEvents`）は宣言しない。`supportsAbortIfForgotten` は `false`。`setDefaultHalfLifeHours` のフックは Fake に書き口が無いので渡さない。
4. `cd packages/testkit && pnpm exec vitest run src/__tests__/tmp-fakes-conformance.test.ts`。
5. 測り終えたら一時ファイルを必ず削除し、commit に入れない。

**その時点の実測**（2026-10-03、main `3d23fe44` に本 PR の歯を足しただけの状態。時点を過ぎれば変わる数である）:

| 種類 | 直す前 | 直した後 |
|---|---|---|
| MemoryStore | 22 赤 / 356 緑 | 17 赤 / 361 緑 |
| RelationStore | 0 赤 / 26 緑 / 7 skip | 同左 |
| VectorStore | 1 赤 / 60 緑 | 0 赤 / 61 緑 |
| LexicalStore | 0 赤 / 33 緑 | 同左 |
| EventStore | 2 赤 / 25 緑 | 0 赤 / 27 緑 |
| OutboxStore | 3 赤 / 41 緑 / 1 skip | 1 赤 / 43 緑 / 1 skip |
| TenantSettingsStore | 1 赤 / 35 緑 | 同左 |
| 合計（613 本、8 skip） | 29 赤 | 19 赤（10 本減。新しく赤くなった it は 0） |

「直した後」は `createMemory` の返り値を写しにした後（決定3）の実測。減った10本は、下の9本と、`purgeMemory は recalls.index_band の digestBand から、この memoryId の digest を伏せる`（ADR 0375 決定3・決定4）の1本。

【未確認】依頼文にあった「615 本中 31 本赤」とは2本ずつ食い違う（上は 613 本中 29 本）。配線の差（上の手順3の任意機能の宣言、`setDefaultHalfLifeRecalls` と `advanceActivitySeq` 系のフックを渡したこと）のどれが効いたかは切り分けていない。減った10本は、どちらの数え方でも同じ it である。

## ずれ【現物・実測】

Fake は、入力で受け取った配列・オブジェクト・Date をそのまま store の行に入れ、読み出しでも行そのものを返していた。呼び手が渡した後に書き換える、または返り値を書き換えると、store の中身が変わる。`InMemoryMemoryStore` などは `structuredClone`（`snapshot`）で切り離している。適合テストの「Issue #1412 A8」の約束のうち、Fake が破っていた9本:

| 種類 | 適合テストの it（名前の前半） |
|---|---|
| MemoryStore | `createMemory は入力（tags の配列・attributes のオブジェクト・validFrom の Date）を…` |
| MemoryStore | `get が返した Memory を呼び手が書き換えても…` |
| MemoryStore | `getMany が返した Memory 配列の要素を呼び手が書き換えても…` |
| MemoryStore | `supersedeWithNewMemories が返した created[].memory を呼び手が書き換えても…` |
| VectorStore | `getVectors が返した vector の配列を呼び手が書き換えても…` |
| EventStore | `append の入力 meta（配列を含む）を呼び手が後から書き換えても…` |
| EventStore | `get が返した meta を呼び手が書き換えても…` |
| OutboxStore | `claimBatch が返した payload を呼び手が書き換えても、store 側の行は変わらない` |
| OutboxStore | `complete/fail に渡した opts.at を、呼び手が後から書き換えても、completedAt/failedAt は変わらない` |

### 10本目: `purgeMemory` の digestBand【実測】

`purgeMemory は recalls.index_band の digestBand から…` は、A8 の約束ではないが、**原因は同じ**である。Fake の `createMemory` が store の中の行そのものを返していたので、`purgeMemory` が行の `digest` を `[purged]` に書き換えると、テストが期待値に使う `created.digest` も `[purged]` になり、赤くなった。**この原因は ADR 0563（PR #1676）の担当が突き止めた**（一時 wiring で `createMemory` の返り値を `structuredClone` すると緑になる、と確かめている）。本 ADR は `createMemory` の返り値を写しにする（決定3）ので、この1本も緑になる。直した後の測定（上の表）で緑になることを確かめた。

## 決定【判断】

直すのは `runtime-fakes.ts` だけ（歯と、下の「既存テストの書き換え」を除く）。

1. 内部の写しの道具を2つ足す: `fakeSnapshot`（`structuredClone`。Date は Date のまま、入れ子は深い複製）と `fakeCopyDate`（`new Date(getTime())`。`null`・`undefined` はそのまま）。**JSON で往復しない**（Date が文字列になる）。
2. **入力は保存するときに写す**: `createMemoryIdempotent` の `tags`・`attributes`・`provenance` と、Date の列（`occurredAt`・`recordedAt`・`lastReinforcedAt`・`validFrom`・`validUntil`・`decayFloorAt`・`purgedAt`）。`buildStoredEvent` の `at`・`actor`・`meta`。`claimBatch` が行に書く `claimedAt`（`opts.now`）。`complete`/`fail` が行に書く `completedAt`/`failedAt`（`opts.at`）。
3. **返り値は返すときに写す**: `FakeMemoryStore.createMemory`・`get`・`getMany`、`supersedeWithNewMemories` の `created[].memory`、`FakeVectorStore.getVectors` の `vector`、`FakeEventStore.get`、`claimBatch` が返すジョブ（浅い `{...job}` を `fakeSnapshot` に替えた。`payload` と Date に届かなかった）。
4. **Fake の内側の読みは、行そのものに書く**: `updateStatus`・`reinforce`・`purgeMemory`・`archiveDecayed` などは、`this.get(...)` で読んだ Memory に直接書いていた。`get` が写しを返すと、書いても store に届かない。そこで私的な `liveOf(viewed)` を足し、`this.liveOf(await this.get(ctx, id))` の形にした。**`this.get` を呼ぶ形は変えない**——`forget.test.ts`・`purge.test.ts`・`restore-archived.test.ts`・`resolve-contested-group.test.ts` は `stores.memoryStore.get` を差し替えて「再読すると行が消えていた」「再読が投げる」を作り、その呼び出し回数まで数える。`this.get` を飛ばして行を直接引くと、この差し替えが内側に届かない（【実測】途中の版でこれをやり、11本が赤くなった）。
5. 歯が行そのものを書き換えたいときのための口 `liveRowForTest(ctx, id)` を足した。`get` が写しを返すようになったので、「`get` の戻り値を書き換えれば store が変わる」という手口は使えなくなる。

### 既存テストの書き換え【現物・実測】

`get`・`createMemory` の戻り値が行そのものであることを前提にしたテストが、決定3で赤くなった。**いずれも「別の誰かが読んでから書くまでの間に状態を変えた」を決定的に作る手口で、書き換える対象は変わらず、取る口だけを `liveRowForTest` に替えた**。

`createMemory` の返り値を写しにしたときに赤くなった 22 本（9 ファイル。`beforeUpdateStatus` や `updateStatusWithEvent` の差し替えの中で、`createMemory` の返り値の `status`・`purgedAt`・`content`・`digest` を書き換えていた）: `foreign-realm-store-errors.test.ts`・`forget.test.ts`・`mark-contested-group.test.ts`・`mark-contested.test.ts`・`outcome-error-format.test.ts`・`purge.test.ts`・`resolve-contested.test.ts`・`resolve-orphaned-contested.test.ts`・`restore-archived.test.ts`。最初の直しで 19 本、残り 3 本（`m2` を書き換える「2件目の再読」）を足して全部緑。

`get` の返り値を前提にした 5 本:

- `consolidate.test.ts`: CAS が破れたら `status_changed_concurrently`
- `runtime.test.ts`: reextract の CAS（対象 M の1件目を書きに来た瞬間に forgotten）
- `resolve-contested.test.ts`: 相互参照が破れている片方は `ineligible(pair_broken)`
- `resolve-orphaned-contested.test.ts`: `no_contested_with_id`、`opposite_not_orphaned`（superseded）の2本

## 歯【実測】

`packages/core/src/__tests__/fake-isolates-caller-mutation.test.ts`（24本）。9本の約束と 10 本目（`createMemory` の返り値）を Fake に当てる歯が13本、対照の歯が11本。対照は「書き換えなければ値が正しく読める」「返り値は凍結されていない」「Date は Date のまま」「id が変わらない」「書き込みの口は写しではなく行を更新する」「`claimBatch` の再取得（lease 切れ）が行を更新する」「`complete` を `opts.at` 無しで呼ぶと現在時刻が入る」など。

- **直す前**: 最初の23本は **12本赤、11本緑**（歯の12本はすべて赤。対照の11本は緑＝Fake の今の正しい振る舞いを縛る）。`createMemory` の返り値の歯（1本）は後から足し、`createMemory` の返り値を行そのものに戻す変異（M14）で赤くなることを確かめた。
- **直した後**: 24本緑。

## 変異試験【実測】

`/tmp` に退避した修正版を `cp` で戻した。各変異の後に歯のファイルだけを走らせ、赤になった it を記録した。戻した後、23本緑に戻ることも確かめた。

**写しを外す変異**（直した箇所ごと。歯が赤くなる）:

| 変異 | 赤になった it |
|---|---|
| M1 `createMemory` の `tags` を `input.tags` に戻す | `createMemory: 入力の tags・attributes・validFrom…` |
| M2 `attributes` の写しを外す | 同上 |
| M3 `validFrom` の写しを外す | 同上 |
| M4 `get` が行をそのまま返す | `get: 返した Memory を書き換えても…` |
| M5 `getMany` が行をそのまま返す | `getMany: …` |
| M6 `supersedeWithNewMemories` の `created[].memory` が行をそのまま | `supersedeWithNewMemories: 返した created[].memory…` |
| M7 `getVectors` が `entry.vector` をそのまま返す | `返した vector の配列を書き換えても…` |
| M8 `buildStoredEvent` の `meta` の写しを外す | `append: 入力 meta…` |
| M9 `FakeEventStore.get` が行をそのまま返す | `get: 返した meta を書き換えても…` |
| M10 `claimBatch` の返り値を浅い `{...job}` に戻す | `claimBatch: 返した payload…`、`claimBatch: 返した claimedAt・availableAt…` |
| M11 `claimedAt = opts.now`（呼び手の Date を行に入れる） | `claimBatch: 返した claimedAt・availableAt…` |
| M12 `complete` が `opts.at` をそのまま行に入れる | `complete: 渡した opts.at…` |
| M13 `fail` が `opts.at` をそのまま行に入れる | `fail: 渡した opts.at…` |
| M14 `createMemory` が行をそのまま返す | `createMemory: 返した Memory が、後の purge（行の書き換え）で動かない…` |

**やりすぎた実装**（写しの取りすぎ・正当な操作を壊す。対照の歯が赤くなる）:

| 変異 | 赤になった it |
|---|---|
| O1 `get` の写しを `JSON.parse(JSON.stringify(...))` で取る（Date が文字列になる） | 対照 `get・getMany は同じ中身（… Date は Date のまま）…`。ほか `get`・`createMemory` の2本も赤（読み戻しの Date を `.getTime()`/`.toISOString()` で比べるため） |
| O2 `get` が id を変える（`${id}-copy`） | 対照 `get・getMany は同じ中身…`、`書き込みの口（updateStatus）…`、`created の id は get の id と一致する…`、`updateStatusWithEvent が積んだイベントも…` |
| O3 `get` の返り値を凍結する（`Object.freeze`） | 対照 `返り値は凍結されていない…`（と、書き換える側の `get: …` が例外で赤） |
| O4 `getVectors` の `vector` を凍結する | 対照 `書き換えなければ元の値・memoryId のまま読め、凍結もされていない` |
| O5 `FakeEventStore.get` を JSON 往復にする（`at` が文字列になる） | 対照 `書き換えなければ meta・at（Date のまま）・id が読み戻り…` |
| O6 `claimBatch` の返り値を JSON 往復にする（Date が文字列になる） | 対照 `claimBatch の返り値は payload が同じ中身で、Date は Date のまま…`。ほか `claimedAt・availableAt…` も赤 |
| O7 `liveOf` が写しをそのまま返す（内側の書き込みが写しに行く） | 対照 `書き込みの口（updateStatus）は、get が返した複製ではなく store の中の行を更新する` |
| O8 `complete` が `opts.at` を無視して現在時刻を入れる | `complete: 渡した opts.at…` |

## 既存テスト【実測】

`runtime-fakes` を import している core のテスト196ファイル（`grep -rl runtime-fakes packages/core/src --include=*.test.ts`）を名指しで走らせた（`runtime.test.ts`・`fake-*.test.ts`・outbox・event 関係を含む）。**緑。2375本。** 決定4を入れる前の版では 11 本赤、`liveOf` を入れて 5 本、上の5本を書き換えて 0 本、`createMemory` の返り値を写しにして 22 本赤、上の書き換えで 0 本になった。全 core テストではなく、Fake を使う196ファイルである（Fake を使わない core のテストは走らせていない）。ほかに `pnpm typecheck`・`pnpm format:check`、触ったファイルの eslint を通した。

## 直さないもの【判断】

- **意図して課していない11本**: [ADR 0140](./0140-contested-requires-companion.md) 決定2の contested 10本（`ContestedWithoutCompanionError` を `createMemory`・`createMemoryWithOutbox`・`updateStatus`・`updateStatusWithEvent`・`supersedeWithNewMemories` が投げる、5口×2本）と、[ADR 0125](./0125-half-life-hours-range.md) の `halfLifeHours` の値域の1本。Fake は意図してこれを課さない（`recall-pipeline.test.ts` などが壊れた Memory を意図して作るため。`createMemoryIdempotent` のコメント）。
- **任意機能の4本**: `scrubPurged`・`createMemoriesWithOutboxAndEvents`・`searchMany`・`listRelatedMany`（と `supportsSupersedeCreatedEvents`）。Fake が持たないので宣言しない。
- **他の種類のずれ**: ADR 0563・0564（別の担い手が並行して直す。本 ADR からはリンクしない——まだ main に無い）。本 ADR は「呼び手の書き換えで Fake の中身が変わる」9本と、同じ原因の1本だけを直す。
- **適合テストが測っていない口の写し**: `createMemoryWithOutbox`・`list*`・`search*`・`updateStatus` の返り値などは、まだ store の行そのものを返す。**適合テストの A8 は代表的な口だけを固定している**ので、これらは測れていない。写しにしたときに既存の歯がどれだけ変わるかは試していない【未確認】。

## CHANGELOG と migration【判断】

変えない。Fake は `packages/core/src/__tests__/runtime-fakes.ts`（テスト専用、出荷物ではない）。

## 採らなかった案

- **適合テストを Fake に通す／除外オプションを足す**: #768 コメント2が退けている。
- **内側の読みを `this.get` から行を直接引く形に替える**: 差し替えた `get` の呼び出し回数を数える既存の歯が、内側に届かなくなる（決定4の実測）。
- **`structuredClone` の代わりに JSON 往復**: Date が文字列になる（O1・O5・O6）。

## これが覆るとしたら

#768 のコメント2の方針が変わり、Fake を適合テストに通すようになったとき（本 ADR の専用の歯は適合テストに吸収される）。または、`createMemoryWithOutbox` など残りの返り値も写しにしたくなったとき（`liveRowForTest` に移す既存の歯が増える）。

## 【未確認】

- 上の「615 本中 31 本」との2本の食い違いの原因。
- 本 ADR の測定は、Postgres を使っていない（Fake だけ）。

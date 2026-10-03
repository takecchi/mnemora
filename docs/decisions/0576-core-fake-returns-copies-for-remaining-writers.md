# ADR 0576: core の Fake の残りの口も、store の行そのものではなく写しを返す（ADR 0562 の未確認の続き）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-03

クローンの委譲先（担い手。マネージャー mgr-4ba236a4 の指示による）が書いた。決めたのはクローンで、オーナーではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手の判定、【未確認】は確かめていないこと。

## 背景【現物】

[ADR 0562](./0562-core-fake-isolates-caller-mutation.md) は、core のテスト用 Fake（`packages/core/src/__tests__/runtime-fakes.ts`）のうち、適合テスト（Issue #1412 A8）が測る口だけを「写しを返す」形に直した。その「直さないもの」に、次の【未確認】を残している。

> `createMemoryWithOutbox`・`list*`・`search*`・`updateStatus` の返り値などは、まだ store の行そのものを返す。…写しにしたときに既存の歯がどれだけ変わるかは試していない【未確認】

本 ADR はその続きで、`search*` 以外の残りを直し、「既存の歯がどれだけ変わるか」を測る。Fake は適合テストを通らない（Issue #768 のコメント2。ADR 0562 の「方針」）ので、直したものは専用の `fake-*.test.ts` で押さえる。

## 決定【判断】

返すときに `fakeSnapshot`（`structuredClone`。Date は Date のまま、入れ子は深い複製）を通す。道具と作法は ADR 0562 と同じ（`fakeSnapshot`・`fakeCopyDate`・内側の読みは `liveOf`、歯が行を書き換えるときは `liveRowForTest`）。

直した口（`runtime-fakes.ts`）:

- `FakeMemoryStore`
  - Observation: `createObservation`・`getObservation`・`createObservationWithOutbox` の `observation`（新規・既存の両方）と `jobs`（浅い `{ ...job }` だったので `payload`・Date が行と共有だった。深い写しに替えた）
  - label: `listLabels`・`registerLabel`
  - `createMemoryWithOutbox` の `memory`（新規・既存の両方）と `jobs`（`enqueueJob` が backing に積んだ行そのものを返していた）
  - `listBySourceObservation`・`listBySourceObservationAllVersions`
  - `updateStatus`・`updateStatusWithEvent`（`memory` と `event`）
  - `setEmbeddingStatus`（書いた場合と、巻き戻しを断った no-op の場合の両方）・`reinforce`（書いた場合と no-op の両方。`reinforceMany` は `reinforce` 経由）
  - `purgeMemory`・`markContestedPair`・`resolveContestedPair`・`markContestedGroup`・`resolveContestedGroup`・`resolveOrphanedContested`（いずれも `memory`/`members` と `event`/`events`）・`restoreSupersededBy`
  - `findActiveByClaimKey`・`findContestedByClaimKey`
- `FakeEventStore`: `append`・`list`

依頼の一覧に**足した**もの（漏れ）:

- `createObservationWithOutbox` の `created: false` の側の `observation`（再送が既存の行を返す口）と、`createMemoryWithOutbox` の `created: false` の側の `memory`。
- 入力の側が2つ残っていた。`createMemoryIdempotent` の `claimKey`（`input.claimKey ?? null` で呼び手の参照をそのまま行に入れていた。ADR 0562 の入力の写しの一覧に無い）と、`reinforce` が行に書く `lastReinforcedAt`（呼び手の `at` をそのまま入れていた）。どちらも `fakeSnapshot` / `fakeCopyDate` に替えた。

**内側で、公開の口の戻り値を書き換えている呼び手は無かった**【実測】。`runtime-fakes.ts` の中で `this.updateStatus`・`this.reinforce`・`this.createMemoryIdempotent` などの戻り値を使うのは、`reinforceMany`（`reinforce` の戻り値を配列に集めて返すだけ）、`recordUsageAndReinforce`（`reinforceMany` の戻り値を捨てる）、`createMemory`・`createMemoryWithOutbox`・`createObservationWithOutbox`（返す直前に写す）だけで、いずれも書き込みはしない。行に書く口は ADR 0562 の決定4のとおり `this.liveOf(await this.get(...))` を使っており、今回の変更で触っていない。

## 既存テストの書き換え【実測】

`recall-pipeline.test.ts` の2本は、`createEmbeddedMemory`（`createMemory` 経由）の戻り値を書き換えて、store の行を `undefined` にする前提だった。ADR 0562（#1675）で `createMemory` が写しを返すようになってからは、**書き換えは store に届かず、歯が空振りしていた**。

- `subjectId が在ればその値、null ならそのまま null、Memory 側で undefined でも null に揃える`（`undefinedSubject.subjectId = undefined`）
- `Memory.occurredAt が undefined でも null に揃える（subjectId と同じ防御）`（`memory.occurredAt = undefined`）

**直す前の実測**: `recall-runtime.ts` の防御（`member.memory.subjectId ?? null`・`member.memory.occurredAt ?? null`）の `?? null` を外した変異を入れて、この2本を走らせた。**2本とも緑のままだった**（保存済みの行は `createMemory` が既に `null` に揃えているので、書き換えが届かなくても期待どおりに読めるため）。`liveRowForTest(ctx, id)!.subjectId = undefined` などに替えると、**同じ変異で2本とも赤になり**（`expected undefined not to be undefined`）、変異を戻すと緑に戻る。コメントも直した（`occurredAt` 側は「`?? null` で正規化しない」という古い記述も、実際は `?? null` で正規化していたので合わせた）。

ほかに、写しの戻り値を書き換えて頼っているテストは見つからなかった。`runtime-fakes` を import している core のテスト 204 ファイルを名指しで走らせ、**緑（2498 本、todo 1 本）**。

## 歯【実測】

`packages/core/src/__tests__/fake-returns-copies-for-writers.test.ts`（46 本）。各口について、返り値を（配列・Date・ネストしたオブジェクトまで）書き換える `scribble` を当て、`liveRowForTest`（行そのもの）と公開の `get` / `list` の両方が基準から変わらないことを見る。書き換えない読みの対照、書いたことが store に届いていること、`liveRowForTest` への書き込みが後の `get` / `list` に見えること、返り値が凍結されていないことと Date が Date のままであることを、対照の歯にした。

- **直す前**（`d4306501` の `runtime-fakes.ts` に歯だけを当てた）: **46 本中 30 本が赤、16 本が緑**。赤の内訳は、口ごとの歯 28 本と、対照のうち「返す行と保存する行が別である」ことを縛る 2 本（`createMemoryWithOutbox が作った行は liveRowForTest で…`・`updateStatus の返り値は呼ぶたびに別の複製で…`）。緑の 16 本は、書き換えなければ値が正しく読めること・書いたことが届くこと・凍結していないことを縛る対照で、**今の Fake の正しい振る舞い**を縛る。
- **直した後**: 46 本緑。あわせて ADR 0562 の歯（`fake-isolates-caller-mutation.test.ts`、24 本）と `recall-pipeline.test.ts` を走らせ、209 本緑。
- `tsc -p tsconfig.json`（core）は通り、変更した3ファイルに `eslint` と `prettier --check` を当てて指摘なし。

## 変異試験【実測】

`runtime-fakes.ts` を `cp` で退避し、変異を入れて歯（`fake-returns-copies-for-writers.test.ts` と `fake-isolates-caller-mutation.test.ts`）を走らせ、赤になった it を記録し、`cp` で戻して同じ歯が緑に戻ることを確かめた。最後の `git status --porcelain` は空。

**写しを外す変異**（歯が赤くなる）:

| 変異 | 赤になった it |
|---|---|
| M1 `updateStatus` が行をそのまま返す | `updateStatus: 返り値を書き換えても…`、対照 `updateStatus の返り値は呼ぶたびに別の複製で…` |
| M2 `createMemoryWithOutbox` の `memory` が行をそのまま | `memory（新規・既存の両方）と jobs を書き換えても…`、対照 `createMemoryWithOutbox が作った行は liveRowForTest で…` |
| M3 `createMemoryWithOutbox` の `jobs` が行をそのまま | `memory（新規・既存の両方）と jobs を書き換えても…` |
| M4 `listBySourceObservation` が行をそのまま | `listBySourceObservation: 返した要素を書き換えても…` |
| M5 `listLabels` が行をそのまま | `listLabels: 返した要素を書き換えても…` |
| M6 `FakeEventStore.append` が行をそのまま | `append: 返り値を書き換えても、get・list は…` |
| M7 `FakeEventStore.list` が行をそのまま | `list: 返した要素を書き換えても…`、`list: limit で切った結果を…` |
| M8 `markContestedPair` の `first` が行をそのまま | `markContestedPair: first・second・events を…` |
| M9 `purgeMemory` の `event` が行をそのまま | `purgeMemory: memory と event を…` |
| M10 `getObservation` が行をそのまま | `getObservation: 返り値を書き換えても…` |
| M11 `findActiveByClaimKey` が行をそのまま | `findActiveByClaimKey: 返した要素を…` |
| M12 `resolveContestedGroup` の `events` が行をそのまま | `resolveContestedGroup: members・events を…` |
| M13 `createMemoryIdempotent` が `claimKey` を共有 | `createMemory: 渡した claimKey を後から…` |
| M14 `reinforce` が `at` をそのまま行に入れる | `reinforce: 渡した at を後から…` |
| M15 `setEmbeddingStatus` の no-op 側が行をそのまま | `setEmbeddingStatus: 書いた返り値・巻き戻しを断った（no-op）…` |

**やりすぎた・取り足りない実装**（対照の歯も含めて赤くなる）:

| 変異 | 赤になった it |
|---|---|
| O1 `liveOf` が写しを返す（内側の書き込みが写しに行く） | 20 本。`updateStatus`・`setEmbeddingStatus`・`reinforce`・`purgeMemory`・contested 系（pair・group・orphaned・restore・`findContestedByClaimKey`）の歯と対照、ADR 0562 の `createMemory: 返した Memory が…` と対照 |
| O2 `liveRowForTest` が写しを返す（歯が行に書けない） | 対照 `createMemoryWithOutbox が作った行は liveRowForTest で…`・`返り値は get と同じ中身で、liveRowForTest への書き込みが…`・`liveRowForTest で取った行への書き込みは…` の 3 本 |
| O3 `updateStatus` が写しに書いてから返す（store に届かない） | 7 本。`updateStatus: …`・`purgeMemory: …`・`restoreSupersededBy: …`、対照 `updateStatus が書いたことは…`・`purgeMemory が書いたことは…`、ADR 0562 の `createMemory: 返した Memory が…` と対照 |
| O4 `updateStatus` が浅い写し `{ ...memory }`（`tags` を共有） | `updateStatus: 返り値を書き換えても…` |
| O5 `listLabels` が JSON 往復（`registeredAt` が文字列） | 対照 `registerLabel の返り値と listLabels の中身は同じで、registeredAt は Date のまま…` |
| O6 `createMemoryWithOutbox` の `jobs` が浅い `{ ...job }`（`payload`・Date を共有） | `memory（新規・既存の両方）と jobs を書き換えても…` |

**どの歯でも捕まらなかった変異は無かった**。ただし次は「同じ振る舞いになる変異」で、試験にならなかったので表に入れていない: `createMemoryIdempotent` が保存する行を写しにして、返す行を元のオブジェクトにする変異。`createMemory` 等は返す前にもう一度写し、元のオブジェクトは誰にも渡らないので、外から区別できない。「保存する行と返す行を切る」意図の変異は、行に書く側から見えるものとして O2（`liveRowForTest` を切る）で代えた。

## 直さないもの【判断】

- **`supersedeWithNewMemories`**（`created[].jobs` と、superseded の `event` がまだ行そのもの）。**別の担当が同じメソッドを直す予定**で、行が重なると衝突するので、本 ADR は1行も触らない。ADR 0562 が直した `created[].memory` もそのまま。直された後に、本 ADR の歯と同じ形（`scribble` で書き換えて `liveRowForTest`・`get`・`eventStore.get` で見る）を当てるのが次の手になる【未確認】。
- **`FakeEventStore` の `events` getter**・**`FakeOutboxStore.listJobs`**・**`liveRowForTest`**・**`liveOf`**: 検査用・内部の口で、行そのもの（`listJobs` は浅い複製）を返すのが仕事。歯が「store の中で今どうなっているか」を読むのに使う（本 ADR の歯も `listJobs` と `liveRowForTest` を基準の取得に使っている）。
- **vector / lexical の `search`**: すでに新しいオブジェクト（`memoryId` と数値だけ）を返していて、行を渡していない。
- **`createObservation` などの入力の側**: Observation の `payload`・Date・`attributes` は、保存するときにまだ呼び手の参照のまま行に入る。本 ADR は返り値の側（と、`claimKey`・`reinforce` の `at` の2つ）だけを直した【未確認】。
- **ADR 0562 の「直さないもの」の該当行**: 書き換えない（リポジトリの慣行として、後の ADR が先の ADR に戻ってリンクを足す例は見つからなかった。ADR 0573 から ADR 0563 へも足されていない）。本 ADR が 0562 を指す。

## CHANGELOG と migration【判断】

変えない。Fake は `packages/core/src/__tests__/` のテスト専用で出荷物ではない。

## これが覆るとしたら

#768 のコメント2の方針が変わり、Fake を適合テストに通すようになったとき（本 ADR の歯は適合テストに吸収される）。または、`supersedeWithNewMemories` を直す担当が、本 ADR と別の写しの作法を採ったとき。

## 【未確認】

- 本 ADR の測定は Postgres を使っていない（Fake だけ）。
- 変異試験は、直した口ごとに全部は入れていない（上の表の15本と6本）。入れていない口（`resolveContestedPair`・`restoreSupersededBy`・`updateStatusWithEvent`・`reinforceMany`・`registerLabel` など）の歯は、直す前に赤になったことと、`scribble` が届く限りを書き換えることで間接的に支えているだけで、口ごとの「写しを外す」変異では確かめていない。

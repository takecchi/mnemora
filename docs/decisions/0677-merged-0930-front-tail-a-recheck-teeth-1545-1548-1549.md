# ADR 0677: 09/30 マージの前半の残り（#1545・#1548・#1549）の確かめ直しで見つかった穴に歯を足す（Issue #1734）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-07

**これはクローン（miku）の判断で、オーナーの判断ではない**（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。出所は Issue [#1734](https://github.com/takecchi/mnemora/issues/1734)。担当は mgr-0106ab7d、測ったのは作業者。
出所の区別: 【現物】は読んだコード、【実測】は手元で走らせた結果、【判断】は担い手の判定。
これは試験だけの変更で、実装・TSDoc・migration・CHANGELOG・公開の適合テスト（`*-conformance.ts`）・`__fixtures__/` は触らない（[ADR 0671](./0671-merged-0930-front-rest-recheck-teeth-1523-1525-1527-1529.md) と同じ）。

## 経緯【実測】

2026-09-30（UTC）にマージされた89本の確かめ直し（#1734）のうち、A 群の最後の3本（#1545・#1548・#1549）に、足りない側とやりすぎた側の変異を当てた。測定は main `ed61bd67`【実測】。変異の数とすり抜けは次のとおりで、表は #1734 の各コメントにある。

| PR    | ADR  | 変異 | すり抜け | 約束の内 | 約束の外 | 元と同じ働き |
| ----- | ---- | ---- | -------- | -------- | -------- | ------------ |
| #1545 | 0437 | 71   | 19       | 16       | 2        | 1            |
| #1548 | 0440 | 35   | 3        | 0        | 0        | 3            |
| #1549 | 0439 | 51   | 10       | 6        | 2        | 2            |

約束の内の22本に歯を足した。足した歯ごとに、元の変異を `cp` で当てて赤になること、戻して `cmp` が一致し緑になることを確かめた。後の ADR で約束が広がったもの（#1545 は ADR 0512 が `scrubPurged` に `recalls.index_band` の digest を伏せる仕事を足した。#1549 は ADR 0503・0515・0456・0466・0469・0521）は、広がった約束に当てた。狭まった・意味が変わった約束は、歯を足す対象の中には無かった。#1548 の bullmq の文書の約束（「`lockDuration` はこの driver から設定できない」「【未実測】」）は、後の ADR 0449・0548 で逆になっているが、文書だけの約束で当てる変異が無く、歯の対象ではない。

## 決定【判断】

1. **実装は変えない。**公開の適合テストにも足さない。歯は各パッケージの固有のテストに置く。
2. 次の歯を足す。

| PR    | すり抜けた変異                                                                                                                                                                                 | 足した歯（置き場所）                                                                                                                                                         | 変異での赤                  |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| #1545 | `scrubPurged` が残骸の判定から `tags`・`attributes`・claim key（Postgres は claim key の2つの列）の1つを外す（Postgres・testkit）                                                              | 残骸が1つの欄だけの purge 済みの行も、その欄が消える（`packages/postgres` の新規 `scrub-purged-residue-gaps.postgres.test.ts`。InMemory と Postgres）                       | 赤（各1。6本）              |
| #1545 | `scrubPurged` が `purged_at` だけで対象にする（`status` を見ない。Postgres・testkit）                                                                                                         | `purgedAt` が立っていても `forgotten` でない行は触らない（同上）                                                                                                             | 赤（各1。2本）              |
| #1545 | `proposedCount` が 0 を割れる・`proposed` 以外の label も減らす（Postgres・testkit）                                                                                                           | 登録済みの label の `proposedCount` は動かさない・数が紐付けより小さくても 0 を割らない（同上）                                                                              | 赤（各1。4本）              |
| #1545 | `scrubPurged` が `assertWellFormedCtx` を外す（Postgres・testkit）                                                                                                                             | NUL を含む `tenantId` は `MalformedIdentifierError`（同上）                                                                                                                  | 赤（各1。2本）              |
| #1545 | `getSubjectActivitySeqs` の `subjectIds` の欄の名前を変える（Postgres・testkit）                                                                                                               | `subjectIds[0]`・`[1]`・`[2]` の壊れた要素で `field` と message を見る（`packages/postgres` の新規 `tenant-settings-subject-ids-field-name.postgres.test.ts`）               | 赤（各3。2本）              |
| #1549 | `checkedRef` が小文字にそろえない                                                                                                                                                              | 実在しない大文字の uuid の message が小文字（`packages/postgres` の新規 `memory-store-reference-spelling-gaps.postgres.test.ts`。createMemory・updateStatus・recordUsage ほか） | 赤（2）                     |
| #1549 | `updateStatusWithEvent`・`resolveContestedGroup` の `supersededById` を `checkedRef` に通さない                                                                                                | uuid でない `supersededById` が `memory not found for tenant`（同上）                                                                                                        | 赤（2・1）                  |
| #1549 | testkit `assertOwnMemoryRef` が `null` を「参照しない」にしない                                                                                                                                | 3つの参照欄に明示の `null` を渡した `createMemory` が通る（同上。InMemory と Postgres）                                                                                      | 赤（1）                     |
| #1549 | core の `FakeMemoryStore` の `resolveContestedPair`・`resolveContestedGroup` が、別テナントの `supersededById` の検査を外す                                                                    | 別テナントの `supersededById` が `memory not found for tenant` で、全員 contested のまま（`packages/core` の新規 `fake-cross-tenant-superseded-by-pair-and-group.test.ts`）  | 赤（各1。2本）              |

| #1548 | （すり抜けなし。約束の内は0）                                                                                                                                                                  | 足していない。PR の歯と適合テストが、35の変異のうち約束の内をすべて捕まえた                                                                                                  | —                           |

3. **歯を足さないもの（約束の外・同値）**

| PR    | 変異                                                                                               | 理由                                                                                                                                                  |
| ----- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| #1545 | `scrubPurged` の label の紐付けの DELETE から `ml.tenant_id` を外す                                | 同値。記憶の id は uuid で全テナントで一意で、`m.tenant_id = ml.tenant_id AND m.id = ml.memory_id` の結合も残る                                       |
| #1545 | `scrubPurged` が残骸を消すとき `updated_at`／`updatedAt` を動かさない（Postgres・testkit）         | 約束の外。約束は「残骸の無い行は動かさない」だけ                                                                                                      |
| #1548 | `Intl` の年が整数かの検査を外す・`month` を `numeric` にする・ずらした日付を `formatCalendarDate` で組む | 同値。`en-CA` は年月日を必ず返す・`Number()` のあと必ず2桁に0詰めする・`toISOString` の日付部分と同じ書き方                                            |
| #1549 | `insertMemoryRow` の拒みの順（observation → superseded-by）の入れ替え                              | 約束の外。ADR 0439 は順を決めていない                                                                                                                 |
| #1549 | Fake が空文字も参照として断る                                                                      | 約束の外。PR は Fake の空文字（従来は「参照しない」）を変えていない                                                                                   |
| #1549 | `resolveContestedPair` の `updateSide` の `checkedRef`・事前検査の `checkedRef` を外す             | 同値。入口の `normalizeUuidCase` が先に小文字にそろえ、事前検査と同じ検査が後ろにも在って、トランザクションが巻き戻る                                  |

## 測ったこと【実測】

- 走らせたのは名指しのファイルだけ。Postgres は専用のもの（`C.UTF-8`）を立てた。全スイートは走らせていない。
- 足した歯は、変異を当てる前は緑（Postgres 22件・6件、core 2件）。

## 引き受けた負債

- #1549 の `explainEmptyStatusUpdate`・`recordUsageOn` などの口ごとの検査は、`cross-tenant-reference-check` と適合テストの1〜8件で縛られている。薄い口がある（r5 の空文字は1件）。
- #1545 の `scrubPurged` の `updated_at` の動きは縛っていない。
- #1548 の bullmq の文書は、後の ADR で逆になった部分が文書に残っているかを、この ADR では読んでいない（H 群の読み比べの領分）。

## これが覆るとしたら

- #1549 の r10（拒みの順）が約束だと分かれば、`insertMemoryRow` の3つの参照が同時に壊れた入力で、testkit・Fake と順をそろえる歯を足す。
- `scrubPurged` の `updated_at` が約束だと分かれば、残骸を消した行の `updatedAt` が動くことを縛る歯を足す。

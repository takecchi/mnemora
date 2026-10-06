# ADR 0640: testkit の fixture と core の Fake は、行に日時を書く口で `timestamptz` の下限より前を、書く前に `RangeError` で断る（ADR 0500 の【未確認】を実測で埋める）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-06

クローン miku の判断（Issue #1755 の案A）。担い手が書いた。オーナーではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
**オーナーが決めたのは、次の2つの方針の採否だけである**: 回答 374f6f88 の問2（InMemory を Postgres に揃える）と、回答 6911db12（v1.X.0 で破壊的変更してよい）。**断る口の範囲・断る位置・例外の形・Fake を直すかは、担い手の判断である。**
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手の判定、【未確認】は確かめていないこと。

- **文脈**: [ADR 0500](./0500-testkit-fixture-alignment-claimkey-labels-timestamptz-seq-llm-float4.md) の決めたこと2は、`timestamptz` の下限（4714-11-24 BC 00:00:00 UTC、JS では `Date.UTC(-4713, 10, 24)`）より前を、「Postgres が `22008` にする口にだけ」fixture でも断るとした。同 ADR の「引き受けた負債」は、「書く口（`createMemory` の `occurredAt`・`validFrom` など、行に日時を書く口）の下限は調べていない【未確認】」を残した。読みの口は [ADR 0547](./0547-pg-out-of-range-date-reads-clamp-to-floor.md) で「下限へ寄せて比べる」に変わったが、書く口は変えていない。`packages/testkit/src/fixtures.ts` の冒頭は「Postgres が DB の例外で拒む入力を、この入口の fixture は書き込みの前に断る」と約束している。この約束から、行に日時を書く口が外れていた（Issue #1755、#1753 の README の実測で見つかった）。`@mnemora/testkit` の `package.json` は `./fixtures` を export しているので、fixture は公開の振る舞いである。【現物】

- **見つけたこと**【現物】:
  1. fixture の検査 `assertQueryTimestamptz`（`__fixtures__/query-check.ts`）を呼んでいたのは、`opts.now`・`requeueEmbedJobs`・`archiveDecayed`・outbox の `complete`・`fail` の `at` だけだった。行の欄に日時を書く口からは呼ばれていなかった。
  2. 日時が行に入る経路は、検査の入口が少数に集まっている: `assertObservationDatesValid`（Observation の4欄）、`assertStorableNewMemory`（Memory の6欄。`createMemory` 系・`supersedeWithNewMemories` の新しい行が通る）、`assertRecallRecordStorable`（`createdAt`）、`reinforce` の入口、`assertStorableMemoryEvent`（イベントの `at`。`buildStoredMemoryEvent` から、イベントを書くすべての口が通る）。
  3. core のテスト専用 Fake（`runtime-fakes.ts`）も、同じ口に Invalid Date の検査だけを持ち、下限は `FakeOutboxStore.complete`・`fail`（ADR 0597）にしか無かった。

- **測ったこと**（【実測】2026-10-06、手元の PostgreSQL 17 + pgvector、`C.UTF-8`、自分専用のインスタンス。日時は、下限の1ms 前・紀元前9001年・**下限ちょうど**・下限の1ms 後の4つで渡した。2実装を並べた常設の歯は `packages/postgres/src/__tests__/testkit-fixture-alignment-written-floor.postgres.test.ts`）:

  **下限ちょうど・1ms 後は、下の全部の口で Postgres も fixture も通る。** 下限より前は次のとおり。`22008` は `DrizzleQueryError` の `cause.code`。

  | 口 | 欄 | 下限より前の Postgres |
  | --- | --- | --- |
  | `createMemory`・`createMemoryWithOutbox`・`createMemoriesWithOutboxAndEvents`・`supersedeWithNewMemories`（新しい行） | `occurredAt`・`recordedAt`・`lastReinforcedAt`・`validFrom`・`validUntil`・`decayFloorAt` | `22008`（6欄 × 4口、24通り全部）。冪等の既存の行が在っても `22008`（`createMemory` の `occurredAt`・`decayFloorAt` で確認） |
  | `createObservation`・`createObservationWithOutbox` | `occurredAt`・`recordedAt`・`validFrom`・`validUntil` | `22008`（4欄 × 2口）。`externalId` が既存の行でも `22008`（衝突を見る前） |
  | `reinforce`・`reinforceMany`・`recordUsageAndReinforce` | `at` | `22008`。**何も書かない呼び出し（起点より古い `at`）でも** `22008`。ただし、`ids` が空の `reinforceMany`・`recordUsageAndReinforce`、記録済みで何も強化しない `recordUsageAndReinforce` の2回目は、通る（`at` を見ない） |
  | `createRecall` | `createdAt` | `22008` |
  | `EventStore.append` | `at` | `22008`（`memoryId` が null でも在っても） |
  | `updateStatusWithEvent` | `event.at` | `22008`。CAS に弾かれる呼び出し・対象が無い呼び出しは、`at` の例外ではなく CAS・不在の例外 |
  | `supersedeWithNewMemories` | `supersede[].event.at` | CAS を通る対象は `22008`。**CAS に弾かれる対象は通る**（`conflicted` に積まれ、イベントを書かない）。2対象のうち、通る側が下限より前なら `22008`、弾かれる側だけが下限より前なら通る |
  | `supersedeWithNewMemories`・`createMemoriesWithOutboxAndEvents` | `buildCreatedEvent` が返すイベントの `at` | `created: true` の行は `22008`。**冪等の既存の行（`created: false`）は、イベントを作らないので通る** |
  | `markContestedPair`（2件とも）・`resolveContestedPair`・`markContestedGroup`・`resolveContestedGroup`・`resolveOrphanedContested`（成功する経路） | `event.at` | `22008`。状態が合わない呼び出しは、状態の例外（CAS） |
  | `restoreSupersededBy` | `event.at` | `22008`。**対象が1件も無くても**（実在しない id でも）`22008` |
  | `purgeMemory` | `event.at`（`purged_at` も同じ値） | `22008`。purge できない状態の行でも `22008`（墓石の NUL と同じく、UPDATE の引数として先に拒む）。不在の id でも `22008` |
  | `createMemoriesWithOutboxAndEvents` | 候補2件のうち1件の欄が下限より前 | その候補だけが `dropped` になり、もう1件は書かれる（候補ごとの SAVEPOINT。Invalid Date の候補も同じ）。候補が1件だけなら、その `22008` が投げられる |
  | `OutboxStore.claimBatch`・`purgeExpiredEventsByRetention` | `now` | **通る**（`claimBatch` は ADR 0547 の寄せ。保持期間の掃除は、下限より前に行が無いので何も書かない） |

  - `reinforce` の「何も書かない呼び出しでも拒む」は、ADR 0500 の `nowSeq` の溢れ（「起点より古い `at` は、溢れる組み合わせでも通る」）とは逆である。日時の `at` は、WHERE の比較に使われる前に、パラメータとして変換されるから。【判断】（機構は測っていない。測ったのは結果だけ）
  - 測っていない: `purgeExpiredEventsByRetention` で、実際に `events_purged` を書く（`now` が下限以後で、対象の行がある）経路の下限。`now` が下限より前なら、対象の行が存在しえないので、書かない。
  - 測っていない: 外部の adapter、`TrigramLexicalStore`（fixture が無い）。

- **決めたこと**【判断】:
  1. **fixture の書く口は、Postgres が `22008` にした口・欄だけを、書き込みの前に断る。** 例外は `RangeError`、文面は `<口>: <欄> must not be earlier than 4714-11-24 BC (the lower bound of a Postgres timestamptz)`（`assertQueryTimestamptz` と同じ）。下限ちょうどは通す。Postgres が通す口・分岐は断らない（上の表の「通る」）。何も書かない（Memory・Observation・イベント・outbox・ラベル・使用の記録・Recall・活動時計は呼ぶ前のまま）。
  2. **新しい関数 `assertWrittenTimestamptzFloor`（`query-check.ts`）を足した。** 下限だけを見て、Invalid Date は見ない（欄ごとの Invalid Date の検査と文面は、そのまま。#807・ADR 0493）。`assertQueryTimestamptz` は、`assertQueryDate` のあとにこれを呼ぶ形にした（振る舞いは同じ）。名前は書く口向け。読みの口には使わない（ADR 0547）。
  3. **呼ぶ位置は、Postgres がその値を実際に書く分岐の中に合わせた。**
     - 入口で見る（冪等の既存の行が在っても拒む）: Observation の4欄、Memory の6欄、`createRecall` の `createdAt`、`reinforce` の `at`（no-op の判定の前）。
     - イベントの `at` は `assertStorableMemoryEvent`（すべての口の合流点）に入れた。ただし、`supersedeWithNewMemories` の事前検査だけは `skipAtFloor` で下限を見ず、CAS を通る対象だけを別に見る（CAS に弾かれる対象は Postgres が `at` を見ないので、断ると「やりすぎ」になる）。
     - `restoreSupersededBy` は、対象が無くても下限を見る。`purgeMemory` は、行を引く前に見る。
     - `created: false` の行には、イベントを作らないので、`buildCreatedEvent` の `at` を見ない（元の作りのまま）。
  4. **core の Fake（`runtime-fakes.ts`）も、同じ口を同じ位置で直した。**【判断】ADR 0597 が、`FakeOutboxStore.complete`・`fail` を直した理由（「Fake だけ直さない」は、「Postgres で通らないテストが Fake で通る」ずれを残す）が、そのまま当たる。Fake は ADR 0493・0500 以降、fixture と同じ検査の組を持つ形で保たれてきた。Fake の側には、fixture の `assertStorableMemoryEvent` に当たる `assertBuildableFakeEvent` があり、同じ形（`skipAtFloor`）にした。core のテスト専用で、publish されない。
  5. **core の TSDoc（`Observation.occurredAt`）・`docs/memory-model.md`・`packages/postgres/README.md` の「例外の見分け方」・`fixtures.ts` 冒頭**を、いまの振る舞いに直した。`Observation.occurredAt` の TSDoc は、ADR 0547 のあとも「読みの口の条件・`opts.now` は ADR 0500 から断る」と書いていた（読みの口は ADR 0547 で断らなくなった）ので、そこも直した。
  6. **CHANGELOG・migration-v1 の分類は 🟡（非破壊）に置いた。**【判断】`docs/migration-v1.md` の数え方の規律2（オーナー回答 `3f3411c5`。[ADR 0461](./0461-v1-2-0-release-prep-inspection.md)）に従う。公開の fixture が新しく例外を投げる変更は破壊的と数えない。[ADR 0500](./0500-testkit-fixture-alignment-claimkey-labels-timestamptz-seq-llm-float4.md) も、同じ種類の変更を 🟡 に置いた。⚠ 一方、[ADR 0597](./0597-outbox-complete-fail-at-below-floor-rejected-and-negative-limit-comment-measured.md) は、`PostgresOutboxStore` という**本物の adapter** の振る舞いを変えたので 🔴 に置いた。この ADR は本物の adapter を変えない。

- **採らなかった案**:
  1. **Postgres の側を fixture に合わせる（B）。** B1（書く前に下限へ寄せて保存する）は、呼び手が渡した値と違う値が黙って保存され、後から見分けられない。B2（Postgres も `RangeError` で先に断る）は、断ることは変わらず、例外の顔だけを変える別の話（README の「例外の見分け方」の5つの顔を減らす）。どちらも、この Issue の「fixture が約束から外れている」は直さない。
  2. **`assertQueryDate` 自体に下限を足し、全部の日時の口に掛ける。** ADR 0500 の採らなかった案1と同じ。読みの口と `purge*` の `olderThan` は Postgres が通す。
  3. **`assertStorableMemoryEvent` で、`supersedeWithNewMemories` の対象のイベントも常に断る。** 実装は1行で済むが、CAS に弾かれる対象（Postgres が `at` を見ない）を断る「やりすぎ」になる（実測の行）。
  4. **`createMemoriesWithOutboxAndEvents` の1候補の下限違反を、呼び出し全体の例外にする。** Postgres は SAVEPOINT で、その候補だけを `dropped` にする（実測）。fixture も、Invalid Date などと同じ `dropped` の経路にした（元の作りのまま）。
  5. **core の Fake を直さない。** 上の決めたこと4。Fake は conformance に繋がっていない（Issue #768）ので、Fake だけの歯（`fake-written-timestamptz-floor.test.ts`）を足した。

- **引き受けた負債**:
  - 例外の顔は揃えていない。fixture は `RangeError`、Postgres は `DrizzleQueryError`（`cause.code` `22008`）。揃えるのは「断るかどうか」と「断ったとき何も書かないこと」まで（`fixtures.ts` の冒頭、ADR 0500）。
  - **二重に誤った入力で、どちらを先に報告するかは揃えていない。** 例えば、purge できない状態の行に、下限より前の `at` を渡した `purgeMemory` は、Postgres が `22008`、fixture が、いまは `22008`（行を引く前に見る）。ほかの口（`updateStatusWithEvent` の CAS 不一致など）は、Postgres が CAS の例外を先に出し、fixture も同じ順にした。口ごとの順は、上の表の測った範囲だけを写している。
  - 外部の `MemoryStore`・`EventStore` 実装は変えない。conformance suite（`describe*Conformance`）には、歯を足していない。書く口の下限を断る約束は、Postgres の `timestamptz` 固有で、adapter 一般の契約ではない（ADR 0597 は `OutboxStore.complete`・`fail` を契約にしたが、あれは本物の adapter の振る舞いを変えた別の判断）。【判断】
  - 測っていない口が残る（上の「測っていない」）。
  - fixture が断る口が増えるので、`@mnemora/testkit/fixtures` に下限より前の日時を書いていたテストは、新しく落ちる。🟡 に数える（決めたこと6）。覆すのはオーナーの判断。

- **これが覆るとしたら**:
  - オーナーが「fixture が新しく例外を投げる変更も 🔴 に数える」と決めたとき（ADR 0461 の判断を覆すとき）。CHANGELOG の `### Breaking`・migration-v1 の番号付きの項目へ移す。移す箇所は、CHANGELOG の `[1.3.0]` 節の `### Changed` の該当の箇条と、`docs/migration-v1.md` の「🟡 v1.2.0 → 次の版」の該当の箇条。
  - PostgreSQL が `timestamptz` の下限より前を通す（範囲が広がる）とき。2実装を並べた歯 `testkit-fixture-alignment-written-floor.postgres.test.ts` が落ちる。
  - `@mnemora/postgres` が、書く前に下限より前を断る（B2）か、下限へ寄せて書く（B1）ようになるとき。fixture の例外の型・文面は見直す。
  - Postgres が `reinforce` の何も書かない呼び出しの `at` を見なくなる（実行計画・ドライバの変更）とき。同じ歯が落ちる。

- **歯の赤→緑と変異**: PR 本文に書いた。

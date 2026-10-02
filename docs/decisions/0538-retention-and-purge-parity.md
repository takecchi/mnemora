# ADR 0538: 穴探し — 保持と掃除の口（`purgeExpiredEventsByRetention`・`purgeExpiredRecalls`・`purgeCompletedJobs`）を3者（Fake・InMemory・Postgres）で突き合わせる。Fake の `events_purged` の `meta` だけ、日時が `Date` のままで割れていた（直した）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-02

ADR 0536 の棚卸しの「次の候補」の2つ目（保持・掃除の口）に当たる（0536 の番号だけを書く。0536 が main に入る前でも門が通るように、リンクにはしていない）。クローン miku の委譲先（担い手。マネージャー mgr-2c9f30d0 の指示による）が書いた。直す線（約束に実装を戻す・Fake を Postgres に揃える）の中だけを直した。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果（Node.js v22、PostgreSQL 17 + pgvector を自分専用のポートで）、【判断】は担い手の判定。

- **文脈**: ADR 0536 の棚卸しで、次の口は3者の突き合わせが無かった。`MemoryStore.purgeExpiredEventsByRetention` は conformance にも `store-boundary-diff` にも無く（Fake 単独の `event-retention-purge.test.ts` と Postgres の並行・設定変更の歯だけ。ADR 0522 の測定では3者一致だったが使い捨てのスクリプトで、歯は無かった）、`purgeExpiredRecalls`・`OutboxStore.purgeCompletedJobs` は InMemory と Postgres だけ（conformance と `store-boundary-diff`。Fake は `fake-purge-expired-recalls-and-completed-jobs.test.ts` の単独）。`scrubPurged` は Fake が実装していない。既にある歯と同じことは測り直さず、3者の差分だけを足す。

## 測り方【実測】

3者に同じ入力を流し、結果と、その後の状態を平らなデータにして比べた（`EXPECTED` は 21 項目）。時刻はすべて固定で、実時間に依らない（決定的）。
- **`purgeExpiredEventsByRetention`**: 設定が無い（`unset`）・無期限（`unlimited`）・30 日（`executed`）。cutoff（`now - 30 日`）の前後（-1000ms・-1ms・ちょうど・+1ms・+999ms・+1000ms）のイベントで、境界は `at < cutoff`（ちょうどは残る）。`dryRun`（件数と期間だけ返し何も消さない）・`limit: 1`（古い順に1件だけ、`reachedLimit: true`）・残り・もう何も無い・注入した `now` を進めると cutoff も進む。`events_purged` の記録（`meta` の4欄）と、**古い `events_purged` の行は掃除の対象にならない**こと。テナントごとの保持（別のテナントに触れない・設定を短くすると次の掃除が増える）。日数が巨大なとき（約1億日を超える）は、表せる最も古い時刻へ寄せて何も消さず、例外にもしない。
- **`purgeExpiredRecalls`**: `createdAt` を指定した記録5件（`olderThan` の -1000ms・-1ms・ちょうど・+1ms・+1000ms）と、それぞれに使用の行。`dryRun`・`limit: 1`・残り・`olderThan` を1ms進めると「ちょうど」の1件が入る・別テナントは自分の呼び出しでだけ消える。`purged`・`purgedUsages`・`reachedLimit`・`oldestPurgedAt`・`newestPurgedAt`、掃除後の `getRecall`。
- **`OutboxStore.purgeCompletedJobs`**: 6本のジョブのうち5本を `olderThan` の前後（-1000ms・-1ms・ちょうど・+1ms・+1000ms）で完了させ、1本は claim したまま完了させない。`dryRun`・`limit: 1`・残り（ちょうどと後の分と未完了は残る）・1ms 進める・別テナント。

## 結果

### Fake の `events_purged` の `meta` だけ割れていた（直した）【実測】

Fake の `purgeExpiredEvents`（`purgeExpiredEventsByRetention` も同じ関数を通る）が積む `events_purged` の `meta` は、`oldestPurgedAt`・`newestPurgedAt`・`olderThan` を **`Date` のまま**持っていた。InMemory（`toISOString()`）と Postgres（`jsonb` で読み戻すと文字列）は **ISO 8601 の文字列**。`meta` を読み戻した値の型が3者のうち Fake だけ違っていた。`meta` の型は TSDoc に書いていない（`{ purgedCount, oldestPurgedAt, newestPurgedAt, olderThan }` の4欄）が、監査ログは JSON として保存・往復する値であり、Postgres と InMemory が文字列である（`memory-events-meta-parity.postgres.test.ts` が InMemory↔Postgres を縛る）ので、**Fake を文字列に揃えた**（Fake だけの直し。非公開。落ちる入力は増えない）。直す前は、この歯の Fake 側が赤になる（`toISOString()` を外す変異で確かめた。下の「変異試験」の1件目）。core の Fake を読むテストは、`events_purged` の `meta` を `Date` として読んでいなかった（名指しで走らせた14本が緑）。

### ほかは3者一致【実測。決定的】

上の測り方の全項目で、Fake・InMemory・Postgres の結果と状態が一致した。境界（ちょうど・1ms 前後）は3つの口とも「厳密に古い」（`<`）、`limit` は古い順、`reachedLimit` は「候補が `limit` より多い」とき、`dryRun` は何も消さず同じ件数と期間を返す、別テナントに触れない。ミリ秒の端数（`.999`・`.001`）も一致した（ADR 0427 の秒境界の領域）。

## `scrubPurged` の扱い【判断】

Fake は `scrubPurged` を実装しない任意メソッドで（ADR 0375・0437。実装しない adapter では `Runtime.purge` が後始末を飛ばす）、InMemory と Postgres の2者だけが比較の対象になる。**この ADR では新しい歯を足さなかった。**理由: 比較には「v1.1.0 より前の `purgeMemory` が残した派生物（`tags`・`attributes`・`claimKey`・label の紐付け）が残った purge 済みの行」を作る必要があるが、今の `createMemory` は `purgedAt` を受けず（試して、InMemory と Postgres でどちらも無視された）、今の `purgeMemory` は派生物を消すので、store の公開口だけでは残骸の行を作れない。既にある歯は、残骸を実装ごとに直接作って縛っている（conformance の `supportsScrubPurged`〔`memory-store-conformance.ts` と `memory-store-round31-teeth.ts`。InMemory と Postgres の両方が走らせる〕と、`repurge-legacy-residue.postgres.test.ts`）。Runtime 経由の間接の比較（`purge` の `already_purged`）は ADR 0522 の歯が3者で縛っている。Fake に実装が無いことは `fake-retention-purge-parity.test.ts` の1本が縛る。

## 決定したこと

1. Fake の `events_purged` の `meta` の日時を ISO 8601 の文字列にそろえた（`packages/core/src/__tests__/runtime-fakes.ts`。Fake だけの直し）。実装・公開 API・既定値・conformance suite（ADR 0434 決定5）・CHANGELOG・`docs/migration-v1.md` は変えていない。
2. 3者の差分を歯で縛った:
   - `packages/core/src/__tests__/fake-retention-purge-parity.test.ts`（Fake。`scrubPurged` が無いことの1本を含む）
   - `packages/postgres/src/__tests__/retention-purge-parity.postgres.test.ts`（InMemory と実 Postgres。DB はファイル冒頭で作り直し、tenant はこのファイル専用の名前）
   - 同じ操作列と同じ `EXPECTED`（21 項目）。

## 変異試験【実測】

実装を1つずつ曲げ、歯が噛むかを確かめた。戻した後は `git status` に歯の2ファイル以外が無い。**19 件すべて赤**（歯を5回走らせてフレークは見えなかった）。
- Fake: `events_purged` の `meta` を `Date` に戻す（今回の直しを外す）／イベント・記録・ジョブの境界を `<` から `<=` に／イベントのテナントの絞りを外す／`events_purged` も掃除する／保持日数に1日足す／`purgedUsages` を 0 にする。
- InMemory: イベント・記録・ジョブの境界／保持日数に1日足す／`purgedUsages` を 0 にする。
- Postgres: イベントの境界を `<=` に／`events_purged` も掃除する／古い順を新しい順に／記録の境界／ジョブの境界／完了していない行も対象にする。
- **最初の版で噛まなかった変異が2件あった**: 「`events_purged` も掃除する」（Fake と Postgres）が緑のまま通った。最初の操作列は、古い `events_purged` の行を作っていなかったため。「古い `events_purged` の行は掃除の対象にならない」段（`at` が cutoff より古い `events_purged` を直接追記して、掃除の後も残ることを見る）を足して、両方とも赤になった。

## 検討した代替案

1. **`scrubPurged` の残骸を、実装ごとに直接作って3者（Fake は不在）で比べる。** 採らなかった（上のとおり。既にある歯が縛っている）。
2. **Fake の `meta` を直さず、歯の側で `Date` を文字列にならして比べる。** 採らなかった。3者で `meta` の型が違うままになり、Fake を読む利用者のテストが `Postgres` と違う型を前提にしうる。

## オーナーの領分の材料

なし（既定値・公開 API・決定を覆す材料は見つからなかった）。

## これが覆るとしたら

- `events_purged` の `meta` の型を、日時の文字列から別の形（例: 数値の epoch）に変える決定が出たとき（3者を揃えて歯を書き換える）。
- `createMemory` が `purgedAt` を受けるようになったとき（`scrubPurged` を3者で比べる歯が足せる）。

## 測っていないこと

- `purgeExpiredEventsByRetention` の並行（保持の設定を同時に書き換える）。Postgres の `purge-expired-events-by-retention-concurrency.postgres.test.ts` が縛る面。
- `limit` が負・非整数・巨大などの境界入力は `store-boundary-diff`（InMemory↔Postgres）と `fake-store-postgres-parity.test.ts`（Fake）が既に縛っている。
